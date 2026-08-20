import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

/**
 * Every wagmi call that touches a chain must say which chain, in source, at the call
 * site. This is #63's guard.
 *
 * A wagmi read with no `chainId` resolves to the connected wallet's chain, or with no
 * wallet to `wagmiConfig.chains[0]` - which is `hardhat`, so a testnet build with no
 * wallet reads whoever answers on 127.0.0.1:8545. Eight sites shipped that way, and
 * both e2e suites run against a local node where the configured chain and `chains[0]`
 * are the same value, so no suite could see it. Fixing the eight sites without this
 * file would fix eight instances of an open-ended class: the ninth would type-check,
 * render, and pass every test, exactly as the first eight did.
 *
 * So this walks the app's sources and fails on any chain-touching wagmi call that does
 * not pin `chainId`. It is deliberately a *closed world*: every name imported from
 * `"wagmi"` or `"wagmi/actions"` must be classified below as either chain-bound or
 * chain-free, and an import this file has never heard of fails the test until someone
 * classifies it. A guard that only checks the calls it already knows about would be as
 * wide as the list someone chose to write down, which is how `abi-matches-artifact`'s
 * constants went unguarded and how the EvmTarget scan missed the Yul spelling.
 *
 * Honest limits, so nobody reads more assurance into this than it gives:
 *
 * - The pin must be a literal `chainId:` property (or shorthand) in the options object
 *   at the call site. A pin smuggled in through a spread fails the test even though it
 *   might work at runtime; write it literally, so the reader and this guard see the
 *   same thing.
 * - Method calls on a client (`client.getLogs(...)`) are not import-tracked. They are
 *   covered by pinning the client itself: `getPublicClient` is chain-bound, so a
 *   client can only be acquired for an explicit chain.
 * - `viem` is not restricted. Nothing in the app builds a viem client directly; if
 *   that changes, extend this to `"viem"` imports rather than trusting this note.
 */

/** Hooks whose single options argument must carry `chainId`. */
const PINNED_HOOKS = new Set(["useBlock", "useReadContract", "useSimulateContract", "useWatchContractEvent"]);

/** Actions of shape `(config, options)` whose options must carry `chainId`. */
const PINNED_ACTIONS = new Set([
  "getBalance",
  "getBlock",
  "getBlockNumber",
  "getPublicClient",
  "readContract",
  "simulateContract",
  "waitForTransactionReceipt",
  "watchContractEvent",
  "writeContract",
]);

/**
 * Imports that never pick a chain by themselves. `useAccount` and friends report or
 * steer the *wallet's* chain, which is the thing the pins exist to stop following;
 * they take no options that route a read.
 */
const CHAIN_FREE = new Set([
  "createConfig",
  "http",
  "useAccount",
  "useChainId",
  "useConnect",
  "useConnections",
  "useDisconnect",
  "useSwitchChain",
  "WagmiProvider",
]);

/** Chain-bound names needing bespoke handling rather than the two shapes above. */
const SPECIAL = new Set(["useReadContracts", "useWriteContract"]);

interface Violation {
  file: string;
  line: number;
  message: string;
}

function violationAt(sourceFile: ts.SourceFile, node: ts.Node, message: string): Violation {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file: sourceFile.fileName, line: line + 1, message };
}

function hasChainIdProperty(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      ts.isIdentifier(p.name) &&
      p.name.text === "chainId",
  );
}

function hasProperty(obj: ts.ObjectLiteralExpression, name: string): boolean {
  return obj.properties.some(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      ts.isIdentifier(p.name) &&
      p.name.text === name,
  );
}

/**
 * All chain-touching wagmi call sites in `source` that do not pin `chainId`, plus any
 * wagmi import this file cannot classify. Pure over its inputs, so the plant tests
 * below exercise the same function the repo scan trusts - both halves of the join.
 */
