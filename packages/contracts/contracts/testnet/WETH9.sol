// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title WETH9
/// @notice Wrapped ETH for chains that do not ship a canonical one.
/// @dev Deployed as part of the Uniswap v3 stack the launch rehearsal stands up on
///      Robinhood Chain testnet (#26). Testnet 46630 has no canonical WETH: the two
///      widely-held wrappers there both maintain the supply-equals-backing invariant but
///      neither matches canonical WETH9 bytecode, so their behaviour under the position
///      manager is unverified. Seeding the liquidity allocation through an unverified
///      wrapper is exactly the guess `deploy-launch.ts` refuses to make, hence our own.
///
///      Mainnet uses the chain's canonical WETH; this contract is not part of that
///      deployment. It implements the `IWETH9` surface the Uniswap periphery calls —
///      `deposit`, `withdraw`, and the ERC20 methods — and nothing more.
contract WETH9 is ERC20 {
    /// @notice Thrown when a withdrawal's ETH transfer fails.
    error EthTransferFailed();

    /// @notice Emitted when ETH is wrapped.
    event Deposit(address indexed account, uint256 amount);
    /// @notice Emitted when ETH is unwrapped.
    event Withdrawal(address indexed account, uint256 amount);

    constructor() ERC20("Wrapped Ether", "WETH") {}

    /// @notice Wrap the ETH sent with this call.
    function deposit() public payable {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    /// @notice Unwrap `amount` back into ETH.
    /// @dev Burns before transferring, so a reentrant callee sees the reduced balance
    ///      and cannot withdraw the same tokens twice.
    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        emit Withdrawal(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    /// @notice Plain ETH transfers wrap, matching canonical WETH9.
    receive() external payable {
        deposit();
    }
}
