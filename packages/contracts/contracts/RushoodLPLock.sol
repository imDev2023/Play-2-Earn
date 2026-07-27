// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {INonfungiblePositionManager} from "./interfaces/INonfungiblePositionManager.sol";

/// @title RushoodLPLock
/// @notice Custodies the Uniswap v3 position seeded with the 25% liquidity allocation
///         and refuses to release it for 2 years — the "team can't pull liquidity and
///         rug the token" guarantee from the spec.
/// @dev Owned by the governance Timelock, so even the post-unlock withdrawal is a
///      timelocked, publicly-visible action rather than a unilateral team transaction.
///
///      The guarantee this contract makes is a *negative* one, and it is enforced by
///      omission as much as by the `StillLocked` check: there is deliberately no
///      `approve`, no `setApprovalForAll`, no `decreaseLiquidity`, and no generic
///      call/multicall forwarder. Any of those would defeat the lock — an approval
///      hands the position to a third party, and a liquidity decrease drains the pool
///      while leaving an empty NFT behind. `collectFees` is the single carve-out,
///      because sweeping accrued trading fees does not touch liquidity.
///
///      The lock can be lengthened but never shortened (`extendLock`), so the stated
///      unlock time is always a floor on the remaining commitment. Renouncing
///      ownership is left available: it permanently strands the position, which is the
///      strongest possible anti-rug signal, but it is irreversible — treat it as a
///      deliberate burn of the liquidity, not a cleanup step.
contract RushoodLPLock is ERC721Holder, Ownable {
    /// @notice How long the position stays locked from deployment: 2 years.
    uint64 public constant LOCK_SECONDS = 730 days;

    /// @notice The Uniswap v3 position manager holding the locked position.
    INonfungiblePositionManager public immutable positionManager;

    /// @notice Where collected trading fees are sent (the Treasury).
    address public immutable feeRecipient;

    /// @notice Timestamp before which no position may leave this contract.
    ///         Monotonically non-decreasing — see `extendLock`.
    uint256 public unlockTime;

    /// @notice Emitted when the lock is lengthened.
    event LockExtended(uint256 previousUnlockTime, uint256 newUnlockTime);
    /// @notice Emitted when a position leaves the lock after expiry.
    event PositionWithdrawn(uint256 indexed tokenId, address indexed to);
    /// @notice Emitted when trading fees are swept to the fee recipient.
    event FeesCollected(uint256 indexed tokenId, uint256 amount0, uint256 amount1);

    /// @notice Thrown when the constructor is given the zero address as position manager.
    error PositionManagerIsZeroAddress();
    /// @notice Thrown when the constructor is given the zero address as fee recipient.
    error FeeRecipientIsZeroAddress();
    /// @notice Thrown when a withdrawal is attempted before the lock expires.
    error StillLocked(uint256 nowTimestamp, uint256 unlockTimestamp);
    /// @notice Thrown when an extension would shorten (or not move) the lock.
    error LockNotExtended(uint256 currentUnlockTime, uint256 requestedUnlockTime);

    /// @param positionManager_ The Uniswap v3 `NonfungiblePositionManager`.
    /// @param feeRecipient_ Destination for collected trading fees (the Treasury).
    /// @param owner_ The governance Timelock.
    constructor(
        INonfungiblePositionManager positionManager_,
        address feeRecipient_,
        address owner_
    ) Ownable(owner_) {
        if (address(positionManager_) == address(0)) revert PositionManagerIsZeroAddress();
        if (feeRecipient_ == address(0)) revert FeeRecipientIsZeroAddress();

        positionManager = positionManager_;
        feeRecipient = feeRecipient_;
        unlockTime = block.timestamp + LOCK_SECONDS;
    }

    /// @notice True while the position is still locked. The headline number a holder
    ///         (or a block explorer) checks to confirm liquidity cannot be pulled.
    function isLocked() external view returns (bool) {
        return block.timestamp < unlockTime;
    }

    /// @notice Sweep a position's accrued trading fees to the fee recipient.
    /// @dev Permissionless on purpose: the destination is fixed at construction, so
    ///      letting anyone trigger the sweep costs nothing and removes a liveness
    ///      dependency on the Timelock. Safe during the lock — collecting fees does
    ///      not reduce the position's liquidity.
    /// @param tokenId The locked position to collect from.
    function collectFees(uint256 tokenId) external returns (uint256 amount0, uint256 amount1) {
        (amount0, amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: feeRecipient,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        emit FeesCollected(tokenId, amount0, amount1);
    }

    /// @notice Release a position once the lock has expired.
    /// @param tokenId The position to release.
    /// @param to Recipient of the position NFT.
    function withdraw(uint256 tokenId, address to) external onlyOwner {
        if (block.timestamp < unlockTime) revert StillLocked(block.timestamp, unlockTime);

        positionManager.safeTransferFrom(address(this), to, tokenId);
        emit PositionWithdrawn(tokenId, to);
    }

    /// @notice Lengthen the lock. Cannot shorten it, so holders can always read
    ///         `unlockTime` as a floor on the remaining commitment.
    /// @param newUnlockTime The new, strictly later unlock timestamp.
    function extendLock(uint256 newUnlockTime) external onlyOwner {
        if (newUnlockTime <= unlockTime) revert LockNotExtended(unlockTime, newUnlockTime);

        emit LockExtended(unlockTime, newUnlockTime);
        unlockTime = newUnlockTime;
    }
}
