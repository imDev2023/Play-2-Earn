import { expect } from "chai";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import config from "../hardhat.config";

/**
 * The guard behind `evmVersion: "cancun"` in hardhat.config.ts.
 *
 * Robinhood Chain runs ArbOS 61 and accepts every Cancun opcode solc emits by itself -
 * PUSH0, MCOPY, TSTORE, TLOAD - but it rejects BLOBBASEFEE by name, and BLOBHASH with it.
 * solc only ever emits those two when something asks for them, so targeting Cancun is
 * safe exactly as long as nothing does.
 *
 * That is a property of the compiled output, not of the config, so it needs a test rather
 * than a comment: without one, the first contract to read a blob field would compile
 * clean, deploy, and revert with an invalid opcode on a chain nobody re-probed.
 *
 * Both tests below read solc's build-info, which is the record of what solc actually
 * compiled. The first version of this file walked `contracts/` instead, and that was
 * wrong twice over: it missed the Yul spelling `blobbasefee()` in an assembly block, and
 * it never looked at the submodule property templates that `RushoodProperties` imports
 * and compiles. A directory is a guess at what gets compiled; build-info is the answer.
 */

const ARTIFACTS_DIR = join(__dirname, "..", "artifacts");

/** The two opcodes ArbOS rejects, under the names solc disassembles them to. */
const FORBIDDEN = ["BLOBBASEFEE", "BLOBHASH"];

/**
 * Every spelling that makes solc emit one of them.
 *
 * The set is closed: BLOBBASEFEE comes from `block.blobbasefee` or Yul `blobbasefee()`,
 * BLOBHASH from `blobhash(...)` in either language. Missing the Yul form is what let the
 * previous guard pass over a planted `assembly { let x := blobbasefee() }`.
 */
