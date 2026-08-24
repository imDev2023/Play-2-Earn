# Relayer operations runbook

The settlement relayer is the only always-on service RUSHOOD has.
It watches for an unsettled bet, publishes the next reveal from the server hash chain, and pays the gas to do it.

This document is written to be followed by someone who has never run it before, at an hour when they would rather not be reading it.

## The first thing to know

**A relayer outage cannot take player money.**
Every bet becomes refundable by its own player after `SETTLE_TIMEOUT`, which is one hour, and `refund()` is permissionless and not gated by pause.
That path is guaranteed by the contract and needs no service to be running.

**What an outage does take is the game.**
`RushoodGame` allows one bet at a time.
A single unsettled bet therefore blocks every other player, not just the one who placed it, until it is settled or refunded an hour later.

So: an outage is urgent, but it is never a reason to panic about funds.
Fix it calmly, in the order below.

## What runs where

The service is `packages/contracts/scripts/relayer-service.ts`.
It is deliberately free of Hardhat: it takes an RPC URL, a private key and a game address from the environment, and nothing else.
Do not run `scripts/relayer.ts` against a public network - that is the local-development script, it reads its game address from a gitignored build artefact, and it picks its signer by index from whatever accounts the node exposes.
It now refuses to start off localhost without an explicit seed, but it is still the wrong tool.

The same artifact runs on testnet and on production.
Only the credential file differs.
That is intentional: the procedure you exercise on testnet is then the procedure that is true at launch.

### Install

```bash
sudo useradd --system --home /opt/rushood --shell /usr/sbin/nologin relayer
sudo git clone https://github.com/imDev2023/Play-2-Earn /opt/rushood
cd /opt/rushood && sudo npm ci --omit=dev --workspace @rushood/contracts --include-workspace-root
sudo install -m 0644 packages/contracts/deploy/rushood-relayer.service /etc/systemd/system/
sudo mkdir -p /etc/rushood && sudo touch /etc/rushood/relayer.env
sudo chmod 0600 /etc/rushood/relayer.env && sudo chown root:root /etc/rushood/relayer.env
```

Fill in `/etc/rushood/relayer.env` (see the table below), then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rushood-relayer
journalctl -u rushood-relayer -f
```

A container image is also provided at `packages/contracts/Dockerfile.relayer` if you would rather run it that way.
It carries no Solidity toolchain.

## Configuration

Every value is an environment variable.
The service validates all of them on boot and refuses to start with a list of everything that is wrong, rather than dying on the first problem.

| Variable | Required | Meaning |
|---|---|---|
| `RELAYER_NETWORK` | no | A committed deployment by name (see below). Supplies `RELAYER_RPC_URL` and `RELAYER_GAME_ADDRESS` |
| `RELAYER_RPC_URL` | unless `RELAYER_NETWORK` | JSON-RPC endpoint. Mainnet is `https://rpc.mainnet.chain.robinhood.com` |
| `RELAYER_GAME_ADDRESS` | unless `RELAYER_NETWORK` | The deployed `RushoodGame` |
| `RELAYER_PRIVATE_KEY` | yes | The account that sponsors settlement gas |
| `RELAYER_SEED` | yes | The master seed. **No default.** See below |
| `RELAYER_HEALTHCHECK_URL` | strongly advised | Healthchecks.io ping URL for the dead man's switch |
| `RELAYER_ALERT_URL` | strongly advised | Healthchecks.io ping URL for explicit alerts. Must be a **different** check |
| `RELAYER_CHAIN_LENGTH` | no (256) | Reveals per epoch. Must match what the deployment committed |
| `RELAYER_ROTATION_MARGIN` | no (4) | How early to rotate before the chain runs out |
| `RELAYER_POLL_INTERVAL_MS` | no (3000) | Loop interval. Also the settlement latency |
| `RELAYER_ETH_WARN_WEI` | no (0.01 ETH) | Gas balance that warns |
| `RELAYER_ETH_PAGE_WEI` | no (0.001 ETH) | Gas balance that pages |
| `RELAYER_PROBE_TIMEOUT_MS` | no (60000) | Failed-poll window before the node counts as unreachable |
| `RELAYER_BLOCK_STALL_MS` | no (120000) | Frozen-head window before the chain counts as stalled |

