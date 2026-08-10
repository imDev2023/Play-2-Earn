// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ConservationProperties} from
    "../../lib/evm-security-standards/templates/hardhat/Conservation.sol";
import {SolvencyProperties} from
    "../../lib/evm-security-standards/templates/hardhat/Solvency.sol";
import {Rushood} from "../Rushood.sol";
import {Treasury} from "../Treasury.sol";
import {RushoodGame} from "../RushoodGame.sol";

/// @title RushoodProperties
/// @notice The Medusa/Echidna campaign target: conservation and solvency over a live
///         game, driven by fuzzed play rather than by scripted scenarios.
///
/// The property worth having here is narrow and specific. RUSHOOD's whole economic
/// safety argument is one sentence: `placeBet` caps a stake so that the resulting win
/// can never exceed `1/solvencyCapDen` of the treasury the bet joined, therefore a win
/// can always be paid. Everything else - the edge, the burn, the tiers - is revenue.
/// That sentence is what these properties try to break.
///
/// It is genuinely falsifiable rather than tautological. Governance can move `edgeNum`,
/// `edgeDen`, `solvencyCapDen` and `burnRateBps` while bets are in flight, and the burn
/// removes treasury value on every settle. A campaign that raises the edge, drops the
/// solvency denominator and then settles a winner is exactly the sequence that would
/// expose an ordering mistake between the cap check and the payout.
///
/// @dev Assertion mode. `EchidnaAssertions` reports through a bare `assert`, so a
///      violation surfaces as a panic against the named `invariant_` function plus the
///      shrunk call sequence. See lib/evm-security-standards/templates/hardhat/README.md.
contract RushoodProperties is ConservationProperties, SolvencyProperties {
    /// @dev Long enough that a campaign cannot exhaust it and start reverting on
    ///      `InvalidReveal` for a reason that is not a finding.
    uint256 private constant CHAIN_LENGTH = 512;

    /// @dev Bankroll handed to the treasury. Comfortably above `DEFAULT_TREASURY_FLOOR`
    ///      so the campaign spends its time on play rather than on `TreasuryBelowFloor`.
    uint256 private constant TREASURY_SEED = 500_000_000 * 1e18;

    Rushood internal immutable rush;
    Treasury internal immutable treasuryVault;
    RushoodGame internal immutable game;

    /// @dev The precomputed server hash chain. `chain[i] = keccak256(chain[i - 1])`, so
    ///      revealing `chain[i - 1]` satisfies a commitment of `chain[i]`. The head walks
    ///      downwards as bets settle; `cursor` is the index the head currently sits at.
    bytes32[CHAIN_LENGTH] internal chain;
    uint256 internal cursor;

    /// @dev The open bet's terms, recorded here as the harness places it.
    ///
    /// Deliberately NOT read back from `game.bets(betId)`. Two reasons, and both matter.
    /// A conservation property that derives its expectation from the same storage it is
    /// checking is circular - it would agree with the contract however wrong the contract
    /// was. And `bets()` is a positional tuple whose order this repo has already had
    /// silently rearranged underneath it; `stake` and `clientSeed` are both `uint256`, so
    /// swapping them would still compile and this property would quietly start asserting
    /// against entropy. Tracking the terms at the point they are chosen avoids both.
    uint8 internal openTier;
    uint256 internal openStake;

    constructor() {
        rush = new Rushood(address(this));
        treasuryVault = new Treasury(rush);

        chain[0] = keccak256(abi.encodePacked("rushood-properties-genesis"));
        for (uint256 i = 1; i < CHAIN_LENGTH; ++i) {
            chain[i] = keccak256(abi.encodePacked(chain[i - 1]));
        }
        cursor = CHAIN_LENGTH - 1;

        // This contract is deployer, governance, guardian, relayer and the only player.
        // Collapsing the roles is safe for these two properties because neither asserts
        // anything about authorisation - that is `AccessControlSentinelProperties`, which
        // needs the opposite setup (privileged addresses excluded from the sender set).
        game = new RushoodGame(rush, treasuryVault, chain[cursor], address(this));
        treasuryVault.setGame(address(game));

        rush.transfer(address(treasuryVault), TREASURY_SEED);
        rush.approve(address(game), type(uint256).max);
    }

    // -------------------------------------------------------------------------------
    // Handlers. Inputs are folded into the legal range rather than rejected, so the
    // fuzzer spends its budget exploring play instead of rediscovering the validators.
    // -------------------------------------------------------------------------------

    function handlePlaceBet(uint8 tierSeed, uint256 stakeSeed, uint256 clientSeed) public {
        if (game.activeBetId() != 0) return;

        uint8 tier = uint8(tierSeed % game.TIER_COUNT());
        uint256 floor = game.minBet();
        uint256 ceiling = game.maxBet(tier);
        if (ceiling < floor) return;

        uint256 stake = floor + (stakeSeed % (ceiling - floor + 1));
        game.placeBet(tier, stake, clientSeed);
        openTier = tier;
        openStake = stake;
    }

    function handleSettle() public {
        if (game.activeBetId() == 0 || cursor == 0) return;
        bytes32 reveal = chain[cursor - 1];
        cursor -= 1;
        game.settleBet(reveal);
        openStake = 0;
    }

    function handleRefund() public {
        uint256 betId = game.activeBetId();
        if (betId == 0) return;
        // Only reachable once the fuzzer has advanced time past SETTLE_TIMEOUT; a call
        // that is merely early reverts, which is correct behaviour rather than a finding.
        game.refund(betId);
        openStake = 0;
    }

    /// @dev The economic knobs, which is where a solvency break would actually come from.
    function handleSetBurnRate(uint256 bps) public {
        game.setBurnRate(bps % (game.MAX_BURN_RATE_BPS() + 1));
    }

    /// @dev The sharpest edge in the system, and the reason this campaign exists.
    ///
    /// `burnTreasuryProfit` is the one path that destroys treasury value outright. The
    /// contract refuses it while a bet is open, and that refusal is load-bearing: the
    /// balance backing an open bet's payout can be many times `treasuryFloor`, so burning
    /// down to the floor mid-bet would leave a winner unpayable. Removing that single
    /// guard is what this property was verified against - the campaign finds the break in
    /// seconds. Fuzzing the call with the guard in place costs nothing, since it simply
    /// reverts whenever a bet is active.
    function handleBurnProfit(uint256 amount) public {
        uint256 balance = game.treasuryBalance();
        uint256 floor = game.treasuryFloor();
        if (balance <= floor) return;
        game.burnTreasuryProfit(amount % (balance - floor + 1));
    }

    /// @dev The same call at its extreme, reachable in one step.
    ///
    /// This exists because the sampled version above could not find the break. Burning a
    /// uniformly random slice leaves roughly half the treasury standing, which still
    /// covers a payout capped at 1% of it - so the violating region is the last ~1% of
    /// the range and the campaign essentially never landed there. With the floor burn
    /// available as its own call, removing the mid-bet guard fails in seconds.
    ///
    /// The general lesson, worth more than this handler: a bounded handler decides which
    /// states the campaign can reach, so the extremes have to be directly reachable
    /// rather than left to be sampled.
    function handleBurnAllProfit() public {
        uint256 balance = game.treasuryBalance();
        uint256 floor = game.treasuryFloor();
        if (balance <= floor) return;
        game.burnTreasuryProfit(balance - floor);
    }

    // -------------------------------------------------------------------------------
    // Property adapters
    // -------------------------------------------------------------------------------

    /// @notice Every conservation relationship this system has.
    function conservationLedgers() public view override returns (Ledger[] memory ledgers) {
        ledgers = new Ledger[](2);

        // Backing, not bookkeeping: anyone may donate rush to the treasury, so this is
        // `held >= accounted`. Marking it exact would turn a donation into a failure.
        ledgers[0] = Ledger({
            name: "treasury covers the active bet",
            accounted: _activeLiability(),
            held: rush.balanceOf(address(treasuryVault)),
            exact: false
        });

        // The game is a router, never a vault: stakes go straight to the treasury and
        // payouts leave from it. Exact, because a non-zero balance here is not a
        // donation problem, it is rush that has stopped moving where it was supposed to.
        ledgers[1] = Ledger({
            name: "game custodies nothing",
            accounted: 0,
            held: rush.balanceOf(address(game)),
            exact: true
        });
    }

    /// @notice The actors the solvency sweep walks.
    function actors() public view override returns (address[] memory who) {
        // The game admits one active bet at a time and this harness is its only player,
        // so the sweep is a single entry. A longer list would cost campaign time per call
        // and find nothing extra.
        who = new address[](1);
        who[0] = address(this);
    }

    /// @notice What the protocol could pay out right now.
    /// @dev Deliberately the treasury's real balance. The mixin warns against
    ///      `balanceOf(address(this))` because a donation can flatter an insolvent
    ///      protocol - here the treasury balance *is* the internal accounting, since
    ///      `RushoodGame.treasuryBalance()` reads exactly this and every cap is derived
    ///      from it. Reading anything else would test a number the contract does not use.
    function solvencyCapacity() public view override returns (uint256) {
        return rush.balanceOf(address(treasuryVault));
    }

    /// @notice What this actor could claim right now, in the same unit.
    function claimableBy(address actor) public view override returns (uint256) {
        return actor == address(this) ? _activeLiability() : 0;
    }

    /// @dev What the treasury owes on the open bet, taking the worse of the two ways it
    ///      can resolve. A win pays `payoutFor`; a timeout returns the stake. Payout is
    ///      always the larger (0.95 x N x stake, N >= 2), but taking the max keeps the
    ///      property honest if the edge or the tier table ever changes.
    function _activeLiability() internal view returns (uint256) {
        if (game.activeBetId() == 0 || openStake == 0) return 0;

        uint256 payout = game.payoutFor(openTier, openStake);
        return payout > openStake ? payout : openStake;
    }
}
