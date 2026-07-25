import type { CSSProperties } from "react";
import { label, panel } from "../lib/ui";

/**
 * The plain-language fairness disclosure: how the game proves a roll wasn't rigged,
 * and — just as important — what you are still trusting after that proof.
 *
 * The residual list is deliberately unflattering. A fairness page that only lists
 * guarantees is marketing; the useful part for a skeptic is the part that admits
 * where the guarantees stop.
 */
export function FairnessDisclosure({ compact = false }: { compact?: boolean }) {
  return (
    <section
      data-testid="fairness-disclosure"
      style={{ display: "flex", flexDirection: "column", gap: "1rem" }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <span style={label}>How a roll is decided</span>
        <p style={prose}>
          Before you bet, the house has already locked in its next secret number and
          published its fingerprint on-chain — a <strong>commitment</strong>. It cannot
          change the secret afterwards, because any other value would have a different
          fingerprint. When you place your bet, your browser adds{" "}
          <strong>your own random number</strong>, which the house has never seen. At
          settlement the house publishes its secret, the contract checks it against the
          commitment it made earlier, and the result comes out of both numbers together:
        </p>
        <pre data-testid="fairness-formula" style={formula} className="mono">
          {"roll = keccak256(serverReveal, yourEntropy, betId) mod N\nyou win when roll is 0 — a 1-in-N shot"}
        </pre>
        <p style={prose}>
          Neither side can steer it. The house&apos;s number was fixed before your bet
          existed; your number was fixed before the house&apos;s was public. And because
          every input is published, anyone can re-run the arithmetic — that&apos;s what
          the verifier does.
        </p>
      </div>

      {!compact && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <span style={label}>What you are still trusting</span>
          <p style={prose}>
            Provably fair means the <em>result</em> can&apos;t be faked. It does not mean
            there is nothing left to trust. Here is the whole residual, plainly:
          </p>
          <ul data-testid="fairness-residual" style={list}>
            <li style={item}>
              <strong>The house runs the secret chain.</strong> It generates and holds the
              sequence of secrets, and publishes their fingerprints. That makes cheating{" "}
              <em>detectable</em> — this is the industry-standard provably-fair model. It
              is <em>not</em> the zero-trust guarantee of an on-chain VRF, where no one
              holds the secret at all. Swapping in a VRF is a planned upgrade; no provider
              is live on this chain yet.
            </li>
            <li style={item}>
              <strong>The house knows your result before you do.</strong> The moment your
              bet lands, your entropy is public and the house already holds its reveal —
              so it can compute the outcome before it settles. It cannot change that
              outcome. But it does mean a dishonest house could stall specifically on
              winning bets and let them time out into a refund: you&apos;d get your stake
              back, not your winnings. A settled-vs-refunded record is public, so this is
              detectable, and it is the sharpest reason to check that your wins actually
              settle.
            </li>
            <li style={item}>
              <strong>The house picks when to settle, not what.</strong> A stalled relayer
              can&apos;t change your roll, but it can leave your bet hanging. That&apos;s
              why the contract lets you take your stake back yourself after an hour — no
              permission needed.
            </li>
            <li style={item}>
              <strong>Your randomness is only as good as your browser.</strong> Your
              number comes from your own device&apos;s cryptographic generator. On a
              compromised machine, that protection is gone.
            </li>
            <li style={item}>
              <strong>Record the commitment before you bet.</strong> The panel shows it
              and every bet stores its own on-chain, so this is belt-and-braces — but the
              proof is strongest when you kept your own copy.
            </li>
            <li style={item}>
              <strong>A stalled settlement can leak a secret.</strong> If the house
              broadcasts a reveal that never confirms and the bet is refunded, that value
              is public while the commitment it belongs to is still standing — a watcher
              could predict the <em>next</em> bet. The house rotates to a fresh chain
              after any downtime, and an emergency pause can halt new bets, but this is a
              real edge and we&apos;d rather name it.
            </li>
            <li style={item}>
              <strong>The house edge is real.</strong> Every tier pays 0.95 × N, a flat 5%
              edge. Verifiable is not the same as profitable — over time, the house wins.
            </li>
            <li style={item}>
              <strong>The contracts are not yet audited.</strong> A security audit is a
              gate before any real-value launch, not something already behind us.
            </li>
          </ul>
        </div>
      )}
    </section>
  );
}

const prose: CSSProperties = {
  margin: 0,
  color: "var(--muted)",
  fontSize: "0.92rem",
  lineHeight: 1.6,
};

const formula: CSSProperties = {
  ...panel,
  margin: 0,
  fontSize: "0.82rem",
  lineHeight: 1.7,
  overflowX: "auto",
  color: "var(--text)",
  background: "var(--panel-2)",
};

const list: CSSProperties = {
  margin: 0,
  paddingLeft: "1.1rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.55rem",
};

const item: CSSProperties = {
  color: "var(--muted)",
  fontSize: "0.9rem",
  lineHeight: 1.6,
};
