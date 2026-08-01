"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { parseAbiItem, type Address, type Hex } from "viem";
import { getPublicClient, readContract } from "wagmi/actions";
import { useWatchContractEvent } from "wagmi";
import { wagmiConfig } from "./wagmi";
import { GAME_ABI, GAME_ADDRESS } from "./contracts";

export type BetOutcome = "pending" | "won" | "lost";

export interface BetEntry {
  betId: bigint;
  tier: number;
  stake: bigint;
  outcome: BetOutcome;
  payout: bigint;
  /** The player's entropy for this bet. Undefined until hydrated from chain. */
  clientSeed?: bigint;
  /** The commitment this bet was locked against (#24). */
  commit?: Hex;
  /** The reveal that settled it; absent while pending. */
  reveal?: Hex;
  /** The roll the chain reported, to cross-check a local recomputation against. */
  roll?: bigint;
}

const BET_PLACED = parseAbiItem(
  "event BetPlaced(uint256 indexed betId, address indexed player, uint8 tier, uint256 stake, uint256 clientSeed, bytes32 commit)",
);
const BET_SETTLED = parseAbiItem(
  "event BetSettled(uint256 indexed betId, address indexed player, bool win, uint256 payout, bytes32 reveal, uint256 roll)",
);

type Draft = Map<string, BetEntry>;

function place(draft: Draft, betId: bigint, args: LogArgs): Draft {
  const key = betId.toString();
  const next = new Map(draft);
  const existing = next.get(key);
  next.set(key, {
    ...existing,
    betId,
    tier: Number(args.tier ?? 0),
    stake: args.stake ?? 0n,
    outcome: existing?.outcome ?? "pending",
    payout: existing?.payout ?? 0n,
    clientSeed: args.clientSeed ?? existing?.clientSeed,
    commit: args.commit ?? existing?.commit,
  });
  return next;
}

function settle(draft: Draft, betId: bigint, args: LogArgs): Draft {
  const key = betId.toString();
  const next = new Map(draft);
  const existing = next.get(key);
  next.set(key, {
    ...existing,
    betId,
    tier: existing?.tier ?? 0,
    stake: existing?.stake ?? 0n,
    outcome: args.win ? "won" : "lost",
    payout: args.payout ?? 0n,
    reveal: args.reveal ?? existing?.reveal,
    roll: args.roll ?? existing?.roll,
  });
  return next;
}

type LogArgs = {
  betId?: bigint;
  player?: string;
  tier?: number;
  stake?: bigint;
  clientSeed?: bigint;
  commit?: Hex;
  win?: boolean;
  payout?: bigint;
  reveal?: Hex;
  roll?: bigint;
};

/**
 * Fold this player's logs into the draft with `apply`, collecting the bet ids
 * touched (so the caller can hydrate them). Shared by the BetPlaced and BetSettled
 * watchers, which differ only in how each log updates a bet.
 */
function foldPlayerLogs(
  draft: Draft,
  logs: readonly { args: LogArgs }[],
  address: string | undefined,
  apply: (draft: Draft, betId: bigint, args: LogArgs) => Draft,
): { draft: Draft; ids: bigint[] } {
  let next = draft;
  const ids: bigint[] = [];
  for (const log of logs) {
    const args = log.args;
    if (args.betId !== undefined && args.player?.toLowerCase() === address?.toLowerCase()) {
      next = apply(next, args.betId, args);
      ids.push(args.betId);
    }
  }
  return { draft: next, ids };
}

/**
 * The connected player's bet history, newest first. Backfills past bets via a log
 * query on mount, then folds in live BetPlaced/BetSettled events. Session-scoped:
 * it reads directly from chain logs rather than a persistent indexer (that's a
 * later concern), which is ample for a single active-bet game.
 */
