import type { CSSProperties } from "react";
import { PlayPanel } from "./PlayPanel";

export default function Home() {
  return (
    <main style={main}>
      <header style={header}>
        <h1 className="mono" style={wordmark}>
          RUSHOOD
        </h1>
        <p data-testid="tagline" style={tagline}>
          Pick your odds.{" "}
          <span style={{ color: "var(--muted)" }}>Instant, provably-fair draws — up to</span>{" "}
          <span className="mono" style={{ color: "var(--moon)", fontWeight: 800 }}>
            950×
          </span>
          .
        </p>
      </header>
      <PlayPanel />
      <footer style={footer}>
        Flat 5% house edge · solvent by construction · every roll verified on-chain.
      </footer>
    </main>
  );
}

const main: CSSProperties = {
  maxWidth: 560,
  margin: "0 auto",
  padding: "3.5rem 1.25rem 4rem",
  display: "flex",
  flexDirection: "column",
  gap: "1.75rem",
};

const header: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
};

const wordmark: CSSProperties = {
  margin: 0,
  fontSize: "2.6rem",
  fontWeight: 800,
  letterSpacing: "0.02em",
  background: "linear-gradient(90deg, var(--cool), var(--moon) 85%)",
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
};

const tagline: CSSProperties = {
  margin: 0,
  fontSize: "1.05rem",
  color: "var(--text)",
};

const footer: CSSProperties = {
  color: "var(--muted)",
  fontSize: "0.8rem",
  textAlign: "center",
  borderTop: "1px solid var(--line-soft)",
  paddingTop: "1.25rem",
};
