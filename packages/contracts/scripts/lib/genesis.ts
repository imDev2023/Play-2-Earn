/**
 * Genesis allocation of the fixed 1,000,000,000 RUSH supply (#26, spec §3).
 *
 * The whole supply is minted once to the deployer and then split across five buckets.
 * Shares are expressed in basis points and amounts derived with integer maths, so the
 * five buckets sum to exactly MAX_SUPPLY with no dust left behind — an invariant the
 * tests assert rather than assume.
 */

/** The fixed total supply: 1,000,000,000 RUSH (18 decimals). Mirrors Rushood.MAX_SUPPLY. */
export const MAX_SUPPLY = 1_000_000_000n * 10n ** 18n;

const BPS_DENOMINATOR = 10_000n;

/** Declared locally so this module stays free of an ethers import and remains pure. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The five genesis buckets, keyed by the role that ends up holding them. */
export type GenesisBucket = "treasury" | "liquidity" | "community" | "team" | "staking";

/** A bucket's share and what it is for. */
export interface GenesisShare {
  /** Share of total supply, in basis points. */
  readonly bps: bigint;
  /** Where the tokens end up, for the deployment log and the published addresses. */
  readonly destination: string;
}

/**
 * Spec §3. Percentages are locked by the spec; only the destinations vary by network.
 *
 * The liquidity bucket is the one that does not go to a contract directly — it is held
 * by the deployer just long enough to seed the Uniswap pool, after which the resulting
 * position NFT is locked in RushoodLPLock.
 */
export const GENESIS_ALLOCATION: Readonly<Record<GenesisBucket, GenesisShare>> = {
  treasury: { bps: 4_500n, destination: "Treasury contract (house bankroll)" },
  liquidity: { bps: 2_500n, destination: "Uniswap position, then RushoodLPLock" },
  community: { bps: 1_500n, destination: "Safe multisig (community / marketing / airdrop)" },
  team: { bps: 1_000n, destination: "RushoodVesting (6-mo cliff, linear to month 24)" },
  staking: { bps: 500n, destination: "Safe multisig (staking bootstrap reserve)" },
} as const;

/** Every bucket name, in spec order. */
export const GENESIS_BUCKETS = Object.keys(GENESIS_ALLOCATION) as readonly GenesisBucket[];

/** RUSH amount for a single bucket. */
export function allocationOf(bucket: GenesisBucket, totalSupply: bigint = MAX_SUPPLY): bigint {
  return (totalSupply * GENESIS_ALLOCATION[bucket].bps) / BPS_DENOMINATOR;
}

/** RUSH amounts for all five buckets. */
export function allocations(totalSupply: bigint = MAX_SUPPLY): Record<GenesisBucket, bigint> {
  return Object.fromEntries(
    GENESIS_BUCKETS.map((bucket) => [bucket, allocationOf(bucket, totalSupply)]),
  ) as Record<GenesisBucket, bigint>;
}

/**
 * Total across all buckets. Must equal `totalSupply` — if it ever doesn't, the split
 * is leaving tokens stranded on the deployer and the deployment should abort.
 */
export function allocationTotal(totalSupply: bigint = MAX_SUPPLY): bigint {
  return GENESIS_BUCKETS.reduce((sum, bucket) => sum + allocationOf(bucket, totalSupply), 0n);
}

/** Where each bucket's tokens are sent at genesis. */
export type GenesisDestinations = Readonly<Record<GenesisBucket, string>>;

/**
 * The slice of an ERC20 this module needs. Structural, so the distribution logic stays
 * decoupled from ethers' generated contract types and is exercised directly by tests.
 */
export interface TransferableToken {
  transfer(to: string, amount: bigint): Promise<{ wait(): Promise<unknown> }>;
  totalSupply(): Promise<bigint>;
  balanceOf(account: string): Promise<bigint>;
}

/**
 * Transfer the genesis allocation from the distributor to its five destinations.
 *
 * Aborts before moving anything if the split wouldn't consume the supply exactly, or if
 * the distributor doesn't hold the whole supply — a partial genesis distribution is far
 * harder to unwind than a failed one, and on mainnet it is unrecoverable.
 *
 * @returns The amount sent to each bucket.
 */
export async function distributeGenesis(
  token: TransferableToken,
  distributor: string,
  destinations: GenesisDestinations,
): Promise<Record<GenesisBucket, bigint>> {
  const totalSupply = await token.totalSupply();

  const total = allocationTotal(totalSupply);
  if (total !== totalSupply) {
    throw new Error(
      `Genesis split does not consume the supply exactly: ${total} allocated vs ${totalSupply} minted`,
    );
  }

  const held = await token.balanceOf(distributor);
  if (held !== totalSupply) {
    throw new Error(
      `Distributor ${distributor} holds ${held}, expected the full supply ${totalSupply}`,
    );
  }

  for (const bucket of GENESIS_BUCKETS) {
    if (!destinations[bucket] || destinations[bucket] === ZERO_ADDRESS) {
      throw new Error(`Genesis destination for "${bucket}" is unset`);
    }
  }

  const sent = allocations(totalSupply);
  for (const bucket of GENESIS_BUCKETS) {
    await (await token.transfer(destinations[bucket], sent[bucket])).wait();
  }
  return sent;
}
