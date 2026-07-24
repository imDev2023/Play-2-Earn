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
