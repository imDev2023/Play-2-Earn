import { ethers, network } from "hardhat";
import { isLocalNetwork } from "./lib/local-network";

/**
 * Deploy the RUSHOOD (RUSH) token.
 *
 * The entire fixed supply is minted to the distributor at construction. Pick the
 * distributor with DISTRIBUTOR_ADDRESS. On a local/in-process network we fall back
 * to the first signer for convenience; on any live network the address is required
 * so we never accidentally mint the whole supply to a throwaway account.
 *
 *   Local:   npx hardhat run scripts/deploy.ts
 *   Testnet: npx hardhat run scripts/deploy.ts --network robinhoodTestnet   (chainId 46630)
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const isLocal = isLocalNetwork(network.name);

  const distributor = process.env.DISTRIBUTOR_ADDRESS ?? (isLocal ? deployer.address : "");
  if (!distributor) {
    throw new Error(
      `DISTRIBUTOR_ADDRESS is required when deploying to "${network.name}". ` +
        `Set it to the address that should receive the full RUSH supply.`,
    );
  }

  console.log(`Network:      ${network.name}`);
  console.log(`Deployer:     ${deployer.address}`);
  console.log(`Distributor:  ${distributor}`);

  const Rushood = await ethers.getContractFactory("Rushood");
  const rush = await Rushood.deploy(distributor);
  await rush.waitForDeployment();

  const address = await rush.getAddress();
  const supply = await rush.totalSupply();
  const decimals = await rush.decimals();
  console.log(`RUSH deployed at: ${address}`);
  console.log(`Total supply:     ${ethers.formatUnits(supply, decimals)} RUSH -> ${distributor}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
