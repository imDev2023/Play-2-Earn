import type { Address } from "viem";
import { ACTIVE_CHAIN_ID } from "./chain";

/**
 * The committed address book: which contracts this app talks to, per chain (#61).
 *
 * An entry exists here if and only if a deployment record exists under
 * `docs/deployments/`, plus the deterministic local skeleton. That rule is what makes
 * the absence of `4663` a statement rather than an oversight: there is no mainnet
 * deployment, so a build pointed at mainnet must fail loudly below rather than
 * resolve to an address where nothing is deployed.
 *
 * `test/addresses.test.ts` holds each committed entry to its source of truth - the
 * testnet row is compared against `docs/deployments/robinhoodTestnet.md` - so this
 * table cannot silently drift from the published record.
 */
export interface ContractAddresses {
  game: Address;
  rush: Address;
}

export const CONTRACT_ADDRESSES: Record<number, ContractAddresses> = {
  // Local Hardhat skeleton: deterministic addresses from `deploy-skeleton.ts` on a
  // fresh node (deployer nonces 0/1/2).
  31337: {
    game: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    rush: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  },
  // Robinhood Chain testnet, the 2026-08-13 redeploy
  // (docs/deployments/robinhoodTestnet.md).
  46630: {
    game: "0x84DD77034E1eDFEf6A26a5aAbb0036FA1F4b56aA",
    rush: "0xDc0B7143528964953a1A8b9f999DAc065542bA43",
  },
  // 4663 (mainnet) is deliberately absent: no deployment exists.
};

const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Trim an env value and treat the empty string as unset.
 *
 * The empty string matters operationally: `NEXT_PUBLIC_GAME_ADDRESS= npm run dev`
 * is how a shell suppresses a value that a gitignored `.env` file would otherwise
 * supply, because a variable already present in the environment beats the file. If
 * "" counted as set, there would be no way to reach the committed entry on a machine
 * whose `.env` carries an override.
 */
function normalise(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Resolve the game and token addresses for a chain, loudly.
 *
 * Precedence per address: explicit environment override, then the committed entry.
 * An operator overriding an address by hand should not be silently ignored - the
 * same rule the relayer's config follows for its seed.
 *
 * There is no fallback beyond those two. The failure this replaces is a build
 * pointed at a public chain silently reading the local skeleton address - present,
 * plausible, and about a chain where nothing is deployed at it (the same shape as
 * the checklist-attribution bug #60 fixed). Problems are collected and thrown
 * together, `loadRelayerConfig` style, so a misconfigured build names everything
 * wrong with it at once. The throw happens at module load, which for a Next.js
 * build is build time: the wrong artefact is never produced at all.
 *
 * The chain id taken here is `ACTIVE_CHAIN_ID` - the raw configured value - not
 * `activeChainId`, which folds an unknown id onto Hardhat. For wagmi calls that
 * fold is a typing convenience; for choosing which real-money contract to talk to
 * it would be the silent local fallback this module exists to remove, with a typo'd
 * `NEXT_PUBLIC_CHAIN_ID` quietly selecting the skeleton entry.
 */
export function resolveContractAddresses(
  chainId: number,
  env: { game?: string | undefined; rush?: string | undefined },
): ContractAddresses {
  const problems: string[] = [];
  const committed = CONTRACT_ADDRESSES[chainId] as ContractAddresses | undefined;

  const resolve = (name: string, raw: string | undefined, fallback: Address | undefined) => {
    const override = normalise(raw);
    if (override !== undefined && !ADDRESS_SHAPE.test(override)) {
      problems.push(`${name} is not a valid address (got ${JSON.stringify(override)})`);
      return undefined;
    }
    const value = (override as Address | undefined) ?? fallback;
    if (value === undefined) {
      problems.push(
        `${name} is not set and chain ${chainId} has no committed entry in lib/addresses.ts. ` +
          "Add the deployment to the address book, or set the variable explicitly.",
      );
    }
    return value;
  };

  const game = resolve("NEXT_PUBLIC_GAME_ADDRESS", env.game, committed?.game);
  const rush = resolve("NEXT_PUBLIC_RUSH_ADDRESS", env.rush, committed?.rush);

  if (problems.length > 0 || game === undefined || rush === undefined) {
    throw new Error(
      `Contract addresses for chain ${chainId} could not be resolved:\n  - ${problems.join("\n  - ")}`,
    );
  }
  return { game, rush };
}

/**
 * The resolved addresses for the configured chain.
 *
 * The env vars are read literally here (not via a helper) because Next.js inlines
 * `process.env.NEXT_PUBLIC_*` into the client bundle by textual reference, and a
 * dynamic lookup would read `undefined` in the browser.
 */
const resolved = resolveContractAddresses(ACTIVE_CHAIN_ID, {
  game: process.env.NEXT_PUBLIC_GAME_ADDRESS,
  rush: process.env.NEXT_PUBLIC_RUSH_ADDRESS,
});

export const GAME_ADDRESS: Address = resolved.game;
export const RUSH_ADDRESS: Address = resolved.rush;
