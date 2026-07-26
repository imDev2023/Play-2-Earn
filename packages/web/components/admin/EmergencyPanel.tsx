"use client";

import type { CSSProperties } from "react";
import { hint, label, panel, statusBadge, tonedButton } from "../../lib/ui";

/**
 * The emergency pause.
 *
 * Deliberately not behind the timelock: the guardian (the Safe) can act immediately,
 * because a delay on the stop button defeats the point of having one. The copy states
 * exactly what a pause does and does not stop, since an operator reaching for it is
 * usually deciding whether it is enough.
 */

export interface EmergencyPanelProps {
  paused?: boolean;
  canPause: boolean;
  busy: boolean;
  onToggle: (next: boolean) => void;
}

export function EmergencyPanel({ paused, canPause, busy, onToggle }: EmergencyPanelProps) {
  const known = paused !== undefined;
  return (
    <section data-testid="emergency-panel" style={{ ...panel, display: "grid", gap: "0.75rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
        <span style={label}>Emergency</span>
        <span data-testid="pause-state" style={paused ? pausedChip : liveChip}>
          {known ? (paused ? "paused" : "live") : "…"}
        </span>
      </header>

      <button
        data-testid="pause-toggle"
        style={{
          ...tonedButton(paused ? "var(--cool)" : "var(--hot)", !canPause || busy || !known),
          padding: "0.7rem 1rem",
          fontSize: "0.95rem",
          fontWeight: 700,
        }}
        disabled={!canPause || busy || !known}
        onClick={() => onToggle(!paused)}
      >
        {busy ? "Confirming…" : paused ? "Resume the game" : "Pause the game"}
      </button>

      <p style={hint}>
        Pausing halts <strong>new bets only</strong>. Settlement and refunds keep working, so a bet
        already in flight always resolves and no player&apos;s stake is ever stranded by a pause.
      </p>
      {!canPause && (
        <p data-testid="pause-denied" style={{ ...hint, color: "var(--hot)" }}>
          Only the guardian can pause. Connect the guardian account to use this.
        </p>
      )}
    </section>
  );
}

const liveChip: CSSProperties = {
  ...statusBadge,
  color: "var(--cool)",
  borderColor: "var(--cool)",
};
const pausedChip: CSSProperties = { ...statusBadge, color: "var(--hot)", borderColor: "var(--hot)" };
