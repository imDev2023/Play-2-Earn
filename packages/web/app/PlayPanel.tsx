"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { decodeEventLog, formatUnits, parseUnits } from "viem";
import {
  useAccount,
  useBlock,
  useChainId,
  useConnect,
  useDisconnect,
  useReadContract,
  useWatchContractEvent,
  useWriteContract,
} from "wagmi";
import { getBlock, readContract, waitForTransactionReceipt } from "wagmi/actions";
import { wagmiConfig } from "../lib/wagmi";
import { ACTIVE_CHAIN_ID } from "../lib/chain";
import {
  EDGE_DEN,
  EDGE_NUM,
  GAME_ABI,
  GAME_ADDRESS,
  multiplierLabel,
  RUSH_ABI,
  RUSH_ADDRESS,
  TIERS,
  toBetView,
} from "../lib/contracts";
import { useBetHistory } from "../lib/useBetHistory";
import { betBlock, betBlockMessage } from "../lib/bet-validity";
import { approvalAmount, betsCovered } from "../lib/approval";
import { betFailure, type BetFailure } from "../lib/errors";
import { betBoundsLabel, formatAmount } from "../lib/amount";
import { settlementState, type SettlementState } from "../lib/settlement";
import { useStableCallback } from "../lib/useStableCallback";
import { chip, label, panel, primaryButton, ghostButton } from "../lib/ui";
import { OddsLadder } from "../components/OddsLadder";
import { NetworkOnboarding } from "../components/NetworkOnboarding";
import { BuyRush } from "../components/BuyRush";
import { Reveal, type RevealPhase } from "../components/Reveal";
import { SettlementHelp } from "../components/SettlementHelp";
import { BetHistory } from "../components/BetHistory";
import { FairnessPanel } from "../components/FairnessPanel";

type Result = { win: boolean; payout: bigint };
type Status = "idle" | "approving" | "placing" | "waiting" | "error";

/**
 * The player's entropy contribution: 256 bits from the browser's CSPRNG, generated
 * locally at bet time so the house never sees it in advance. Full width, because the
 * fairness panel tells players this is 256 bits of their own randomness (#24).
 */
function randomSeed(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
}

