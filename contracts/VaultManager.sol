// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.34;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title VaultManager
/// @notice Holds the bank's interest funds, separate from customer principal.
/// @dev Supports the standard six-decimal MockUSDC asset, not fee-on-transfer or rebasing tokens.
/// The admin may withdraw all available liquidity; future interest is not reserved.
contract VaultManager is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public savingCore;
    address public feeReceiver;

    error ZeroAddress();
    error InvalidContract(address account);
    error InvalidTokenDecimals(uint8 actual);
    error SavingCoreAlreadySet(address currentCore);
    error UnauthorizedSavingCore(address caller);
    error AmountZero();
    error InsufficientVaultBalance(uint256 available, uint256 required);
    error OwnershipRenounceDisabled();

    event SavingCoreSet(address indexed savingCore);
    event VaultFunded(address indexed admin, uint256 amount);
    event VaultWithdrawn(address indexed admin, uint256 amount);
    event FeeReceiverUpdated(address indexed previousReceiver, address indexed newReceiver);
    event InterestPaid(address indexed savingCore, uint256 amount);

    /// @param token_ Deployed ERC20 asset with six decimals.
    /// @param admin_ Initial Bank Admin; may differ from the deployer.
    /// @param feeReceiver_ Nonzero recipient of early-withdrawal penalties paid by Core.
    constructor(address token_, address admin_, address feeReceiver_)
        Ownable(_validateAdmin(admin_))
    {
        if (token_ == address(0) || feeReceiver_ == address(0)) revert ZeroAddress();
        if (token_.code.length == 0) revert InvalidContract(token_);

        uint8 actualDecimals = IERC20Metadata(token_).decimals();
        if (actualDecimals != 6) revert InvalidTokenDecimals(actualDecimals);

        token = IERC20(token_);
        feeReceiver = feeReceiver_;
    }

    modifier onlySavingCore() {
        if (savingCore == address(0) || _msgSender() != savingCore) {
            revert UnauthorizedSavingCore(_msgSender());
        }
        _;
    }

    /// @notice Binds the authorized Core once; an incorrect binding cannot be replaced.
    /// @param core Deployed Core contract to authorize for interest payouts.
    function setSavingCore(address core) external onlyOwner {
        if (savingCore != address(0)) revert SavingCoreAlreadySet(savingCore);
        if (core == address(0)) revert ZeroAddress();
        if (core.code.length == 0) revert InvalidContract(core);

        savingCore = core;
        emit SavingCoreSet(core);
    }

    /// @notice Funds the interest pool from the admin, including while paused or unbound.
    /// @param amount Positive amount in smallest token units; requires allowance to this Vault.
    function fundVault(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert AmountZero();

        address admin = _msgSender();
        token.safeTransferFrom(admin, address(this), amount);
        emit VaultFunded(admin, amount);
    }

    /// @notice Withdraws available liquidity to the current admin without reserving future interest.
    /// @param amount Positive amount in smallest token units, at most the actual Vault balance.
    function withdrawVault(uint256 amount) external onlyOwner whenNotPaused nonReentrant {
        if (amount == 0) revert AmountZero();
        uint256 available = token.balanceOf(address(this));
        if (amount > available) revert InsufficientVaultBalance(available, amount);

        address admin = _msgSender();
        token.safeTransfer(admin, amount);
        emit VaultWithdrawn(admin, amount);
    }

    /// @notice Updates the fee recipient read by Core, including while paused; transfers no tokens.
    /// @param receiver Nonzero recipient; existing deposit penalty snapshots remain unchanged.
    function setFeeReceiver(address receiver) external onlyOwner {
        if (receiver == address(0)) revert ZeroAddress();

        address previousReceiver = feeReceiver;
        feeReceiver = receiver;
        emit FeeReceiverUpdated(previousReceiver, receiver);
    }

    /// @notice Blocks Vault withdrawals and interest payouts; funding remains available.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Re-enables Vault withdrawals and interest payouts.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Pays interest exclusively to the bound Core, which must be the caller.
    /// @param amount Positive amount in smallest token units, at most the actual Vault balance.
    function payInterest(uint256 amount) external onlySavingCore whenNotPaused nonReentrant {
        if (amount == 0) revert AmountZero();
        uint256 available = token.balanceOf(address(this));
        if (amount > available) revert InsufficientVaultBalance(available, amount);

        token.safeTransfer(savingCore, amount);
        emit InterestPaid(savingCore, amount);
    }

    /// @notice Always rejects renouncing the system's sole Bank Admin role.
    /// @dev Kept nonpayable to preserve the D1-03 ABI, although this body only reverts.
    function renounceOwnership() public override onlyOwner {
        revert OwnershipRenounceDisabled();
    }

    /// @dev Validates before Ownable construction to preserve D1-03's ZeroAddress error.
    function _validateAdmin(address admin_) internal pure returns (address) {
        if (admin_ == address(0)) revert ZeroAddress();
        return admin_;
    }
}
