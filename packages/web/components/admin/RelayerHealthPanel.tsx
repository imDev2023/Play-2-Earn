"use client";

import type { RelayerHealth, RelayerStatus } from "../../lib/admin/health";
import { hint, label, panel, statusBadge } from "../../lib/ui";

/**
 * The relayer health / settlement-lag indicator.
 *
 * Phrased in the terms that matter to the operator rather than the process: a bet that
 * is not being settled is the failure, and the deadline that makes it everyone's
 * problem is the settle timeout, after which the player takes the stake back.
 */

export function RelayerHealthPanel({ health }: { health: RelayerHealth }) {
  const tone = TONES[health.status];
  return (
    <section data-testid="relayer-health" style={{ ...panel, display: "grid", gap: "0.6rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
        <span style={label}>Relayer</span>
        <span data-testid="relayer-status" style={{ ...statusBadge, color: tone, borderColor: tone }}>
          {LABELS[health.status]}
        </span>
      </header>
      <p data-testid="relayer-detail" style={{ margin: 0, fontSize: "0.9rem" }}>
        {health.detail}
      </p>
      <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
        <Figure name="Pending" value={`${health.pendingSeconds}s`} />
        <Figure
          name="Refundable in"
          value={health.status === "idle" ? "-" : `${health.refundableIn}s`}
        />
        <Figure
          name="Last settlement lag"
          value={health.lastSettleLag !== undefined ? `${health.lastSettleLag}s` : "-"}
        />
      </div>
      <p style={hint}>
        Measured on-chain, from the active bet&apos;s age against <code>SETTLE_TIMEOUT</code> - so
        this reports whether bets are actually being settled, not whether a process is running.
      </p>
    </section>
  );
}

function Figure({ name, value }: { name: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
      <span style={label}>{name}</span>
      <span className="mono" style={{ fontSize: "0.95rem" }}>
        {value}
      </span>
    </div>
  );
}

const LABELS: Record<RelayerStatus, string> = {
  idle: "idle",
  settling: "settling",
  lagging: "lagging",
  stalled: "stalled",
  unknown: "unknown",
};

const TONES: Record<RelayerStatus, string> = {
  idle: "var(--muted)",
  settling: "var(--cool)",
  lagging: "var(--moon)",
  stalled: "var(--hot)",
  unknown: "var(--muted)",
};

