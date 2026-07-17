// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Ping
/// @notice Placeholder contract that proves the toolchain compiles and tests run green.
///         It carries no product logic and is removed once the RUSH token lands (ticket #17).
contract Ping {
    function ping() external pure returns (string memory) {
        return "pong";
    }
}
