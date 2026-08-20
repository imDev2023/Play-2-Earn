"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { parseAbiItem, type Address, type Hex } from "viem";
import { getPublicClient } from "wagmi/actions";
import { useReadContracts } from "wagmi";
import { wagmiConfig } from "../wagmi";
import { activeChainId } from "../chain";
import { TIMELOCK_ABI, ZERO_BYTES32, operationStatus, type OperationStatus } from "../timelock";
import { describeAdminCall, type AdminCallDescription } from "./ops";
import { successValue } from "./readResult";

/**
 * The timelock's operation queue, rebuilt from its own logs.
 *
 * A queued change is not a thing this app remembers - it lives on-chain, was probably
 * queued from a different browser, and will be executed days later by someone else. So
 * the queue is reconstructed from `CallScheduled` (what is being called) joined with
 * `CallSalt` (the salt `execute` needs, which `CallScheduled` does not carry), and each
 * operation's live state is read back from the timelock rather than inferred from the
 * delay that was requested.
 *
 * Like the player-facing history, this reads logs directly rather than an indexer -
 * ample for a console watching one contract's governance traffic.
 */

const REFRESH_MS = 5_000;

/** Newest operations first; enough history to see what has recently landed. */
const MAX_OPERATIONS = 25;

const CALL_SCHEDULED = parseAbiItem(
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
);
const CALL_SALT = parseAbiItem("event CallSalt(bytes32 indexed id, bytes32 salt)");

export interface QueuedOperation {
  id: Hex;
  /** Zero when the operation was queued without one (not by this console). */
  salt: Hex;
  target: Address;
  value: bigint;
  data: Hex;
  predecessor: Hex;
  /** The delay requested at schedule time. */
  delay: bigint;
  blockNumber: bigint;
  status?: OperationStatus;
  /** Unix seconds at which the operation becomes executable. */
  readyAt?: bigint;
  /** Null when the calldata is not one of this console's operations. */
  description: AdminCallDescription | null;
}

export interface TimelockQueue {
  operations: QueuedOperation[];
  isLoading: boolean;
  /**
   * True when the log query failed, so the queue could not be read at all. Distinct
   * from an empty queue: "nothing is pending" and "we cannot see what is pending" lead
   * an operator to opposite actions.
   */
  unavailable: boolean;
  refresh: () => void;
}

export function useTimelockQueue(timelock?: Address): TimelockQueue {
  const [scheduled, setScheduled] = useState<QueuedOperation[]>([]);
  const [isLoading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!timelock) {
      setScheduled([]);
      setUnavailable(false);
      return;
    }
    let cancelled = false;

    async function load() {
      try {
        const client = getPublicClient(wagmiConfig, { chainId: activeChainId });
        if (!client) return;
        const [calls, salts] = await Promise.all([
          client.getLogs({ address: timelock, event: CALL_SCHEDULED, fromBlock: 0n, toBlock: "latest" }),
          client.getLogs({ address: timelock, event: CALL_SALT, fromBlock: 0n, toBlock: "latest" }),
        ]);
        if (cancelled) return;

        const saltById = new Map<string, Hex>();
        for (const log of salts) {
          if (log.args.id && log.args.salt) saltById.set(log.args.id.toLowerCase(), log.args.salt);
        }
        setUnavailable(false);

        const operations = calls
          .filter((log) => log.args.id !== undefined && log.args.target !== undefined)
          .map((log) => {
            const id = log.args.id as Hex;
            const data = (log.args.data ?? "0x") as Hex;
            return {
              id,
              salt: saltById.get(id.toLowerCase()) ?? ZERO_BYTES32,
              target: log.args.target as Address,
              value: log.args.value ?? 0n,
              data,
              predecessor: (log.args.predecessor ?? ZERO_BYTES32) as Hex,
              delay: log.args.delay ?? 0n,
              blockNumber: log.blockNumber ?? 0n,
              description: describeAdminCall(data),
            } satisfies QueuedOperation;
          })
          .sort((a, b) => (b.blockNumber > a.blockNumber ? 1 : b.blockNumber < a.blockNumber ? -1 : 0))
          .slice(0, MAX_OPERATIONS);

        setScheduled(operations);
      } catch {
        // No node, or a provider that won't serve a full-range log query. Say the queue
        // is unreadable rather than let it render as empty - an operator who believes
        // nothing is pending will re-queue a change that is already waiting.
        if (!cancelled) setUnavailable(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    setLoading(true);
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [timelock, nonce]);

  // Live state per operation. Read back rather than derived from the scheduling block,
  // so an operation cancelled or executed elsewhere shows up as such here.
  const { data: states } = useReadContracts({
    contracts: scheduled.flatMap((op) => [
      { chainId: activeChainId, address: timelock, abi: TIMELOCK_ABI, functionName: "getOperationState", args: [op.id] },
      { chainId: activeChainId, address: timelock, abi: TIMELOCK_ABI, functionName: "getTimestamp", args: [op.id] },
    ]),
    query: { enabled: Boolean(timelock) && scheduled.length > 0, refetchInterval: REFRESH_MS },
  });

  // Results are positional, so they are only safe to zip back onto `scheduled` when
  // they were read for exactly this list. A mismatched length means the queue changed
  // while the state read was in flight; showing one operation's status against
  // another's row would put a live Execute button on a change that is still waiting.
  const aligned = states?.length === scheduled.length * 2 ? states : undefined;

  const operations = useMemo(
    () =>
      scheduled.map((op, index) => {
        const state = successValue<number | bigint>(aligned?.[index * 2]);
        return {
          ...op,
          status: state === undefined ? undefined : operationStatus(Number(state)),
          readyAt: successValue<bigint>(aligned?.[index * 2 + 1]),
        };
      }),
    [scheduled, aligned],
  );

  return { operations, isLoading, unavailable, refresh };
}