export function useBetHistory(address: Address | undefined) {
  const [drafts, setDrafts] = useState<Draft>(new Map());

  // Read the authoritative record for a bet from chain state, so a row is correct
  // even if its BetPlaced event was missed or arrived after settlement. Since #24 this
  // also supplies the fairness inputs (clientSeed/commit/reveal), which means the
  // verify link works for a bet whose events this session never saw.
  const hydrate = useCallback((betId: bigint) => {
    (async () => {
      try {
        const bet = await readContract(wagmiConfig, {
          address: GAME_ADDRESS,
          abi: GAME_ABI,
          functionName: "bets",
          args: [betId],
        });
        const [, rawTier, stake, clientSeed, , , commit, reveal] = bet;
        const tier = Number(rawTier);
        setDrafts((draft) => {
          const key = betId.toString();
          const existing = draft.get(key);
          if (!existing) return draft;
          if (
            existing.tier === tier &&
            existing.stake === stake &&
            existing.clientSeed === clientSeed &&
            existing.commit === commit &&
            existing.reveal === nonZero(reveal)
          ) {
            return draft;
          }
          const next = new Map(draft);
          next.set(key, {
            ...existing,
            tier,
            stake,
            clientSeed,
            commit,
            // An unsettled (or refunded) bet consumed no reveal, so the slot is zero.
            reveal: nonZero(reveal),
          });
          return next;
        });
      } catch {
        // Best-effort: leave whatever the events supplied.
      }
    })();
  }, []);

  // Backfill history for this player when the account changes, merging onto any
  // live entries that arrived first (rather than clobbering them).
  useEffect(() => {
    let cancelled = false;
    setDrafts(new Map());
    if (!address) return;
    (async () => {
      try {
        const client = getPublicClient(wagmiConfig);
        if (!client) return;
        const [placed, settled] = await Promise.all([
          client.getLogs({
            address: GAME_ADDRESS,
            event: BET_PLACED,
            args: { player: address },
            fromBlock: 0n,
            toBlock: "latest",
          }),
          client.getLogs({
            address: GAME_ADDRESS,
            event: BET_SETTLED,
            args: { player: address },
            fromBlock: 0n,
            toBlock: "latest",
          }),
        ]);
        if (cancelled) return;
        setDrafts((prev) => {
          let draft = prev;
          for (const log of placed) {
            if (log.args.betId !== undefined) draft = place(draft, log.args.betId, log.args);
          }
          for (const log of settled) {
            if (log.args.betId !== undefined) draft = settle(draft, log.args.betId, log.args);
          }
          return draft;
        });
      } catch {
        // No node / unsupported log query: live events still populate history.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address]);

  // Fold matching logs into the draft, then hydrate the touched bets so tier/stake
  // stay authoritative even if a BetPlaced event was missed or arrived out of order.
  const watch = useCallback(
    (apply: (draft: Draft, betId: bigint, args: LogArgs) => Draft) =>
      (logs: readonly { args: LogArgs }[]) => {
        let ids: bigint[] = [];
        setDrafts((draft) => {
          const folded = foldPlayerLogs(draft, logs, address, apply);
          ids = folded.ids;
          return folded.draft;
        });
        ids.forEach(hydrate);
      },
    [address, hydrate],
  );

  useWatchContractEvent({
    address: GAME_ADDRESS,
    abi: GAME_ABI,
    eventName: "BetPlaced",
    enabled: Boolean(address),
    onLogs: watch(place),
  });

  useWatchContractEvent({
    address: GAME_ADDRESS,
    abi: GAME_ABI,
    eventName: "BetSettled",
    enabled: Boolean(address),
    onLogs: watch(settle),
  });

  const history = useMemo(
    () => [...drafts.values()].sort((a, b) => (b.betId > a.betId ? 1 : b.betId < a.betId ? -1 : 0)),
    [drafts],
  );

  return { history };
}

/** Treat the zero word as "absent" - an unconsumed reveal slot reads as 0x00…0. */
function nonZero(value: Hex): Hex | undefined {
  return /^0x0*$/.test(value) ? undefined : value;
}
