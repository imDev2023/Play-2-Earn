import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

/**
 * Robinhood Chain (Arbitrum Orbit L2) is the production target - see the spec.
 * Networks are wired here but left keyless in the scaffold; later tickets add
 * deploy config + secrets. Chain IDs: mainnet 4663, testnet 46630.
 */

/**
 * Accounts for a public network.
 *
 * The launch checklist (#26) needs *distinct* addresses for deployer, relayer, player
 * and guardian - running them all from one key would let access-control checks pass
 * for the wrong reason. `TESTNET_PRIVATE_KEYS` takes a comma-separated list; a single
 * `DEPLOYER_PRIVATE_KEY` still works for deploy-only runs.
 */
/**
 * Explorer hosts used for Blockscout verification. The mainnet host is the one the spec
 * names (§10); the testnet host mirrors what the frontend already points at.
 */
const TESTNET_EXPLORER =
  process.env.BLOCKSCOUT_TESTNET_URL ?? "https://explorer.testnet.chain.robinhood.com";
const MAINNET_EXPLORER =
  process.env.BLOCKSCOUT_MAINNET_URL ?? "https://robinhoodchain.blockscout.com";

function accountsFromEnv(): string[] {
  const list = process.env.TESTNET_PRIVATE_KEYS;
  if (list) {
    return list
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean);
  }
  return process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];
}
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      /**
       * Set explicitly because Hardhat's default here is `paris`, not solc 0.8.24's own
       * default - so leaving it unset silently gave up PUSH0 and MCOPY on a chain that
       * supports both. The evm-security profile requires this be a decision, not a default.
       *
       * `cancun` is chosen from what the chain actually accepts, not from what its parent
       * family is assumed to support. Both 4663 and 46630 report ArbOS 61, and an
       * `eth_call` probe with a state override confirmed on each: BASEFEE, PUSH0, MCOPY,
       * TSTORE and TLOAD all execute, while a deliberate `0xfe` control is rejected as an
       * invalid opcode - so the probe distinguishes support from a blanket accept.
       *
       * The one Cancun opcode this chain does NOT have is BLOBBASEFEE, which the node
       * rejects by name ("BLOBBASEFEE is not supported on Arbitrum"); BLOBHASH is the same
       * story. That is safe here only because solc emits those two solely when the source
       * reads `block.blobbasefee` or calls `blobhash()`, and nothing does. `test/EvmTarget.ts`
       * is the guard that keeps it that way - without it this setting is one blob-opcode
       * reference away from producing bytecode the chain cannot run.
       */
      evmVersion: "cancun",
    },
  },
  networks: {
    robinhoodTestnet: {
      url: process.env.ROBINHOOD_TESTNET_RPC_URL ?? "",
      chainId: 46630,
      accounts: accountsFromEnv(),
    },
    robinhoodMainnet: {
      url: process.env.ROBINHOOD_MAINNET_RPC_URL ?? "",
      chainId: 4663,
      accounts: accountsFromEnv(),
    },
  },

  /**
   * Blockscout source verification (#26, spec §10.7: "Verify all contracts on
   * Blockscout; publish addresses + the open-source verifier").
   *
   * Blockscout implements the Etherscan-compatible verification API but ignores the
   * API key, so a non-empty placeholder is all it wants. Both hosts are env-overridable
   * because only the mainnet one is named in the spec (`robinhoodchain.blockscout.com`);
   * the testnet default mirrors the explorer host the frontend already uses. If either
   * turns out to be wrong, `verify` fails loudly against a real endpoint rather than
   * silently reporting success.
   */
  etherscan: {
    apiKey: {
      robinhoodTestnet: process.env.BLOCKSCOUT_API_KEY ?? "blockscout",
      robinhoodMainnet: process.env.BLOCKSCOUT_API_KEY ?? "blockscout",
    },
    customChains: [
      {
        network: "robinhoodTestnet",
        chainId: 46630,
        urls: {
          apiURL: `${TESTNET_EXPLORER}/api`,
          browserURL: TESTNET_EXPLORER,
        },
      },
      {
        network: "robinhoodMainnet",
        chainId: 4663,
        urls: {
          apiURL: `${MAINNET_EXPLORER}/api`,
          browserURL: MAINNET_EXPLORER,
        },
      },
    ],
  },
  // Blockscout is the verification target; Sourcify would silently double-submit.
  sourcify: { enabled: false },
};

export default config;
