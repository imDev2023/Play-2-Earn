"use client";

import { useState } from "react";
import { formatUnits, maxUint256, parseUnits } from "viem";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useReadContract,
  useWatchContractEvent,
  useWriteContract,
} from "wagmi";
import { readContract, waitForTransactionReceipt } from "wagmi/actions";
import { wagmiConfig } from "../lib/wagmi";
import {
  GAME_ABI,
  GAME_ADDRESS,
  multiplierLabel,
  RUSH_ABI,
  RUSH_ADDRESS,
  TIERS,
} from "../lib/contracts";

type Result = { win: boolean; payout: bigint };
type Status = "idle" | "approving" | "placing" | "waiting" | "error";

function randomSeed(): bigint {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
}

export function PlayPanel() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { writeContractAsync: writeAsync } = useWriteContract();

  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tier, setTier] = useState(0);
  const [stakeInput, setStakeInput] = useState("100");

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

  // Parse the stake input to wei; null when it isn't a valid positive amount.
  let stake: bigint | null = null;
  try {
    const parsed = parseUnits(stakeInput || "0", 18);
    stake = parsed > 0n ? parsed : null;
  } catch {
    stake = null;
  }

  const belowMin = stake !== null && minBet !== undefined && stake < minBet;
  const aboveMax = stake !== null && maxBet !== undefined && stake > maxBet;

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
        }
      }
    },
  });

  async function placeBet() {
    if (!stake || belowMin || aboveMax) return;
    setError(null);
    setResult(null);
    try {
      // Approve only when the standing allowance can't cover this stake.
      const allowance = address
        ? await readContract(wagmiConfig, {
            address: RUSH_ADDRESS,
            abi: RUSH_ABI,
            functionName: "allowance",
            args: [address, GAME_ADDRESS],
          })
        : 0n;
      if (allowance < stake) {
        // Approve once (max) so repeat bets skip the approval step.
        setStatus("approving");
        const approveHash = await writeAsync({
          address: RUSH_ADDRESS,
          abi: RUSH_ABI,
          functionName: "approve",
          args: [GAME_ADDRESS, maxUint256],
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
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  const busy = status === "approving" || status === "placing" || status === "waiting";

  if (!isConnected) {
    return (
      <section style={panel}>
        <p>Connect a wallet to play.</p>
        {connectors.map((connector) => (
          <button
            key={connector.uid}
            data-testid={`connect-${connector.type}`}
            style={button}
            onClick={() => connect({ connector })}
          >
            Connect {connector.name}
          </button>
        ))}
      </section>
    );
  }

  return (
    <section style={panel}>
      <p data-testid="account">
        Connected: <code>{address}</code>
      </p>
      <p data-testid="balance">
        Balance: {balance !== undefined ? `${formatUnits(balance, 18)} RUSH` : "—"}
      </p>

      <label style={field}>
        Odds tier
        <select
          data-testid="tier"
          style={input}
          value={tier}
          disabled={busy}
          onChange={(e) => setTier(Number(e.target.value))}
        >
          {TIERS.map((t, i) => (
            <option key={t.odds} value={i}>
              {t.label} — 1-in-{t.odds} pays {multiplierLabel(t.odds)}
            </option>
          ))}
        </select>
      </label>

      <label style={field}>
        Stake (RUSH)
        <input
          data-testid="stake"
          style={input}
          type="number"
          min="0"
          value={stakeInput}
          disabled={busy}
          onChange={(e) => setStakeInput(e.target.value)}
        />
      </label>
      <p data-testid="bet-bounds" style={{ fontSize: "0.8rem", color: "#666", margin: 0 }}>
        {minBet !== undefined && maxBet !== undefined
          ? `Min ${formatUnits(minBet, 18)} · Max ${formatUnits(maxBet, 18)} RUSH`
          : "…"}
      </p>

      <button
        data-testid="place-bet"
        style={button}
        disabled={busy || !stake || belowMin || aboveMax}
        onClick={placeBet}
      >
        {busy
          ? statusLabel(status)
          : `Place bet (${stake ? formatUnits(stake, 18) : "…"} RUSH)`}
      </button>
      {(belowMin || aboveMax) && (
        <p data-testid="bet-invalid" style={{ color: "crimson", margin: 0 }}>
          {belowMin ? "Stake is below the minimum bet." : "Stake exceeds the max for this tier."}
        </p>
      )}
      {result && (
        <p data-testid="result" style={{ fontWeight: 700 }}>
          {result.win
            ? `You won! Payout ${formatUnits(result.payout, 18)} RUSH 🎉`
            : "You lost this round."}
        </p>
      )}
      {error && (
        <p data-testid="error" style={{ color: "crimson" }}>
          {error}
        </p>
      )}
      <button style={{ ...button, background: "transparent", color: "#555" }} onClick={() => disconnect()}>
        Disconnect
      </button>
    </section>
  );
}

function statusLabel(status: Status): string {
  if (status === "approving") return "Approving RUSH…";
  if (status === "placing") return "Placing bet…";
  return "Waiting for settlement…";
}

const panel: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  alignItems: "flex-start",
  marginTop: "2rem",
};

const field: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  fontSize: "0.9rem",
  color: "#333",
};

const input: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  fontSize: "1rem",
  borderRadius: "0.4rem",
  border: "1px solid #ccc",
  minWidth: "16rem",
};

const button: React.CSSProperties = {
  padding: "0.6rem 1.2rem",
  fontSize: "1rem",
  borderRadius: "0.5rem",
  border: "1px solid #16a34a",
  background: "#16a34a",
  color: "white",
  cursor: "pointer",
};
