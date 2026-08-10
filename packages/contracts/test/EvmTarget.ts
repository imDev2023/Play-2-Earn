import { expect } from "chai";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import config from "../hardhat.config";

/**
 * The guard behind `evmVersion: "cancun"` in hardhat.config.ts.
 *
 * Robinhood Chain runs ArbOS 61 and accepts every Cancun opcode solc emits by itself -
 * PUSH0, MCOPY, TSTORE, TLOAD - but it rejects BLOBBASEFEE by name, and BLOBHASH with it.
 * solc only ever emits those two when the source explicitly reads `block.blobbasefee` or
 * calls `blobhash()`, so targeting Cancun is safe exactly as long as no source does.
 *
 * That is a property of the source tree, not of the config, so it needs a test rather
 * than a comment: without one, the first contract to read a blob field would compile
 * clean, deploy, and revert with an invalid opcode on a chain nobody re-probed.
 */

const CONTRACTS_DIR = join(__dirname, "..", "contracts");

/** Every .sol under `dir`, recursively. */
function soliditySources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...soliditySources(full));
    else if (entry.endsWith(".sol")) found.push(full);
  }
  return found;
}

/** Comments are not code; a blob opcode named in prose must not fail the build. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

describe("EVM target", () => {
  it("pins evmVersion explicitly rather than inheriting Hardhat's default", () => {
    // Hardhat's default is `paris`, which is neither solc 0.8.24's own default nor what
    // this chain supports. The security profile requires the choice be recorded.
    const solidity = config.solidity as { settings?: { evmVersion?: string } };
    expect(solidity.settings?.evmVersion).to.equal("cancun");
  });

  it("uses no blob opcode, which is the only reason cancun is safe here", () => {
    const offenders = soliditySources(CONTRACTS_DIR).filter((file) => {
      const code = stripComments(readFileSync(file, "utf8"));
      return /\bblock\s*\.\s*blobbasefee\b/.test(code) || /\bblobhash\s*\(/.test(code);
    });

    expect(
      offenders,
      "Robinhood Chain rejects BLOBBASEFEE and BLOBHASH. Reading a blob field compiles " +
        "under cancun and then reverts on chain as an invalid opcode. Drop the read, or " +
        "lower evmVersion to shanghai and re-probe the chain first.",
    ).to.deep.equal([]);
  });
});
