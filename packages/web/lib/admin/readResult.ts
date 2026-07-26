/**
 * One entry of a `useReadContracts` result.
 *
 * The console reads its state with `allowFailure` (the default), because a failed call
 * is often the answer it wants — "this address is not a timelock" is discovered by
 * asking it for a min delay and being refused. That makes unwrapping an entry the same
 * gesture everywhere: a value, or nothing, never a thrown query.
 */
export interface ContractReadResult {
  status: "success" | "failure";
  result?: unknown;
}

/** The value a read returned, or undefined if that particular call failed. */
export function successValue<T>(entry: ContractReadResult | undefined): T | undefined {
  return entry?.status === "success" ? (entry.result as T) : undefined;
}
