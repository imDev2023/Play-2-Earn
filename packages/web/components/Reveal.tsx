"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { formatUnits } from "viem";
import { lossExplanation, multiplierLabel, TIERS } from "../lib/contracts";

export type RevealPhase = "idle" | "drawing" | "won" | "lost";

/**
 * The settlement reveal - RUSHOOD's one orchestrated moment. While the relayer
 * settles, the draw flickers through numbers; on settle it snaps to a win burst
 * or a quiet miss. Moonshot wins get their own callout.
 */
export function Reveal({
  phase,
  tier,
  payout,
  roll,
}: {
  phase: RevealPhase;
  tier: number;
  payout: bigint;
  /**
   * The roll the chain reported in `BetSettled`. Undefined only if a settlement ever
   * reaches this screen without one, in which case the panel falls back to the dash
   * rather than inventing a number.
   */
  roll?: bigint;
}) {
  const scramble = useScramble(phase === "drawing");
  if (phase === "idle") return null;

  const isMoonshot = tier === TIERS.length - 1;

  if (phase === "drawing") {
    return (
      <div data-testid="reveal" data-phase="drawing" style={card("var(--line)")}>
        <span style={eyebrow}>Drawing your number</span>
        <span className="mono draw-flicker" style={bigNumber("var(--cool)")}>
          {scramble}
        </span>
        <span style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
          Verifying the reveal on-chain…
        </span>
      </div>
    );
  }

  if (phase === "won") {
    return (
      <div
        data-testid="reveal"
        data-phase="won"
        className="win-burst"
        style={card("var(--win)", "rgba(61, 255, 158, 0.1)")}
      >
        <span style={{ ...eyebrow, color: "var(--win)" }}>
          {isMoonshot ? "★ Moonshot hit" : `Winner · ${multiplierLabel(tier)}`}
        </span>
        <span data-testid="reveal-figure" className="mono" style={bigNumber("var(--win)")}>
          +{formatUnits(payout, 18)}
        </span>
        <span style={{ color: "var(--muted)", fontSize: "0.9rem" }}>RUSH paid to your wallet</span>
      </div>
    );
  }

  const missReason = lossExplanation(tier);

  return (
    <div data-testid="reveal" data-phase="lost" style={card("var(--line)")}>
      <span style={eyebrow}>No luck this round</span>
      <span
        data-testid="reveal-figure"
        className="mono"
        style={{ ...bigNumber("var(--loss)"), opacity: 0.8 }}
      >
        {roll === undefined ? "-" : roll.toString()}
      </span>
      {/*
        Its own line, under the number it explains, rather than run together with the
        copy below: the two say different things, and at 0.9rem in a centred card a
        single run wraps wherever the box happens to break.
      */}
      {missReason !== null && (
        <span
          data-testid="reveal-miss-reason"
          style={{ color: "var(--muted)", fontSize: "0.9rem" }}
        >
          {missReason}
        </span>
      )}
      <span style={{ color: "var(--muted)", fontSize: "0.9rem" }}>
        The stake stays with the house. Run it back?
      </span>
    </div>
  );
}

/** Cycles a random 4-digit draw while active; freezes otherwise. */
function useScramble(active: boolean): string {
  const [value, setValue] = useState("0000");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!active) {
      if (timer.current) clearInterval(timer.current);
      return;
    }
    timer.current = setInterval(() => {
      setValue(String(Math.floor(Math.random() * 10000)).padStart(4, "0"));
    }, 70);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [active]);
  return value;
}

function card(border: string, bg = "var(--panel-2)"): CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.3rem",
    padding: "1.4rem 1.2rem",
    borderRadius: "var(--radius)",
    border: `1px solid ${border}`,
    background: bg,
    textAlign: "center",
  };
}

const eyebrow: CSSProperties = {
  fontSize: "0.72rem",
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  color: "var(--muted)",
};

function bigNumber(color: string): CSSProperties {
  return {
    fontSize: "2.6rem",
    fontWeight: 800,
    lineHeight: 1.05,
    color,
    letterSpacing: "-0.02em",
  };
}
