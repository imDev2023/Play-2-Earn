// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Treasury} from "./Treasury.sol";

/// @title RushoodGame
/// @notice "Pick your odds" number-prediction game settled by an on-chain per-play
///         commit-reveal hash chain. A player chooses one of six odds tiers
///         (1-in-2 up to the 1-in-1000 moonshot) and a stake; every tier pays a flat
///         5% house edge, and bet sizing keeps the house provably solvent.
/// @dev Flow:
///      1. `placeBet(tier, stake, clientSeed)` locks `stake` into the treasury after
///         enforcing the min bet, the per-tier solvency cap, and the treasury floor.
///      2. The relayer calls `settleBet(reveal)` where keccak256(reveal) equals the
///         current chain head. The outcome is derived from `reveal` + the player's
///         `clientSeed`; a win pays `payoutFor(tier, stake)` (= 0.95 x N x stake) from
///         the treasury, a loss leaves the stake in the treasury.
///      3. On success the chain advances (`currentCommit = reveal`). Every input the
///         draw consumed is published — the commitment on `BetPlaced`, the reveal and
///         roll on `BetSettled`, and all of it readable from `bets(betId)` — so anyone
///         can re-run `outcomeOf` and confirm the result (#24).
///      4. If no relayer settles within `SETTLE_TIMEOUT`, the player can `refund` the
///         locked stake. The relayer may `rotateChain` (only between bets).
///
///      Economics:
///      - Tier N is a 1-in-N shot: win when `keccak256(reveal, clientSeed, betId) % N == 0`
///        (see `outcomeOf`), so P(win) = 1/N. The winning payout is `0.95 * N * stake`, giving an
///        expected return of `(1/N) * 0.95 * N = 0.95` on every tier — a flat 5% edge.
///      - `maxPayout = 1% of the treasury balance`. The per-tier cap
///        `maxBet(tier) = maxPayout / multiplier` guarantees any single win costs at
///        most 1% of the pool, and because the stake is added to the treasury on
///        `placeBet` (and no other bet can interleave — one bet is active at a time),
///        a placed bet's payout is *always* affordable at settle time. This resolves
///        the underfunded-treasury brick left open by the skeleton.
///      - Below `treasuryFloor` the game pauses: no new bets are accepted until the
///        pool is refilled.
///
///      Governance (#22):
///      - `governance` — the policy role. Defaults to the deployer and is handed to a
///        `TimelockController` (controlled by a Safe multisig) post-deploy, so every
///        sensitive parameter change is queued behind a public delay.
///      - `guardian` — the emergency role. Also defaults to the deployer and is handed
///        to the Safe; it can `pause`/`unpause`. Pausing halts new bets while leaving
///        `settleBet` and `refund` working, so in-flight bets always resolve.
///      - Economic invariants (edge, solvency cap, min bet, treasury floor) are
///        **immutable by default**: they are seeded from the `DEFAULT_*` constants and
///        their setters revert unless governance flips `economicsGovernable` on. That
///        flag is the opt-in switch for experimenting with a governable economy; with
///        it off the game behaves exactly as the fixed-parameter #20/#21 build. The
///        tier structure itself stays fixed by redeploy.
///
///      One bet is active at a time (concurrency deepens later).
contract RushoodGame is Pausable {
    using SafeERC20 for IERC20;

    struct Bet {
        address player;
        uint8 tier;
        uint256 stake;
        uint256 clientSeed;
        uint256 placedAt;
        bool settled;
        /// @dev Chain head this bet is locked against — the server's commitment,
        ///      published before the bet existed. Stored (not just emitted) so the
        ///      whole verification input set is readable from `bets(betId)` forever,
        ///      without an archive node or an indexer (#24).
        bytes32 commit;
        /// @dev The reveal that settled this bet; zero until settled (a refund also
        ///      leaves it zero, since no reveal was consumed).
        bytes32 reveal;
    }

    /// @notice Number of selectable odds tiers.
    uint8 public constant TIER_COUNT = 6;

    /// @notice Default payout numerator/denominator: 95/100 = 0.95, a 5% house edge.
    /// @dev The effective values live in `edgeNum`/`edgeDen`; these are the seed defaults.
    uint256 public constant DEFAULT_EDGE_NUM = 95;
    uint256 public constant DEFAULT_EDGE_DEN = 100;

    /// @notice Default solvency cap denominator: a single win may pay at most 1/CAP of the pool.
    uint256 public constant DEFAULT_SOLVENCY_CAP_DEN = 100; // 1% of treasury balance

    /// @notice Default smallest allowed stake.
    uint256 public constant DEFAULT_MIN_BET = 1e18;

    /// @notice Default treasury floor below which the game pauses (accepts no new bets).
    /// @dev `DEFAULT_MIN_BET * DEFAULT_EDGE_NUM * 1000` — the pool size at which the
    ///      riskiest tier's (1-in-1000) minimum bet exactly saturates the 1% solvency
    ///      cap: `maxBet(moonshot) == minBet` here. At or above the floor every tier is
    ///      therefore playable at a >= minBet stake; below it the house is too thin to
    ///      safely back the top tiers, so the game pauses rather than offer a bet it
    ///      can't cover.
    uint256 public constant DEFAULT_TREASURY_FLOOR = 95_000 * 1e18;

    /// @notice How long an unsettled bet must wait before it can be refunded.
    uint256 public constant SETTLE_TIMEOUT = 1 hours;

    /// @notice Basis-points denominator for the burn rate (10000 = 100%).
    uint256 public constant BPS_DEN = 10_000;

    /// @notice Default per-play burn rate: 2.5% of the stake.
    uint256 public constant DEFAULT_BURN_RATE_BPS = 250;

    /// @notice Ceiling governance may set the burn rate to: 10% of the stake.
    uint256 public constant MAX_BURN_RATE_BPS = 1_000;

    /// @notice The RUSH token staked and paid out.
    IERC20 public immutable token;

    /// @notice The treasury that custodies stakes and funds payouts.
    Treasury public immutable treasury;

    /// @notice Account authorized to rotate the server hash chain.
    address public immutable relayer;

    /// @notice Policy role: tunes the burn rate, profit-burns, and (when unlocked) the
    ///         economic invariants, and manages the governance/guardian roles.
    /// @dev Defaults to the deployer; migrated to a Timelock + Safe post-deploy (#22).
    address public governance;

    /// @notice Emergency role: can pause/unpause the game. Defaults to the deployer;
    ///         migrated to the Safe multisig post-deploy (#22).
    address public guardian;

    /// @notice When false (the default) the economic-invariant setters revert; when
    ///         governance flips it true, edge/cap/min-bet/floor become tunable via the
    ///         timelock. The opt-in switch for a governable economy.
    bool public economicsGovernable;

    /// @notice Effective payout numerator/denominator (winnings = stake * num * N / den).
    uint256 public edgeNum;
    uint256 public edgeDen;

    /// @notice Effective solvency cap denominator: a win pays at most 1/den of the pool.
    uint256 public solvencyCapDen;

    /// @notice Effective smallest allowed stake.
    uint256 public minBet;

    /// @notice Effective treasury floor below which the game pauses.
    uint256 public treasuryFloor;

    /// @notice Fraction of each settled stake that is burned, in basis points.
    uint256 public burnRateBps;

    /// @notice Head of the server hash chain: the next reveal must hash to this.
    bytes32 public currentCommit;

    /// @notice Monotonic bet id counter (also the id of the most recent bet).
    uint256 public betCounter;

    /// @notice Id of the currently unsettled bet, or 0 when none is active.
    uint256 public activeBetId;

    /// @notice All bets by id.
    mapping(uint256 => Bet) public bets;

    /// @param commit The server commitment this bet is locked against. Together with
    ///        the `reveal` in `BetSettled` it lets anyone re-run the whole draw from
    ///        events alone — see `outcomeOf` and the public verifier.
    event BetPlaced(
        uint256 indexed betId,
        address indexed player,
        uint8 tier,
        uint256 stake,
        uint256 clientSeed,
        bytes32 commit
    );
    /// @param reveal The server's pre-image of the bet's commitment.
    /// @param roll The draw reduced to the tier's range; a win is a roll of 0.
    event BetSettled(
        uint256 indexed betId,
        address indexed player,
        bool win,
        uint256 payout,
        bytes32 reveal,
        uint256 roll
    );
    event StakeBurned(uint256 indexed betId, uint256 amount);
    event BetRefunded(uint256 indexed betId, address indexed player, uint256 amount);
    event ChainRotated(bytes32 newCommit);
    event BurnRateUpdated(uint256 newBps);
    event TreasuryProfitBurned(uint256 amount);
    event GovernanceTransferred(address indexed previous, address indexed next);
    event GuardianTransferred(address indexed previous, address indexed next);
    event EconomicsGovernableSet(bool enabled);
    event MinBetUpdated(uint256 newMinBet);
    event EdgeUpdated(uint256 newNum, uint256 newDen);
    event SolvencyCapUpdated(uint256 newCapDen);
    event TreasuryFloorUpdated(uint256 newFloor);

    /// @notice Thrown when the constructor is given the zero address as token.
    error TokenIsZeroAddress();
    /// @notice Thrown when the constructor is given the zero address as treasury.
    error TreasuryIsZeroAddress();
    /// @notice Thrown when the constructor is given the zero address as relayer.
    error RelayerIsZeroAddress();
    /// @notice Thrown when a tier index is not in [0, TIER_COUNT).
    error InvalidTier();
    /// @notice Thrown when placing a bet while one is already active.
    error BetAlreadyActive();
    /// @notice Thrown when the stake is below minBet.
    error BetBelowMin();
    /// @notice Thrown when the stake exceeds the per-tier solvency cap.
    error ExceedsMaxBet();
    /// @notice Thrown when the treasury balance is below the floor (game paused).
    error TreasuryBelowFloor();
    /// @notice Thrown when rotating the chain while a bet is still active.
    error CannotRotateMidBet();
    /// @notice Thrown when settling with no bet active.
    error NoActiveBet();
    /// @notice Thrown when the reveal does not hash to the current chain head.
    error InvalidReveal();
    /// @notice Thrown when a non-relayer attempts to rotate the chain.
    error NotRelayer();
    /// @notice Thrown when a non-governance account calls a governance-only function.
    error NotGovernance();
    /// @notice Thrown when a non-guardian account calls a guardian-only function.
    error NotGuardian();
    /// @notice Thrown when handing governance to the zero address.
    error GovernanceIsZeroAddress();
    /// @notice Thrown when handing the guardian role to the zero address.
    error GuardianIsZeroAddress();
    /// @notice Thrown when setting a burn rate above MAX_BURN_RATE_BPS.
    error BurnRateTooHigh();
    /// @notice Thrown when a profit-burn would drop the treasury below the floor.
    error BurnBelowFloor();
    /// @notice Thrown when a profit-burn is attempted while a bet is active.
    error BurnWhileBetActive();
    /// @notice Thrown when refunding a bet id that is not the active, unsettled bet.
    error NotRefundable();
    /// @notice Thrown when refunding before the settle timeout has elapsed.
    error RefundNotReady();
    /// @notice Thrown when an economic setter is called while the economy is locked.
    error EconomicsLocked();
    /// @notice Thrown when an economic setter is given an out-of-range value.
    error InvalidEconomics();
    /// @notice Thrown when an economic parameter change is attempted while a bet is active.
    error EconomicUpdateWhileBetActive();

    /// @dev Restricts a call to the governance (policy) role.
    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    /// @dev Restricts a call to the guardian (emergency) role.
    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    /// @dev Restricts an economic-invariant setter to when governance has unlocked them.
    modifier whenEconomicsGovernable() {
        if (!economicsGovernable) revert EconomicsLocked();
        _;
    }

    /// @dev Blocks an economic-parameter change while a bet is in flight. A bet's payout
    ///      is capped at `placeBet` against the *then-current* edge/cap; forbidding a
    ///      mid-bet change keeps that payability guarantee enforced by the contract rather
    ///      than left to rely on the governance timelock outlasting `SETTLE_TIMEOUT`.
    modifier whenBetInactive() {
        if (activeBetId != 0) revert EconomicUpdateWhileBetActive();
        _;
    }

    /// @param token_ The RUSH token address.
    /// @param treasury_ The treasury holding stakes and funding payouts.
    /// @param initialCommit The genesis head of the server hash chain.
    /// @param relayer_ The account authorized to rotate the chain.
    /// @dev The `governance` and `guardian` roles both default to the deployer, mirroring
    ///      `Treasury.deployer`; #22 migrates them to a Timelock + Safe post-deploy. The
    ///      economic invariants are seeded from the `DEFAULT_*` constants and stay locked
    ///      (`economicsGovernable == false`) until governance opts in.
    constructor(IERC20 token_, Treasury treasury_, bytes32 initialCommit, address relayer_) {
        if (address(token_) == address(0)) revert TokenIsZeroAddress();
        if (address(treasury_) == address(0)) revert TreasuryIsZeroAddress();
        if (relayer_ == address(0)) revert RelayerIsZeroAddress();
        token = token_;
        treasury = treasury_;
        currentCommit = initialCommit;
        relayer = relayer_;
        governance = msg.sender;
        guardian = msg.sender;
        burnRateBps = DEFAULT_BURN_RATE_BPS;
        edgeNum = DEFAULT_EDGE_NUM;
        edgeDen = DEFAULT_EDGE_DEN;
        solvencyCapDen = DEFAULT_SOLVENCY_CAP_DEN;
        minBet = DEFAULT_MIN_BET;
        treasuryFloor = DEFAULT_TREASURY_FLOOR;
    }

    /// @notice The odds N for a tier: a 1-in-N shot.
    /// @param tier Tier index in [0, TIER_COUNT).
    /// @return The odds N (2, 4, 10, 50, 100, or 1000).
    function odds(uint8 tier) public pure returns (uint256) {
        if (tier == 0) return 2;
        if (tier == 1) return 4;
        if (tier == 2) return 10;
        if (tier == 3) return 50;
        if (tier == 4) return 100;
        if (tier == 5) return 1000;
        revert InvalidTier();
    }

    /// @notice The winning payout for a stake on a tier: 0.95 * N * stake.
    /// @dev Integer division rounds the payout down (in the house's favour), so a win
    ///      never pays more than the exact edge x N x stake.
    function payoutFor(uint8 tier, uint256 stake) public view returns (uint256) {
        return (stake * edgeNum * odds(tier)) / edgeDen;
    }

    /// @notice Recompute a draw from its public inputs — the game's fairness formula,
    ///         callable by anyone.
    /// @dev This is *the* outcome rule: `settleBet` calls it rather than repeating the
    ///      arithmetic, so the number the game settles on and the number a skeptic
    ///      recomputes come from one implementation. The public verifier package
    ///      mirrors it off-chain and its test suite pins the two together.
    ///
    ///      Neither party can grind the draw. The server's `reveal` is fixed before the
    ///      bet exists (only its hash is public — the standing commitment), and the
    ///      player's `clientSeed` is fixed at bet time, before the reveal is public.
    ///      Mixing `betId` in domain-separates bets, so an outcome can never be replayed
    ///      onto another bet — relevant after a refund, which deliberately leaves the
    ///      chain head unadvanced.
    /// @param reveal The server's pre-image of the bet's commitment.
    /// @param clientSeed The player's entropy, fixed at bet time.
    /// @param betId The bet's id.
    /// @param tier Odds tier in [0, TIER_COUNT).
    /// @return roll The draw reduced to the tier's range, in [0, N).
    /// @return win True when `roll == 0` — a 1-in-N event.
    function outcomeOf(bytes32 reveal, uint256 clientSeed, uint256 betId, uint8 tier)
        public
        pure
        returns (uint256 roll, bool win)
    {
        roll = uint256(keccak256(abi.encodePacked(reveal, clientSeed, betId))) % odds(tier);
        win = roll == 0;
    }

    /// @notice Current treasury balance backing payouts.
    function treasuryBalance() public view returns (uint256) {
        return token.balanceOf(address(treasury));
    }

    /// @notice The most a single win may pay: 1/solvencyCapDen of the treasury balance.
    function maxPayout() public view returns (uint256) {
        return treasuryBalance() / solvencyCapDen;
    }

    /// @notice Largest stake allowed on a tier so its win stays within `maxPayout`.
    /// @dev `maxBet = maxPayout / multiplier`. Expanded from that definition
    ///      (`maxPayout = balance / solvencyCapDen`, `multiplier = edgeNum * N / edgeDen`)
    ///      it is `balance * edgeDen / (solvencyCapDen * edgeNum * N)`, so it stays
    ///      correct if the edge or the cap change. Integer division rounds down, which
    ///      keeps `payoutFor(tier, maxBet) <= maxPayout` for every tier.
    function maxBet(uint8 tier) public view returns (uint256) {
        return (treasuryBalance() * edgeDen) / (solvencyCapDen * edgeNum * odds(tier));
    }

    /// @notice Place the single active bet on a tier, locking `stake` into the treasury.
    /// @dev Blocked while paused: an emergency pause halts new bets but leaves settlement
    ///      and refunds working, so in-flight bets always resolve.
    /// @param tier Odds tier in [0, TIER_COUNT).
    /// @param stake Amount of RUSH to wager, within [minBet, maxBet(tier)].
    /// @param clientSeed Player-supplied entropy mixed into the outcome.
    /// @return betId The id of the newly created bet.
    function placeBet(uint8 tier, uint256 stake, uint256 clientSeed)
        external
        whenNotPaused
        returns (uint256 betId)
    {
        if (activeBetId != 0) revert BetAlreadyActive();
        if (tier >= TIER_COUNT) revert InvalidTier();
        if (treasuryBalance() < treasuryFloor) revert TreasuryBelowFloor();
        if (stake < minBet) revert BetBelowMin();
        // Cap against the balance *before* this stake is added, so a win pays at most
        // 1% of the pool the bet joined.
        if (stake > maxBet(tier)) revert ExceedsMaxBet();

        betId = ++betCounter;
        activeBetId = betId;
        // Pin the commitment the bet is locked against at placement time, so the
        // player's proof that the server committed *before* the draw survives the
        // head advancing on every later settlement.
        bytes32 commit = currentCommit;
        bets[betId] = Bet({
            player: msg.sender,
            tier: tier,
            stake: stake,
            clientSeed: clientSeed,
            placedAt: block.timestamp,
            settled: false,
            commit: commit,
            reveal: bytes32(0)
        });

        token.safeTransferFrom(msg.sender, address(treasury), stake);
        emit BetPlaced(betId, msg.sender, tier, stake, clientSeed, commit);
    }

    /// @notice Settle the active bet with the server reveal.
    /// @dev Not gated by pause: an in-flight bet must always be able to resolve.
    /// @param reveal Pre-image of the current chain head (keccak256(reveal) == currentCommit).
    function settleBet(bytes32 reveal) external {
        uint256 betId = activeBetId;
        if (betId == 0) revert NoActiveBet();
        if (keccak256(abi.encodePacked(reveal)) != currentCommit) revert InvalidReveal();

        Bet storage bet = bets[betId];
        bet.settled = true;
        bet.reveal = reveal;
        activeBetId = 0;
        currentCommit = reveal;

        // 1-in-N: win when the draw lands on 0. P(win) = 1/N. The rule lives in the
        // public `outcomeOf` so the settled result and any independent recomputation
        // come from the same implementation (#24).
        (uint256 roll, bool win) = outcomeOf(reveal, bet.clientSeed, betId, bet.tier);
        uint256 payout = win ? payoutFor(bet.tier, bet.stake) : 0;
        // Deflation: a slice of every settled stake is burned regardless of outcome,
        // so totalSupply only ever falls as the game is played. Tiny next to the 1%
        // solvency cap, so it never threatens payability.
        uint256 burnAmount = (bet.stake * burnRateBps) / BPS_DEN;
        if (win) {
            // Effects above the external calls keep this reentrancy-safe. The solvency
            // cap enforced at placeBet guarantees the treasury (which also holds this
            // bet's stake) can always cover `payout`, so this never bricks the game.
            treasury.pay(bet.player, payout);
        }
        emit BetSettled(betId, bet.player, win, payout, reveal, roll);

        // Burn last: it runs on every settled play (win or loss) but after the payout,
        // so it can never starve a win. A zero rate simply skips it.
        if (burnAmount != 0) {
            treasury.burn(burnAmount);
            emit StakeBurned(betId, burnAmount);
        }
    }

    /// @notice Refund the locked stake for a bet the relayer never settled.
    /// @dev Callable by anyone once `SETTLE_TIMEOUT` has elapsed; the stake returns
    ///      to the original player. Works even while paused, so an emergency pause never
    ///      strands a player's funds. The chain head does NOT advance — the reveal was
    ///      never used, so it remains valid for the next bet.
    ///
    ///      Fairness caveat: if the relayer had broadcast `settleBet(reveal)` but the
    ///      tx never confirmed before the timeout, that `reveal` is public in the
    ///      mempool while the head still equals `keccak256(reveal)`. A watcher could
    ///      then predict the next bet's outcome. The relayer therefore rotates the
    ///      chain when it resumes after any downtime (see scripts/relayer.ts); the
    ///      guardian can additionally pause new bets during an incident (#22).
    /// @param betId The active, unsettled bet to refund.
    function refund(uint256 betId) external {
        if (betId == 0 || betId != activeBetId) revert NotRefundable();

        Bet storage bet = bets[betId];
        if (block.timestamp < bet.placedAt + SETTLE_TIMEOUT) revert RefundNotReady();

        bet.settled = true;
        activeBetId = 0;

        treasury.pay(bet.player, bet.stake);
        emit BetRefunded(betId, bet.player, bet.stake);
    }

    /// @notice Rotate the server hash chain to a fresh genesis commit.
    /// @dev Relayer-only and only between bets: an active bet's reveal lives on the
    ///      current chain, so rotating mid-bet would strand it. Used to roll to a
    ///      new chain before the current one is exhausted.
    /// @param newGenesis The genesis head of the replacement chain.
    function rotateChain(bytes32 newGenesis) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (activeBetId != 0) revert CannotRotateMidBet();
        currentCommit = newGenesis;
        emit ChainRotated(newGenesis);
    }

    // ---------------------------------------------------------------------------------
    // Emergency pause (guardian)
    // ---------------------------------------------------------------------------------

    /// @notice Halt new bets in an emergency. Settlement and refunds keep working.
    /// @dev Guardian-only (the Safe multisig) so it can act immediately, without the
    ///      governance timelock delay that slow policy changes require.
    function pause() external onlyGuardian {
        _pause();
    }

    /// @notice Resume accepting new bets.
    function unpause() external onlyGuardian {
        _unpause();
    }

    // ---------------------------------------------------------------------------------
    // Role management (governance)
    // ---------------------------------------------------------------------------------

    /// @notice Hand the governance (policy) role to a new holder — e.g. the Timelock.
    /// @dev Governance-only, so once handed to the timelock only a timelocked call can
    ///      move it again.
    function setGovernance(address newGovernance) external onlyGovernance {
        if (newGovernance == address(0)) revert GovernanceIsZeroAddress();
        emit GovernanceTransferred(governance, newGovernance);
        governance = newGovernance;
    }

    /// @notice Hand the guardian (emergency pause) role to a new holder — e.g. the Safe.
    /// @dev Governance-managed: the policy role assigns the emergency role.
    function setGuardian(address newGuardian) external onlyGovernance {
        if (newGuardian == address(0)) revert GuardianIsZeroAddress();
        emit GuardianTransferred(guardian, newGuardian);
        guardian = newGuardian;
    }

    // ---------------------------------------------------------------------------------
    // Economic policy (governance)
    // ---------------------------------------------------------------------------------

    /// @notice Set the per-play stake burn rate, in basis points.
    /// @dev Governance-only and bounded by MAX_BURN_RATE_BPS so the role can tune the
    ///      deflation knob but cannot set a confiscatory rate.
    /// @param newBps New burn rate in basis points (<= MAX_BURN_RATE_BPS).
    function setBurnRate(uint256 newBps) external onlyGovernance {
        if (newBps > MAX_BURN_RATE_BPS) revert BurnRateTooHigh();
        burnRateBps = newBps;
        emit BurnRateUpdated(newBps);
    }

    /// @notice Burn accumulated treasury profit, permanently shrinking the supply.
    /// @dev Governance-only, only between bets, and only down to `treasuryFloor` — the
    ///      balance above the floor is discretionary profit; the floor is the reserve
    ///      the solvency cap depends on, so it can never be burned away.
    /// @param amount Amount of RUSH to burn from the treasury.
    function burnTreasuryProfit(uint256 amount) external onlyGovernance {
        if (activeBetId != 0) revert BurnWhileBetActive();
        if (treasuryBalance() < treasuryFloor + amount) revert BurnBelowFloor();
        treasury.burn(amount);
        emit TreasuryProfitBurned(amount);
    }

    /// @notice Unlock or re-lock the economic-invariant setters.
    /// @dev The opt-in switch for a governable economy. Off by default, so the fixed
    ///      #20/#21 parameters are effectively immutable; governance can flip it on to
    ///      experiment with tuning edge/cap/min-bet/floor via the timelock, and off again
    ///      to re-freeze them.
    function setEconomicsGovernable(bool enabled) external onlyGovernance {
        economicsGovernable = enabled;
        emit EconomicsGovernableSet(enabled);
    }

    /// @notice Set the minimum stake. Requires the economy to be unlocked.
    /// @dev Rejects zero; only settable between bets (see `whenBetInactive`).
    function setMinBet(uint256 newMinBet)
        external
        onlyGovernance
        whenEconomicsGovernable
        whenBetInactive
    {
        if (newMinBet == 0) revert InvalidEconomics();
        minBet = newMinBet;
        emit MinBetUpdated(newMinBet);
    }

    /// @notice Set the house edge as `num/den` (payout multiplier per unit of odds).
    /// @dev Requires `0 < num <= den` so the payout is a real, non-negative house edge;
    ///      only settable between bets (see `whenBetInactive`).
    function setEdge(uint256 num, uint256 den)
        external
        onlyGovernance
        whenEconomicsGovernable
        whenBetInactive
    {
        if (num == 0 || den == 0 || num > den) revert InvalidEconomics();
        edgeNum = num;
        edgeDen = den;
        emit EdgeUpdated(num, den);
    }

    /// @notice Set the solvency cap denominator (a win pays at most 1/den of the pool).
    /// @dev Requires `den >= 1`; a larger denominator is a tighter (safer) cap; only
    ///      settable between bets (see `whenBetInactive`).
    function setSolvencyCap(uint256 den)
        external
        onlyGovernance
        whenEconomicsGovernable
        whenBetInactive
    {
        if (den == 0) revert InvalidEconomics();
        solvencyCapDen = den;
        emit SolvencyCapUpdated(den);
    }

    /// @notice Set the treasury floor below which the game pauses new bets.
    /// @dev Rejects a zero floor: the floor is the solvency reserve the per-tier cap
    ///      depends on, so disabling it entirely would break the payability guarantee.
    ///      Only settable between bets (see `whenBetInactive`).
    function setTreasuryFloor(uint256 newFloor)
        external
        onlyGovernance
        whenEconomicsGovernable
        whenBetInactive
    {
        if (newFloor == 0) revert InvalidEconomics();
        treasuryFloor = newFloor;
        emit TreasuryFloorUpdated(newFloor);
    }
}
