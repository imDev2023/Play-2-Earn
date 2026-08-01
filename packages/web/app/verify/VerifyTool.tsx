"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import { readContract } from "wagmi/actions";
import {
  commitmentFor,
  multiplierLabel,
  parseVerifyInputs,
  verifyRoll,
  type RawVerifyInputs,
  type Verdict,
} from "@rushood/verifier";
import { wagmiConfig } from "../../lib/wagmi";
import { GAME_ABI, GAME_ADDRESS, TIERS } from "../../lib/contracts";
import { chip, field, ghostButton, hexValue, hint, label, panel, primaryButton, textInput } from "../../lib/ui";
import { isZeroHex } from "../../lib/fairness";

/**
 * The public `/verify` tool.
 *
 * Two ways in, and the difference matters:
 *
 * - **Paste the inputs** (or open a verify link, which carries them all in the URL).
 *   Everything happens locally; this page could be served from a hostile host and the
 *   verdict would still be trustworthy, because the only thing it does is arithmetic.
 * - **Look the bet up on-chain** - a convenience that reads `bets(betId)` through this
 *   app's RPC. Faster, but you're taking that RPC's word for the inputs. It's clearly
 *   marked as such, because the whole point of this page is not having to.
 */

type Fields = Required<{ [K in keyof RawVerifyInputs]: string }>;

const EMPTY: Fields = {
  betId: "",
  tier: "0",
  clientEntropy: "",
  serverReveal: "",
  commitment: "",
  win: "",
  roll: "",
};

const INPUTS: { field: keyof Fields; title: string; hint: string; placeholder: string }[] = [
  {
    field: "betId",
    title: "Bet id",
    hint: "From the BetPlaced event.",
    placeholder: "7",
  },
  {
    field: "clientEntropy",
    title: "Your entropy",
    hint: "The clientSeed you contributed at bet time.",
    placeholder: "0x… or a decimal number",
  },
  {
    field: "commitment",
    title: "The house's commitment",
    hint: "The chain head your bet was locked against - published before the bet.",
    placeholder: "0x…",
  },
  {
    field: "serverReveal",
    title: "The house's reveal",
    hint: "Published at settlement. Must hash to the commitment.",
    placeholder: "0x…",
  },
];

