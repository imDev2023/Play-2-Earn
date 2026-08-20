import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";

/**
 * The condition both e2e suites make unreachable: the configured chain is not
 * `wagmiConfig.chains[0]`.
 *
 * Every e2e run points the app at a local node, where `ACTIVE_CHAIN_ID` and
 * `chains[0]` are the same value - so an unpinned read resolves to the right chain by
 * coincidence, and the assertion that would catch #63 is the one the harness makes
 * impossible. That is the folded-input lesson from the fuzzing work arriving in the
 * client: a fixture that folds the configured chain onto the default chain cannot
 * fail an assertion about them differing.
 *
 * So this file builds the app's real config with the two deliberately different -
 * `NEXT_PUBLIC_CHAIN_ID=46630` while `chains[0]` stays `hardhat` - and proves the
 * routing mechanism at the transport boundary, by intercepting fetch and recording
 * which RPC endpoint each read actually asked:
 *
 * - an *unpinned* read goes to the local transport, whoever answers there (#63's bug);
 * - a read pinned with `chainId: activeChainId` goes to the testnet endpoint.
 *
 * The first assertion is as load-bearing as the second. If it ever fails, wagmi's
 * fallback stopped being `chains[0]` (or someone reordered `chains` so the fallback
 * happens to be right), and `chain-pinning.test.ts` - which assumes an unpinned call
 * is a wrong-chain call - needs its premise re-examined.
 *
 * Env is set before the app modules load, which is why every import here is dynamic.
 */

process.env.NEXT_PUBLIC_CHAIN_ID = "46630";

type Recorded = { host: string; body: string };

describe("configured chain differs from chains[0] (#63)", () => {
  let wagmiConfig: typeof import("../lib/wagmi").wagmiConfig;
  let activeChainId: typeof import("../lib/chain").activeChainId;
  let LOCAL_RPC_URL: string;
  let TESTNET_RPC_URL: string;
  let readContract: typeof import("wagmi/actions").readContract;
  let GAME_ABI: typeof import("../lib/contracts").GAME_ABI;
  const requests: Recorded[] = [];

  before(async () => {
    ({ activeChainId } = await import("../lib/chain"));
    ({ wagmiConfig } = await import("../lib/wagmi"));
    ({ LOCAL_RPC_URL, TESTNET_RPC_URL } = await import("../lib/endpoints"));
    ({ readContract } = await import("wagmi/actions"));
    ({ GAME_ABI } = await import("../lib/contracts"));

    // Answer every RPC request with an empty result ("0x" is, fittingly, the exact
    // reply the live bug surfaced). The reads below are expected to throw on it; the
    // subject of the test is which endpoint was asked, never what it said.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = String(init?.body ?? "");
      requests.push({ host: new URL(url).host, body });
      const id = (JSON.parse(body) as { id?: number }).id ?? 1;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0x" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  const GAME = "0x84DD77034E1eDFEf6A26a5aAbb0036FA1F4b56aA" as const;

  it("the divergence this file exists to exercise actually holds", () => {
    assert.equal(activeChainId, 46630, "configured chain must be the testnet");
    assert.equal(
      wagmiConfig.chains[0].id,
      31337,
      "chains[0] must remain hardhat; if this moved, re-examine chain-pinning.test.ts's premise",
    );
    assert.notEqual(wagmiConfig.chains[0].id, activeChainId);
  });

  it("an unpinned read asks the local transport, not the configured chain", async () => {
    requests.length = 0;
    await readContract(wagmiConfig, {
      address: GAME,
      abi: GAME_ABI,
      functionName: "bets",
      args: [1n],
    }).catch(() => undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].host, new URL(LOCAL_RPC_URL).host);
  });

  it("a read pinned to activeChainId asks the configured chain's endpoint", async () => {
    requests.length = 0;
    await readContract(wagmiConfig, {
      chainId: activeChainId,
      address: GAME,
      abi: GAME_ABI,
      functionName: "bets",
      args: [1n],
    }).catch(() => undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].host, new URL(TESTNET_RPC_URL).host);
  });
});
