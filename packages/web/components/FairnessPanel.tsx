"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { verifyRoll } from "@rushood/verifier";
import { shortHex, verifyHref, verifyInputsFor } from "../lib/fairness";
import type { BetEntry } from "../lib/useBetHistory";
import { chip, ghostButton, hexValue, hint, label, linkButton, panel } from "../lib/ui";
import { FairnessDisclosure } from "./FairnessDisclosure";

/**
 * The in-app fairness panel: the house's commitment, the player's own entropy, and a
 * one-click link into the public `/verify` tool.
 *
 * It also re-runs the check locally and shows the verdict inline — the app doing its
 * homework in front of you. That is a convenience, not the proof: the proof is the
 * link, which carries every input so it can be re-checked anywhere, by anyone,
 * including from the command line.
 */
export function FairnessPanel({
  bet,
  standingCommit,
}: {
  /** The most recent bet, if there is one. */
  bet?: BetEntry;
  /** Head of the server hash chain — what the *next* bet will be locked against. */
  standingCommit?: `0x${string}`;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const inputs = bet ? verifyInputsFor(bet) : null;
  const verdict = inputs ? verifyRoll(inputs) : null;

  return (
    <section
      data-testid="fairness-panel"
      style={{ ...panel, display: "flex", flexDirection: "column", gap: "0.9rem" }}
    >
      <div style={header}>
        <span style={label}>Provably fair</span>
        {verdict && (
          <span
            data-testid="fairness-verdict"
            className="mono"
            style={{
              ...chip,
              color: verdict.ok ? "var(--win)" : "var(--hot)",
              borderColor: verdict.ok ? "var(--win)" : "var(--hot)",
            }}
          >
            {verdict.ok ? "verified ✓" : `mismatch: ${verdict.failures.join(", ")}`}
          </span>
        )}
      </div>

      {bet?.commit !== undefined && bet.clientSeed !== undefined ? (
        <>
          <Row
            title="The house committed first"
            hint="Published before your bet — it can't change its secret now."
            value={bet.commit}
            testId="fairness-commitment"
          />
          <Row
            title="You added your own entropy"
            hint="256 bits generated in your browser at bet time. The house never saw it in advance."
            value={`0x${bet.clientSeed.toString(16)}`}
            testId="fairness-entropy"
          />
          {bet.reveal ? (
            <Row
              title="The house revealed its secret"
              hint="Hashes to the commitment above — the contract rejects anything else."
              value={bet.reveal}
              testId="fairness-reveal"
            />
          ) : (
            <p data-testid="fairness-pending" style={hint}>
              Waiting on the reveal. Once this bet settles you can verify it — and if the
              house never settles, you can take your stake back after an hour.
            </p>
          )}
          {verdict && (
            <p data-testid="fairness-roll" className="mono" style={hint}>
              roll {verdict.computed.roll.toString()} of {verdict.computed.odds.toString()} —{" "}
              {verdict.computed.win ? "a win (roll 0)" : "a miss (a win is roll 0)"}
            </p>
          )}
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {inputs && (
              <a
                data-testid="verify-link"
                style={linkButton}
                href={verifyHref(inputs)}
                target="_blank"
                rel="noreferrer"
              >
                Verify this roll yourself →
              </a>
            )}
            <button style={ghostButton} onClick={() => setShowDetail((open) => !open)}>
              {showDetail ? "Hide" : "How does this work?"}
            </button>
          </div>
        </>
      ) : (
        <>
          {standingCommit && (
            <Row
              title="The house's standing commitment"
              hint="Your next bet locks against this. Copy it now if you want your own record."
              value={standingCommit}
              testId="fairness-standing-commit"
            />
          )}
          <p data-testid="fairness-empty" style={hint}>
            Place a bet and its full fairness record shows up here — the commitment, your
            entropy, and a link to check the result independently.
          </p>
        </>
      )}

      {showDetail && <FairnessDisclosure compact />}
    </section>
  );
}

function Row({
  title,
  hint: hintCopy,
  value,
  testId,
}: {
  title: string;
  hint: ReactNode;
  value: string;
  testId: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
      <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>{title}</span>
      <code data-testid={testId} title={value} style={hexValue} className="mono">
        {shortHex(value)}
      </code>
      <span style={hint}>{hintCopy}</span>
    </div>
  );
}

const header: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  flexWrap: "wrap",
};
