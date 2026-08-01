/**
 * How large a spending approval to ask the wallet for.
 *
 * The game used to approve `maxUint256`. Wallets render that as an unlimited spending
 * cap behind a red security warning, and a player meets it on their first bet, on a
 * page whose whole pitch is that nothing has to be taken on trust.
 *
 * The warning is a heuristic about a shape, and the shape does not fit this contract.
 * `RushoodGame` moves RUSH in exactly one place:
 *
 *     token.safeTransferFrom(msg.sender, address(treasury), stake)
 *
 * The source is always `msg.sender`, so an allowance granted here can only ever be
 * spent by a transaction the granter sends themselves. There is no sweep, no admin
 * path, `treasury` is immutable, and the game is not upgradeable. None of which a
 * player can check in the two seconds the prompt is on screen, which is the point:
 * the cost of the unlimited approval is trust, not custody.
 *
 * So the approval is a budget instead. One prompt buys a run of bets, which keeps the
 * one-tap play the unlimited cap was there for (spec §6, `[spec-resolved]`), and the
 * wallet shows a concrete number rather than a warning. When the budget runs dry the
 * caller approves again, using the check it already makes: `allowance < stake`.
 */

/** How many bets at the current stake one approval should cover. */
export const BETS_PER_APPROVAL = 50n;

export interface ApprovalInputs {
  /** The stake being placed, in wei. */
  stake: bigint;
  /** The player's RUSH balance, or undefined before it has been read. */
  balance?: bigint;
}

/**
 * The allowance to request, in wei.
 *
 * Capped at the balance because approving beyond what the player holds inflates the
 * number in the prompt without buying a single extra roll. Floored at the stake so the
 * approval always covers the transfer it is authorising, even on a stale balance read.
 */
export function approvalAmount({ stake, balance }: ApprovalInputs): bigint {
  const budget = stake * BETS_PER_APPROVAL;
  if (balance === undefined) return budget;
  const capped = balance < budget ? balance : budget;
  return capped < stake ? stake : capped;
}

/**
 * How many bets an approved budget pays for, rounded down.
 *
 * Used for the copy shown next to the prompt, so it reports what the balance cap
 * actually bought rather than the budget that was asked for.
 */
export function betsCovered(amount: bigint, stake: bigint): number {
  if (stake <= 0n) return 0;
  return Number(amount / stake);
}
