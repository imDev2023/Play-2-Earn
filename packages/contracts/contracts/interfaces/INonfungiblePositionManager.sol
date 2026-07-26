// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title INonfungiblePositionManager
/// @notice The slice of Uniswap v3's `NonfungiblePositionManager` that the LP lock needs.
/// @dev Declared locally rather than pulling in `@uniswap/v3-periphery`, which pins an
///      older Solidity and would drag the whole periphery into this build — the same
///      minimal-interface approach as `IERC20Burnable`.
///
///      A Uniswap v3 liquidity position is an ERC721 token held by this position
///      manager; locking the position therefore means custodying that NFT and refusing
///      to let anything move it (or its liquidity) until the lock expires.
interface INonfungiblePositionManager {
    /// @param tokenId The position NFT whose accrued fees are being collected.
    /// @param recipient Where the collected fees are sent.
    /// @param amount0Max Upper bound on token0 collected (use `type(uint128).max` for all).
    /// @param amount1Max Upper bound on token1 collected (use `type(uint128).max` for all).
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    /// @notice Sweep the trading fees a position has accrued to `recipient`.
    /// @dev Collecting fees does not touch the position's liquidity, so it is safe to
    ///      expose while the position itself is locked.
    function collect(
        CollectParams calldata params
    ) external payable returns (uint256 amount0, uint256 amount1);

    /// @notice Move a position NFT. Used once, after the lock expires.
    function safeTransferFrom(address from, address to, uint256 tokenId) external;

    /// @notice Current holder of a position NFT.
    function ownerOf(uint256 tokenId) external view returns (address);
}
