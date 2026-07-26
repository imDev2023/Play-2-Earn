import type { CSSProperties } from "react";
import Link from "next/link";
import { AdminConsole } from "./AdminConsole";

export const metadata = {
  title: "Treasury & operations · RUSHOOD",
  description:
    "Multisig-gated console for the RUSHOOD treasury: parameters queued through the timelock, the profit-burn, the emergency pause, and relayer health.",
};

export default function AdminPage() {
  return (
    <main style={main}>
      <header style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
        <Link href="/" style={back}>
          ← back to the game
        </Link>
        <h1 style={heading}>Treasury &amp; operations</h1>
        <p style={lede}>
          The operator&apos;s view of the house: what the treasury holds, the parameters it plays
          by, and whether bets are being settled. Policy changes queue through the governance
          timelock, so players see them coming; the emergency pause does not, so it can actually
          stop things.
        </p>
      </header>

      <AdminConsole />
    </main>
  );
}

const main: CSSProperties = {
  maxWidth: 760,
  margin: "0 auto",
  padding: "3rem 1.25rem 4rem",
  display: "flex",
  flexDirection: "column",
  gap: "1.75rem",
};

const back: CSSProperties = {
  color: "var(--muted)",
  fontSize: "0.85rem",
  textDecoration: "none",
};

const heading: CSSProperties = {
  margin: 0,
  fontSize: "2rem",
  fontWeight: 800,
  letterSpacing: "0.01em",
};

const lede: CSSProperties = {
  margin: 0,
  color: "var(--muted)",
  fontSize: "0.95rem",
  lineHeight: 1.6,
};
