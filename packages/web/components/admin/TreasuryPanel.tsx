"use client";

import type { CSSProperties, ReactNode } from "react";
import type { Address } from "viem";
import { edgePercentLabel, formatRush, percentLabel } from "../../lib/admin/format";
import { ghostButton, hint, label, panel, statusBadge } from "../../lib/ui";

/**
 * The bankroll and the rules it is governed by, side by side.
 *
 * These are the numbers an operator has to trust before touching anything else, so
 * every one is read from the contract that enforces it — and anything that has not
 * loaded shows as "…" rather than as a plausible zero.
 */

export interface TreasuryPanelProps {
  treasury?: Address;
  balance?: bigint;
  floor?: bigint;
  maxPayout?: bigint;
  minBet?: bigint;
  burnRateBps?: bigint;
  edgeNum?: bigint;
  edgeDen?: bigint;
  solvencyCapDen?: bigint;
  economicsGovernable?: boolean;
  /** Jump to the profit-burn with the burnable amount filled in. */
  onBurnProfit?: (amount: string) => void;
}

export function TreasuryPanel(props: TreasuryPanelProps) {
  const { balance, floor, maxPayout, minBet, burnRateBps, edgeNum, edgeDen } = props;

  const headroom =
    balance !== undefined && floor !== undefined ? (balance > floor ? balance - floor : 0n) : undefined;
  const belowFloor = balance !== undefined && floor !== undefined && balance < floor;

  return (
    <section data-testid="treasury-panel" style={{ ...panel, display: "grid", gap: "1rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
        <span style={label}>Treasury</span>
        {props.treasury && (
          <code style={{ fontSize: "0.75rem", color: "var(--muted)" }}>{props.treasury}</code>
        )}
      </header>

      <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", flexWrap: "wrap" }}>
        <strong data-testid="treasury-balance" className="mono" style={balanceStyle}>
          {balance !== undefined ? `${formatRush(balance)} RUSH` : "…"}
        </strong>
        {belowFloor && (
          <span data-testid="below-floor" style={warn}>
            below floor — the game rejects new bets
          </span>
        )}
      </div>

      <div style={grid}>
        <Stat name="Floor" value={floor !== undefined ? `${formatRush(floor)} RUSH` : "…"}>
          The solvency reserve. New bets stop below it, and it can never be burned away.
        </Stat>
        <Stat
          name="Profit above floor"
          value={headroom !== undefined ? `${formatRush(headroom)} RUSH` : "…"}
        >
          Discretionary — this is what the profit-burn may destroy.
        </Stat>
        <Stat name="Max payout" value={maxPayout !== undefined ? `${formatRush(maxPayout)} RUSH` : "…"}>
          The most any single win can cost:{" "}
          {props.solvencyCapDen !== undefined ? `1/${props.solvencyCapDen}` : "…"} of the balance.
        </Stat>
        <Stat name="Minimum bet" value={minBet !== undefined ? `${formatRush(minBet)} RUSH` : "…"} />
        <Stat
          name="House edge"
          value={
            edgeNum !== undefined && edgeDen !== undefined
              ? `${edgePercentLabel(edgeNum, edgeDen)} (${edgeNum}/${edgeDen})`
              : "…"
          }
        />
        <Stat
          name="Per-play burn"
          value={burnRateBps !== undefined ? `${percentLabel(burnRateBps)} (${burnRateBps} bps)` : "…"}
        />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <span data-testid="economics-lock" style={props.economicsGovernable ? unlockedChip : lockedChip}>
          {props.economicsGovernable === undefined
            ? "economics: …"
            : props.economicsGovernable
              ? "economics unlocked"
              : "economics locked"}
        </span>
        {props.onBurnProfit && (
          <button
            data-testid="burn-profit"
            style={ghostButton}
            disabled={!headroom}
            onClick={() => props.onBurnProfit?.(headroom ? formatRush(headroom) : "")}
          >
            Burn profit…
          </button>
        )}
      </div>
      <p style={hint}>
        The economics lock is the #22 opt-in: while it is off, the edge, cap, minimum bet and
        floor are immutable — a queued change to any of them reverts on execution.
      </p>
    </section>
  );
}

function Stat({ name, value, children }: { name: string; value: string; children?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
      <span style={label}>{name}</span>
      <span className="mono" style={{ fontSize: "0.95rem" }}>
        {value}
      </span>
      {children && <span style={{ ...hint, fontSize: "0.74rem" }}>{children}</span>}
    </div>
  );
}

const balanceStyle: CSSProperties = {
  fontSize: "1.7rem",
  fontWeight: 800,
  color: "var(--cool)",
};

const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: "0.9rem 1.2rem",
};

const warn: CSSProperties = {
  fontSize: "0.8rem",
  color: "var(--hot)",
  fontWeight: 600,
};

const lockedChip: CSSProperties = { ...statusBadge, background: "var(--panel-2)" };
const unlockedChip: CSSProperties = {
  ...statusBadge,
  color: "var(--moon)",
  borderColor: "var(--moon)",
};
