"use client";

import type { CSSProperties } from "react";
import { countdownLabel, type SettlementState } from "../lib/settlement";
import { panel, primaryButton } from "../lib/ui";

/**
 * What to say while a draw is taking longer than a draw should.
 *
 * Nothing here fires on a healthy settle: the relayer answers in seconds and the player
 * only ever sees the reveal. It exists for the case where the relayer is down, which is
 * exactly when a real-value game has to be most explicit, and where the app previously
 * showed a flickering number and the words "Verifying the reveal on-chain..." for as
 * long as the player was willing to watch.
 *
 * Three things belong on screen, in this order, because it is the order the questions
 * arrive in: what is being waited on, whether the money is safe, and what the player can
 * do about it. The refund is the answer to all three and it is enforced by the contract,
 * so it is described as a guarantee rather than as an apology.
 */
export function SettlementHelp({
  state,
  refunding,
  onRefund,
  error,
}: {
  state: SettlementState;
  refunding: boolean;
  onRefund: () => void;
  error: string | null;
}) {
  if (state.phase === "drawing") return null;

  const refundable = state.phase === "refundable";

  return (
    <div
      data-testid="settlement-help"
      data-phase={state.phase}
      style={{ ...panel, display: "flex", flexDirection: "column", gap: "0.6rem" }}
    >
      <span style={eyebrow}>
        {refundable ? "Your stake is claimable" : "This is taking longer than usual"}
      </span>

      <p style={body}>
        A relayer settles every bet by publishing the reveal your draw was committed against. Yours
        has not published one yet, which usually means it is briefly offline. Your stake is held by
        the contract, not by us.
      </p>

      {refundable ? (
        <p style={body}>
          The settlement window has passed, so you can take your stake back now. This returns the
          amount you bet - not a win, because no draw ever happened.
        </p>
      ) : (
        <p style={body}>
          If nothing settles it, you can reclaim your stake in{" "}
          <strong data-testid="refund-countdown" style={{ color: "var(--text)" }}>
            {countdownLabel(state.refundableIn)}
          </strong>
          . That deadline is enforced by the contract and cannot be refused or paused.
        </p>
      )}

      <button
        data-testid="refund"
        style={primaryButton(!refundable || refunding)}
        disabled={!refundable || refunding}
        onClick={onRefund}
      >
        {refunding
          ? "Reclaiming…"
          : refundable
            ? "Reclaim my stake"
            : `Reclaim available in ${countdownLabel(state.refundableIn)}`}
      </button>

      {error && (
        <p data-testid="refund-error" style={{ ...body, color: "var(--hot)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

const eyebrow: CSSProperties = {
  fontSize: "0.72rem",
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  color: "var(--muted)",
};

const body: CSSProperties = {
  margin: 0,
  fontSize: "0.85rem",
  lineHeight: 1.5,
  color: "var(--muted)",
};
