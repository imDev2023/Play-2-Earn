// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Treasury} from "./Treasury.sol";

/// @title RushoodGame
/// @notice One hardcoded tier settled by an on-chain per-play commit-reveal hash
///         chain, with a relayer that settles automatically and a timeout refund
///         that protects players if the relayer goes dark.
/// @dev Flow:
///      1. `placeBet(clientSeed)` locks a fixed stake into the treasury and stamps
///         the time.
///      2. The relayer calls `settleBet(reveal)` where keccak256(reveal) equals the
///         current chain head, paying its own gas. The outcome is derived from
///         `reveal` + the player's `clientSeed`; a win pays `PAYOUT_MULTIPLIER x`
///         stake from the treasury, a loss leaves the stake in the treasury.
///      3. On success the chain advances (`currentCommit = reveal`).
///      4. If no relayer settles within `SETTLE_TIMEOUT`, the player can `refund`
///         the locked stake. The relayer may `rotateChain` to a fresh chain (only
///         between bets) before the current chain is exhausted.
///
///      One bet is active at a time. Multiple concurrent bets, odds tiers, and
///      payout math deepen in later tickets; the relayer role gains governance
///      (multisig + timelock) in #22.
contract RushoodGame {
    using SafeERC20 for IERC20;

    struct Bet {
        address player;
        uint256 stake;
        uint256 clientSeed;
        uint256 placedAt;
        bool settled;
    }

    /// @notice Fixed stake for the single hardcoded tier.
    uint256 public constant BET_AMOUNT = 100 * 1e18;

    /// @notice Winning payout multiplier for the single hardcoded tier (zero-edge).
    uint256 public constant PAYOUT_MULTIPLIER = 2;

    /// @notice How long an unsettled bet must wait before it can be refunded.
    uint256 public constant SETTLE_TIMEOUT = 1 hours;

    /// @notice The RUSH token staked and paid out.
    IERC20 public immutable token;

    /// @notice The treasury that custodies stakes and funds payouts.
    Treasury public immutable treasury;

    /// @notice Account authorized to rotate the server hash chain.
    address public immutable relayer;

    /// @notice Head of the server hash chain: the next reveal must hash to this.
    bytes32 public currentCommit;

    /// @notice Monotonic bet id counter (also the id of the most recent bet).
    uint256 public betCounter;

    /// @notice Id of the currently unsettled bet, or 0 when none is active.
    uint256 public activeBetId;

    /// @notice All bets by id.
    mapping(uint256 => Bet) public bets;

    event BetPlaced(uint256 indexed betId, address indexed player, uint256 stake, uint256 clientSeed);
    event BetSettled(uint256 indexed betId, address indexed player, bool win, uint256 payout);
    event BetRefunded(uint256 indexed betId, address indexed player, uint256 amount);
    event ChainRotated(bytes32 newCommit);

    /// @notice Thrown when the constructor is given the zero address as token.
    error TokenIsZeroAddress();
    /// @notice Thrown when the constructor is given the zero address as treasury.
    error TreasuryIsZeroAddress();
    /// @notice Thrown when the constructor is given the zero address as relayer.
    error RelayerIsZeroAddress();
    /// @notice Thrown when placing a bet while one is already active.
    error BetAlreadyActive();
    /// @notice Thrown when rotating the chain while a bet is still active.
    error CannotRotateMidBet();
    /// @notice Thrown when settling with no bet active.
    error NoActiveBet();
    /// @notice Thrown when the reveal does not hash to the current chain head.
    error InvalidReveal();
    /// @notice Thrown when a non-relayer attempts to rotate the chain.
    error NotRelayer();
    /// @notice Thrown when refunding a bet id that is not the active, unsettled bet.
    error NotRefundable();
    /// @notice Thrown when refunding before the settle timeout has elapsed.
    error RefundNotReady();

    /// @param token_ The RUSH token address.
    /// @param treasury_ The treasury holding stakes and funding payouts.
    /// @param initialCommit The genesis head of the server hash chain.
    /// @param relayer_ The account authorized to rotate the chain.
    constructor(IERC20 token_, Treasury treasury_, bytes32 initialCommit, address relayer_) {
        if (address(token_) == address(0)) revert TokenIsZeroAddress();
        if (address(treasury_) == address(0)) revert TreasuryIsZeroAddress();
        if (relayer_ == address(0)) revert RelayerIsZeroAddress();
        token = token_;
        treasury = treasury_;
        currentCommit = initialCommit;
        relayer = relayer_;
    }

    /// @notice Place the single active bet, locking the fixed stake into the treasury.
    /// @param clientSeed Player-supplied entropy mixed into the outcome.
    /// @return betId The id of the newly created bet.
    function placeBet(uint256 clientSeed) external returns (uint256 betId) {
        if (activeBetId != 0) revert BetAlreadyActive();

        betId = ++betCounter;
        activeBetId = betId;
        bets[betId] = Bet({
            player: msg.sender,
            stake: BET_AMOUNT,
            clientSeed: clientSeed,
            placedAt: block.timestamp,
            settled: false
        });

        token.safeTransferFrom(msg.sender, address(treasury), BET_AMOUNT);
        emit BetPlaced(betId, msg.sender, BET_AMOUNT, clientSeed);
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

        bool win = uint256(keccak256(abi.encodePacked(reveal, bet.clientSeed))) % 2 == 0;
        uint256 payout = win ? bet.stake * PAYOUT_MULTIPLIER : 0;
        if (win) {
            // Effects above the external call keep this reentrancy-safe. If the
            // treasury cannot cover the payout this reverts and the bet stays
            // active — acceptable for a funded skeleton; solvency caps that make
            // payouts always-affordable land in #20.
            treasury.pay(bet.player, payout);
        }

        emit BetSettled(betId, bet.player, win, payout);
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
}
