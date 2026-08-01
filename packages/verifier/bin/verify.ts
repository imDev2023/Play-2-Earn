#!/usr/bin/env node
/**
 * `rushood-verify` - check a RUSHOOD roll from the command line.
 *
 * The point of this file is that you don't have to trust rushood's website to
 * believe a result. It talks to nothing: give it the numbers the chain published
 * and it re-runs the draw locally.
 *
 *   npm run verify -- \
 *     --betId 7 --tier 5 --clientEntropy 0x1f… --serverReveal 0x… --commitment 0x…
 *
 * Or paste the share link straight off the in-app fairness panel:
 *
 *   npm run verify -- --url "https://rushood.example/verify?betId=7&tier=5&…"
 *
 * Exit code 0 means every check passed; 1 means something did not add up.
 */

import {
  commitmentFor,
  multiplierLabel,
  parseVerifyInputs,
  verifyRoll,
  type RawVerifyInputs,
} from "../src/index";

const FIELDS = [
  "betId",
  "tier",
  "clientEntropy",
  "serverReveal",
  "commitment",
  "win",
  "roll",
] as const;

function usage(): string {
  return [
    "Usage: rushood-verify [--url <verify link>] [--<field> <value> …]",
    "",
    `Fields: ${FIELDS.join(", ")}`,
    "",
    "  betId, tier, clientEntropy   the bet's public inputs (decimal or 0x hex)",
    "  serverReveal, commitment     32-byte hex values",
    "  win, roll                    optional: what the chain claims happened",
    "",
    "Every value is published on-chain: read them off the BetPlaced/BetSettled",
    "events or from RushoodGame.bets(betId). Nothing is sent anywhere.",
  ].join("\n");
}

/** Read `--key value` pairs and any `--url` query params into one raw record. */
function readArgs(argv: string[]): RawVerifyInputs | { error: string } {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) return { error: `unexpected argument "${arg}"` };
    const key = arg.slice(2);
    const value = argv[++i];
    if (value === undefined) return { error: `--${key} needs a value` };

    if (key === "url") {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return { error: `--url is not a valid URL: ${value}` };
      }
      // Explicit flags win over the link, so you can correct one field of a
      // pasted link without rebuilding it.
      for (const field of FIELDS) {
        const fromUrl = url.searchParams.get(field);
        if (fromUrl !== null && raw[field] === undefined) raw[field] = fromUrl;
      }
      continue;
    }

    if (!(FIELDS as readonly string[]).includes(key)) {
      return { error: `unknown field --${key}` };
    }
    raw[key] = value;
  }
  return raw;
}

function main(argv: string[]): number {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return argv.length === 0 ? 1 : 0;
  }

  const args = readArgs(argv);
  if ("error" in args) {
    console.error(`error: ${args.error}\n\n${usage()}`);
    return 1;
  }

  const parsed = parseVerifyInputs(args);
  if (!parsed.ok) {
    console.error("error: the inputs are incomplete or malformed\n");
    for (const { field, message } of parsed.errors) console.error(`  --${field}: ${message}`);
    console.error(`\n${usage()}`);
    return 1;
  }

  const inputs = parsed.inputs;
  const verdict = verifyRoll(inputs);
  const { computed } = verdict;

  console.log(`bet #${inputs.betId} - 1-in-${computed.odds} (${multiplierLabel(inputs.tier)})`);
  console.log("");
  console.log("  hash-chain link");
  console.log(`    commitment claimed   ${inputs.commitment}`);
  console.log(`    keccak256(reveal)    ${commitmentFor(inputs.serverReveal)}`);
  console.log(`    ${verdict.commitmentValid ? "MATCH - the server revealed what it committed to" : "MISMATCH - this reveal is not the committed one"}`);
  console.log("");
  console.log("  the draw");
  console.log(`    keccak256(reveal, clientEntropy, betId)`);
  console.log(`      = 0x${computed.entropy.toString(16).padStart(64, "0")}`);
  console.log(`    mod ${computed.odds} = ${computed.roll}  ->  ${computed.win ? "WIN" : "LOSS"} (a win is a roll of 0)`);

  if (inputs.reported?.roll !== undefined || inputs.reported?.win !== undefined) {
    console.log("");
    console.log("  against what the chain reported");
    if (inputs.reported.roll !== undefined) {
      console.log(`    roll  reported ${inputs.reported.roll}  recomputed ${computed.roll}`);
    }
    if (inputs.reported.win !== undefined) {
      console.log(`    win   reported ${inputs.reported.win}  recomputed ${computed.win}`);
    }
  }

  console.log("");
  if (verdict.ok) {
    console.log("PASS - this roll is exactly what the published inputs produce.");
    return 0;
  }
  console.log(`FAIL - ${verdict.failures.join(", ")}`);
  return 1;
}

process.exit(main(process.argv.slice(2)));