export function PlayPanel() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { writeContractAsync: writeAsync } = useWriteContract();

  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [failure, setFailure] = useState<BetFailure | null>(null);
  // The bet now waiting on a relayer, so the screen can explain the wait and offer the
  // contract's refund instead of animating indefinitely. Null whenever nothing is
  // pending, which is the normal case.
  const [pending, setPending] = useState<{ betId: bigint; placedAt: number } | null>(null);
  const [refunding, setRefunding] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);
  const [tier, setTier] = useState(0);
  // The tier of the bet currently settling - captured at placement so the reveal
  // describes the settled bet, not whatever the ladder is showing now.
  const [betTier, setBetTier] = useState(0);
  const [stakeInput, setStakeInput] = useState("100");
  // How many bets the approval now in flight covers, so the status line can say what
  // the player is being asked to approve rather than leave them to read the hex.
  const [approvalBets, setApprovalBets] = useState(0);

  const wrongNetwork = isConnected && chainId !== ACTIVE_CHAIN_ID;

  // Every event this panel watches is chain-wide, so each handler has to ask whether the
  // log is about the connected player. Asking it the same way in one place keeps the
  // settle, refund and recovery paths from drifting on address casing.
  // Memoised on the address alone: the recovery effect depends on it, and a fresh
  // closure each render would re-run that effect on every render.
  const isMine = useCallback(
    (player: string | undefined) =>
      player !== undefined &&
      address !== undefined &&
      player.toLowerCase() === address.toLowerCase(),
    [address],
  );

  const { history } = useBetHistory(address);

  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: RUSH_ADDRESS,
    abi: RUSH_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  const { data: minBet } = useReadContract({
    address: GAME_ADDRESS,
    abi: GAME_ABI,
    functionName: "minBet",
  });

  const { data: maxBet } = useReadContract({
    address: GAME_ADDRESS,
    abi: GAME_ABI,
    functionName: "maxBet",
    args: [tier],
  });

  // Somebody watching a draw that never resolves will reload the page, and that is
  // exactly the moment the refund has to still be on offer. React state does not
  // survive a reload, so the pending bet is recovered from the chain: `activeBetId` is
  // the single unsettled bet, by the contract's own invariant.
  const { data: activeBetId } = useReadContract({
    address: GAME_ADDRESS,
    abi: GAME_ABI,
    functionName: "activeBetId",
    query: { enabled: isConnected && pending === null, refetchInterval: 5_000 },
  });

  useEffect(() => {
    if (pending !== null || !address || !activeBetId) return;
    let cancelled = false;
    (async () => {
      const raw = await readContract(wagmiConfig, {
        address: GAME_ADDRESS,
        abi: GAME_ABI,
        functionName: "bets",
        args: [activeBetId],
      });
      const bet = toBetView(raw);
      // Somebody else's bet is none of this screen's business, and a settled one needs
      // no help.
      if (cancelled || bet.settled) return;
      if (!isMine(bet.player)) return;
      setPending({ betId: activeBetId, placedAt: Number(bet.placedAt) });
      setStatus("waiting");
      setBetTier(bet.tier);
    })().catch(() => {
      // Best-effort recovery; a failed read leaves the screen exactly as it was.
    });
    return () => {
      cancelled = true;
    };
  }, [activeBetId, address, pending, isMine]);

  // Chain time, watched only while a bet is pending. The countdown has to agree with
  // the contract that enforces it: a refund button that unlocks a minute before
  // `refund` will accept the call is worse than one that unlocks a minute late.
  const { data: head } = useBlock({
    watch: pending !== null,
    query: { enabled: pending !== null },
  });

  // The refund deadline the contract will actually enforce, rather than an hour
  // hard-coded here that would drift if the constant ever moved.
  const { data: settleTimeout } = useReadContract({
    address: GAME_ADDRESS,
    abi: GAME_ABI,
    functionName: "SETTLE_TIMEOUT",
  });

  // The commitment the *next* bet locks against, so a player can record it before
  // betting rather than take our word for it afterwards (#24).
  const { data: standingCommit, refetch: refetchCommit } = useReadContract({
    address: GAME_ADDRESS,
    abi: GAME_ABI,
    functionName: "currentCommit",
  });

  // Parse the stake input to wei; null when it isn't a valid positive amount.
  let stake: bigint | null = null;
  try {
    const parsed = parseUnits(stakeInput || "0", 18);
    stake = parsed > 0n ? parsed : null;
  } catch {
    stake = null;
  }

  const block = betBlock({ stake, minBet, maxBet, balance });
  const belowMin = block === "below-min";
  const aboveMax = block === "above-max";
  const potentialWin = stake
    ? (stake * BigInt(EDGE_NUM) * BigInt(TIERS[tier].odds)) / BigInt(EDGE_DEN)
    : null;
  const lowBalance = balance !== undefined && minBet !== undefined && balance < minBet;

  // Watch for this player's settlement and surface win/loss + payout.
  //
  // Both handlers below are held stable rather than written inline: wagmi resubscribes
  // whenever `onLogs` changes identity, and a log emitted during that gap never
  // arrives. An inline arrow is a new identity every render, and this screen now
  // re-renders on every block while a bet is pending - which is precisely when the
  // settlement it is waiting for lands. See lib/useStableCallback.
  const onSettledLog = useStableCallback((logs: readonly { args: unknown }[]) => {
    for (const log of logs) {
      const { player, win, payout } = log.args as {
        player?: string;
        win?: boolean;
        payout?: bigint;
      };
      if (isMine(player) && win !== undefined) {
        setResult({ win, payout: payout ?? 0n });
        setStatus("idle");
        setPending(null);
        void refetchBalance();
        // Settling advanced the chain head; the panel should show the new one.
        void refetchCommit();
      }
    }
  });

  useWatchContractEvent({
    address: GAME_ADDRESS,
    abi: GAME_ABI,
    eventName: "BetSettled",
    enabled: isConnected,
    onLogs: onSettledLog,
  });

  // A refunded bet never settles, so it never emits BetSettled. Without this the draw
  // would keep animating after the stake had already been returned - and a refund can
  // be triggered by anyone, not only by the button below.
  //
  // This one closed over `pending`, so before being pinned it changed identity the
  // moment a bet started pending: it resubscribed exactly as the bet it watches for
  // became refundable.
  const onRefundedLog = useStableCallback((logs: readonly { args: unknown }[]) => {
    for (const log of logs) {
      const { player, betId } = log.args as { player?: string; betId?: bigint };
      if (isMine(player) && betId === pending?.betId) {
        setPending(null);
        setStatus("idle");
        setResult(null);
        setFailure({
          message: "Nothing settled your bet in time, so your stake was returned.",
          tone: "neutral",
        });
        void refetchBalance();
      }
    }
  });

  useWatchContractEvent({
    address: GAME_ADDRESS,
    abi: GAME_ABI,
    eventName: "BetRefunded",
    enabled: isConnected && pending !== null,
    onLogs: onRefundedLog,
  });

  async function placeBet() {
    if (!stake || block !== null || wrongNetwork) return;
    setFailure(null);
    setRefundError(null);
    setResult(null);
    setPending(null);
    setBetTier(tier);
    try {
      const allowance = address
        ? await readContract(wagmiConfig, {
            address: RUSH_ADDRESS,
            abi: RUSH_ABI,
            functionName: "allowance",
            args: [address, GAME_ADDRESS],
          })
        : 0n;
      if (allowance < stake) {
        // Approve a budget covering a run of bets, so repeat rolls stay one-tap
        // without asking the wallet for an unlimited cap. See lib/approval.ts.
        const amount = approvalAmount({ stake, balance });
        setApprovalBets(betsCovered(amount, stake));
        setStatus("approving");
        const approveHash = await writeAsync({
          address: RUSH_ADDRESS,
          abi: RUSH_ABI,
          functionName: "approve",
          args: [GAME_ADDRESS, amount],
        });
        await waitForTransactionReceipt(wagmiConfig, { hash: approveHash });
      }

      setStatus("placing");
      const betHash = await writeAsync({
        address: GAME_ADDRESS,
        abi: GAME_ABI,
        functionName: "placeBet",
        args: [tier, stake, randomSeed()],
      });
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash: betHash });

      // Identify the bet from its own BetPlaced log rather than by reading
      // `activeBetId` afterwards: by the time a read lands the relayer may already have
      // settled this bet and another player's may be active, and refunding a betId we
      // guessed is the one mistake this feature must not make.
      setPending(betPlacedFrom(receipt.logs, await blockTimestamp(receipt.blockNumber)));

      setStatus("waiting"); // relayer settles; BetSettled resets to idle.
    } catch (err) {
      setFailure(betFailure(err));
      setStatus("error");
    }
  }

  async function refundBet() {
    if (!pending) return;
    setRefundError(null);
    setRefunding(true);
    try {
      const hash = await writeAsync({
        address: GAME_ADDRESS,
        abi: GAME_ABI,
        functionName: "refund",
        args: [pending.betId],
      });
      await waitForTransactionReceipt(wagmiConfig, { hash });
      // BetRefunded clears the pending state, the same way BetSettled does for a win.
    } catch (err) {
      const { message } = betFailure(err);
      setRefundError(message);
    } finally {
      setRefunding(false);
    }
  }

  const busy = status === "approving" || status === "placing" || status === "waiting";

  // Only computable once the chain has told us all three; until then the draw is young
  // enough that the plain reveal is the honest thing to show.
  const settlement: SettlementState | null =
    pending && head && settleTimeout !== undefined
      ? settlementState({
          placedAt: pending.placedAt,
          now: Number(head.timestamp),
          settleTimeout: Number(settleTimeout),
        })
      : null;

  const revealPhase: RevealPhase =
    status === "placing" || status === "waiting"
      ? "drawing"
      : result
        ? result.win
          ? "won"
          : "lost"
        : "idle";

  if (!isConnected) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
        <section style={{ ...panel, display: "flex", flexDirection: "column", gap: "0.85rem" }}>
          <span style={label}>Get in the game</span>
          <p style={{ margin: 0, color: "var(--muted)" }}>
            Connect a wallet to pick your odds and take a shot at the moonshot.
          </p>
          <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
            {connectors.map((connector) => (
              <button
                key={connector.uid}
                data-testid={`connect-${connector.type}`}
                style={ghostButton}
                onClick={() => connect({ connector })}
              >
                Connect {connector.name}
              </button>
            ))}
          </div>
        </section>
        <section style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          <span style={label}>The ladder</span>
          <OddsLadder selected={tier} onSelect={setTier} disabled />
        </section>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.4rem" }}>
      <div style={topBar}>
        <span data-testid="balance" style={chip} className="mono">
          {balance !== undefined ? `${formatUnits(balance, 18)} RUSH` : "… RUSH"}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <code data-testid="account" style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
            {address?.slice(0, 6)}…{address?.slice(-4)}
          </code>
          <button style={ghostButton} onClick={() => disconnect()}>
            Disconnect
          </button>
        </div>
      </div>

      <NetworkOnboarding />

      {revealPhase !== "idle" && (
        <Reveal phase={revealPhase} tier={betTier} payout={result?.payout ?? 0n} />
      )}

      {settlement && (
        <SettlementHelp
          state={settlement}
          refunding={refunding}
          onRefund={refundBet}
          error={refundError}
        />
      )}

      <section style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
        <span style={label}>Pick your odds</span>
        <OddsLadder selected={tier} onSelect={setTier} disabled={busy} />
      </section>

      <section style={{ ...panel, display: "flex", flexDirection: "column", gap: "0.85rem" }}>
        <label style={field}>
          <span style={label}>Stake</span>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <input
              data-testid="stake"
              className="mono"
              style={input}
              type="number"
              min="0"
              value={stakeInput}
              disabled={busy}
              onChange={(e) => setStakeInput(e.target.value)}
            />
            <span style={{ color: "var(--muted)" }}>RUSH</span>
          </div>
        </label>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "0.5rem",
          }}
        >
          <span
            data-testid="bet-bounds"
            className="mono"
            style={{ fontSize: "0.8rem", color: "var(--muted)" }}
          >
            {minBet !== undefined && maxBet !== undefined ? betBoundsLabel(minBet, maxBet) : "…"}
          </span>
          {potentialWin !== null && !belowMin && !aboveMax && (
            <span data-testid="potential-win" className="mono" style={{ fontSize: "0.85rem" }}>
              wins{" "}
              <strong style={{ color: "var(--cool)" }}>{formatAmount(potentialWin)} RUSH</strong> at{" "}
              {multiplierLabel(tier)}
            </span>
          )}
        </div>

        <button
          data-testid="place-bet"
          style={primaryButton(busy || !stake || block !== null || wrongNetwork)}
          disabled={busy || !stake || block !== null || wrongNetwork}
          onClick={placeBet}
        >
          {wrongNetwork
            ? "Switch network to play"
            : busy
              ? statusLabel(status, approvalBets)
              : `Place bet · ${stake ? formatUnits(stake, 18) : "…"} RUSH`}
        </button>

        {block && (
          <p
            data-testid="bet-invalid"
            style={{ color: "var(--hot)", margin: 0, fontSize: "0.85rem" }}
          >
            {betBlockMessage(block, balance)}
          </p>
        )}
        {failure && (
          <p
            data-testid="error"
            data-tone={failure.tone}
            style={{
              color: failure.tone === "error" ? "var(--hot)" : "var(--muted)",
              margin: 0,
              fontSize: "0.85rem",
            }}
          >
            {failure.message}
          </p>
        )}

        <BuyRush lowBalance={lowBalance} />
      </section>

      <FairnessPanel bet={history[0]} standingCommit={standingCommit} />

      <BetHistory history={history} />
    </div>
  );
}