const BLOB_READS = [
  { pattern: /\bblock\s*\.\s*blobbasefee\b/, spelling: "block.blobbasefee" },
  { pattern: /\bblobbasefee\s*\(/, spelling: "blobbasefee() in assembly" },
  { pattern: /\bblobhash\s*\(/, spelling: "blobhash()" },
];

interface Bytecode {
  object: string;
  opcodes: string;
}

interface BuildInfo {
  input: { sources: Record<string, { content: string }> };
  output: {
    contracts: Record<string, Record<string, { evm?: { deployedBytecode?: Bytecode } }>>;
  };
}

interface Unit {
  sourceName: string;
  contractName: string;
  source: string;
  runtime?: Bytecode;
}

/**
 * Every contract in the tree as it stands now, with the source and bytecode it was last
 * compiled from.
 *
 * Each entry is read through the artifact's own `.dbg.json`, and only the artifact's own
 * slice of the build-info it points at is taken. That indirection is the whole point.
 * Hardhat compiles incrementally and leaves earlier build-info files behind, and each one
 * carries a full copy of every source in its compilation unit - so a build-info still
 * reachable from some untouched contract can hold a stale copy of a file that has since
 * been edited and recompiled elsewhere. Reading build-infos whole reports code that no
 * longer exists: an earlier draft of this test failed on a `block.blobbasefee` that had
 * been deleted two compiles previously. An artifact, by contrast, always points at the
 * build-info that produced it, so its own entry is current by construction.
 */
function compiledUnits(dir: string): Unit[] {
  const units: Unit[] = [];
  const loaded = new Map<string, BuildInfo>();

  const walk = (from: string) => {
    for (const entry of readdirSync(from)) {
      const full = join(from, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "build-info") walk(full);
        continue;
      }
      if (!entry.endsWith(".dbg.json")) continue;

      const { buildInfo } = JSON.parse(readFileSync(full, "utf8")) as { buildInfo: string };
      const path = resolve(dirname(full), buildInfo);
      if (!loaded.has(path)) loaded.set(path, JSON.parse(readFileSync(path, "utf8")) as BuildInfo);
      const info = loaded.get(path)!;

      const { sourceName, contractName } = JSON.parse(
        readFileSync(full.replace(/\.dbg\.json$/, ".json"), "utf8"),
      ) as { sourceName: string; contractName: string };

      units.push({
        sourceName,
        contractName,
        source: info.input.sources[sourceName]?.content ?? "",
        runtime: info.output.contracts[sourceName]?.[contractName]?.evm?.deployedBytecode,
      });
    }
  };

  walk(dir);
  return units;
}

/** Comments are not code; a blob opcode named in prose must not fail the build. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * How much of `object` is code rather than solc's trailing CBOR metadata, whose own last
 * two bytes are its length.
 *
 * The metadata is a hash, and solc disassembles it along with everything else - so with
 * two of the 256 byte values forbidden, roughly a third of contracts would report a blob
 * opcode that is not there. Truncating here is what keeps this test from failing at random.
 */
function codeByteLength(object: string): number {
  const bytes = Buffer.from(object.replace(/^0x/, ""), "hex");
  if (bytes.length < 2) return bytes.length;
  const code = bytes.length - 2 - bytes.readUInt16BE(bytes.length - 2);
  return code > 0 ? code : bytes.length;
}

/**
 * The opcodes solc says it emitted, up to the start of the metadata blob.
 *
 * Taking solc's disassembly rather than walking the hex is deliberate. A hand-rolled walk
 * has to skip each PUSH's operand to stay aligned, and has to hard-code that BLOBHASH is
 * 0x49 and BLOBBASEFEE is 0x4a - a pair it is easy to write down backwards, and nothing
 * would notice. solc already did both jobs.
 */
function mnemonics({ object, opcodes }: Bytecode): Set<string> {
  const limit = codeByteLength(object);
  const tokens = opcodes.trim().split(/\s+/);
  const seen = new Set<string>();
  for (let i = 0, offset = 0; i < tokens.length && offset < limit;) {
    const token = tokens[i];
    seen.add(token);
    // PUSH1..PUSH32 are followed by an operand token that is data, not an instruction.
    const operandBytes = /^PUSH([1-9]|[12]\d|3[0-2])$/.test(token) ? Number(token.slice(4)) : 0;
    offset += 1 + operandBytes;
    i += operandBytes > 0 ? 2 : 1;
  }
  return seen;
}

/**
 * Contracts whose presence proves the scan reached the places the two known leaks were.
 *
 * A scan over nothing passes, and so does a scan over the wrong half of the tree.
 * `SolvencyCore` is the anchor that matters most: it lives in the submodule, and its
 * absence would mean the templates had silently dropped out of scope again.
 */
const MUST_BE_SCANNED = ["RushoodGame", "Treasury", "RushoodProperties", "SolvencyCore"];

describe("EVM target", () => {
  it("pins evmVersion explicitly rather than inheriting Hardhat's default", () => {
    // Hardhat's default is `paris`, which is neither solc 0.8.24's own default nor what
    // this chain supports. The security profile requires the choice be recorded.
    const solidity = config.solidity as { settings?: { evmVersion?: string } };
    expect(solidity.settings?.evmVersion).to.equal("cancun");
  });

  it("emits no blob opcode, which is the only reason cancun is safe here", () => {
    const units = compiledUnits(ARTIFACTS_DIR);
    const offenders: string[] = [];

    for (const unit of units) {
      // Interfaces and abstract contracts compile to nothing to run.
      if (!unit.runtime?.object || unit.runtime.object === "0x") continue;
      const present = mnemonics(unit.runtime);
      for (const op of FORBIDDEN) {
        if (present.has(op)) offenders.push(`${op} in ${unit.contractName} (${unit.sourceName})`);
      }
    }

    const scanned = units.map((unit) => unit.contractName);
    for (const required of MUST_BE_SCANNED) {
      expect(scanned, `${required} was not scanned, so this test proved nothing`).to.include(
        required,
      );
    }

    expect(
      offenders,
      "Robinhood Chain rejects BLOBBASEFEE and BLOBHASH. Emitting either compiles under " +
        "cancun and then reverts on chain as an invalid opcode. Drop the read, or lower " +
        "evmVersion to shanghai and re-probe the chain first.",
    ).to.deep.equal([]);
  });

  it("asks for no blob field in any compiled source, constructors included", () => {
    // The runtime scan above cannot see a constructor: creation bytecode embeds the
    // runtime of every contract the constructor deploys, each with its own metadata blob,
    // and there is no reliable point at which to stop disassembling one that runs through
    // them. So the constructor half of the property is checked at the source instead.
    const units = compiledUnits(ARTIFACTS_DIR);
    const offenders = new Set<string>();

    for (const unit of units) {
      const code = stripComments(unit.source);
      for (const { pattern, spelling } of BLOB_READS) {
        if (pattern.test(code)) offenders.add(`${spelling} in ${unit.sourceName}`);
      }
    }

    const scanned = units.map((unit) => unit.contractName);
    for (const required of MUST_BE_SCANNED) {
      expect(scanned, `${required} was not scanned, so this test proved nothing`).to.include(
        required,
      );
    }

    expect(
      [...offenders],
      "Robinhood Chain rejects BLOBBASEFEE and BLOBHASH. Reading a blob field compiles " +
        "under cancun and then reverts on chain as an invalid opcode.",
    ).to.deep.equal([]);
  });
});
