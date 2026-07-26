"use client";

import { useMemo, useState, type CSSProperties } from "react";
import type { Address, Hex } from "viem";
import { useAccount, useBlock, useConnect, useDisconnect, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { wagmiConfig } from "../../lib/wagmi";
import { GAME_ABI, GAME_ADDRESS } from "../../lib/contracts";
import { NO_PREDECESSOR, TIMELOCK_ABI, randomSalt } from "../../lib/timelock";
import { readableError } from "../../lib/errors";
import { operatorAccess } from "../../lib/admin/access";
import {
  adminOp,
  encodeAdminOp,
  parseAdminOp,
  preflightAdminOp,
  type AdminOpId,
  type AdminWarning,
  type OpFieldError,
} from "../../lib/admin/ops";
import { formatDuration, shortAddress } from "../../lib/admin/format";
import { useGameAdmin } from "../../lib/admin/useGameAdmin";
import { useTimelockRoles } from "../../lib/admin/useTimelockRoles";
import { useTimelockQueue, type QueuedOperation } from "../../lib/admin/useTimelockQueue";
import { useRelayerHealth } from "../../lib/admin/useRelayerHealth";
import { NetworkOnboarding } from "../../components/NetworkOnboarding";
import { TreasuryPanel } from "../../components/admin/TreasuryPanel";
import { RelayerHealthPanel } from "../../components/admin/RelayerHealthPanel";
import { EmergencyPanel } from "../../components/admin/EmergencyPanel";
import { ChangeForm } from "../../components/admin/ChangeForm";
import { QueuePanel } from "../../components/admin/QueuePanel";
import { chip, ghostButton, hint, label, panel } from "../../lib/ui";

/**
 * The admin / treasury console (#25).
 *
 * Gated to whoever actually holds the roles on-chain — which is a question the page
 * asks the contracts rather than a list it is configured with. Everything sensitive
 * routes through the timelock so that a parameter change is public before it lands;
 * the emergency pause deliberately does not, because a delay on the stop button defeats
 * the point of one.
 */
export function AdminConsole() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { writeContractAsync } = useWriteContract();
  const { data: block } = useBlock({ watch: true });

  const game = useGameAdmin();
  const timelock = useTimelockRoles(game.governance, address);
  const queue = useTimelockQueue(timelock.address);
  const health = useRelayerHealth(game.activeBetId, game.settleTimeout);

  const access = operatorAccess({
    account: address,
    governance: game.governance,
    guardian: game.guardian,
    timelock: timelock.address,
    isProposer: timelock.isProposer,
    isExecutor: timelock.isExecutor,
    isCanceller: timelock.isCanceller,
  });

  const [selected, setSelected] = useState<AdminOpId>("setBurnRate");
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<OpFieldError[]>([]);
  const [busy, setBusy] = useState<BusyKey>();
  const [notice, setNotice] = useState<string>();
  const [failure, setFailure] = useState<string>();

  // Field values are namespaced by operation, so switching operation and switching back
  // does not silently reinterpret a number typed for a different unit.
  const fieldKey = (id: AdminOpId, name: string) => `${id}.${name}`;
  const rawValues = useMemo(() => {
    const spec = adminOp(selected);
    return Object.fromEntries(
      spec.fields.map((f) => [f.name, values[fieldKey(selected, f.name)] ?? ""]),
    );
  }, [selected, values]);

  // Warnings track what is true right now, live, so an operator sees the economics lock
  // (or a bet in flight) before signing rather than after.
  const warnings: AdminWarning[] = useMemo(() => {
    const parsed = parseAdminOp(selected, rawValues, { maxBurnRateBps: game.maxBurnRateBps });
    if (!parsed.ok) return [];
    if (
      game.economicsGovernable === undefined ||
      game.activeBetId === undefined ||
      game.treasuryBalance === undefined ||
      game.treasuryFloor === undefined
    ) {
      return [];
    }
    return preflightAdminOp(selected, parsed.args, {
      economicsGovernable: game.economicsGovernable,
      activeBetId: game.activeBetId,
      treasuryBalance: game.treasuryBalance,
      treasuryFloor: game.treasuryFloor,
    });
  }, [selected, rawValues, game]);

  async function run(id: BusyKey, message: string, send: () => Promise<Hex>) {
    setBusy(id);
    setFailure(undefined);
    setNotice(undefined);
    try {
      const hash = await send();
      await waitForTransactionReceipt(wagmiConfig, { hash });
      setNotice(message);
      game.refetch();
      queue.refresh();
    } catch (error) {
      setFailure(readableError(error));
    } finally {
      setBusy(undefined);
    }
  }

  function submitChange() {
    const parsed = parseAdminOp(selected, rawValues, { maxBurnRateBps: game.maxBurnRateBps });
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors([]);

    const timelockAddress = timelock.address;
    if (access.canQueue && timelockAddress) {
      const data = encodeAdminOp(selected, parsed.args);
      const delay = timelock.minDelay ?? 0n;
      void run(
        "submit",
        `Queued ${adminOp(selected).label}. Executable in ${formatDuration(delay)}.`,
        () =>
          writeContractAsync({
            address: timelockAddress,
            abi: TIMELOCK_ABI,
            functionName: "schedule",
            args: [GAME_ADDRESS, 0n, data, NO_PREDECESSOR, randomSalt(), delay],
          }),
      );
      return;
    }

    if (access.canChangeParamsDirectly) {
      void run("submit", `${adminOp(selected).label} applied.`, () =>
        writeContractAsync({
          address: GAME_ADDRESS,
          abi: GAME_ABI,
          functionName: selected,
          args: parsed.args as never,
        }),
      );
    }
  }

  function executeOperation(op: QueuedOperation) {
    const timelockAddress = timelock.address;
    if (!timelockAddress) return;
    void run(op.id, `Executed ${op.description?.label ?? "operation"}.`, () =>
      writeContractAsync({
        address: timelockAddress,
        abi: TIMELOCK_ABI,
        functionName: "execute",
        // Re-supplied exactly as scheduled: the timelock recomputes the operation id
        // from these, so a single altered byte simply fails to match anything queued.
        args: [op.target, op.value, op.data, op.predecessor, op.salt],
      }),
    );
  }

  function cancelOperation(op: QueuedOperation) {
    const timelockAddress = timelock.address;
    if (!timelockAddress) return;
    void run(op.id, `Cancelled ${op.description?.label ?? "operation"}.`, () =>
      writeContractAsync({
        address: timelockAddress,
        abi: TIMELOCK_ABI,
        functionName: "cancel",
        args: [op.id],
      }),
    );
  }

  function togglePause(next: boolean) {
    void run("pause", next ? "Game paused." : "Game resumed.", () =>
      writeContractAsync({
        address: GAME_ADDRESS,
        abi: GAME_ABI,
        functionName: next ? "pause" : "unpause",
      }),
    );
  }

  if (!isConnected) {
    return (
      <section data-testid="admin-gate" style={{ ...panel, display: "grid", gap: "0.85rem" }}>
        <span style={label}>Operator sign-in</span>
        <p style={{ margin: 0, color: "var(--muted)" }}>
          Connect the multisig (or, before the governance handoff, the deployer key) to open the
          console. Roles are read from the contracts — connecting proves nothing on its own.
        </p>
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
          {connectors.map((connector) => (
            <button
              key={connector.uid}
              data-testid={`connect-${connector.type}`}
              style={ghostButton}
              onClick={() => connect({ connector })}
            >
              Connect {connector.name}
            </button>
          ))}
        </div>
      </section>
    );
  }

  if (!game.reachable) {
    return (
      <section data-testid="admin-gate" style={{ ...panel, display: "grid", gap: "0.6rem" }}>
        <span style={label}>No chain</span>
        <p data-testid="chain-unreachable" style={{ margin: 0, color: "var(--muted)" }}>
          {game.isLoading
            ? "Reading the game's roles…"
            : `Could not read the game at ${GAME_ADDRESS}. Check the RPC endpoint and that the contracts are deployed on this network.`}
        </p>
        <NetworkOnboarding />
      </section>
    );
  }

  if (!access.authorized) {
    return (
      <section data-testid="admin-gate" style={{ ...panel, display: "grid", gap: "0.7rem" }}>
        <span style={label}>Not an operator</span>
        <p data-testid="access-denied" style={{ margin: 0 }}>
          {shortAddress(address)} holds none of this deployment&apos;s admin roles.
        </p>
        <dl style={roleList}>
          <Role name="Governance (policy)" value={game.governance} />
          <Role name="Guardian (pause)" value={game.guardian} />
        </dl>
        <button style={ghostButton} onClick={() => disconnect()}>
          Disconnect
        </button>
      </section>
    );
  }

  return (
    <div data-testid="admin-console" style={{ display: "grid", gap: "1.3rem" }}>
      <div style={topBar}>
        <span data-testid="governance-mode" style={chip} className="mono">
          {MODE_LABEL[access.mode]}
          {access.mode === "timelock" && timelock.minDelay !== undefined
            ? ` · ${formatDuration(timelock.minDelay)} delay`
            : ""}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <span data-testid="operator-roles" style={{ ...hint, fontSize: "0.78rem" }}>
            {access.roles.join(" · ")}
          </span>
          <code style={{ color: "var(--muted)", fontSize: "0.8rem" }}>{shortAddress(address)}</code>
          <button style={ghostButton} onClick={() => disconnect()}>
            Disconnect
          </button>
        </div>
      </div>

      <NetworkOnboarding />

      {notice && (
        <p data-testid="admin-notice" style={noticeStyle}>
          {notice}
        </p>
      )}
      {failure && (
        <p data-testid="admin-error" style={{ ...noticeStyle, borderColor: "var(--hot)", color: "var(--hot)" }}>
          {failure}
        </p>
      )}

      <TreasuryPanel
        treasury={game.treasury}
        balance={game.treasuryBalance}
        floor={game.treasuryFloor}
        maxPayout={game.maxPayout}
        minBet={game.minBet}
        burnRateBps={game.burnRateBps}
        edgeNum={game.edgeNum}
        edgeDen={game.edgeDen}
        solvencyCapDen={game.solvencyCapDen}
        economicsGovernable={game.economicsGovernable}
        onBurnProfit={(amount) => {
          setSelected("burnTreasuryProfit");
          setErrors([]);
          setValues((prev) => ({ ...prev, [fieldKey("burnTreasuryProfit", "amount")]: amount }));
        }}
      />

      <div style={twoUp}>
        <RelayerHealthPanel health={health} />
        <EmergencyPanel
          paused={game.paused}
          canPause={access.canPause}
          busy={busy === "pause"}
          onToggle={togglePause}
        />
      </div>

      <ChangeForm
        selected={selected}
        values={rawValues}
        errors={errors}
        warnings={warnings}
        mode={access.mode}
        canQueue={access.canQueue}
        canApplyDirectly={access.canChangeParamsDirectly}
        minDelay={timelock.minDelay}
        busy={busy === "submit"}
        onSelect={(id) => {
          setSelected(id);
          setErrors([]);
        }}
        onChange={(name, value) => {
          setErrors((prev) => prev.filter((e) => e.field !== name));
          setValues((prev) => ({ ...prev, [fieldKey(selected, name)]: value }));
        }}
        onSubmit={submitChange}
      />

      {access.mode === "timelock" && (
        <QueuePanel
          operations={queue.operations}
          now={block?.timestamp}
          unavailable={queue.unavailable}
          canExecute={access.canExecuteQueued}
          canCancel={access.canCancel}
          busyId={busy}
          onExecute={executeOperation}
          onCancel={cancelOperation}
        />
      )}
    </div>
  );
}

function Role({ name, value }: { name: string; value?: string }) {
  return (
    <>
      <dt style={{ ...label, margin: 0 }}>{name}</dt>
      <dd className="mono" style={{ margin: 0, fontSize: "0.8rem", wordBreak: "break-all" }}>
        {value ?? "…"}
      </dd>
    </>
  );
}

/**
 * Which action is awaiting confirmation: the change form, the pause, or a specific
 * queued operation (keyed by its id, since the queue renders one button pair per row).
 */
type BusyKey = "submit" | "pause" | Hex;

const MODE_LABEL = {
  timelock: "governed by timelock",
  direct: "governed directly by your key",
  foreign: "governed by another account",
  unknown: "governance unknown",
} as const;

const topBar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
};

const twoUp: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: "1.3rem",
};

const roleList: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(140px, auto) 1fr",
  gap: "0.35rem 1rem",
  margin: 0,
  alignItems: "baseline",
};

const noticeStyle: CSSProperties = {
  margin: 0,
  padding: "0.7rem 0.9rem",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--cool)",
  background: "var(--panel-2)",
  fontSize: "0.88rem",
};
