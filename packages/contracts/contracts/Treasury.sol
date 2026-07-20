// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Burnable} from "./interfaces/IERC20Burnable.sol";

/// @title Treasury
/// @notice Minimal RUSH vault for the walking skeleton. It custodies staked RUSH
///         and releases it (winnings or refunds) only when the authorized game says so.
/// @dev The game address is wired once, after deployment, to break the
///      Treasury<->Game constructor cycle. Everything here deepens in later tickets
///      (profit-burn, governance, solvency caps) — this is the thinnest safe vault.
contract Treasury {
    using SafeERC20 for IERC20;

    /// @notice The RUSH token this treasury holds and pays out.
    IERC20 public immutable token;

    /// @notice Account allowed to wire the game (the deployer).
    address public immutable deployer;

    /// @notice The one game contract authorized to move funds. Zero until wired.
    address public game;

    /// @notice Thrown when the constructor is given the zero address as token.
    error TokenIsZeroAddress();
    /// @notice Thrown when wiring the zero address as the game.
    error GameIsZeroAddress();
    /// @notice Thrown when the game has already been wired.
    error GameAlreadySet();
    /// @notice Thrown when a non-deployer calls a deployer-only function.
    error NotDeployer();
    /// @notice Thrown when a caller other than the wired game requests a payout.
    error NotGame();

    /// @param token_ The RUSH token address.
    constructor(IERC20 token_) {
        if (address(token_) == address(0)) revert TokenIsZeroAddress();
        token = token_;
        deployer = msg.sender;
    }

    /// @notice Wire the authorized game exactly once.
    /// @param game_ The RushoodGame contract permitted to pay winnings.
    function setGame(address game_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (game != address(0)) revert GameAlreadySet();
        if (game_ == address(0)) revert GameIsZeroAddress();
        game = game_;
    }

    /// @notice Release RUSH (a winning payout or a refunded stake). Callable only
    ///         by the wired game.
    /// @param to Recipient of the funds.
    /// @param amount Amount of RUSH to transfer.
    function pay(address to, uint256 amount) external {
        if (msg.sender != game) revert NotGame();
        token.safeTransfer(to, amount);
    }

    /// @notice Burn RUSH held by the treasury, permanently shrinking the supply.
    ///         Callable only by the wired game (per-play burn and profit-burn).
    /// @param amount Amount of RUSH to burn from the treasury's own balance.
    function burn(uint256 amount) external {
        if (msg.sender != game) revert NotGame();
        IERC20Burnable(address(token)).burn(amount);
    }
}