export function VerifyTool() {
  const params = useSearchParams();
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [lookup, setLookup] = useState<{ state: "idle" | "loading" | "error"; message?: string }>({
    state: "idle",
  });

  // A verify link carries every input, so an opened link should just... verify.
  const fromUrl = useMemo(() => {
    const next: Partial<Fields> = {};
    for (const key of Object.keys(EMPTY) as (keyof Fields)[]) {
      const value = params.get(key);
      if (value !== null) next[key] = value;
    }
    return next;
  }, [params]);

  const run = useCallback((source: Fields) => {
    const parsed = parseVerifyInputs(source);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      setVerdict(null);
      return;
    }
    setErrors([]);
    setVerdict(verifyRoll(parsed.inputs));
  }, []);

  useEffect(() => {
    if (Object.keys(fromUrl).length === 0) return;
    const seeded = { ...EMPTY, ...fromUrl };
    setFields(seeded);
    run(seeded);
  }, [fromUrl, run]);

  const set = (name: keyof Fields, value: string) =>
    setFields((prev) => ({ ...prev, [name]: value }));

  /** Convenience path: pull the bet's record straight off the contract. */
  async function lookUpOnChain() {
    const betId = fields.betId.trim();
    if (!betId) {
      setLookup({ state: "error", message: "Enter a bet id first." });
      return;
    }
    setLookup({ state: "loading" });
    try {
      const bet = await readContract(wagmiConfig, {
        address: GAME_ADDRESS,
        abi: GAME_ABI,
        functionName: "bets",
        args: [BigInt(betId)],
      });
      const [player, tier, , clientSeed, , settled, commit, reveal] = bet;
      if (player === "0x0000000000000000000000000000000000000000") {
        setLookup({ state: "error", message: `No bet #${betId} exists on this contract.` });
        return;
      }
      const next: Fields = {
        ...fields,
        tier: String(Number(tier)),
        clientEntropy: clientSeed.toString(),
        commitment: commit,
        serverReveal: isZeroHex(reveal) ? "" : reveal,
        // The chain's own claim isn't loaded here: a lookup is for the *inputs*. The
        // recomputed result below is what says whether the bet was fair.
        win: "",
        roll: "",
      };
      setFields(next);
      setLookup({
        state: "idle",
        message: settled
          ? undefined
          : `Bet #${betId} hasn't settled yet - there's no reveal to check.`,
      });
      run(next);
    } catch (err) {
      setLookup({
        state: "error",
        message: `Couldn't reach the contract: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      });
    }
  }

  const errorFor = (field: keyof Fields) => errors.find((e) => e.field === field)?.message;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <section style={{ ...panel, display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div style={field}>
          <span style={label}>Odds tier</span>
          <select
            data-testid="verify-tier"
            style={textInput}
            value={fields.tier}
            onChange={(e) => set("tier", e.target.value)}
          >
            {TIERS.map((t, i) => (
              <option key={t.odds} value={i}>
                {t.label} · 1-in-{t.odds}
              </option>
            ))}
          </select>
        </div>

        {INPUTS.map((spec) => (
          <div key={spec.field} style={field}>
            <span style={label}>{spec.title}</span>
            <input
              data-testid={`verify-${spec.field}`}
              className="mono"
              style={textInput}
              value={fields[spec.field]}
              placeholder={spec.placeholder}
              onChange={(e) => set(spec.field, e.target.value)}
            />
            <span style={hint}>{errorFor(spec.field) ?? spec.hint}</span>
          </div>
        ))}

        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
          <button data-testid="verify-run" style={primaryButton()} onClick={() => run(fields)}>
            Verify
          </button>
          <button
            data-testid="verify-lookup"
            style={ghostButton}
            disabled={lookup.state === "loading"}
            onClick={lookUpOnChain}
          >
            {lookup.state === "loading" ? "Reading chain…" : "Look the bet up on-chain"}
          </button>
        </div>
        <p style={hint}>
          Verifying is offline. Looking a bet up is not - it reads{" "}
          <code className="mono">bets(betId)</code> through this app&apos;s node, so you
          are trusting that node for the <em>inputs</em>. Read them off a block explorer
          instead if you&apos;d rather not.
        </p>
        {lookup.message && (
          <p
            data-testid="verify-lookup-message"
            style={{
              ...hint,
              color: lookup.state === "error" ? "var(--hot)" : "var(--muted)",
            }}
          >
            {lookup.message}
          </p>
        )}
      </section>

      {verdict && <Result verdict={verdict} fields={fields} />}
    </div>
  );
}

function Result({ verdict, fields }: { verdict: Verdict; fields: Fields }) {
  const { computed } = verdict;
  const tier = Number(fields.tier);
  return (
    <section
      data-testid="verify-result"
      style={{
        ...panel,
        display: "flex",
        flexDirection: "column",
        gap: "0.9rem",
        borderColor: verdict.ok ? "var(--win)" : "var(--hot)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
        <strong
          data-testid="verify-verdict"
          style={{ fontSize: "1.2rem", color: verdict.ok ? "var(--win)" : "var(--hot)" }}
        >
          {verdict.ok ? "PASS - this roll checks out" : "FAIL - this roll does not check out"}
        </strong>
        <span className="mono" style={chip}>
          1-in-{computed.odds.toString()} · {multiplierLabel(tier)}
        </span>
      </div>

      <Check
        testId="verify-chain-link"
        ok={verdict.commitmentValid}
        title="The reveal matches the commitment"
        detail={
          verdict.commitmentValid
            ? "keccak256(reveal) equals the value published before the bet, so the house revealed the number it was locked into."
            : `keccak256(reveal) is ${commitmentFor(fields.serverReveal as `0x${string}`)}, which is not the commitment given.`
        }
      />

      <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
        <span style={label}>The recomputed draw</span>
        <code data-testid="verify-entropy" className="mono" style={hexValue}>
          0x{computed.entropy.toString(16).padStart(64, "0")}
        </code>
        <span data-testid="verify-roll" className="mono" style={{ fontSize: "0.9rem" }}>
          mod {computed.odds.toString()} = {computed.roll.toString()} →{" "}
          <strong style={{ color: computed.win ? "var(--win)" : "var(--muted)" }}>
            {computed.win ? "WIN" : "LOSS"}
          </strong>
        </span>
        <span style={hint}>A win is a roll of exactly 0 - a 1-in-{computed.odds.toString()} event.</span>
      </div>

      {(fields.roll.trim() !== "" || fields.win.trim() !== "") && (
        <Check
          testId="verify-reported"
          ok={!verdict.failures.some((f) => f === "roll-mismatch" || f === "win-mismatch")}
          title="It agrees with what the chain reported"
          detail={
            verdict.failures.includes("roll-mismatch") || verdict.failures.includes("win-mismatch")
              ? "The recomputation disagrees with the reported outcome. Check that every input came from the same bet."
              : "The reported outcome is exactly what these inputs produce."
          }
        />
      )}
    </section>
  );
}

function Check({
  ok,
  title,
  detail,
  testId,
}: {
  ok: boolean;
  title: string;
  detail: string;
  testId: string;
}) {
  return (
    <div data-testid={testId} style={{ display: "flex", gap: "0.55rem", alignItems: "flex-start" }}>
      <span aria-hidden style={{ color: ok ? "var(--win)" : "var(--hot)", fontWeight: 800 }}>
        {ok ? "✓" : "✕"}
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
        <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>{title}</span>
        <span style={hint}>{detail}</span>
      </span>
    </div>
  );
}




