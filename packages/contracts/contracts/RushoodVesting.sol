// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";
import {VestingWalletCliff} from "@openzeppelin/contracts/finance/VestingWalletCliff.sol";

/// @title RushoodVesting
/// @notice Holds the 10% team/dev allocation (100,000,000 RUSH) behind a 6-month cliff,
///         then streams it linearly until it is fully vested at month 24 — the
///         "insiders can't dump at launch" guarantee from the spec.
/// @dev A thin, named concretion of OpenZeppelin's `VestingWalletCliff` (which is
///      abstract), so Hardhat compiles it into a first-class artifact that the deploy
///      scripts and tests reference by name — the same pattern as `RushoodTimelock`.
///
///      The schedule is deliberately hard-coded rather than passed in at deploy: a
///      token holder reading this contract can see the lock-up terms directly, and no
///      constructor argument can quietly shorten them. Only the beneficiary and the
///      start timestamp vary per deployment.
///
///      Cliff semantics: the cliff gates the stream, it does not restart it. Nothing is
///      releasable before month 6; at month 6 the first 6/24 = 25% unlocks in one step,
///      and the remaining 75% streams out over the following 18 months. This is the
///      standard cliff shape and matches `VestingWalletCliff`'s formula.
///
///      Months are a fixed 30 days so the schedule is exact and auditable — CLIFF is
///      180 days and DURATION is 720 days, not calendar months.
///
///      Ownership: `VestingWallet` makes the beneficiary the owner, and every release
///      pays that owner. `release` itself is permissionless — anyone may trigger it,
///      but the funds can only ever land on the beneficiary.
contract RushoodVesting is VestingWalletCliff {
    /// @notice Seconds before any tokens vest: 6 months (180 days).
    uint64 public constant CLIFF_SECONDS = 180 days;

    /// @notice Total vesting window measured from `start()`: 24 months (720 days).
    ///         The cliff consumes the first 6; the remaining 18 vest linearly.
    uint64 public constant DURATION_SECONDS = 720 days;

    /// @param beneficiary Account that receives the vested RUSH (becomes the owner).
    /// @param startTimestamp Unix timestamp at which the vesting schedule begins.
    constructor(
        address beneficiary,
        uint64 startTimestamp
    )
        VestingWallet(beneficiary, startTimestamp, DURATION_SECONDS)
        VestingWalletCliff(CLIFF_SECONDS)
    {}
}
