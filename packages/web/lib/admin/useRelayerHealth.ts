"use client";

import { useEffect, useState } from "react";
import { parseAbiItem } from "viem";
import { useBlock, useReadContract } from "wagmi";
import { getPublicClient, readContract } from "wagmi/actions";
import { wagmiConfig } from "../wagmi";
import { activeChainId } from "../chain";
import { GAME_ABI, GAME_ADDRESS, toBetView } from "../contracts";
import { relayerHealth, type RelayerHealth } from "./health";

/**
 * Relayer health, assembled from chain state.
 *
 * "Now" is the latest block's timestamp, not the browser clock: the bet's `placedAt` is
 * chain time, and on a local node the two can be hours apart after a single
 * `evm_increaseTime`. Comparing chain time to chain time keeps the lag honest wherever
 * the console runs.
 */

const BET_SETTLED = parseAbiItem(
  "event BetSettled(uint256 indexed betId, address indexed player, bool win, uint256 payout, bytes32 reveal, uint256 roll)",
);

export function useRelayerHealth(activeBetId?: bigint, settleTimeout?: bigint): RelayerHealth {
  // "Now" must be the *configured* chain's clock: lag is `now - placedAt`, and a block
  // timestamp from whatever chain the wallet is on turns the indicator into noise (#63).
  const { data: block } = useBlock({ chainId: activeChainId, watch: true });
  const [lastSettleLag, setLastSettleLag] = useState<bigint>();

  const { data: activeBet } = useReadContract({
    chainId: activeChainId,
    address: GAME_ADDRESS,
    abi: GAME_ABI,
    functionName: "bets",
    args: [activeBetId ?? 0n],
    query: { enabled: Boolean(activeBetId) },
  });

  // How long the last settlement actually took. Recomputed whenever the active bet
  // changes - every settlement moves `activeBetId` back to zero, so that is exactly
  // the edge worth reacting to, and it avoids re-scanning logs on a timer.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const client = getPublicClient(wagmiConfig, { chainId: activeChainId });
        if (!client) return;
        const logs = await client.getLogs({
          address: GAME_ADDRESS,
          event: BET_SETTLED,
          fromBlock: 0n,
          toBlock: "latest",
        });
        const last = logs[logs.length - 1];
        if (!last?.args.betId || last.blockNumber === null) return;
        const [settledIn, bet] = await Promise.all([
          client.getBlock({ blockNumber: last.blockNumber }),
          readContract(wagmiConfig, {
            chainId: activeChainId,
            address: GAME_ADDRESS,
            abi: GAME_ABI,
            functionName: "bets",
            args: [last.args.betId],
          }),
        ]);
        // By name, not index: this read positionally once picked the stake - a
        // wei-scale number that floors every lag at zero and pins the indicator to
        // healthy - and only the comment stood between the next reader and doing it
        // again. `toBetView` reads the order off the ABI instead.
        const { placedAt } = toBetView(bet);
        if (cancelled) return;
        setLastSettleLag(settledIn.timestamp > placedAt ? settledIn.timestamp - placedAt : 0n);
      } catch {
        // Best effort: without it the indicator simply omits the last-lag figure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeBetId]);

  const now = block?.timestamp;
  const placedAt = activeBetId && activeBet ? toBetView(activeBet).placedAt : undefined;

  return relayerHealth({
    activeBetId: activeBetId ?? 0n,
    // Without chain time there is nothing to measure the bet's age against. Withhold
    // `placedAt` so the indicator reads "unknown" rather than "0s pending, healthy".
    placedAt: now === undefined ? undefined : placedAt,
    now: now ?? 0n,
    settleTimeout: settleTimeout ?? FALLBACK_SETTLE_TIMEOUT,
    lastSettleLag,
  });
}

/** `RushoodGame.SETTLE_TIMEOUT`, used only until the real value has been read. */
const FALLBACK_SETTLE_TIMEOUT = 3600n;
