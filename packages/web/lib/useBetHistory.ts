"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { parseAbiItem, type Address, type Hex } from "viem";
import { getPublicClient, readContract } from "wagmi/actions";
import { useWatchContractEvent } from "wagmi";
import { wagmiConfig } from "./wagmi";
import { GAME_ABI, GAME_ADDRESS } from "./contracts";
import { useStableCallback } from "./useStableCallback";

/**
 * `refunded` is its own outcome, not a kind of loss and not a kind of pending.
 *
 * A refunded bet never settles, so it never emits `BetSettled` and history left it
 * reading "pending" for ever - about a bet whose stake is already back in the player's
 * wallet. Folding it into "lost" would be worse: the player lost nothing.
 */
export type BetOutcome = "pending" | "won" | "lost" | "refunded";

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
const BET_REFUNDED = parseAbiItem(
  "event BetRefunded(uint256 indexed betId, address indexed player, uint256 amount)",
);

type Draft = Map<string, BetEntry>;

/** How one event updates a bet. The three watchers differ only in this. */
type Reducer = (draft: Draft, betId: bigint, args: LogArgs) => Draft;

/** A batch of decoded logs as wagmi hands them to `onLogs`. */
type PlayerLogs = readonly { args: LogArgs }[];

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

/**
 * The stake came back, so the bet is closed with no roll and nothing to verify: the
 * reveal was never consumed, which is why `refund` leaves the chain head where it is.
 */
function refundEntry(draft: Draft, betId: bigint, args: LogArgs): Draft {
  const key = betId.toString();
  const next = new Map(draft);
  const existing = next.get(key);
  next.set(key, {
    ...existing,
    betId,
    tier: existing?.tier ?? 0,
    stake: existing?.stake ?? args.amount ?? 0n,
    outcome: "refunded",
    payout: args.amount ?? existing?.stake ?? 0n,
  });
  return next;
}

/**
 * The three reducers applied in order, as a pure function over a log sequence.
 *
 * The hook itself is all wagmi subscriptions and effects, so the part worth testing -
 * which event closes a bet, and as what - is exposed here rather than left reachable
 * only through a rendered component.
 */
export function foldBetLogs(
  logs: readonly { kind: "placed" | "settled" | "refunded"; args: LogArgs }[],
): BetEntry[] {
  let draft: Draft = new Map();
  for (const { kind, args } of logs) {
    if (args.betId === undefined) continue;
    const apply = kind === "placed" ? place : kind === "settled" ? settle : refundEntry;
    draft = apply(draft, args.betId, args);
  }
  return [...draft.values()].sort((a, b) => (b.betId > a.betId ? 1 : b.betId < a.betId ? -1 : 0));
}

