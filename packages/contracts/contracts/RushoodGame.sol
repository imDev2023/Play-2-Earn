// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Treasury} from "./Treasury.sol";

/// @title RushoodGame (walking skeleton)
/// @notice The thinnest complete bet: one hardcoded tier, settled by an on-chain
///         per-play commit-reveal hash chain.
/// @dev Flow:
///      1. `placeBet(clientSeed)` locks a fixed stake into the treasury.
///      2. The relayer calls `settleBet(reveal)` where keccak256(reveal) equals the
///         current chain head. The outcome is derived from `reveal` + the player's
///         `clientSeed`; a win pays `PAYOUT_MULTIPLIER x` stake from the treasury,
///         a loss leaves the stake in the treasury.
///      3. On success the chain advances (`currentCommit = reveal`), so the next
///         reveal must hash to this one.
///
///      One bet is active at a time — the skeleton plays a single bet end-to-end.
///      Multiple concurrent bets, odds tiers, and payout math deepen in later tickets.
contract RushoodGame {
    using SafeERC20 for IERC20;

    struct Bet {
        address player;
        uint256 stake;
        uint256 clientSeed;
        bool settled;
    }

    /// @notice Fixed stake for the single hardcoded tier.
    uint256 public constant BET_AMOUNT = 100 * 1e18;

    /// @notice Winning payout multiplier for the single hardcoded tier (zero-edge).
    uint256 public constant PAYOUT_MULTIPLIER = 2;

    /// @notice The RUSH token staked and paid out.
    IERC20 public immutable token;

    /// @notice The treasury that custodies stakes and funds payouts.
    Treasury public immutable treasury;

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

    /// @notice Thrown when the constructor is given the zero address as token.
    error TokenIsZeroAddress();
    /// @notice Thrown when the constructor is given the zero address as treasury.
    error TreasuryIsZeroAddress();
    /// @notice Thrown when placing a bet while one is already active.
    error BetAlreadyActive();
    /// @notice Thrown when settling with no bet active.
    error NoActiveBet();
    /// @notice Thrown when the reveal does not hash to the current chain head.
    error InvalidReveal();

    /// @param token_ The RUSH token address.
    /// @param treasury_ The treasury holding stakes and funding payouts.
    /// @param initialCommit The genesis head of the server hash chain.
    constructor(IERC20 token_, Treasury treasury_, bytes32 initialCommit) {
        if (address(token_) == address(0)) revert TokenIsZeroAddress();
        if (address(treasury_) == address(0)) revert TreasuryIsZeroAddress();
        token = token_;
        treasury = treasury_;
        currentCommit = initialCommit;
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
            treasury.payWinnings(bet.player, payout);
        }

        emit BetSettled(betId, bet.player, win, payout);
    }
}
