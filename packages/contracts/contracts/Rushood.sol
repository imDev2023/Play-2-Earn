// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title RUSHOOD (RUSH) chip token
/// @notice Fixed-supply ERC20 chip token for the RUSHOOD game.
/// @dev The entire supply is minted once, in the constructor, to the distributor.
///      There is deliberately no mint path, no owner, and no admin/pause hooks:
///      the token is immutable. `_mint` is internal to OpenZeppelin's ERC20 and is
///      only reachable here from the constructor, so no post-deploy minting exists.
///      Holders may burn their own tokens (or approved allowances) via ERC20Burnable.
contract Rushood is ERC20, ERC20Burnable {
    /// @notice The fixed total supply: 1,000,000,000 RUSH (18 decimals).
    uint256 public constant MAX_SUPPLY = 1_000_000_000 * 1e18;

    /// @notice Thrown when the constructor is given the zero address as distributor.
    error DistributorIsZeroAddress();

    /// @param distributor Address that receives the entire initial supply.
    constructor(address distributor) ERC20("RUSHOOD", "RUSH") {
        if (distributor == address(0)) revert DistributorIsZeroAddress();
        _mint(distributor, MAX_SUPPLY);
    }
}
