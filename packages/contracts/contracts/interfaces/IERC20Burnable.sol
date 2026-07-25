// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IERC20Burnable
/// @notice The slice of OpenZeppelin's ERC20Burnable the treasury calls to burn its
///         own balance. Kept minimal so the treasury needn't import the full token.
interface IERC20Burnable {
    /// @notice Burn `amount` tokens from the caller's balance.
    function burn(uint256 amount) external;
}