/**
 * The bet this receipt created, read from its own `BetPlaced` log.
 *
 * The logs of one transaction are the only place the id is unambiguous. Other logs can
 * share the block, so the topic is matched rather than the position taken on trust.
 */
function betPlacedFrom(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  placedAt: number,
): { betId: bigint; placedAt: number } | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== GAME_ADDRESS.toLowerCase()) continue;
    try {
      const event = decodeEventLog({
        abi: GAME_ABI,
        topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
        data: log.data as `0x${string}`,
      });
      if (event.eventName === "BetPlaced") {
        return { betId: (event.args as { betId: bigint }).betId, placedAt };
      }
    } catch {
      // Not one of ours; the receipt carries the token's Transfer logs too.
    }
  }
  return null;
}

/** The chain's own clock at the block a bet landed in. */
async function blockTimestamp(blockNumber: bigint): Promise<number> {
  const block = await getBlock(wagmiConfig, { blockNumber });
  return Number(block.timestamp);
}

function statusLabel(status: Status, approvalBets: number): string {
  // Name the budget, so the number in the wallet prompt is one the player was told to
  // expect rather than one they have to work out from the hex.
  if (status === "approving") {
    return approvalBets > 1 ? `Approving a budget for ${approvalBets} bets…` : "Approving RUSH…";
  }
  if (status === "placing") return "Placing bet…";
  return "Drawing…";
}

const topBar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
};

const field: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
};

const input: CSSProperties = {
  padding: "0.55rem 0.7rem",
  fontSize: "1.1rem",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line)",
  background: "var(--ink-2)",
  color: "var(--text)",
  width: "10rem",
};
