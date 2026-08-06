"use client";

import type { CSSProperties } from "react";
import { formatAmount } from "../lib/amount";
import { multiplierLabel, TIERS } from "../lib/contracts";
import { verifyHref, verifyInputsFor } from "../lib/fairness";
import type { BetEntry } from "../lib/useBetHistory";
import { label } from "../lib/ui";

/** The player's past plays, newest first, with outcome and payout. */
export function BetHistory({ history }: { history: BetEntry[] }) {
  return (
    <section
      data-testid="history"
      style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}
    >
      <span style={label}>Your plays</span>
      {history.length === 0 ? (
        <p
          data-testid="history-empty"
          style={{ color: "var(--muted)", margin: 0, fontSize: "0.9rem" }}
        >
          No plays yet. Pick a rung and take your shot.
        </p>
      ) : (
        <ul style={list}>
          {history.map((bet) => (
            <li key={bet.betId.toString()} data-testid={`history-${bet.betId}`} style={row}>
              <span style={{ display: "flex", flexDirection: "column", gap: "0.1rem" }}>
                <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                  {TIERS[bet.tier]?.label ?? `Tier ${bet.tier}`}
                  <span className="mono" style={{ color: "var(--muted)", marginLeft: "0.5rem" }}>
                    {multiplierLabel(bet.tier)}
                  </span>
                </span>
                <span className="mono" style={{ color: "var(--muted)", fontSize: "0.78rem" }}>
                  {formatAmount(bet.stake)} RUSH
                </span>
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                <Verify bet={bet} />
                <Outcome bet={bet} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Per-row escape hatch into the public verifier - every past roll is checkable, not
 *  just the latest one shown in the fairness panel. */
function Verify({ bet }: { bet: BetEntry }) {
  const inputs = verifyInputsFor(bet);
  if (!inputs) return null;
  return (
    <a
      data-testid={`verify-${bet.betId}`}
      href={verifyHref(inputs)}
      target="_blank"
      rel="noreferrer"
      style={verifyLink}
    >
      verify
    </a>
  );
}

function Outcome({ bet }: { bet: BetEntry }) {
  if (bet.outcome === "pending") {
    return (
      <span
        className="mono"
        style={{ ...badge, color: "var(--muted)", borderColor: "var(--line)" }}
      >
        pending
      </span>
    );
  }
  if (bet.outcome === "refunded") {
    // Neither a win nor a loss: no draw happened, and the stake came back.
    return (
      <span
        className="mono"
        style={{ ...badge, color: "var(--muted)", borderColor: "var(--line)" }}
      >
        refunded {formatAmount(bet.payout)}
      </span>
    );
  }
  if (bet.outcome === "won") {
    return (
      <span className="mono" style={{ ...badge, color: "var(--win)", borderColor: "var(--win)" }}>
        won +{formatAmount(bet.payout)}
      </span>
    );
  }
  return (
    <span className="mono" style={{ ...badge, color: "var(--loss)", borderColor: "var(--line)" }}>
      lost
    </span>
  );
}

const list: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
};

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0.6rem 0.85rem",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-soft)",
  background: "var(--panel)",
};

const verifyLink: CSSProperties = {
  fontSize: "0.78rem",
  color: "var(--muted)",
  textDecoration: "underline",
  textUnderlineOffset: "3px",
};

const badge: CSSProperties = {
  fontSize: "0.8rem",
  fontWeight: 700,
  padding: "0.25rem 0.55rem",
  borderRadius: "999px",
  border: "1px solid",
  whiteSpace: "nowrap",
};
