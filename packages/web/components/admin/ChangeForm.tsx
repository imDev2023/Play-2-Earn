"use client";

import type { CSSProperties } from "react";
import type { GovernanceMode } from "../../lib/admin/access";
import {
  ADMIN_OPS,
  adminOp,
  type AdminOpId,
  type AdminWarning,
  type OpFieldError,
} from "../../lib/admin/ops";
import { formatDuration } from "../../lib/admin/format";
import { field, hint, label, panel, primaryButton, textInput } from "../../lib/ui";

/**
 * Queue a parameter change.
 *
 * The form validates against the contract's own bounds before anything is signed. That
 * matters more here than on a normal form: a queued change spends the timelock delay
 * before the chain looks at it, so a value the game can never accept would otherwise
 * cost two days to discover. Constraints that are merely true *today* (the economics
 * lock, a bet in flight, the burn headroom) are shown as warnings instead - they are
 * re-checked at execution, by which time they may well have changed.
 */

export interface ChangeFormProps {
  selected: AdminOpId;
  values: Record<string, string>;
  errors: OpFieldError[];
  warnings: AdminWarning[];
  mode: GovernanceMode;
  canQueue: boolean;
  canApplyDirectly: boolean;
  minDelay?: bigint;
  busy: boolean;
  onSelect: (id: AdminOpId) => void;
  onChange: (fieldName: string, value: string) => void;
  onSubmit: () => void;
}

export function ChangeForm(props: ChangeFormProps) {
  const spec = adminOp(props.selected);
  const allowed = props.canQueue || props.canApplyDirectly;
  const errorFor = (name: string) => props.errors.find((e) => e.field === name);

  return (
    <section data-testid="change-form" style={{ ...panel, display: "grid", gap: "1rem" }}>
      <header style={{ display: "grid", gap: "0.35rem" }}>
        <span style={label}>Change a parameter</span>
        <p style={hint}>{spec.summary}</p>
      </header>

      <label style={field}>
        <span style={label}>Operation</span>
        <select
          data-testid="op-select"
          style={{ ...textInput, cursor: "pointer" }}
          value={props.selected}
          disabled={props.busy}
          onChange={(e) => props.onSelect(e.target.value as AdminOpId)}
        >
          {ADMIN_OPS.map((op) => (
            <option key={op.id} value={op.id}>
              {op.label} · {op.id}
            </option>
          ))}
        </select>
      </label>

      {spec.fields.map((f) => {
        const error = errorFor(f.name);
        return (
          <label key={f.name} style={field}>
            <span style={label}>{f.label}</span>
            {f.kind === "boolean" ? (
              <select
                data-testid={`op-field-${f.name}`}
                style={{ ...textInput, cursor: "pointer" }}
                value={props.values[f.name] ?? "true"}
                disabled={props.busy}
                onChange={(e) => props.onChange(f.name, e.target.value)}
              >
                <option value="true">true - unlocked</option>
                <option value="false">false - locked</option>
              </select>
            ) : (
              <input
                data-testid={`op-field-${f.name}`}
                className="mono"
                style={{ ...textInput, borderColor: error ? "var(--hot)" : "var(--line)" }}
                value={props.values[f.name] ?? ""}
                placeholder={f.placeholder}
                disabled={props.busy}
                onChange={(e) => props.onChange(f.name, e.target.value)}
              />
            )}
            {f.hint && <span style={{ ...hint, fontSize: "0.75rem" }}>{f.hint}</span>}
            {error && (
              <span data-testid={`op-error-${f.name}`} style={errorText}>
                {error.message}
              </span>
            )}
          </label>
        );
      })}

      {props.warnings.length > 0 && (
        <ul data-testid="op-warnings" style={warningList}>
          {props.warnings.map((warning) => (
            <li key={warning.code} style={{ marginBottom: "0.35rem" }}>
              {warning.message}
            </li>
          ))}
        </ul>
      )}

      <button
        data-testid="op-submit"
        style={primaryButton(!allowed || props.busy)}
        disabled={!allowed || props.busy}
        onClick={props.onSubmit}
      >
        {props.busy
          ? "Confirming…"
          : props.canQueue
            ? `Queue through the timelock · executable in ${formatDuration(props.minDelay ?? 0n)}`
            : props.canApplyDirectly
              ? "Apply now - no timelock on this deployment"
              : "Not authorised to change parameters"}
      </button>

      {props.canApplyDirectly && (
        <p data-testid="direct-mode-warning" style={{ ...hint, color: "var(--moon)" }}>
          Governance is still held by your key, so this change lands immediately with no public
          delay. Hand governance to the timelock before real-value play - until then, players get
          no warning of a parameter change.
        </p>
      )}
      {props.mode === "foreign" && (
        <p style={{ ...hint, color: "var(--hot)" }}>
          Governance is held by an address that is neither this account nor a timelock, so nothing
          queued here could execute.
        </p>
      )}
    </section>
  );
}

const errorText: CSSProperties = {
  fontSize: "0.78rem",
  color: "var(--hot)",
};

const warningList: CSSProperties = {
  margin: 0,
  padding: "0.75rem 0.9rem 0.75rem 1.9rem",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--moon)",
  background: "var(--panel-2)",
  color: "var(--text)",
  fontSize: "0.82rem",
  lineHeight: 1.5,
};
