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

    /// @notice Mirrors Uniswap's event, so the seeding script can recover the new
    ///         position's id from the receipt exactly as it will in production.
    event IncreaseLiquidity(
        uint256 indexed tokenId,
        uint128 liquidity,
        uint256 amount0,
        uint256 amount1
    );

    /// @notice Thrown when a transfer names a sender that does not hold the position.
    error NotPositionOwner();
    /// @notice Thrown when a contract recipient rejects the position NFT.
    error UnsafeRecipient();

    constructor(IERC20 token0_, IERC20 token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    /// @notice Parameters Uniswap's `mint` takes, mirrored so the seeding script can be
    ///         exercised against this mock with the exact call it makes in production.
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    /// @notice The price the pool was initialized at, so tests can assert the seeding
    ///         script encoded the intended price rather than its inverse.
    uint160 public lastSqrtPriceX96;
    /// @notice The most recent mint's parameters, for the same reason.
    MintParams public lastMintParams;

    /// @notice Mint a position NFT to `to`, standing in for a seeded liquidity position.
    function mintPosition(address to) external returns (uint256 tokenId) {
        tokenId = _nextTokenId++;
        _owners[tokenId] = to;
    }

    /// @notice Records the initial price; the real contract deploys and initializes a pool.
    function createAndInitializePoolIfNecessary(
        address,
        address,
        uint24,
        uint160 sqrtPriceX96
    ) external returns (address pool) {
        lastSqrtPriceX96 = sqrtPriceX96;
        return address(this);
    }

    /// @notice Pulls both tokens from the caller and mints a position NFT to `recipient`.
    /// @dev Deposits the full desired amounts rather than solving the real liquidity
    ///      maths — enough to verify the script approves, orders and transfers
    ///      correctly, and that the resulting position reaches the lock.
    function mint(
        MintParams calldata params
    ) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1) {
        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;

        IERC20(params.token0).safeTransferFrom(msg.sender, address(this), amount0);
        IERC20(params.token1).safeTransferFrom(msg.sender, address(this), amount1);

        lastMintParams = params;
        tokenId = _nextTokenId++;
        _owners[tokenId] = params.recipient;
        liquidity = uint128(approximateSqrt(amount0 * amount1));

        emit IncreaseLiquidity(tokenId, liquidity, amount0, amount1);
    }

    /// @dev Crude integer sqrt, only so `liquidity` reads as a plausible non-zero number.
    ///      The mock does not model real liquidity maths.
    function approximateSqrt(uint256 value) private pure returns (uint256 result) {
        if (value == 0) return 0;
        result = value;
        uint256 k = value / 2 + 1;
        while (k < result) {
            result = k;
            k = (value / k + k) / 2;
        }
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
