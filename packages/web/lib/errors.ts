/**
 * Wallet and RPC errors arrive as multi-paragraph dumps — the revert, the request body,
 * the docs link, the version banner. The first line is the part a person needs; the
 * rest belongs in the console, not in the UI.
 */
export function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0].trim();
}