type LogArgs = {
  betId?: bigint;
  /** BetRefunded only: the stake returned to the player. */
  amount?: bigint;
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
 * Whether this log is about `address`'s bet, and usable.
 *
 * Each side is required rather than compared optionally: `a?.x === b?.x` is true when
 * both are undefined, so a log that carried no player would have matched a wallet that
 * was not connected.
 */
function isPlayerLog(args: LogArgs, address: string | undefined): boolean {
  if (args.betId === undefined || args.player === undefined || address === undefined) return false;
  return args.player.toLowerCase() === address.toLowerCase();
}

/** The fairness-bearing fields of a `bets(betId)` record. */
export interface ChainBet {
  tier: number;
  stake: bigint;
  clientSeed: bigint;
  commit: Hex;
  reveal: Hex;
}

/**
 * `existing` brought up to date with a `bets()` read, never losing ground.
 *
 * A hydrate read races the events it exists to back up: it is a snapshot taken before
 * the reply landed, so it can predate a settlement whose `BetSettled` has already been
 * folded in. Writing its fields straight over the entry then erased a reveal the event
 * had already supplied, and `verifyInputsFor` needs all of clientSeed, commit and
 * reveal - so the fairness verdict vanished from a row that had just shown one. The
 * chain is authoritative about what it knows; it is not authoritative about what it has
 * not caught up to yet, so an absent field never overwrites a present one.
 *
 * Returns `existing` itself when nothing changed, so the caller can skip the update.
 */
export function hydrateEntry(existing: BetEntry, chain: ChainBet): BetEntry {
  const merged: BetEntry = {
    ...existing,
    tier: chain.tier,
    stake: chain.stake,
    clientSeed: chain.clientSeed ?? existing.clientSeed,
    commit: nonZero(chain.commit) ?? existing.commit,
    // An unsettled (or refunded) bet consumed no reveal, so the slot reads as zero.
    reveal: nonZero(chain.reveal) ?? existing.reveal,
  };
  const unchanged =
    existing.tier === merged.tier &&
    existing.stake === merged.stake &&
    existing.clientSeed === merged.clientSeed &&
    existing.commit === merged.commit &&
    existing.reveal === merged.reveal;
  return unchanged ? existing : merged;
}

/**
 * The bet ids in `logs` belonging to `address`.
 *
 * Separate from the fold because the two are needed at different moments: the fold
 * updates state, while these ids drive `hydrate`, which must be called from the event
 * handler itself. Deriving them here keeps that call independent of when React chooses
 * to run a state updater - reading them back out of one is not sound, because an
 * updater can be deferred, and then the hydrate pass silently does nothing.
 */
export function playerBetIds(
  logs: readonly { args: LogArgs }[],
  address: string | undefined,
): bigint[] {
  const ids: bigint[] = [];
  for (const log of logs) {
    if (isPlayerLog(log.args, address)) ids.push(log.args.betId as bigint);
  }
  return ids;
}

/**
 * Fold this player's logs into the draft with `apply`. Shared by the BetPlaced,
 * BetSettled and BetRefunded watchers, which differ only in how each log updates a bet.
 */
function foldPlayerLogs(
  draft: Draft,
  logs: readonly { args: LogArgs }[],
  address: string | undefined,
  apply: (draft: Draft, betId: bigint, args: LogArgs) => Draft,
): Draft {
  let next = draft;
  for (const log of logs) {
    if (isPlayerLog(log.args, address)) {
      next = apply(next, log.args.betId as bigint, log.args);
    }
  }
  return next;
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
        const chain = { tier: Number(rawTier), stake, clientSeed, commit, reveal };
        setDrafts((draft) => {
          const key = betId.toString();
          const existing = draft.get(key);
          if (!existing) return draft;
          const merged = hydrateEntry(existing, chain);
          if (merged === existing) return draft;
          const next = new Map(draft);
          next.set(key, merged);
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
        const [placed, settled, refunded] = await Promise.all([
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
          client.getLogs({
            address: GAME_ADDRESS,
            event: BET_REFUNDED,
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
          // Last, so a refund is never overwritten by the BetPlaced that preceded it.
          for (const log of refunded) {
            if (log.args.betId !== undefined) draft = refundEntry(draft, log.args.betId, log.args);
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
  // The ids come from the logs rather than back out of the state updater, so hydration
  // does not depend on when React runs it.
  // Held stable for the component's whole life, not merely memoised: wagmi resubscribes
  // whenever `onLogs` changes identity, and a log landing in that gap is lost. See
  // useStableCallback. This screen re-renders on every block while a bet is pending, so
  // the gap is widest exactly when BetPlaced and BetSettled arrive.
  const receive = useStableCallback((logs: readonly { args: LogArgs }[], apply: Reducer) => {
    setDrafts((draft) => foldPlayerLogs(draft, logs, address, apply));
    playerBetIds(logs, address).forEach(hydrate);
  });

  const onPlaced = useStableCallback((logs: PlayerLogs) => receive(logs, place));
  const onSettled = useStableCallback((logs: PlayerLogs) => receive(logs, settle));
  const onRefunded = useStableCallback((logs: PlayerLogs) => receive(logs, refundEntry));

  useWatchContractEvent({
    address: GAME_ADDRESS,
    abi: GAME_ABI,
    eventName: "BetPlaced",
    enabled: Boolean(address),
    onLogs: onPlaced,
  });

  useWatchContractEvent({
    address: GAME_ADDRESS,
    abi: GAME_ABI,
    eventName: "BetSettled",
    enabled: Boolean(address),
    onLogs: onSettled,
  });

  useWatchContractEvent({
    address: GAME_ADDRESS,
    abi: GAME_ABI,
    eventName: "BetRefunded",
    enabled: Boolean(address),
    onLogs: onRefunded,
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