### Committed deployments

`RELAYER_NETWORK` names an entry in `scripts/service/networks.ts`, the committed network book (#61).
An entry exists there if and only if a deployment record exists under `docs/deployments/`, so the name is a pointer to configuration that is reviewed and versioned rather than typed at run time.
The explicit `RELAYER_RPC_URL` and `RELAYER_GAME_ADDRESS` variables still win where set - that is how the "switch to a fallback provider" move under Responding works - but the chain expectation survives the override, because a fallback provider serves the same chain.

Naming a network also makes boot verify the chain: the service asks the endpoint for its chain id before doing anything else, and refuses to start if the answer is not the one the entry commits to.
A configuration built from explicit variables alone carries no such expectation.

The one committed entry today is `robinhoodTestnet` (chain 46630), and `npm run relayer:testnet` starts the service against it.
Secrets are never part of an entry: `RELAYER_PRIVATE_KEY` and `RELAYER_SEED` come from the environment exactly as before.

### The seed

`RELAYER_SEED` is the crown-jewel secret.
Every reveal the relayer will ever publish is derived from it, so anyone who holds it can compute every future roll before it is placed.

It has no default in production and the service refuses to start with the committed development seed, by name.
Do not put it in the unit file, which is world-readable.
`EnvironmentFile` with mode 0600 is the floor.

Better, and free: `systemd-creds`, which keeps it encrypted at rest and out of `systemctl show`.

```bash
sudo systemd-creds encrypt --name=relayer-seed - /etc/rushood/seed.cred
# paste the seed, then Ctrl-D
```

Then add to the unit:

```
LoadCredentialEncrypted=relayer-seed:/etc/rushood/seed.cred
```

and drop `RELAYER_SEED` from the environment file.
The service reads `$CREDENTIALS_DIRECTORY/relayer-seed` on its own when `RELAYER_SEED` is unset, so nothing else is needed.
The credential name must be exactly `relayer-seed`.
An explicit `RELAYER_SEED` in the environment still wins, so you can override it by hand mid-incident without editing the unit.

**Rotating the seed does not require a redeploy.**
The chain design already supports it: `rotateChain(newGenesis)` accepts any new tip, and is legal whenever no bet is in flight.
To rotate, stop the relayer between bets, set the new seed, publish the new tip, and start it.
The service resolves the on-chain head against its own chains at boot and will refuse to start if the seed does not match the deployment, so a mistake here fails loudly rather than silently settling nothing.

## Alerts

All alerting goes through Healthchecks.io, on its free tier.

### Setting it up, once

You need **two checks**, not one.
This is the single most important thing on this page to get right, and the service refuses to boot if you point both variables at the same check.

1. Create a check named `rushood-relayer-alive`.
   Set its **period** to a few times `RELAYER_POLL_INTERVAL_MS` and its **grace** to comfortably more than `RELAYER_PROBE_TIMEOUT_MS`.
   With the defaults (3s poll, 60s probe timeout), a period of 5 minutes and a grace of 5 minutes is sane: long enough that a momentary blip does not page, short enough that a dead relayer is noticed within ten.
   Do not set the period near the poll interval; a check that expects a ping every 3 seconds will flap on ordinary network jitter and be muted within a day.
   Put its ping URL in `RELAYER_HEALTHCHECK_URL`.
2. Create a second check named `rushood-relayer-alerts`.
   Give it **no schedule** at all, so it is only ever down when the relayer explicitly says so.
   Put its ping URL in `RELAYER_ALERT_URL`.
3. Attach the notification channels you actually read to both.
   Email alone is not a pager. On the free tier, a phone push through the Healthchecks.io mobile app, or a Telegram or Slack integration, is what makes this a page rather than a log line.
4. Confirm both, before you need them: `curl -fsS "$RELAYER_ALERT_URL/fail"` should notify you, and `curl -fsS "$RELAYER_ALERT_URL"` should clear it.

Why two: the heartbeat pings its check **up** once per pass.
Pointed at the alert check, that ping would cancel any page the relayer raised within one poll interval, and because alerts are edge-triggered it would never be re-delivered.
You would get exactly one notification and then a green dashboard for the rest of the outage, which is worse than no alerting at all, because it looks like it is working.

### The two mechanisms

There are two distinct mechanisms and it is worth knowing which is which.

**The dead man's switch** is the `rushood-relayer-alive` check's own schedule.
The relayer pings it once per loop pass, but *only while the connection is provably alive*.
If the relayer crashes, is killed, loses its network, or is pointed at a dead node, the pings stop and Healthchecks.io raises the alarm on its own.
This is the backstop that does not depend on the failing process being well enough to report its own failure.

It is deliberately **not** pinged from the settle path.
Pinging on settlement would make a quiet night with no bets look identical to a dead relayer, and the resulting false pages would get the check muted within a week.

**Explicit alerts** are posted by the relayer to `rushood-relayer-alerts` for conditions it can see and you cannot.

| Alert | Severity | Means |
|---|---|---|
| `settlement-lag` | page | A bet has been unsettled past the healthy window (60s) |
| `settlement-stalled` | page | A bet is past `SETTLE_TIMEOUT`; the player can refund |
| `rpc-down` | page | Polls are failing; nothing will be settled |
| `chain-stalled` | page | The node answers but its head is frozen |
| `chain-exhaustion` | page | Rotation was due and has not happened |
| `seed-mismatch` | page | The on-chain head is on no chain this seed can derive |
| `relayer-funding` | warn, then page | Gas balance is low, then nearly out |

Each condition is delivered once when it starts and resolved once when it clears, not repeated every pass.
An escalation from warn to page is delivered again, because that is new information.

A pass that cannot reach the node resolves nothing except liveness.
It has no evidence about the gas balance or the reveal chain, and treating its silence as good news would clear a live alert and re-raise it seconds later, which is how a check becomes noise.

### Responding

**`settlement-lag` or `settlement-stalled`.**
1. `systemctl status rushood-relayer` and `journalctl -u rushood-relayer -n 100`.
2. If the process is down, start it. It will settle the outstanding bet on its first pass; catching up is ordinary behaviour, not a special path.
3. If it is up and logging `poll failed`, treat it as `rpc-down` below.
4. If it is up and quiet, check the gas balance - a relayer that cannot pay cannot settle, and that surfaces here too.

**`rpc-down`.**
1. Check the endpoint directly: `curl -s -X POST -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' "$RELAYER_RPC_URL"`.
2. If the endpoint is fine, the fault is local - DNS, egress, the host. Restart the service.
3. If the endpoint is down, switch `RELAYER_RPC_URL` to a fallback provider and restart.

**`chain-stalled`.**
The node is reachable but the chain's head is not moving.
Restarting will not help and repeated restarts only add noise.
Confirm against a second RPC endpoint, then wait or escalate to the chain operator.

**`chain-exhaustion`.**
Rotation is only legal between bets, so this means either the relayer is down, or bets are arriving continuously and it never gets an idle moment.
1. Confirm the relayer is running and settling.
2. If it is running, this resolves itself at the next gap between bets.
3. If the chain reaches its end with a bet in flight, that bet **cannot be settled at all** and will have to be refunded after the timeout. Pause the game to stop new bets, let the in-flight one refund, then rotate.

**`seed-mismatch`.**
The relayer is running and can settle nothing at all, so every bet placed from here will run to its refund.
Restarting will not help: the fault is the seed or the deployment, not the process.
1. Confirm which seed the service is actually using. If it came from a credential, check that `LoadCredentialEncrypted` names the file you think it does.
2. Compare `currentCommit()` on the game against the chain your seed derives. If the game was rotated by another operator or another host, that is your answer.
3. Restore the correct seed and restart. Do not rotate the on-chain chain to match a seed you are unsure of; that decision is irreversible and every future roll depends on it.

**`relayer-funding`.**
Send ETH to the relayer address, which is logged on every boot.
The warn floor exists so this is never urgent; if it has reached page, expect settlement to stop shortly.

## Confirming recovery

Do not trust the absence of alerts.
Confirm the game is actually settling:

1. `journalctl -u rushood-relayer -n 20` should show a recent `settled bet` line, or a clean idle loop.
2. `activeBetId()` on the game should be `0`, or a bet less than a minute old.
3. The `/admin` console's relayer panel should read **settling** or **idle**. It derives its status from the same state machine the pager uses, so if the console disagrees with the pager, that is itself a bug worth chasing.
4. Place a real bet on testnet and watch it settle.

## Deliberate failure drills

Run these after any change to the service, on testnet, before touching production.
The status column records whether the drill has actually been performed against a running relayer, not merely covered by a unit test.

| Drill | Expected | Verified |
|---|---|---|
| Stop the service with a bet in flight, then start it | The bet settles on the first pass after restart | yes, on a local node |
| `SIGTERM` a running relayer | Finishes the pass in flight, then exits cleanly | yes, on a local node |
| Start with `RELAYER_SEED` unset | Refuses to boot, naming the variable | yes |
| Start with the committed dev seed | Refuses to boot, saying the seed is public | yes |
| Start with a seed that does not match the deployment | Refuses to boot rather than running and settling nothing | yes |
| Kill the node under a running relayer | `rpc-down` fires; the process stays up and recovers when the node returns | yes, on a local node |
| Drain the relayer's ETH | `relayer-funding` warns, then pages | yes, on a local node |
| Let a bet age past the healthy window | `settlement-lag` pages, then resolves once it settles or refunds | yes, on a local node |
| Run the chain to its end with bets arriving continuously | `chain-exhaustion` pages once, and the stuck bet can only be refunded | yes, on a local node |
| Recover from exhaustion per the procedure below | Refund the stuck bet, and the relayer rotates on the next idle pass | yes, on a local node |
| Alerts reach their destination over the wire | `POST $RELAYER_ALERT_URL/fail` on the way in, `POST $RELAYER_ALERT_URL` on the way out | yes, against a local stand-in for Healthchecks.io |
| Run the container image | Boots unprivileged, settles a live bet, carries no Solidity toolchain | yes, `docker run` against a local node |
| Install and run under systemd | Starts on boot, restarts on crash, logs to the journal | **not yet** |

Keep this column honest: if you change the service and cannot re-run a drill, set its cell back to **not yet** rather than leaving a claim the code no longer earns.

Two rows deserve their caveats stated plainly rather than buried.
The alert-delivery drill used a local HTTP server standing in for Healthchecks.io, so it proves the relayer posts the right thing to the right URL, and not that your Healthchecks.io account is wired to your phone.
Do step 4 of the setup above to prove that half.
The systemd row has not been run at all, because the unit needs a Linux host and the development machine is not one.
Run it on the testnet box before production, and treat that as a gate rather than a formality: the unit file has already had two bugs that only an install would have caught.

Two notes from running them, both of which cost time the first time:

**Killing the node.**
`lsof -ti:8545` matches client connections as well as the listener, and the relayer holds one, so that command kills the relayer along with the node and the drill proves nothing.
Use `lsof -ti:8545 -sTCP:LISTEN`.

**Judging recovery.**
`rpc-down` resolving only says the relayer can read the chain again.
Place a bet and watch it settle before you believe it, exactly as in "Confirming recovery" above.
In the drill the bet settled 1.1s after placement on a 1s poll interval, which is the latency to expect: one poll plus one block.

## What this service does not do

There is one relayer.
There is no automated failover, and that is a deliberate scope decision: one reliable, observable relayer first.
If it is down, the game is down until someone acts, and the hour of refund protection is the safety net that makes that acceptable rather than catastrophic.
