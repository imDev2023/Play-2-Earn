"use client";

import type { CSSProperties } from "react";
import { multiplierLabel, TIERS } from "../lib/contracts";
import { tierAccent } from "../lib/ui";

/**
 * The Odds Ladder — RUSHOOD's signature. Risk ascends visually: the coin flip sits
 * at the base, the 1-in-1000 moonshot is crowned and glowing at the top. Each rung
 * is a selectable bet; the accent runs cool→hot up the ladder.
 */
export function OddsLadder({
  selected,
  onSelect,
  disabled,
}: {
  selected: number;
  onSelect: (tier: number) => void;
  disabled?: boolean;
}) {
  const count = TIERS.length;
  // Render top-down: highest tier (moonshot) first.
  const rungs = TIERS.map((tier, index) => ({ tier, index })).reverse();

  return (
    <div role="radiogroup" aria-label="Odds tier" style={ladder}>
      {rungs.map(({ tier, index }) => {
        const isMoonshot = index === count - 1;
        const isSelected = index === selected;
        const accent = tierAccent(index, count);
        return (
          <button
            key={tier.odds}
            role="radio"
            aria-checked={isSelected}
            data-testid={`rung-${index}`}
            data-selected={isSelected}
            disabled={disabled}
            onClick={() => onSelect(index)}
            className={isMoonshot ? "moon-glow" : undefined}
            style={rung(accent, isSelected, isMoonshot, Boolean(disabled))}
          >
            <span style={rungLeft}>
              {isMoonshot && (
                <span aria-hidden style={{ color: "var(--gold)", fontSize: "1.1rem" }}>
                  ★
                </span>
              )}
              <span style={{ display: "flex", flexDirection: "column", gap: "0.1rem" }}>
                <span style={{ fontWeight: 700, fontSize: isMoonshot ? "1.05rem" : "0.95rem" }}>
                  {tier.label}
                </span>
                <span className="mono" style={{ fontSize: "0.78rem", color: "var(--muted)" }}>
                  1-in-{tier.odds} · {oddsPct(tier.odds)} to win
                </span>
              </span>
            </span>
            <span
              className="mono"
              style={{
                fontSize: isMoonshot ? "1.9rem" : "1.25rem",
                fontWeight: 800,
                color: accent,
                textShadow: isMoonshot ? "0 0 20px rgba(255,61,139,0.55)" : "none",
              }}
            >
              {multiplierLabel(tier.odds)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Win probability as a compact percentage label (1-in-N → 1/N). */
function oddsPct(odds: number): string {
  const pct = 100 / odds;
  return pct >= 1 ? `${pct.toFixed(0)}%` : `${pct.toFixed(1)}%`;
}

const ladder: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
};

function rung(
  accent: string,
  selected: boolean,
  moonshot: boolean,
  disabled: boolean,
): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    width: "100%",
    textAlign: "left",
    padding: moonshot ? "0.95rem 1.1rem" : "0.7rem 1.1rem",
    borderRadius: "var(--radius-sm)",
    cursor: disabled ? "not-allowed" : "pointer",
    color: "var(--text)",
    background: selected
      ? `linear-gradient(90deg, ${hexA(accent, 0.16)}, ${hexA(accent, 0.04)})`
      : "var(--panel-2)",
    border: `1px solid ${selected ? accent : "var(--line)"}`,
    borderLeft: `3px solid ${accent}`,
    opacity: disabled && !selected ? 0.7 : 1,
    transition: "border-color 0.12s ease, background 0.12s ease",
  };
}

const rungLeft: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
};

/** Hex color with an alpha channel, for tinted rung backgrounds. */
function hexA(hex: string, alpha: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
