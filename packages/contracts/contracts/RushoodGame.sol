// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
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
///      3. On success the chain advances (`currentCommit = reveal`).
///      4. If no relayer settles within `SETTLE_TIMEOUT`, the player can `refund` the
///         locked stake. The relayer may `rotateChain` (only between bets).
///
///      Economics:
///      - Tier N is a 1-in-N shot: win when `keccak256(reveal, clientSeed) % N == 0`,
///        so P(win) = 1/N. The winning payout is `0.95 * N * stake`, giving an
///        expected return of `(1/N) * 0.95 * N = 0.95` on every tier — a flat 5% edge.
///      - `maxPayout = 1% of the treasury balance`. The per-tier cap
///        `maxBet(tier) = maxPayout / multiplier` guarantees any single win costs at
///        most 1% of the pool, and because the stake is added to the treasury on
///        `placeBet` (and no other bet can interleave — one bet is active at a time),
///        a placed bet's payout is *always* affordable at settle time. This resolves
///        the underfunded-treasury brick left open by the skeleton.
///      - Below `TREASURY_FLOOR` the game pauses: no new bets are accepted until the
///        pool is refilled.
///
///      One bet is active at a time (concurrency deepens later); the relayer role
///      gains governance (multisig + timelock) in #22.
contract RushoodGame {
    using SafeERC20 for IERC20;

    struct Bet {
        address player;
        uint8 tier;
        uint256 stake;
        uint256 clientSeed;
        uint256 placedAt;
        bool settled;
    }

    /// @notice Number of selectable odds tiers.
    uint8 public constant TIER_COUNT = 6;

    /// @notice Payout numerator/denominator: winnings = stake * EDGE_NUM * N / EDGE_DEN.
    ///         95/100 = 0.95, i.e. a 5% house edge on every tier.
    uint256 public constant EDGE_NUM = 95;
    uint256 public constant EDGE_DEN = 100;

    /// @notice Solvency cap denominator: a single win may pay at most 1/CAP of the pool.
    uint256 public constant SOLVENCY_CAP_DEN = 100; // 1% of treasury balance

    /// @notice Smallest allowed stake.
    uint256 public constant MIN_BET = 1e18;

    /// @notice Below this treasury balance the game pauses (accepts no new bets).
    /// @dev Set to `MIN_BET * EDGE_NUM * 1000` — the pool size at which the riskiest
    ///      tier's (1-in-1000) minimum bet exactly saturates the 1% solvency cap:
    ///      `maxBet(moonshot) == MIN_BET` here. At or above the floor every tier is
    ///      therefore playable at a >= MIN_BET stake; below it the house is too thin
    ///      to safely back the top tiers, so the game pauses rather than offer a bet
    ///      it can't cover.
    uint256 public constant TREASURY_FLOOR = 95_000 * 1e18;

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

    /// @notice Account authorized to tune economic policy (burn rate, profit-burn).
    /// @dev The deployer at construction; #22 migrates this to a Safe + Timelock.
    address public immutable governance;

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

    event BetPlaced(
        uint256 indexed betId,
        address indexed player,
        uint8 tier,
        uint256 stake,
        uint256 clientSeed
    );
    event BetSettled(uint256 indexed betId, address indexed player, bool win, uint256 payout);
    event StakeBurned(uint256 indexed betId, uint256 amount);
    event BetRefunded(uint256 indexed betId, address indexed player, uint256 amount);
    event ChainRotated(bytes32 newCommit);
    event BurnRateUpdated(uint256 newBps);
    event TreasuryProfitBurned(uint256 amount);

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
    /// @notice Thrown when the stake is below MIN_BET.
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

    /// @param token_ The RUSH token address.
    /// @param treasury_ The treasury holding stakes and funding payouts.
    /// @param initialCommit The genesis head of the server hash chain.
    /// @param relayer_ The account authorized to rotate the chain.
    /// @dev The `governance` role (burn-rate + profit-burn) defaults to the deployer,
    ///      mirroring `Treasury.deployer`; #22 migrates it to a Safe + Timelock.
    constructor(IERC20 token_, Treasury treasury_, bytes32 initialCommit, address relayer_) {
        if (address(token_) == address(0)) revert TokenIsZeroAddress();
        if (address(treasury_) == address(0)) revert TreasuryIsZeroAddress();
        if (relayer_ == address(0)) revert RelayerIsZeroAddress();
        token = token_;
        treasury = treasury_;
        currentCommit = initialCommit;
        relayer = relayer_;
        governance = msg.sender;
        burnRateBps = DEFAULT_BURN_RATE_BPS;
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
    ///      never pays more than the exact 0.95 x N x stake.
    function payoutFor(uint8 tier, uint256 stake) public pure returns (uint256) {
        return (stake * EDGE_NUM * odds(tier)) / EDGE_DEN;
    }

    /// @notice Current treasury balance backing payouts.
    function treasuryBalance() public view returns (uint256) {
        return token.balanceOf(address(treasury));
    }

    /// @notice The most a single win may pay: 1% of the treasury balance.
    function maxPayout() public view returns (uint256) {
        return treasuryBalance() / SOLVENCY_CAP_DEN;
    }

    /// @notice Largest stake allowed on a tier so its win stays within `maxPayout`.
    /// @dev `maxBet = maxPayout / multiplier`. Expanded from that definition
    ///      (`maxPayout = balance / SOLVENCY_CAP_DEN`, `multiplier = EDGE_NUM * N / EDGE_DEN`)
    ///      it is `balance * EDGE_DEN / (SOLVENCY_CAP_DEN * EDGE_NUM * N)`, so it stays
    ///      correct if the edge or the cap change. Integer division rounds down, which
    ///      keeps `payoutFor(tier, maxBet) <= maxPayout` for every tier.
    function maxBet(uint8 tier) public view returns (uint256) {
        return (treasuryBalance() * EDGE_DEN) / (SOLVENCY_CAP_DEN * EDGE_NUM * odds(tier));
    }

    /// @notice Place the single active bet on a tier, locking `stake` into the treasury.
    /// @param tier Odds tier in [0, TIER_COUNT).
    /// @param stake Amount of RUSH to wager, within [MIN_BET, maxBet(tier)].
    /// @param clientSeed Player-supplied entropy mixed into the outcome.
    /// @return betId The id of the newly created bet.
    function placeBet(uint8 tier, uint256 stake, uint256 clientSeed) external returns (uint256 betId) {
        if (activeBetId != 0) revert BetAlreadyActive();
        if (tier >= TIER_COUNT) revert InvalidTier();
        if (treasuryBalance() < TREASURY_FLOOR) revert TreasuryBelowFloor();
        if (stake < MIN_BET) revert BetBelowMin();
        // Cap against the balance *before* this stake is added, so a win pays at most
        // 1% of the pool the bet joined.
        if (stake > maxBet(tier)) revert ExceedsMaxBet();

        betId = ++betCounter;
        activeBetId = betId;
        bets[betId] = Bet({
            player: msg.sender,
            tier: tier,
            stake: stake,
            clientSeed: clientSeed,
            placedAt: block.timestamp,
            settled: false
        });

        token.safeTransferFrom(msg.sender, address(treasury), stake);
        emit BetPlaced(betId, msg.sender, tier, stake, clientSeed);
    }

    /// @notice Settle the active bet with the server reveal.
    /// @param reveal Pre-image of the current chain head (keccak256(reveal) == currentCommit).
    function settleBet(bytes32 reveal) external {
        uint256 betId = activeBetId;
        if (betId == 0) revert NoActiveBet();
        if (keccak256(abi.encodePacked(reveal)) != currentCommit) revert InvalidReveal();

        Bet storage bet = bets[betId];
        bet.settled = true;
        activeBetId = 0;
        currentCommit = reveal;

        // 1-in-N: win when the outcome is congruent to 0 mod N. P(win) = 1/N.
        bool win = uint256(keccak256(abi.encodePacked(reveal, bet.clientSeed))) % odds(bet.tier) == 0;
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
        emit BetSettled(betId, bet.player, win, payout);

        // Burn last: it runs on every settled play (win or loss) but after the payout,
        // so it can never starve a win. A zero rate simply skips it.
        if (burnAmount != 0) {
            treasury.burn(burnAmount);
            emit StakeBurned(betId, burnAmount);
        }
    }

    /// @notice Refund the locked stake for a bet the relayer never settled.
    /// @dev Callable by anyone once `SETTLE_TIMEOUT` has elapsed; the stake returns
    ///      to the original player. The chain head does NOT advance — the reveal
    ///      was never used, so it remains valid for the next bet.
    ///
    ///      Fairness caveat: if the relayer had broadcast `settleBet(reveal)` but the
    ///      tx never confirmed before the timeout, that `reveal` is public in the
    ///      mempool while the head still equals `keccak256(reveal)`. A watcher could
    ///      then predict the next bet's outcome. The relayer therefore rotates the
    ///      chain when it resumes after any downtime (see scripts/relayer.ts); a
    ///      trust-minimised on-chain mitigation lands with governance in #22.
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

    /// @notice Set the per-play stake burn rate, in basis points.
    /// @dev Governance-only and bounded by MAX_BURN_RATE_BPS so the role can tune the
    ///      deflation knob but cannot set a confiscatory rate.
    /// @param newBps New burn rate in basis points (<= MAX_BURN_RATE_BPS).
    function setBurnRate(uint256 newBps) external {
        if (msg.sender != governance) revert NotGovernance();
        if (newBps > MAX_BURN_RATE_BPS) revert BurnRateTooHigh();
        burnRateBps = newBps;
        emit BurnRateUpdated(newBps);
    }

    /// @notice Burn accumulated treasury profit, permanently shrinking the supply.
    /// @dev Governance-only, only between bets, and only down to `TREASURY_FLOOR` — the
    ///      balance above the floor is discretionary profit; the floor is the reserve
    ///      the solvency cap depends on, so it can never be burned away.
    /// @param amount Amount of RUSH to burn from the treasury.
    function burnTreasuryProfit(uint256 amount) external {
        if (msg.sender != governance) revert NotGovernance();
        if (activeBetId != 0) revert BurnWhileBetActive();
        if (treasuryBalance() < TREASURY_FLOOR + amount) revert BurnBelowFloor();
        treasury.burn(amount);
        emit TreasuryProfitBurned(amount);
    }
}
