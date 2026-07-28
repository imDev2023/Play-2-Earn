import { ContractFactory, type Signer } from "ethers";

import FactoryArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";
import NFTDescriptorArtifact from "@uniswap/v3-periphery/artifacts/contracts/libraries/NFTDescriptor.sol/NFTDescriptor.json";
import PositionDescriptorArtifact from "@uniswap/v3-periphery/artifacts/contracts/NonfungibleTokenPositionDescriptor.sol/NonfungibleTokenPositionDescriptor.json";
import PositionManagerArtifact from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json";

/**
 * Stand up Uniswap v3 on a chain that does not have it (#26).
 *
 * Robinhood Chain testnet 46630 has no Uniswap v3 deployment — Uniswap publishes
 * addresses for mainnet 4663 only, and `eth_getCode` at each of those addresses on 46630
 * comes back empty. (The UniversalRouter address does have code on testnet, but it is a
 * same-nonce mirror whose immutables point at the mainnet factory and position manager,
 * neither of which exists there. It cannot route anything.)
 *
 * Without a position manager the launch rehearsal cannot seed a pool, and the last
 * unexercised step of the launch sequence stays unexercised. So we bring our own.
 *
 * These are Uniswap's *own published artifacts*, deployed byte-for-byte rather than
 * recompiled from source. That matters more than it looks: the periphery finds pools by
 * CREATE2, using a pool init-code hash fixed at compile time. Recompiling the core with
 * a different solc or optimizer setting changes the deployed pool bytecode, the computed
 * addresses stop matching the real ones, and mints revert somewhere unhelpful. Shipping
 * the artifacts keeps core and periphery in the agreement they were built with.
 */

/**
 * Chains where Uniswap v3 is already deployed, and the position manager to use there.
 *
 * Consulted only to *refuse*: standing up a second factory next to a canonical one would
 * put the launch liquidity in a pool that no router, aggregator or price feed indexes —
 * a launch that looks seeded from the deploy log and is invisible everywhere else.
 */
export const CANONICAL_V3_POSITION_MANAGERS: Readonly<Record<number, string>> = {
  // Robinhood Chain mainnet — developers.uniswap.org, v3 Robinhood Chain deployments.
  4663: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
};

/** The three fee tiers a stock UniswapV3Factory enables in its constructor. */
export const EXPECTED_FEE_TIERS = [500, 3000, 10000] as const;

/**
 * Refuse to self-deploy where a canonical Uniswap already exists.
 *
 * Throws rather than warns. A warning printed into a long deploy log is a warning nobody
 * reads until the liquidity is already in the wrong pool, and the LP position is locked
 * for two years afterwards.
 */
export function assertSelfDeployIsWarranted(chainId: bigint): void {
  const canonical = CANONICAL_V3_POSITION_MANAGERS[Number(chainId)];
  if (canonical) {
    throw new Error(
      `Chain ${chainId} already has Uniswap v3 — deploying another factory would seed the ` +
        `launch liquidity into a pool nothing indexes. Set UNISWAP_POSITION_MANAGER=${canonical} ` +
        `and use the canonical deployment instead.`,
    );
  }
}

/** The addresses of a freshly stood-up Uniswap v3. */
export interface UniswapV3Stack {
  readonly factory: string;
  readonly nftDescriptorLibrary: string;
  readonly positionDescriptor: string;
  readonly positionManager: string;
  readonly weth9: string;
}

export interface DeployStackOptions {
  /**
   * The wrapped-native token the position manager unwraps through. Supplied by the
   * caller rather than deployed here: on a chain that *does* have a canonical WETH, that
   * is the one to use even when Uniswap itself is missing.
   */
  readonly weth9: string;
  /** Native currency label baked into the position NFT's SVG. Robinhood Chain is ETH. */
  readonly nativeCurrencyLabel?: string;
}

/**
 * Deploy factory, descriptor and position manager, and return their addresses.
 *
 * Deliberately does not deploy the router, quoter or multicall: the launch sequence only
 * ever creates a pool and mints one position, and every extra contract here is another
 * address the published list would have to explain.
 */
export async function deployUniswapV3Stack(
  deployer: Signer,
  options: DeployStackOptions,
): Promise<UniswapV3Stack> {
  const factory = await deployFrom(FactoryArtifact.abi, FactoryArtifact.bytecode, deployer);

  // The descriptor renders the position NFT's on-chain SVG. It is cosmetic, but the
  // position manager takes it as a constructor argument, and passing the zero address
  // there leaves `tokenURI` reverting on every position — including the launch one, in
  // any wallet that tries to display it.
  const nftDescriptorLibrary = await deployFrom(
    NFTDescriptorArtifact.abi,
    NFTDescriptorArtifact.bytecode,
    deployer,
  );
  const positionDescriptor = await deployFrom(
    PositionDescriptorArtifact.abi,
    linkLibrary(PositionDescriptorArtifact.bytecode, "NFTDescriptor", nftDescriptorLibrary),
    deployer,
    [options.weth9, encodeCurrencyLabel(options.nativeCurrencyLabel ?? "ETH")],
  );

  const positionManager = await deployFrom(
    PositionManagerArtifact.abi,
    PositionManagerArtifact.bytecode,
    deployer,
    [factory, options.weth9, positionDescriptor],
  );

  return {
    factory,
    nftDescriptorLibrary,
    positionDescriptor,
    positionManager,
    weth9: options.weth9,
  };
}

async function deployFrom(
  abi: unknown,
  bytecode: string,
  deployer: Signer,
  args: readonly unknown[] = [],
): Promise<string> {
  const contract = await new ContractFactory(abi as never, bytecode, deployer).deploy(...args);
  await contract.waitForDeployment();
  return contract.getAddress();
}

/**
 * Splice a deployed library address into unlinked bytecode.
 *
 * Solidity leaves `__$<hash>$__` placeholders where a linked library's address belongs.
 * Only the descriptor needs this — `NFTDescriptor` is too large to inline.
 */
function linkLibrary(bytecode: string, name: string, address: string): string {
  const placeholder = new RegExp(`__\\$[0-9a-fA-F]{34}\\$__|__${name}_+`, "g");
  const linked = bytecode.replace(placeholder, address.replace(/^0x/, "").toLowerCase());
  if (linked.includes("__")) {
    throw new Error(`Unlinked library placeholder remains after linking ${name}`);
  }
  return linked;
}

/** Uniswap stores the native currency label as a right-padded bytes32. */
function encodeCurrencyLabel(label: string): string {
  const bytes = Buffer.from(label, "utf8");
  if (bytes.length > 32) throw new Error(`Native currency label "${label}" exceeds 32 bytes`);
  return "0x" + Buffer.concat([bytes, Buffer.alloc(32 - bytes.length)]).toString("hex");
}
