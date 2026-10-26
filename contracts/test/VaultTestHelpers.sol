// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.34;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IVaultManager} from "../interfaces/IVaultManager.sol";
import {VaultManager} from "../VaultManager.sol";
import {VaultCallerMock} from "./VaultCallerMock.sol";

/// @notice Test-only asset. False returns deliberately occur AFTER ERC20 writes/events.
contract ConfigurableTestToken is ERC20, Ownable {
    uint8 private immutable _precision;
    bool public failTransfer;
    bool public failTransferFrom;

    constructor(uint8 precision_) ERC20("Vault Test Token", "VTT") Ownable(msg.sender) {
        _precision = precision_;
    }

    function decimals() public view override returns (uint8) {
        return _precision;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function setFailureModes(bool transfer_, bool transferFrom_) external onlyOwner {
        failTransfer = transfer_;
        failTransferFrom = transferFrom_;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        bool result = super.transfer(to, amount);
        return failTransfer ? false : result;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool result = super.transferFrom(from, to, amount);
        return failTransferFrom ? false : result;
    }
}

/// @notice Test-only dependency whose metadata call fails with a recognizable error.
contract MetadataFailureMock {
    error MetadataUnavailable();

    function decimals() external pure returns (uint8) {
        revert MetadataUnavailable();
    }
}

/// @notice Test-only caller: attempts a fixed Vault-to-self pull without impersonation.
contract VaultPullAttemptMock is VaultCallerMock {
    constructor(IVaultManager vault_, address operator_) VaultCallerMock(vault_, operator_) {}

    function attemptPull(uint256 amount) external onlyOwner {
        vault.token().transferFrom(address(vault), address(this), amount);
    }
}

/// @notice Test-only token/harness acting as both Vault admin and bound Core.
/// @dev Its callbacks pass authorization so tests exercise nonReentrant, not only role checks.
/// Only the fixture operator can configure attacks or initiate operations; recipients stay fixed.
contract ReentrantTestToken is ERC20, Ownable {
    enum Operation { Fund, Withdraw, PayInterest }

    VaultManager public vault;
    Operation public attackOperation;
    bool public armed;

    error VaultAlreadyConfigured();

    constructor() ERC20("Reentrant Test Token", "RTT") Ownable(msg.sender) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function configureVault(VaultManager vault_) external onlyOwner {
        if (address(vault) != address(0)) revert VaultAlreadyConfigured();
        vault = vault_;
        vault_.setSavingCore(address(this));
        _approve(address(this), address(vault_), type(uint256).max);
    }

    function setAttack(Operation operation, bool enabled) external onlyOwner {
        attackOperation = operation;
        armed = enabled;
    }

    function execute(Operation operation, uint256 amount) external onlyOwner {
        _execute(operation, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        bool result = super.transfer(to, amount);
        _callback();
        return result;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool result = super.transferFrom(from, to, amount);
        _callback();
        return result;
    }

    function _callback() private {
        if (armed) {
            armed = false;
            _execute(attackOperation, 1);
        }
    }

    function _execute(Operation operation, uint256 amount) private {
        if (operation == Operation.Fund) vault.fundVault(amount);
        else if (operation == Operation.Withdraw) vault.withdrawVault(amount);
        else vault.payInterest(amount);
    }
}
