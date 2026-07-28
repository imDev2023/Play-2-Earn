/**
 * Source verification against Blockscout's Etherscan-compatible API (#26).
 *
 * Why not `hardhat-verify`: it sends `constructorArguements` as bare hex, and the
 * Robinhood Chain explorer only accepts them `0x`-prefixed. The rejection is invisible —
 * the submission is accepted, queued, and comes back "Fail - Unable to verify" with no
 * indication that the arguments were the problem. Every launch contract takes constructor
 * arguments, so all six failed; `WETH9`, which takes none, verified through the identical
 * path first time. That is what isolates the prefix as the cause.
 *
 * Submitting directly also fixes the second failure: passing the fully-qualified
 * `path:Name` resolves RushoodTimelock, whose bytecode `hardhat-verify` could not tell
 * apart from OpenZeppelin's TimelockController ("More than one contract was found").
 */

export interface VerificationRequest {
  readonly address: string;
  /** Fully qualified `path/To/File.sol:ContractName`. */
  readonly contractName: string;
  /** Long-form compiler version, e.g. `v0.8.24+commit.e11b9ed9`. */
  readonly compilerVersion: string;
  /** The solc standard JSON input, serialized. */
  readonly standardInput: string;
  /** ABI-encoded constructor arguments, with or without the `0x`. */
  readonly constructorArgs?: string;
  readonly optimizer: { readonly enabled: boolean; readonly runs: number };
}

/** Blockscout's `verifysourcecode` / `checkverifystatus` envelope. */
interface ApiResponse {
  readonly status?: string;
  readonly result?: string | null;
  readonly message?: string;
}

export type SubmitOutcome =
  | { readonly state: "queued"; readonly guid: string }
  | { readonly state: "already-verified" }
  | { readonly state: "error"; readonly message: string };

export type VerifyOutcome =
  | { readonly state: "verified" }
  | { readonly state: "already-verified" }
  /** `rejected` marks a deterministic refusal of the request, which retrying cannot fix. */
  | { readonly state: "failed"; readonly message: string; readonly rejected?: boolean }
  | { readonly state: "timeout" };

/** The slice of `fetch` this module uses — narrow enough that a test stub can stand in. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ json(): Promise<unknown> }>;

export interface VerifyDeps {
  readonly fetch: FetchLike;
  /** Delay between status polls. Zero in tests. */
  readonly waitMs?: number;
  readonly maxPolls?: number;
  /** How many times to submit before believing an opaque failure. */
  readonly attempts?: number;
}

const DEFAULT_WAIT_MS = 6_000;
const DEFAULT_MAX_POLLS = 30;
const DEFAULT_ATTEMPTS = 3;

/**
 * Build the form body for a `verifysourcecode` submission.
 *
 * The `constructorArguements` misspelling is Etherscan's, and Blockscout copies it — the
 * correctly-spelled variant is ignored, which is its own silent failure.
 */
export function buildVerifyForm(request: VerificationRequest): URLSearchParams {
  const form = new URLSearchParams({
    module: "contract",
    action: "verifysourcecode",
    codeformat: "solidity-standard-json-input",
    contractaddress: request.address,
    contractname: request.contractName,
    compilerversion: request.compilerVersion,
    sourceCode: request.standardInput,
    optimizationUsed: request.optimizer.enabled ? "1" : "0",
    runs: String(request.optimizer.runs),
  });

  // An empty tail is not the same as no tail: sending `0x` for a contract that takes no
  // arguments makes Blockscout match against a declared-empty argument section instead of
  // none at all, and the match fails.
  const args = normalizeConstructorArgs(request.constructorArgs);
  if (args) form.set("constructorArguements", args);

  return form;
}

/** `0x`-prefix the arguments, or return undefined when there are none. */
function normalizeConstructorArgs(args: string | undefined): string | undefined {
  if (!args) return undefined;
  const hex = args.startsWith("0x") ? args.slice(2) : args;
  if (hex.length === 0) return undefined;
  return `0x${hex}`;
}

export function interpretSubmit(response: ApiResponse): SubmitOutcome {
  const text = String(response.message ?? response.result ?? "");
  if (/already verified/i.test(text)) return { state: "already-verified" };
  if (response.status === "1" && response.result) {
    return { state: "queued", guid: response.result };
  }
  return { state: "error", message: text || "Blockscout rejected the submission" };
}

export function interpretPoll(response: ApiResponse): "pending" | "verified" | "failed" {
  const text = String(response.result ?? "");
  if (/^pending/i.test(text)) return "pending";
  if (/^pass/i.test(text)) return "verified";
  return "failed";
}

/**
 * Verify one contract, retrying an opaque failure.
 *
 * Blockscout reports "Fail - Unable to verify" both for a genuine source mismatch and for
 * a transient fault in its own verifier queue — the two are indistinguishable from the
 * response. Observed directly on this explorer: two contracts failed on one run and
 * verified on the next from byte-identical submissions. Retrying costs a minute; treating
 * a transient fault as final means a launch script that reports unverified contracts and
 * has to be re-run by hand.
 *
 * A submission Blockscout *rejects* outright is not retried — that is a deterministic
 * complaint about the request, and repeating it would only repeat the complaint.
 */
export async function verifyContract(
  explorerUrl: string,
  request: VerificationRequest,
  deps: VerifyDeps,
): Promise<VerifyOutcome> {
  const attempts = deps.attempts ?? DEFAULT_ATTEMPTS;
  let last: VerifyOutcome = { state: "failed", message: "not attempted" };

  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await attemptVerification(explorerUrl, request, deps);
    if (last.state === "verified" || last.state === "already-verified") return last;
    if (last.state === "failed" && last.rejected) return last;
  }
  return last;
}

/** One submit-and-poll cycle. */
async function attemptVerification(
  explorerUrl: string,
  request: VerificationRequest,
  deps: VerifyDeps,
): Promise<VerifyOutcome> {
  const api = `${explorerUrl.replace(/\/+$/, "")}/api`;

  const submitted = interpretSubmit(
    (await (
      await deps.fetch(api, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: buildVerifyForm(request).toString(),
      })
    ).json()) as ApiResponse,
  );

  if (submitted.state === "already-verified") return { state: "already-verified" };
  // Rejected before it ever reached the compiler — deterministic, so don't retry it.
  if (submitted.state === "error") {
    return { state: "failed", message: submitted.message, rejected: true };
  }

  const maxPolls = deps.maxPolls ?? DEFAULT_MAX_POLLS;
  for (let poll = 0; poll < maxPolls; poll++) {
    await sleep(deps.waitMs ?? DEFAULT_WAIT_MS);
    const status = interpretPoll(
      (await (
        await deps.fetch(
          `${api}?module=contract&action=checkverifystatus&guid=${encodeURIComponent(submitted.guid)}`,
        )
      ).json()) as ApiResponse,
    );
    if (status === "verified") return { state: "verified" };
    if (status === "failed") return { state: "failed", message: "Blockscout could not verify the source" };
  }

  // Bounded rather than open-ended: a stuck queue must not hang the launch script.
  return { state: "timeout" };
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
