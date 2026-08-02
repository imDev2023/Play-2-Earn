"use client";

import { useState, type CSSProperties } from "react";
import { formatUnits, parseUnits } from "viem";
import {
  useAccount,
  useDisconnect,
  useReadContract,
  useWatchContractEvent,
  useWriteContract,
} from "wagmi";
import { readContract, waitForTransactionReceipt } from "wagmi/actions";
import { wagmiConfig } from "../lib/wagmi";
import { isWrongNetwork } from "../lib/chain";
import {
  EDGE_DEN,
  EDGE_NUM,
  GAME_ABI,
  GAME_ADDRESS,
  multiplierLabel,
  RUSH_ABI,
  RUSH_ADDRESS,
  TIERS,
} from "../lib/contracts";
import { useBetHistory } from "../lib/useBetHistory";
import { betBlock, betBlockMessage } from "../lib/bet-validity";
import { approvalAmount, betsCovered } from "../lib/approval";
import { connectLabel } from "../lib/connectors";
import { useWalletConnector } from "../lib/useWalletConnector";
import { readableError } from "../lib/errors";
import { chip, label, panel, primaryButton, ghostButton } from "../lib/ui";
import { OddsLadder } from "../components/OddsLadder";
import { NetworkOnboarding } from "../components/NetworkOnboarding";
import { BuyRush } from "../components/BuyRush";
import { Reveal, type RevealPhase } from "../components/Reveal";
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
  // `chainId` here is the connection's own chain. `useChainId` reports the config's
  // selected chain instead, which wagmi refuses to move to a chain it was not
  // configured with - so it answered ACTIVE_CHAIN_ID however far away the wallet
  // really was, and `wrongNetwork` below was unreachable. See NetworkOnboarding.
  const { address, isConnected, chainId } = useAccount();
  // One button, whichever wallet the player has. See lib/connectors.
  const { wallet, ready: walletReady, connectWallet } = useWalletConnector();
  const { disconnect } = useDisconnect();
  const { writeContractAsync: writeAsync } = useWriteContract();

  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tier, setTier] = useState(0);
  // The tier of the bet currently settling - captured at placement so the reveal
  // describes the settled bet, not whatever the ladder is showing now.
  const [betTier, setBetTier] = useState(0);
  const [stakeInput, setStakeInput] = useState("100");
  // How many bets the approval now in flight covers, so the status line can say what
  // the player is being asked to approve rather than leave them to read the hex.
  const [approvalBets, setApprovalBets] = useState(0);

  const wrongNetwork = isConnected && isWrongNetwork(chainId);

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
  useWatchContractEvent({
    address: GAME_ADDRESS,
    abi: GAME_ABI,
    eventName: "BetSettled",
    enabled: isConnected,
    onLogs: (logs) => {
      for (const log of logs) {
        const { player, win, payout } = log.args as {
          player?: string;
          win?: boolean;
          payout?: bigint;
        };
        if (player?.toLowerCase() === address?.toLowerCase() && win !== undefined) {
          setResult({ win, payout: payout ?? 0n });
          setStatus("idle");
          void refetchBalance();
          // Settling advanced the chain head; the panel should show the new one.
          void refetchCommit();
        }
      }
    },
  });

  async function placeBet() {
    if (!stake || block !== null || wrongNetwork) return;
    setError(null);
    setResult(null);
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
      await waitForTransactionReceipt(wagmiConfig, { hash: betHash });

      setStatus("waiting"); // relayer settles; BetSettled resets to idle.
    } catch (err) {
      setError(readableError(err));
      setStatus("error");
    }
  }

  const busy = status === "approving" || status === "placing" || status === "waiting";
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
            {!walletReady || wallet ? (
              <button
                data-testid="connect-wallet"
                style={ghostButton}
                disabled={!walletReady}
                onClick={connectWallet}
              >
                {walletReady ? connectLabel(wallet) : "Connect wallet"}
              </button>
            ) : (
              <a
                data-testid="install-wallet"
                href="https://ethereum.org/en/wallets/find-wallet/"
                target="_blank"
                rel="noreferrer"
                style={ghostButton}
              >
                Get an EVM wallet →
              </a>
            )}
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

        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
          <span data-testid="bet-bounds" className="mono" style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
            {minBet !== undefined && maxBet !== undefined
              ? `min ${formatUnits(minBet, 18)} · max ${formatUnits(maxBet, 18)}`
              : "…"}
          </span>
          {potentialWin !== null && !belowMin && !aboveMax && (
            <span data-testid="potential-win" className="mono" style={{ fontSize: "0.85rem" }}>
              wins{" "}
              <strong style={{ color: "var(--cool)" }}>
                {formatUnits(potentialWin, 18)} RUSH
              </strong>{" "}
              at {multiplierLabel(tier)}
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
          <p data-testid="bet-invalid" style={{ color: "var(--hot)", margin: 0, fontSize: "0.85rem" }}>
            {betBlockMessage(block, balance)}
          </p>
        )}
        {error && (
          <p data-testid="error" style={{ color: "var(--hot)", margin: 0, fontSize: "0.85rem" }}>
            {error}
          </p>
        )}

        <BuyRush lowBalance={lowBalance} />
      </section>

      <FairnessPanel bet={history[0]} standingCommit={standingCommit} />

      <BetHistory history={history} />
    </div>
  );
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
