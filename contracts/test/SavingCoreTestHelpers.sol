// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.34;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {SavingCore} from "../SavingCore.sol";

/// @notice Test-only depositor with no ERC721 receiver support.
contract DepositCallerMock is Ownable {
    SavingCore public immutable core;

    constructor(SavingCore core_, address operator_) Ownable(operator_) {
        core = core_;
    }

    function approveCore(uint256 amount) external onlyOwner {
        core.token().approve(address(core), amount);
    }

    function open(uint256 planId, uint256 amount) external onlyOwner returns (uint256) {
        return core.openDeposit(planId, amount);
    }

    function renew(uint256 depositId, uint256 newPlanId) external onlyOwner returns (uint256) {
        return core.renewDeposit(depositId, newPlanId);
    }

    function autoRenew(uint256 depositId) external returns (uint256) {
        return core.autoRenewDeposit(depositId);
    }
}

/// @notice Test-only safeMint recipient exercising external callbacks and NFT forwarding.
contract DepositReceiverMock is DepositCallerMock, IERC721Receiver {
    enum Mode {
        Accept,
        Reject,
        WrongSelector,
        ReenterCaught,
        ReenterPropagated,
        Forward,
        ReenterRenewCaught,
        ReenterRenewPropagated,
        ReenterAutoRenewCaught,
        ReenterAutoRenewPropagated
    }

    Mode public mode;
    address public forwardTo;
    bytes public reentryError;
    uint256 public receivedId;
    uint256 public callbackCoreBalance;
    uint256 public callbackTotalPrincipal;
    address public callbackOwner;

    error ReceiverRejected();
    error UnexpectedCallback();

    constructor(SavingCore core_, address operator_) DepositCallerMock(core_, operator_) {}

    function configure(Mode mode_, address forwardTo_) external onlyOwner {
        mode = mode_;
        forwardTo = forwardTo_;
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        if (msg.sender != address(core)) revert UnexpectedCallback();
        receivedId = tokenId;
        callbackCoreBalance = core.token().balanceOf(address(core));
        callbackTotalPrincipal = core.totalPrincipal();
        callbackOwner = core.ownerOf(tokenId);
        if (mode == Mode.Reject) revert ReceiverRejected();
        if (mode == Mode.WrongSelector) return bytes4(0);
        if (mode == Mode.ReenterCaught) {
            try core.openDeposit(1, 1) {} catch (bytes memory reason) { reentryError = reason; }
        } else if (mode == Mode.ReenterPropagated) {
            core.openDeposit(1, 1);
        } else if (mode == Mode.ReenterRenewCaught) {
            try core.renewDeposit(tokenId, 1) {} catch (bytes memory reason) { reentryError = reason; }
        } else if (mode == Mode.ReenterRenewPropagated) {
            core.renewDeposit(tokenId, 1);
        } else if (mode == Mode.ReenterAutoRenewCaught) {
            try core.autoRenewDeposit(tokenId) {} catch (bytes memory reason) { reentryError = reason; }
        } else if (mode == Mode.ReenterAutoRenewPropagated) {
            core.autoRenewDeposit(tokenId);
        } else if (mode == Mode.Forward) {
            core.transferFrom(address(this), forwardTo, tokenId);
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @notice Test-only standard six-decimal token with armed transferFrom and transfer callbacks.
contract CoreReentrantTestToken is ERC20, Ownable {
    enum AttackType { Open, WithdrawMaturity, EarlyWithdraw }

    SavingCore public core;
    AttackType public attackType;
    uint256 public attackDepositId;
    bool public armed;
    bool public catchReentry;
    bytes public reentryError;

    constructor() ERC20("Core Reentrant Test Token", "CRTT") Ownable(msg.sender) {}

    function decimals() public pure override returns (uint8) { return 6; }

    function mint(address to, uint256 amount) external onlyOwner { _mint(to, amount); }

    function configure(SavingCore core_, bool catchReentry_, bool armed_) external onlyOwner {
        core = core_;
        catchReentry = catchReentry_;
        armed = armed_;
        attackType = AttackType.Open;
        // The nested call is independently funded/approved, so the test reaches nonReentrant.
        _approve(address(this), address(core_), type(uint256).max);
    }

    function configureAttack(
        SavingCore core_,
        AttackType attackType_,
        uint256 attackDepositId_,
        bool catchReentry_,
        bool armed_
    ) external onlyOwner {
        core = core_;
        attackType = attackType_;
        attackDepositId = attackDepositId_;
        catchReentry = catchReentry_;
        armed = armed_;
        _approve(address(this), address(core_), type(uint256).max);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool result = super.transferFrom(from, to, amount);
        if (armed && attackType == AttackType.Open) {
            armed = false;
            if (catchReentry) {
                try core.openDeposit(1, 1) {} catch (bytes memory reason) { reentryError = reason; }
            } else {
                core.openDeposit(1, 1);
            }
        }
        return result;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        bool result = super.transfer(to, amount);
        if (armed) {
            armed = false;
            if (attackType == AttackType.WithdrawMaturity) {
                if (catchReentry) {
                    try core.withdrawAtMaturity(attackDepositId) {} catch (bytes memory reason) { reentryError = reason; }
                } else {
                    core.withdrawAtMaturity(attackDepositId);
                }
            } else if (attackType == AttackType.EarlyWithdraw) {
                if (catchReentry) {
                    try core.earlyWithdraw(attackDepositId) {} catch (bytes memory reason) { reentryError = reason; }
                } else {
                    core.earlyWithdraw(attackDepositId);
                }
            }
        }
        return result;
    }
}
