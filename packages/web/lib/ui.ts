import type { CSSProperties } from "react";

/**
 * Shared inline-style tokens so every component draws from one visual system.
 * Colors reference the CSS custom properties defined in app/globals.css.
 */

export const panel: CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius)",
  padding: "1.1rem 1.2rem",
};

export const chip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.45rem",
  padding: "0.3rem 0.6rem",
  borderRadius: "999px",
  border: "1px solid var(--line)",
  background: "var(--panel-2)",
  fontSize: "0.8rem",
  color: "var(--muted)",
};

export const label: CSSProperties = {
  fontSize: "0.72rem",
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "var(--muted)",
};

/**
 * A small uppercase status pill - paused/live, a relayer's state, a queued operation's
 * state. Callers supply the tone: `{ ...statusBadge, color: X, borderColor: X }`.
 */
export const statusBadge: CSSProperties = {
  display: "inline-flex",
  padding: "0.25rem 0.6rem",
  borderRadius: "999px",
  border: "1px solid var(--line)",
  fontSize: "0.72rem",
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--muted)",
};

/**
 * A bordered action button that takes its colour from the action: the destructive ones
 * (pause, cancel) read as hot, the constructive ones (resume, execute) as cool.
 */
export function tonedButton(tone: string, disabled = false): CSSProperties {
  return {
    appearance: "none",
    padding: "0.55rem 0.9rem",
    fontSize: "0.9rem",
    fontWeight: 600,
    borderRadius: "var(--radius-sm)",
    border: `1px solid ${disabled ? "var(--line)" : tone}`,
    background: "transparent",
    color: disabled ? "var(--muted)" : tone,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

/** A stacked label-over-control field. */
export const field: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
};

export const textInput: CSSProperties = {
  padding: "0.55rem 0.7rem",
  fontSize: "0.95rem",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line)",
  background: "var(--ink-2)",
  color: "var(--text)",
  width: "100%",
};

/** Secondary explanatory copy sitting under a control or value. */
export const hint: CSSProperties = {
  margin: 0,
  fontSize: "0.79rem",
  color: "var(--muted)",
  lineHeight: 1.55,
};

/** A full hash shown for inspection - wraps rather than overflows. */
export const hexValue: CSSProperties = {
  fontSize: "0.8rem",
  color: "var(--cool)",
  wordBreak: "break-all",
};

export function primaryButton(disabled = false): CSSProperties {
  return {
    appearance: "none",
    padding: "0.85rem 1.25rem",
    fontSize: "1rem",
    fontWeight: 700,
    letterSpacing: "0.02em",
    borderRadius: "var(--radius-sm)",
    border: "none",
    cursor: disabled ? "not-allowed" : "pointer",
    color: disabled ? "var(--muted)" : "#0a0d16",
    background: disabled
      ? "var(--panel-2)"
      : "linear-gradient(180deg, #57f0ff 0%, var(--cool) 100%)",
    boxShadow: disabled ? "none" : "0 8px 24px -12px rgba(56, 232, 255, 0.7)",
    transition: "transform 0.12s ease, box-shadow 0.12s ease, filter 0.12s ease",
  };
}

export const ghostButton: CSSProperties = {
  appearance: "none",
  padding: "0.55rem 0.9rem",
  fontSize: "0.9rem",
  fontWeight: 600,
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line)",
  background: "transparent",
  color: "var(--text)",
  cursor: "pointer",
};

export const linkButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
  padding: "0.55rem 0.9rem",
  fontSize: "0.9rem",
  fontWeight: 600,
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line)",
  background: "var(--panel-2)",
  color: "var(--text)",
  textDecoration: "none",
};

/**
 * Cool→hot accent for a tier by its index (0 = safest). The ladder reads as a
 * temperature gradient: cyan at the base, magenta at the moonshot.
 */
export function tierAccent(index: number, count: number): string {
  const stops = ["#38e8ff", "#4ad2ff", "#8ab0ff", "#c88cff", "#ff7ac0", "#ff3d8b"];
  if (count <= 1) return stops[0];
  const pos = Math.round((index / (count - 1)) * (stops.length - 1));
  return stops[Math.min(pos, stops.length - 1)];
}