export function findUnpinnedChainCalls(fileName: string, source: string): Violation[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations: Violation[] = [];

  /** local identifier -> imported wagmi name, for chain-bound imports only. */
  const tracked = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    if (module !== "wagmi" && module !== "wagmi/actions") continue;

    const clause = statement.importClause;
    if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
      violations.push(
        violationAt(
          sourceFile,
          statement,
          `only named imports from "${module}" can be checked for chain pinning - rewrite this import`,
        ),
      );
      continue;
    }
    for (const binding of clause.namedBindings.elements) {
      if (binding.isTypeOnly) continue;
      const imported = (binding.propertyName ?? binding.name).text;
      if (CHAIN_FREE.has(imported)) continue;
      if (PINNED_HOOKS.has(imported) || PINNED_ACTIONS.has(imported) || SPECIAL.has(imported)) {
        tracked.set(binding.name.text, imported);
        continue;
      }
      violations.push(
        violationAt(
          sourceFile,
          binding,
          `"${imported}" from "${module}" is not classified in chain-pinning.test.ts - ` +
            "decide whether it touches a chain and add it to the chain-bound or chain-free list",
        ),
      );
    }
  }

  /** Local names bound to `useWriteContract()`'s write functions. */
  const writeFns = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression;
      if (ts.isIdentifier(callee) && tracked.get(callee.text) === "useWriteContract") {
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const property = (element.propertyName ?? element.name).getText(sourceFile);
            if (
              (property === "writeContract" || property === "writeContractAsync") &&
              ts.isIdentifier(element.name)
            ) {
              writeFns.add(element.name.text);
            }
          }
        } else {
          violations.push(
            violationAt(
              sourceFile,
              node,
              "destructure useWriteContract() so its write functions can be checked for chainId",
            ),
          );
        }
      }
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const local = node.expression.text;
      const imported = tracked.get(local);

      if (imported && PINNED_HOOKS.has(imported)) {
        const options = node.arguments[0];
        if (!options || !ts.isObjectLiteralExpression(options) || !hasChainIdProperty(options)) {
          violations.push(
            violationAt(sourceFile, node, `${imported} must pin chainId in its options object`),
          );
        }
      } else if (imported && PINNED_ACTIONS.has(imported)) {
        const options = node.arguments[1];
        if (!options || !ts.isObjectLiteralExpression(options) || !hasChainIdProperty(options)) {
          violations.push(
            violationAt(sourceFile, node, `${imported} must pin chainId in its second argument`),
          );
        }
      } else if (imported === "useReadContracts") {
        // The pin lives per entry here, not on the hook: wagmi routes each contract in
        // `contracts` by that entry's own chainId. Entries are recognised as any object
        // literal carrying `abi`, which finds them inside `.map(...)`/`.flatMap(...)`
        // builders as well as written-out arrays.
        const options = node.arguments[0];
        if (!options || !ts.isObjectLiteralExpression(options)) {
          violations.push(
            violationAt(sourceFile, node, "useReadContracts must be given a literal options object"),
          );
        } else {
          let sawEntry = false;
          const findEntries = (candidate: ts.Node): void => {
            if (ts.isObjectLiteralExpression(candidate) && hasProperty(candidate, "abi")) {
              sawEntry = true;
              if (!hasChainIdProperty(candidate)) {
                violations.push(
                  violationAt(
                    sourceFile,
                    candidate,
                    "every useReadContracts entry must pin chainId",
                  ),
                );
              }
            }
            ts.forEachChild(candidate, findEntries);
          };
          findEntries(options);
          if (!sawEntry) {
            violations.push(
              violationAt(
                sourceFile,
                node,
                "useReadContracts entries could not be found as object literals with an `abi` " +
                  "property - inline them so their chainId pin is checkable",
              ),
            );
          }
        }
      } else if (writeFns.has(local)) {
        const options = node.arguments[0];
        if (!options || !ts.isObjectLiteralExpression(options) || !hasChainIdProperty(options)) {
          violations.push(
            violationAt(
              sourceFile,
              node,
              `${local} (from useWriteContract) must pin chainId so the wallet is asked to ` +
                "switch rather than signing on whatever chain it is on",
            ),
          );
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return violations;
}

const WEB_ROOT = join(__dirname, "..");

function sourceFilesUnder(...roots: string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
    for (const entry of readdirSync(join(WEB_ROOT, root), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      files.push(join(entry.parentPath, entry.name));
    }
  }
  return files;
}

describe("chain pinning (#63)", () => {
  it("every chain-touching wagmi call in app/ and lib/ pins chainId", () => {
    const files = sourceFilesUnder("app", "lib");
    // A scan over zero files passes for free. Anchor it to two files that must exist
    // for the app to function at all, so a broken glob fails here rather than passing
    // as "no violations".
    for (const anchor of ["app/PlayPanel.tsx", "lib/useBetHistory.ts"]) {
      assert.ok(
        files.some((file) => relative(WEB_ROOT, file) === anchor),
        `scan did not visit ${anchor} - the file walk is broken, not the app clean`,
      );
    }
    const violations = files.flatMap((file) =>
      findUnpinnedChainCalls(file, readFileSync(file, "utf8")),
    );
    const report = violations
      .map((v) => `${relative(WEB_ROOT, v.file)}:${v.line} ${v.message}`)
      .join("\n");
    assert.deepEqual(violations, [], `unpinned chain call sites:\n${report}`);
  });

  // Each rule is proven to fail on a planted violation before its pass is believed;
  // a check that has never failed is measuring nothing.
  describe("the analyzer flags each planted violation", () => {
    const flags = (source: string, fileName = "plant.ts") =>
      findUnpinnedChainCalls(fileName, source).map((v) => v.message);

    it("unpinned readContract", () => {
      const found = flags(`
        import { readContract } from "wagmi/actions";
        import { wagmiConfig } from "./wagmi";
        const bet = await readContract(wagmiConfig, { address, abi, functionName: "bets" });
      `);
      assert.equal(found.length, 1);
      assert.match(found[0], /readContract must pin chainId/);
    });

    it("pinned readContract passes", () => {
      const found = flags(`
        import { readContract } from "wagmi/actions";
        import { wagmiConfig } from "./wagmi";
        import { activeChainId } from "./chain";
        const bet = await readContract(wagmiConfig, { chainId: activeChainId, address, abi, functionName: "bets" });
      `);
      assert.deepEqual(found, []);
    });

    it("getPublicClient without a chain", () => {
      const found = flags(`
        import { getPublicClient } from "wagmi/actions";
        import { wagmiConfig } from "./wagmi";
        const client = getPublicClient(wagmiConfig);
      `);
      assert.equal(found.length, 1);
      assert.match(found[0], /getPublicClient must pin chainId/);
    });

    it("unpinned hook (useBlock)", () => {
      const found = flags(`
        import { useBlock } from "wagmi";
        const { data } = useBlock({ watch: true });
      `);
      assert.equal(found.length, 1);
      assert.match(found[0], /useBlock must pin chainId/);
    });

    it("unpinned useWatchContractEvent", () => {
      const found = flags(`
        import { useWatchContractEvent } from "wagmi";
        useWatchContractEvent({ address, abi, eventName: "BetPlaced", onLogs });
      `);
      assert.equal(found.length, 1);
      assert.match(found[0], /useWatchContractEvent must pin chainId/);
    });

    it("useReadContracts entry built by map without chainId", () => {
      const found = flags(`
        import { useReadContracts } from "wagmi";
        const { data } = useReadContracts({
          contracts: VIEWS.map((functionName) => ({ address, abi, functionName })),
        });
      `);
      assert.equal(found.length, 1);
      assert.match(found[0], /every useReadContracts entry must pin chainId/);
    });

    it("useReadContracts with pinned entries passes", () => {
      const found = flags(`
        import { useReadContracts } from "wagmi";
        import { activeChainId } from "./chain";
        const { data } = useReadContracts({
          contracts: VIEWS.map((functionName) => ({ chainId: activeChainId, address, abi, functionName })),
        });
      `);
      assert.deepEqual(found, []);
    });

    it("useReadContracts whose entries cannot be seen at the call site", () => {
      const found = flags(`
        import { useReadContracts } from "wagmi";
        const { data } = useReadContracts({ contracts: prebuiltSomewhereElse });
      `);
      assert.equal(found.length, 1);
      assert.match(found[0], /could not be found as object literals/);
    });

    it("unpinned write through useWriteContract", () => {
      const found = flags(`
        import { useWriteContract } from "wagmi";
        const { writeContractAsync } = useWriteContract();
        await writeContractAsync({ address, abi, functionName: "pause" });
      `);
      assert.equal(found.length, 1);
      assert.match(found[0], /must pin chainId so the wallet is asked to switch/);
    });

    it("renamed write function is still tracked", () => {
      const found = flags(`
        import { useWriteContract } from "wagmi";
        const { writeContractAsync: writeAsync } = useWriteContract();
        await writeAsync({ address, abi, functionName: "pause" });
      `);
      assert.equal(found.length, 1);
    });

    it("an unclassified wagmi import fails until someone classifies it", () => {
      const found = flags(`
        import { getEnsName } from "wagmi/actions";
      `);
      assert.equal(found.length, 1);
      assert.match(found[0], /not classified in chain-pinning\.test\.ts/);
    });

    it("a pin hidden in a spread is rejected, by design", () => {
      const found = flags(`
        import { readContract } from "wagmi/actions";
        import { wagmiConfig } from "./wagmi";
        const PINNED = { chainId: 46630 } as const;
        const bet = await readContract(wagmiConfig, { ...PINNED, address, abi, functionName: "bets" });
      `);
      assert.equal(found.length, 1);
    });
  });
});
