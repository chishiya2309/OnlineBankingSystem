// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Vault interface consumed by SavingCore; amounts use smallest token units.
interface IVaultManager {
    /// @notice Returns the immutable asset used for principal and interest.
    function token() external view returns (IERC20);

    /// @notice Returns the system's current Bank Admin.
    function owner() external view returns (address);

    /// @notice Returns the authorized Core, or zero before binding.
    function savingCore() external view returns (address);

    /// @notice Returns the current early-withdrawal fee recipient.
    function feeReceiver() external view returns (address);

    /// @notice Returns whether financial outflows are paused.
    function paused() external view returns (bool);

    /// @notice Pays interest only to the bound Core; only that Core may call.
    function payInterest(uint256 amount) external;
}
