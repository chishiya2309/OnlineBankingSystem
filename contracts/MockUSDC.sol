// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC
/// @notice Test token with permissionless minting for local testing only.
contract MockUSDC is ERC20 {
    constructor() ERC20("MockUSDC", "mUSDC") {}

    /// @notice Returns the token's six display decimals.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Allows any caller to mint test tokens; unsuitable for a token with real value.
    /// @param to Recipient of the minted tokens.
    /// @param amount Smallest token units, used unchanged: 1 MockUSDC = 1_000_000 units.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
