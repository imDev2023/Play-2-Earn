"use client";

import type { CSSProperties } from "react";
import { GAME_ADDRESS } from "../../lib/contracts";
import { formatDuration, shortAddress } from "../../lib/admin/format";
import type { QueuedOperation } from "../../lib/admin/useTimelockQueue";
import type { OperationStatus } from "../../lib/timelock";
import { hint, label, panel, statusBadge, tonedButton } from "../../lib/ui";

/**
 * The timelock's pending queue.
 *
 * This is the page's real accountability surface: what has been queued, what it will do
 * in plain language, when it becomes executable, and - for anything this console did
 * not build - an honest "unrecognised" rather than a confident-looking mislabel.
 */

export interface QueuePanelProps {
  operations: QueuedOperation[];
  /** Chain time, for the countdowns. */
  now?: bigint;
  /** The queue could not be read at all - not the same as an empty queue. */
  unavailable?: boolean;
  canExecute: boolean;
  canCancel: boolean;
  busyId?: string;
  onExecute: (op: QueuedOperation) => void;
  onCancel: (op: QueuedOperation) => void;
}

export function QueuePanel(props: QueuePanelProps) {
  // Only operations whose state was actually read count as pending. An operation whose
  // status is still unknown is reported as unknown rather than swelling the count.
  const pending = props.operations.filter(
    (op) => op.status === "waiting" || op.status === "ready",
  );

  return (
    <section data-testid="queue-panel" style={{ ...panel, display: "grid", gap: "0.9rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
        <span style={label}>Timelock queue</span>
        <span data-testid="queue-count" style={{ ...hint, fontSize: "0.78rem" }}>
          {props.unavailable ? "unreadable" : `${pending.length} pending`}
        </span>
      </header>

      {props.unavailable ? (
        <p data-testid="queue-unavailable" style={{ ...hint, color: "var(--hot)" }}>
          Could not read the timelock&apos;s queue - the node refused the log query. Treat this as
          unknown, not empty: there may be changes already waiting to execute.
        </p>
      ) : props.operations.length === 0 ? (
        <p data-testid="queue-empty" style={hint}>
          Nothing has been queued on this timelock.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.7rem" }}>
          {props.operations.map((op) => (
            <Operation key={op.id} op={op} {...props} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Operation({
  op,
  now,
  canExecute,
  canCancel,
  busyId,
  onExecute,
  onCancel,
}: QueuePanelProps & { op: QueuedOperation }) {
  const busy = busyId === op.id;
  const open = op.status === "waiting" || op.status === "ready";
  const countdown =
    op.readyAt !== undefined && now !== undefined && op.status === "waiting"
      ? formatDuration(op.readyAt - now)
      : undefined;
  // A call aimed somewhere other than the game is legitimate (the timelock can govern
  // itself) but is not something this console can vouch for.
  const offTarget = op.target.toLowerCase() !== GAME_ADDRESS.toLowerCase();

  return (
    <li data-testid="queue-op" style={row}>
      <div style={{ display: "grid", gap: "0.3rem", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <span
            data-testid="op-status"
            style={{ ...statusBadge, ...STATUS_TONE[op.status ?? "unknown"] }}
          >
            {op.status ?? "…"}
          </span>
          <strong style={{ fontSize: "0.92rem" }}>
            {op.description?.label ?? "Unrecognised call"}
          </strong>
        </div>
        <span style={{ fontSize: "0.85rem", color: "var(--muted)" }}>
          {op.description
            ? op.description.detail
            : `calldata ${op.data.slice(0, 10)}… - not an operation this console builds`}
        </span>
        <span className="mono" style={{ fontSize: "0.72rem", color: "var(--muted)" }}>
          {shortAddress(op.id)} · target {shortAddress(op.target)}
          {offTarget && " (not the game)"}
          {countdown && ` · executable in ${countdown}`}
        </span>
      </div>

      {open && (
        <div style={{ display: "flex", gap: "0.4rem", flexShrink: 0 }}>
          {op.status === "ready" && (
            <button
              data-testid="op-execute"
              style={compact(tonedButton("var(--cool)", !canExecute || busy))}
              disabled={!canExecute || busy}
              onClick={() => onExecute(op)}
            >
              {busy ? "…" : "Execute"}
            </button>
          )}
          <button
            data-testid="op-cancel"
            style={compact(tonedButton("var(--hot)", !canCancel || busy))}
            disabled={!canCancel || busy}
            onClick={() => onCancel(op)}
          >
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

const STATUS_TONE: Record<OperationStatus | "unknown", CSSProperties> = {
  waiting: { color: "var(--moon)", borderColor: "var(--moon)" },
  ready: { color: "var(--cool)", borderColor: "var(--cool)" },
  executed: { color: "var(--muted)", borderColor: "var(--line)" },
  cancelled: { color: "var(--muted)", borderColor: "var(--line)" },
  unknown: { color: "var(--muted)", borderColor: "var(--line)" },
};

const row: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "1rem",
  padding: "0.7rem 0.8rem",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-soft)",
  background: "var(--panel-2)",
};

/** Row-sized: the queue packs several of these into each operation. */
function compact(style: CSSProperties): CSSProperties {
  return { ...style, padding: "0.4rem 0.7rem", fontSize: "0.8rem" };
}
