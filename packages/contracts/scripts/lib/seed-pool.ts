import { Interface, type Log } from "ethers";
import { buildSeedParams, type SeedParams } from "./uniswap-price";

/**
 * Seed the RUSH/ETH Uniswap v3 pool and put the resulting position straight into the
 * lock (#26, spec §10.5).
 *
 * The position is minted with the lock as its recipient rather than minted to the
 * deployer and transferred afterwards. That removes the window in which a launch
 * position sits unlocked in an EOA - a window that, on mainnet, is exactly when
 * everyone is watching.
 *
 * ETH is wrapped to WETH first and the pool is seeded as a plain two-ERC20 mint. The
 * position manager can take native ETH via multicall+refundETH, but that path is
 * fiddlier and its failure mode (ETH stranded in the position manager) is worse.
 */

/**
 * The position manager's surface, as the real Uniswap v3 contract declares it.
 *
 * Stated explicitly rather than borrowed from the local mock's artifact: the mock and
 * the real contract happen to share these signatures today, but binding a deploy script
 * that moves the entire liquidity allocation to a *test fixture's* ABI is the kind of
 * coincidence that stops being true quietly.
 */
export const POSITION_MANAGER_ABI = [
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
] as const;

/** Canonical WETH's wrap + ERC20 surface. */
export const WETH_ABI = [
  "function deposit() payable",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
] as const;

/** Uniswap's `IncreaseLiquidity`, the event that carries the new position's id. */
const POSITION_MANAGER_EVENTS = new Interface([
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
]);

/** A sent transaction that can be awaited for its receipt. */
interface SentTx {
  wait(): Promise<{ logs: readonly Log[] } | null>;
}

/** The slice of an ERC20 the seeding flow uses. */
interface ApprovableToken {
  approve(spender: string, amount: bigint): Promise<SentTx>;
  getAddress(): Promise<string>;
}

/** The slice of WETH the seeding flow uses. */
interface WrappedEth extends ApprovableToken {
  deposit(overrides: { value: bigint }): Promise<SentTx>;
}

/** The slice of the position manager the seeding flow uses. */
interface PositionManager {
  getAddress(): Promise<string>;
  createAndInitializePoolIfNecessary(
    token0: string,
    token1: string,
    fee: number,
    sqrtPriceX96: bigint,
  ): Promise<SentTx>;
  mint(params: {
    token0: string;
    token1: string;
    fee: number;
    tickLower: number;
    tickUpper: number;
    amount0Desired: bigint;
    amount1Desired: bigint;
    amount0Min: bigint;
    amount1Min: bigint;
    recipient: string;
    deadline: bigint;
  }): Promise<SentTx>;
}

export interface SeedPoolRequest {
  readonly positionManager: PositionManager;
  readonly rush: ApprovableToken;
  readonly weth: WrappedEth;
  /** Where the position NFT is minted - the LP lock. */
  readonly recipient: string;
  readonly rushAmount: bigint;
  readonly ethAmount: bigint;
  readonly feeTier?: number;
  /** Seconds from now the mint must land within. */
  readonly deadlineSeconds?: bigint;
  /** Current chain time, used to build the mint deadline. */
  readonly now: bigint;
}

export interface SeedPoolResult {
  readonly tokenId: bigint;
  readonly params: SeedParams;
  readonly rushAddress: string;
  readonly wethAddress: string;
}

const DEFAULT_DEADLINE_SECONDS = 30n * 60n;

/**
 * Wrap, approve, initialize and mint - returning the locked position's id.
 *
 * `amount0Min`/`amount1Min` are left at zero deliberately: this is the pool's first
 * and only mint, so there is no existing price for slippage to move against. Any
 * later liquidity addition should set them.
 */
export async function seedPoolAndLock(request: SeedPoolRequest): Promise<SeedPoolResult> {
  const [rushAddress, wethAddress, positionManagerAddress] = await Promise.all([
    request.rush.getAddress(),
    request.weth.getAddress(),
    request.positionManager.getAddress(),
  ]);

  const params = buildSeedParams({
    tokenA: rushAddress,
    amountA: request.rushAmount,
    tokenB: wethAddress,
    amountB: request.ethAmount,
    feeTier: request.feeTier,
  });

  await (await request.weth.deposit({ value: request.ethAmount })).wait();
  await (await request.rush.approve(positionManagerAddress, request.rushAmount)).wait();
  await (await request.weth.approve(positionManagerAddress, request.ethAmount)).wait();

  await (
    await request.positionManager.createAndInitializePoolIfNecessary(
      params.token0,
      params.token1,
      params.fee,
      params.sqrtPriceX96,
    )
  ).wait();

  const receipt = await (
    await request.positionManager.mint({
      token0: params.token0,
      token1: params.token1,
      fee: params.fee,
      tickLower: params.tickLower,
      tickUpper: params.tickUpper,
      amount0Desired: params.amount0,
      amount1Desired: params.amount1,
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: request.recipient,
      deadline: request.now + (request.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS),
    })
  ).wait();

  const tokenId = extractTokenId(receipt?.logs ?? []);
  return { tokenId, params, rushAddress, wethAddress };
}

/** Pull the new position's id out of the mint receipt. */
function extractTokenId(logs: readonly Log[]): bigint {
  for (const log of logs) {
    try {
      const parsed = POSITION_MANAGER_EVENTS.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (parsed?.name === "IncreaseLiquidity") return parsed.args.tokenId as bigint;
    } catch {
      // Not one of ours - the receipt also carries ERC20 Transfers and the pool's own logs.
      continue;
    }
  }
  throw new Error("Pool seeded but no IncreaseLiquidity event found - cannot identify the position");
}
