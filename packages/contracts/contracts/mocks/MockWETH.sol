// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockWETH
/// @notice Minimal wrapped-ETH stand-in for local dry runs of the LP seeding flow.
/// @dev Test-only. Robinhood Chain has a canonical WETH the real deploy uses; this
///      models just `deposit`/`withdraw` so the seeding script can wrap ETH and mint a
///      two-ERC20 position locally without a live WETH deployment.
contract MockWETH is ERC20 {
    /// @notice Thrown when a withdrawal's ETH transfer fails.
    error EthTransferFailed();

    constructor() ERC20("Wrapped Ether", "WETH") {}

    /// @notice Wrap the ETH sent with this call.
    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    /// @notice Unwrap `amount` back into ETH.
    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}
