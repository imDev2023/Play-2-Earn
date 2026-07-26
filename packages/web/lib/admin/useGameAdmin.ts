"use client";

import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { GAME_ABI, GAME_ADDRESS } from "../contracts";
import { successValue } from "./readResult";

/**
 * Everything the console reads off the game in one place.
 *
 * Nothing here is inferred: every parameter the console displays or preflights against
 * is read from the contract that enforces it, so the console can never quote a cap the
 * game stopped honouring. A missing value stays `undefined` rather than defaulting —
 * an unreachable node must read as "unknown", not as "zero balance, unpaused".
 */

/**
 * How often the console re-reads. An operator watches this page while acting on it —
 * a pause has to show up without a manual refresh — but nothing here changes fast
 * enough to justify following every block.
 */
const REFRESH_MS = 5_000;

const GAME_VIEWS = [
  "governance",
  "guardian",
  "treasury",
  "treasuryBalance",
  "treasuryFloor",
  "maxPayout",
  "minBet",
  "burnRateBps",
  "MAX_BURN_RATE_BPS",
  "edgeNum",
  "edgeDen",
  "solvencyCapDen",
  "activeBetId",
  "SETTLE_TIMEOUT",
  "paused",
  "economicsGovernable",
] as const;

export interface GameAdminState {
  governance?: Address;
  guardian?: Address;
  treasury?: Address;
  treasuryBalance?: bigint;
  treasuryFloor?: bigint;
  maxPayout?: bigint;
  minBet?: bigint;
  burnRateBps?: bigint;
  maxBurnRateBps?: bigint;
  edgeNum?: bigint;
  edgeDen?: bigint;
  solvencyCapDen?: bigint;
  activeBetId?: bigint;
  settleTimeout?: bigint;
  paused?: boolean;
  economicsGovernable?: boolean;
  /** False while the first read is in flight, or when the node cannot be reached. */
  reachable: boolean;
  isLoading: boolean;
  refetch: () => void;
}

export function useGameAdmin(): GameAdminState {
  const { data, isLoading, refetch } = useReadContracts({
    contracts: GAME_VIEWS.map((functionName) => ({
      address: GAME_ADDRESS,
      abi: GAME_ABI,
      functionName,
    })),
    query: { refetchInterval: REFRESH_MS },
  });

  // Looked up by name, not by index, so reordering GAME_VIEWS can never silently
  // reassign one contract's value to another field.
  const at = <T,>(name: (typeof GAME_VIEWS)[number]): T | undefined =>
    successValue<T>(data?.[GAME_VIEWS.indexOf(name)]);

  const governance = at<Address>("governance");

  return {
    governance,
    guardian: at<Address>("guardian"),
    treasury: at<Address>("treasury"),
    treasuryBalance: at<bigint>("treasuryBalance"),
    treasuryFloor: at<bigint>("treasuryFloor"),
    maxPayout: at<bigint>("maxPayout"),
    minBet: at<bigint>("minBet"),
    burnRateBps: at<bigint>("burnRateBps"),
    maxBurnRateBps: at<bigint>("MAX_BURN_RATE_BPS"),
    edgeNum: at<bigint>("edgeNum"),
    edgeDen: at<bigint>("edgeDen"),
    solvencyCapDen: at<bigint>("solvencyCapDen"),
    activeBetId: at<bigint>("activeBetId"),
    settleTimeout: at<bigint>("SETTLE_TIMEOUT"),
    paused: at<boolean>("paused"),
    economicsGovernable: at<boolean>("economicsGovernable"),
    // The governance role is the console's canary: if that one call came back, the
    // node is answering and the game is deployed where the app thinks it is.
    reachable: governance !== undefined,
    isLoading,
    refetch: () => void refetch(),
  };
}
