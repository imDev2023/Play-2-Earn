// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title RushoodTimelock
/// @notice The governance timelock for RUSHOOD. A thin, named wrapper over OpenZeppelin's
///         `TimelockController` so Hardhat compiles it into a first-class artifact that the
///         deploy scripts and tests can reference by name.
/// @dev Wiring: a Safe multisig is granted the PROPOSER and EXECUTOR roles; `admin` is set
///      to the zero address so the timelock is self-administered (no unilateral admin key).
///      RushoodGame's `governance` role is then handed to this contract, so every sensitive
///      parameter change must be queued here by the Safe and can only execute after
///      `minDelay` — giving token holders advance warning of any policy change.
contract RushoodTimelock is TimelockController {
    /// @param minDelay The minimum delay (seconds) before a queued operation can execute.
    /// @param proposers Accounts allowed to queue operations (the Safe multisig).
    /// @param executors Accounts allowed to execute ready operations (the Safe multisig).
    /// @param admin Optional admin; pass the zero address for a self-administered timelock.
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {}
}
