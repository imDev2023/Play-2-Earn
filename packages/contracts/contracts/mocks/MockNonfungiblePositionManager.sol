// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {INonfungiblePositionManager} from "../interfaces/INonfungiblePositionManager.sol";

/// @title MockNonfungiblePositionManager
/// @notice Test double for Uniswap v3's position manager: mints position NFTs and
///         simulates fee accrual so the LP lock can be driven end-to-end without a
///         live Uniswap deployment.
/// @dev Test-only — never deployed to a real network. It models just enough of the
///      real contract to exercise the lock's public interface: positions are NFTs that
///      can be safe-transferred, and `collect` pays out whatever fees the test has
///      accrued onto a position. Fees are pre-funded into this contract by the test.
///
///      The ERC721 surface is hand-rolled rather than inherited from OpenZeppelin
///      because OZ's `ERC721` pulls in `Strings`/`Bytes`, which require the Cancun
///      `mcopy` opcode. Adopting that would mean raising `evmVersion` for the whole
///      project — a production compiler-target change driven by a test fixture. Only
///      the handful of ERC721 behaviours the lock actually depends on are modelled.
contract MockNonfungiblePositionManager is INonfungiblePositionManager {
    using SafeERC20 for IERC20;

    /// @notice The pair's two tokens, mirroring a real pool's token0/token1.
    IERC20 public immutable token0;
    IERC20 public immutable token1;

    /// @notice Uncollected fees per position, as set by `accrueFees`.
    mapping(uint256 tokenId => uint256 amount) public owed0;
    mapping(uint256 tokenId => uint256 amount) public owed1;

    mapping(uint256 tokenId => address holder) private _owners;
    uint256 private _nextTokenId = 1;

    /// @notice Thrown when a transfer names a sender that does not hold the position.
    error NotPositionOwner();
    /// @notice Thrown when a contract recipient rejects the position NFT.
    error UnsafeRecipient();

    constructor(IERC20 token0_, IERC20 token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    /// @notice Mint a position NFT to `to`, standing in for a seeded liquidity position.
    function mintPosition(address to) external returns (uint256 tokenId) {
        tokenId = _nextTokenId++;
        _owners[tokenId] = to;
    }

    /// @notice Credit a position with uncollected trading fees.
    /// @dev The test must also transfer the matching tokens into this contract.
    function accrueFees(uint256 tokenId, uint256 amount0, uint256 amount1) external {
        owed0[tokenId] += amount0;
        owed1[tokenId] += amount1;
    }

    /// @inheritdoc INonfungiblePositionManager
    function ownerOf(uint256 tokenId) external view returns (address) {
        return _owners[tokenId];
    }

    /// @inheritdoc INonfungiblePositionManager
    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        if (_owners[tokenId] != from) revert NotPositionOwner();
        _owners[tokenId] = to;

        if (to.code.length > 0) {
            bytes4 retval = IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, "");
            if (retval != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient();
        }
    }

    /// @inheritdoc INonfungiblePositionManager
    function collect(
        CollectParams calldata params
    ) external payable returns (uint256 amount0, uint256 amount1) {
        amount0 = owed0[params.tokenId];
        amount1 = owed1[params.tokenId];
        if (amount0 > params.amount0Max) amount0 = params.amount0Max;
        if (amount1 > params.amount1Max) amount1 = params.amount1Max;

        owed0[params.tokenId] -= amount0;
        owed1[params.tokenId] -= amount1;

        if (amount0 > 0) token0.safeTransfer(params.recipient, amount0);
        if (amount1 > 0) token1.safeTransfer(params.recipient, amount1);
    }
}
