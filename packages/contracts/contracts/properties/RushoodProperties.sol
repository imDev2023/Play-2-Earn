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
/// It is genuinely falsifiable rather than tautological, and it is worth being exact
/// about where that falsifiability comes from, because an earlier version of this comment
/// was not. `edgeNum` and `edgeDen` are NOT reachable by this campaign: their setters
/// carry `whenEconomicsGovernable` and nothing here flips it for them.
///
/// `solvencyCapDen` WAS in that list and is not any more (#57). While it was, the first
/// assertion in `invariant_payoutWithinCap` compared 1% against 1% on every call: the
/// denominator was pinned at its seeded 100 for the whole run, so the assertion about it
/// could not fail whatever the contract did. That is this file's own recorded trap - a
/// bounded handler decides which states the campaign can reach, and the assertion about
/// the state you folded away is the one that cannot fail. `handleSetSolvencyCap` and
/// `handleSetSolvencyCapBelowFloor` below make it reachable in both directions.
///
/// What actually makes the campaign bite is `burnTreasuryProfit`, the one path that
/// destroys treasury value outright, driven to its extreme by `handleBurnAllProfit`. That
/// is the sequence verified to fail when the mid-bet guard is removed. See that handler.
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

    /// @dev The spec's own numbers, restated here so the properties are anchored to
    ///      docs/spec/RUSHOOD-game-spec.md rather than to the contract they are checking.
    ///      §4 locks a flat 5% edge, so the multiplier is `0.95 * N`.
    uint256 private constant SPEC_EDGE_NUM = 95;
    uint256 private constant SPEC_EDGE_DEN = 100;

    /// @dev §5's seeded default: maxPayout is 1% of the treasury at deployment.
    uint256 private constant SPEC_SOLVENCY_CAP_DEN = 100;

    /// @dev §5's governance ceiling (#57): the cap may be loosened, but no further than
    ///      5% of the treasury. This, not the 1% above, is the bound that has to hold
    ///      across every state the campaign can reach, because loosening is a legal
    ///      governance action. Asserting the 1% here would fail on a lawful `setSolvencyCap`
    ///      rather than on a defect.
    uint256 private constant SPEC_MIN_SOLVENCY_CAP_DEN = 20;

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

    /// @dev `maxPayout` as it stood when the open bet was placed, snapshotted rather than
    ///      re-read at assertion time. The contract caps "against the balance *before*
    ///      this stake is added, so a win pays at most 1% of the pool the bet joined"
    ///      (RushoodGame.placeBet), and the stake then joins the treasury - so re-reading
    ///      `maxPayout()` afterwards compares the bet against a pool its own stake has
    ///      already inflated. That is a weaker question than the spec asks, and weak in
    ///      the direction that hides a violation.
    uint256 internal openMaxPayout;

    /// @dev The handler only ever picks a tier through `% game.TIER_COUNT()`, so this is
    ///      unreachable while the contract's tier count and the spec's table agree. It
    ///      exists to make them disagreeing loud rather than silent.
    error TierOutsideSpecTable(uint8 tier);

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
        _place(tier, stake, clientSeed);
    }

    /// @dev Attempt a stake the cap must refuse.
    ///
    /// `handlePlaceBet` folds its stake into `[minBet, maxBet]`, which is what keeps the
    /// campaign spending its budget on play - but it also means the sampler can never
    /// propose an over-cap bet, so no sequence it generates can ever reach a state where
    /// the cap has been breached. That made `invariant_payoutWithinCap`'s second
    /// assertion unfalsifiable: deleting the `stake > maxBet(tier)` check from `placeBet`
    /// left the campaign fully green, which is exactly the "passes for every input"
    /// failure this whole property was written to remove.
    ///
    /// So the extreme gets its own handler rather than being left to the sampler, the
    /// same fix and for the same reason as `handleBurnAllProfit` below. While the cap
    /// check is intact this reverts and costs one call; once it is not, the bet lands and
    /// the invariant fires. Twice the cap, not `maxBet + 1`, because `maxBet` truncates
    /// down and a one-wei overage can still fit inside `maxPayout`'s own rounding slack -
    /// the assertion would then be honestly satisfied and prove nothing either way.
    function handlePlaceOverCapBet(uint8 tierSeed, uint256 clientSeed) public {
        if (game.activeBetId() != 0) return;

        uint8 tier = uint8(tierSeed % game.TIER_COUNT());
        uint256 overCap = game.maxBet(tier) * 2;
        if (overCap < game.minBet() || overCap > rush.balanceOf(address(this))) return;

        _place(tier, overCap, clientSeed);
    }

    /// @dev Place a bet and record its terms, including the cap it was placed under.
    function _place(uint8 tier, uint256 stake, uint256 clientSeed) private {
        // Read before the call: afterwards the stake has joined the treasury.
        uint256 capAtPlacement = game.maxPayout();
        game.placeBet(tier, stake, clientSeed);
        openTier = tier;
        openStake = stake;
        openMaxPayout = capAtPlacement;
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

    /// @dev Lawful governance loosening and tightening of the solvency cap (#57).
    ///
    /// Folded into `[MIN_SOLVENCY_CAP_DEN, 1000]`, and both ends of that fold are
    /// deliberate. The bottom is the floor itself, so the loosest cap governance may
    /// legally set is reached rather than approached - that is the state
    /// `invariant_payoutWithinCap` is tightest against. The top is 1000 (a 0.1% cap)
    /// rather than `MAX_ECONOMIC_RATIO`, because a denominator near 2^56 drives `maxBet`
    /// below `minBet` and every subsequent `handlePlaceBet` becomes a no-op, which would
    /// starve the campaign of the play it exists to explore. Folding away the *tight* end
    /// is safe in a way folding away the loose end is not: an over-tight cap cannot
    /// breach a solvency bound, it can only refuse bets.
    function handleSetSolvencyCap(uint256 denSeed) public {
        if (game.activeBetId() != 0) return; // whenBetInactive; would revert and cost a call
        if (!game.economicsGovernable()) game.setEconomicsGovernable(true);

        uint256 floor = game.MIN_SOLVENCY_CAP_DEN();
        game.setSolvencyCap(floor + (denSeed % (1_000 - floor + 1)));
    }

    /// @dev The extreme, as its own zero-argument call, for the same reason as
    /// `handlePlaceOverCapBet` and `handleBurnAllProfit`: a folded input can never reach
    /// the value the guard exists to reject, so the assertion about it cannot fail.
    ///
    /// `den == 1` is the case #57 was opened on - it sets `maxPayout` to the entire
    /// treasury, so one win takes the bankroll. While `MIN_SOLVENCY_CAP_DEN` is intact
    /// this reverts and costs a single call. Delete that bound and the cap lands at 1,
    /// `maxPayout` becomes the whole balance, and `invariant_payoutWithinCap` fires on the
    /// next check. That is the plant this handler has to be verified against.
    function handleSetSolvencyCapBelowFloor() public {
        if (game.activeBetId() != 0) return;
        if (!game.economicsGovernable()) game.setEconomicsGovernable(true);

        game.setSolvencyCap(1);
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
    ///
    /// @dev Worth stating plainly, because the property count otherwise overstates the
    ///      coverage: with a single actor and a single pot, `invariant_solvency` reduces
    ///      to `_activeLiability() <= rush.balanceOf(treasuryVault)`, which is the same
    ///      inequality the first conservation ledger already asserts. It cannot fail
    ///      unless `invariant_conservation` has failed first, so it is one property, not
    ///      two. Both bindings are kept because they are the mixins' interface and the
    ///      duplication is free, but the independent signal in this file comes from
    ///      `invariant_payoutWithinCap` below - it is the only one that survives a wrong
    ///      multiplier, and the only one that reads the spec's numbers rather than the
    ///      contract's.
    function claimableBy(address actor) public view override returns (uint256) {
        return actor == address(this) ? _activeLiability() : 0;
    }

    /// @notice The solvency cap the spec locks, checked against the live bet.
    ///
    /// @dev The gap this closes: `invariant_solvency` above compares the open bet's
    ///      liability against the treasury's whole balance, so it says "solvent" and
    ///      stops there. Spec §5 locks something strictly stronger - "maxPayout <= ~1%
    ///      of the Treasury's current RUSH balance" - and a system can satisfy the first
    ///      while violating the second on every bet.
    ///
    ///      Three assertions, each falsifiable on its own:
    ///
    ///      1. The contract's payout never exceeds the spec's `0.95 x N x stake`. This is
    ///         the one the mixins cannot make, because `_activeLiability` used to derive
    ///         its expectation from `game.payoutFor` - a wrong multiplier would have
    ///         inflated expectation and payout together and cancelled out.
    ///      2. The open bet's win stays inside the `maxPayout` it was placed under.
    ///         Deleting the `stake > maxBet(tier)` check in `placeBet` breaks this, but
    ///         only in company with `handlePlaceOverCapBet` - and the claim was false
    ///         before that handler existed, which is the whole reason it does. Verified
    ///         by planting that deletion: with the handler the campaign fails, without it
    ///         the campaign was green. The snapshot is a separate and narrower fix, and
    ///         not what catches that plant - a stake of twice the cap overshoots by so
    ///         much that even the inflated live figure is exceeded. What the snapshot
    ///         catches is a marginal breach: at `maxBet + 1` the stake lifts a live
    ///         `maxPayout()` by roughly `maxBet / 100`, which dwarfs the overage and
    ///         swallows it. Both are needed, for different sizes of the same bug.
    ///      3. `maxPayout` stays within the spec's 5% governance ceiling. This catches a
    ///         governance action that loosens `solvencyCapDen` too far - at `den == 1` a
    ///         single win drains the pool, which is what #57 was opened on.
    ///         **It asserts 5%, not §5's seeded 1%, and the difference is not a
    ///         weakening.** Loosening within the permitted band is lawful, so an assertion
    ///         at 1% would fire on a legal `setSolvencyCap` rather than on a defect. The
    ///         1% is a default, pinned separately below; 5% is the bound that must hold
    ///         across every reachable state.
    ///         Until #57 this assertion could not fail at all: nothing flipped
    ///         `economicsGovernable`, so `solvencyCapDen` sat at 100 for whole runs and
    ///         the check compared 1% against 1%. `handleSetSolvencyCapBelowFloor` is what
    ///         makes it bite, and the plant to verify against is deleting
    ///         `MIN_SOLVENCY_CAP_DEN` from `setSolvencyCap`.
    ///         Both sides do read `treasuryBalance()`, so this cannot catch that number
    ///         itself being wrong - it catches the ratio, which is what §5 locks.
    ///      4. The shipped default still is the spec's 1%. A constant against a literal,
    ///         which is a valid anchor precisely because the literal comes from the spec
    ///         and not from the contract. It cannot fail mid-run, and it is not meant to:
    ///         it fails at compile-to-campaign time if someone retunes the seeded default
    ///         without amending §5.
    ///
    /// The `invariant_` prefix is the vocabulary the property mixins already use -
    /// `invariant_solvency` and `invariant_conservation` are named the same way, and the
    /// campaign's output is read by that prefix. Those two live in the submodule, which
    /// the lint glob does not reach, so this is the first one solhint has ever seen.
    /// Renaming it to satisfy the linter would break the convention it belongs to.
    // solhint-disable-next-line func-name-mixedcase
    function invariant_payoutWithinCap() public view {
        _check(
            game.maxPayout() <= game.treasuryBalance() / SPEC_MIN_SOLVENCY_CAP_DEN,
            "solvency cap: maxPayout exceeds the spec's 5% governance ceiling"
        );
        _check(
            game.DEFAULT_SOLVENCY_CAP_DEN() == SPEC_SOLVENCY_CAP_DEN,
            "solvency cap: the seeded default no longer matches the spec's 1%"
        );

        if (game.activeBetId() == 0 || openStake == 0) return;

        _check(
            game.payoutFor(openTier, openStake) <= _specPayout(openTier, openStake),
            "payout: contract pays more than the spec's 0.95 x N x stake"
        );
        _check(
            game.payoutFor(openTier, openStake) <= openMaxPayout,
            "solvency cap: the open bet's win exceeds the maxPayout it was placed under"
        );
    }

    /// @dev What the treasury owes on the open bet, taking the worse of the two ways it
    ///      can resolve. A win pays the multiplier; a timeout returns the stake. Payout is
    ///      always the larger (0.95 x N x stake, N >= 2), but taking the max keeps the
    ///      property honest if the tier table ever changes.
    ///
    ///      The payout leg is the SPEC's formula, not `game.payoutFor`. Calling the
    ///      contract here would make the property circular in the one dimension that
    ///      matters: a multiplier bug would raise the expectation and the payout by the
    ///      same amount, and conservation would go on holding while every winner was paid
    ///      the wrong number. `invariant_payoutWithinCap` pins the two together.
    function _activeLiability() internal view returns (uint256) {
        if (game.activeBetId() == 0 || openStake == 0) return 0;

        uint256 payout = _specPayout(openTier, openStake);
        return payout > openStake ? payout : openStake;
    }

    /// @dev Spec §4's payout, derived from the spec's own numbers. The tier table is
    ///      restated rather than read from `game.odds` for the same non-circularity
    ///      reason; §4 locks these six values.
    function _specPayout(uint8 tier, uint256 stake) internal pure returns (uint256) {
        return (stake * SPEC_EDGE_NUM * _specOdds(tier)) / SPEC_EDGE_DEN;
    }

    /// @dev Spec §4: tiers are 1-in-2, 4, 10, 50, 100, 1000.
    function _specOdds(uint8 tier) internal pure returns (uint256) {
        if (tier == 0) return 2;
        if (tier == 1) return 4;
        if (tier == 2) return 10;
        if (tier == 3) return 50;
        if (tier == 4) return 100;
        if (tier == 5) return 1000;
        revert TierOutsideSpecTable(tier);
    }
}
