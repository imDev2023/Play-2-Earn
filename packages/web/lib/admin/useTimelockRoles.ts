"use client";

import { useReadContracts } from "wagmi";
import type { Address, Hex } from "viem";
import { TIMELOCK_ABI } from "../timelock";
import { successValue } from "./readResult";

/**
 * Discover whether the game's governance holder is a TimelockController, and what the
 * connected account may do with it.
 *
 * The timelock is found, not configured: the console asks the address that actually
 * holds `governance` whether it answers `getMinDelay()`. A timelock named in an env var
 * but not holding the role would let an operator queue changes that revert on
 * execution, days later — so the address that governs is the only one worth asking.
 */

const REFRESH_MS = 15_000;

export interface TimelockRoles {
  /** The governance holder, once confirmed to be a timelock. */
  address?: Address;
  /** The timelock's configured minimum delay, in seconds. */
  minDelay?: bigint;
  isProposer?: boolean;
  isExecutor?: boolean;
  isCanceller?: boolean;
  isLoading: boolean;
}

export function useTimelockRoles(governance?: Address, account?: Address): TimelockRoles {
  // Probe the governance holder. `allowFailure` (the default) turns "not a timelock"
  // into a failed entry rather than a thrown query, which is exactly the signal wanted.
  const { data: probe, isLoading: probing } = useReadContracts({
    contracts: [
      { address: governance, abi: TIMELOCK_ABI, functionName: "getMinDelay" },
      { address: governance, abi: TIMELOCK_ABI, functionName: "PROPOSER_ROLE" },
      { address: governance, abi: TIMELOCK_ABI, functionName: "EXECUTOR_ROLE" },
      { address: governance, abi: TIMELOCK_ABI, functionName: "CANCELLER_ROLE" },
    ],
    query: { enabled: Boolean(governance), refetchInterval: REFRESH_MS },
  });

  const minDelay = successValue<bigint>(probe?.[0]);
  const proposerRole = successValue<Hex>(probe?.[1]);
  const executorRole = successValue<Hex>(probe?.[2]);
  const cancellerRole = successValue<Hex>(probe?.[3]);
  const isTimelock = minDelay !== undefined && proposerRole !== undefined;

  const rolesReady = isTimelock && Boolean(account) && Boolean(executorRole && cancellerRole);
  const { data: held, isLoading: loadingRoles } = useReadContracts({
    contracts: [
      {
        address: governance,
        abi: TIMELOCK_ABI,
        functionName: "hasRole",
        args: [proposerRole as Hex, account as Address],
      },
      {
        address: governance,
        abi: TIMELOCK_ABI,
        functionName: "hasRole",
        args: [executorRole as Hex, account as Address],
      },
      {
        address: governance,
        abi: TIMELOCK_ABI,
        functionName: "hasRole",
        args: [cancellerRole as Hex, account as Address],
      },
    ],
    query: { enabled: rolesReady, refetchInterval: REFRESH_MS },
  });

  return {
    address: isTimelock ? governance : undefined,
    minDelay,
    isProposer: successValue<boolean>(held?.[0]),
    isExecutor: successValue<boolean>(held?.[1]),
    isCanceller: successValue<boolean>(held?.[2]),
    isLoading: probing || (rolesReady && loadingRoles),
  };
}
