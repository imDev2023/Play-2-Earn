import type { Interface } from "ethers";

/**
 * Identify *which* custom error a call reverted with, whichever way the provider reports
 * it (#26).
 *
 * The launch checklist's negative items exist to prove a contract refused for the reason
 * being tested. Accepting any revert would let them pass on a mistyped address or a bad
 * argument, and a checklist that goes green on a broken deployment is worse than none.
 *
 * Providers disagree about how a revert arrives. Hardhat's in-process node decodes it and
 * hands ethers a `revert: { name }`; a public RPC node returns the ABI-encoded error bytes
 * and ethers leaves `revert` undefined. Reading only the decoded form works locally and
 * fails on every real chain — so this reads both, and decodes the bytes against the
 * contract's own interface rather than a hand-maintained table of selectors.
 */

/** An error object as ethers rethrows it, across the shapes providers produce. */
interface ProviderError {
  readonly revert?: { readonly name?: string } | null;
  readonly data?: unknown;
  readonly info?: { readonly error?: { readonly data?: unknown } } | null;
  readonly error?: { readonly data?: unknown } | null;
  readonly message?: string;
}

/**
 * Pull the ABI-encoded revert payload out of an error, wherever the provider put it.
 *
 * A bare `0x` is treated as absent: the call reverted without a reason, so there is
 * nothing to identify it by.
 */
export function revertData(error: unknown): string | undefined {
  const candidate = error as ProviderError | null;
  if (!candidate || typeof candidate !== "object") return undefined;

  for (const value of [candidate.data, candidate.info?.error?.data, candidate.error?.data]) {
    // A selector alone is 4 bytes — "0x" plus 8 characters.
    if (typeof value === "string" && value.startsWith("0x") && value.length >= 10) return value;
  }
  return undefined;
}

/**
 * Does this error represent a revert with the named custom error?
 *
 * Tries the decoded form first, then the raw bytes, then the message. The message check
 * is last and deliberately loose — it only sees errors that carried no structured data,
 * where a substring is the only evidence available.
 */
export function matchesCustomError(error: unknown, expected: string, iface: Interface): boolean {
  const decoded = (error as ProviderError | null)?.revert?.name;
  if (decoded) return decoded === expected;

  const data = revertData(error);
  if (data) {
    try {
      const parsed = iface.parseError(data);
      // A selector this interface does not know came from somewhere unexpected — a
      // different contract, say. That is not the refusal being tested.
      if (parsed) return parsed.name === expected;
      return false;
    } catch {
      return false;
    }
  }

  return String((error as ProviderError | null)?.message ?? "").includes(expected);
}

/**
 * Run a call expected to revert, and report whether it refused for the expected reason.
 *
 * Returns false if the call *succeeds* — the case that matters most, since a check that
 * treated an unexpectedly-permitted action as a pass would be worse than no check.
 */
export async function revertsWith(
  call: () => Promise<unknown>,
  expected: string,
  iface: Interface,
): Promise<boolean> {
  try {
    await call();
    return false;
  } catch (error) {
    return matchesCustomError(error, expected, iface);
  }
}
