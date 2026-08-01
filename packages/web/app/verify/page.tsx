import { Suspense, type CSSProperties } from "react";
import Link from "next/link";
import { FairnessDisclosure } from "../../components/FairnessDisclosure";
import { VerifyTool } from "./VerifyTool";

export const metadata = {
  title: "Verify a roll · RUSHOOD",
  description:
    "Recompute any RUSHOOD roll from its public inputs and check it against the house's commitment.",
};

export default function VerifyPage() {
  return (
    <main style={main}>
      <header style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
        <Link href="/" style={back}>
          ← back to the game
        </Link>
        <h1 style={heading}>Verify a roll</h1>
        <p style={lede}>
          Paste a bet&apos;s public inputs and this page re-runs the draw. The check itself
          is arithmetic in your browser - no result is taken on our word. The one button
          that touches the network is the optional{" "}
          <em>look the bet up on-chain</em> convenience, which reads the inputs through
          this app&apos;s node so you don&apos;t have to copy them by hand.
        </p>
      </header>

      <Suspense fallback={<p style={lede}>Loading…</p>}>
        <VerifyTool />
      </Suspense>

      <FairnessDisclosure />

      <section style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <h2 style={subheading}>Don&apos;t trust this page either</h2>
        <p style={lede}>
          This tool is a thin wrapper over an open-source module you can run yourself -
          the same one the contract test suite pins against the on-chain formula. Every
          verify link works on the command line as-is:
        </p>
        <pre style={code} className="mono">
          {'npm run verify --workspace @rushood/verifier -- \\\n  --url "<paste a verify link>"'}
        </pre>
      </section>
    </main>
  );
}

const main: CSSProperties = {
  maxWidth: 680,
  margin: "0 auto",
  padding: "3rem 1.25rem 4rem",
  display: "flex",
  flexDirection: "column",
  gap: "2rem",
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

const subheading: CSSProperties = {
  margin: 0,
  fontSize: "1.05rem",
  fontWeight: 700,
};

const lede: CSSProperties = {
  margin: 0,
  color: "var(--muted)",
  fontSize: "0.95rem",
  lineHeight: 1.6,
};

const code: CSSProperties = {
  margin: 0,
  padding: "0.9rem 1rem",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line)",
  background: "var(--panel-2)",
  fontSize: "0.8rem",
  lineHeight: 1.6,
  overflowX: "auto",
};
