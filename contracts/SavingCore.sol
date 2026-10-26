// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.34;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IVaultManager} from "./interfaces/IVaultManager.sol";

/// @title SavingCore
/// @notice Core term deposit engine holding principal, managing plans, and issuing deposit NFTs.
/// @dev In Task D2-01, foundation and Saving Plan Management are implemented.
/// Full deposit workflows and financial helpers will be implemented in D2-02 and Day 3.
contract SavingCore is ERC721, ReentrancyGuard {
    /// @notice Term deposit plan specification.
    struct SavingPlan {
        uint32 tenorDays;
        uint16 aprBps;
        uint256 minDeposit;
        uint256 maxDeposit;
        uint16 earlyWithdrawPenaltyBps;
        bool enabled;
    }

    /// @notice Vault holding the interest reserve; sole authority for Bank Admin.
    IVaultManager public immutable vaultManager;

    /// @notice Underlying deposit token derived from VaultManager.
    IERC20 public immutable token;

    /// @notice System grace period in seconds before auto-renewal is permitted.
    uint256 public immutable gracePeriodSeconds;

    /// @notice Total number of saving plans created.
    uint256 public planCount;

    /// @dev Internal mapping from plan ID to SavingPlan struct.
    mapping(uint256 => SavingPlan) private _plans;

    // --- Custom Errors ---
    error ZeroAddress();
    error InvalidContract(address account);
    error InvalidGracePeriod(uint256 secondsValue);
    error NotBankAdmin(address caller);
    error InvalidTenor(uint256 tenorDays);
    error InvalidApr(uint256 aprBps);
    error InvalidPenalty(uint256 penaltyBps);
    error InvalidDepositLimits(uint256 minDeposit, uint256 maxDeposit);
    error PlanNotFound(uint256 planId);

    // --- Events ---
    event PlanCreated(uint256 indexed planId, uint256 tenorDays, uint256 aprBps);
    event PlanUpdated(uint256 indexed planId, uint256 newAprBps);
    event PlanEnabledChanged(uint256 indexed planId, bool enabled);

    /// @notice Initializes the SavingCore contract.
    /// @param vaultManager_ Address of the deployed VaultManager contract.
    /// @param gracePeriodSeconds_ Grace period in seconds for auto-renewal (variant: 172800).
    constructor(address vaultManager_, uint256 gracePeriodSeconds_)
        ERC721("Saving Deposit Certificate", "SDC")
    {
        if (vaultManager_ == address(0)) revert ZeroAddress();
        if (vaultManager_.code.length == 0) revert InvalidContract(vaultManager_);
        if (gracePeriodSeconds_ == 0) revert InvalidGracePeriod(gracePeriodSeconds_);

        IVaultManager vault = IVaultManager(vaultManager_);
        address tokenAddress = address(vault.token());
        if (tokenAddress == address(0)) revert ZeroAddress();
        if (tokenAddress.code.length == 0) revert InvalidContract(tokenAddress);

        address adminAddress = vault.owner();
        if (adminAddress == address(0)) revert ZeroAddress();

        vaultManager = vault;
        token = IERC20(tokenAddress);
        gracePeriodSeconds = gracePeriodSeconds_;
    }

    /// @dev Restricts access to the current Bank Admin, dynamically queried from VaultManager.
    modifier onlyBankAdmin() {
        if (msg.sender != vaultManager.owner()) {
            revert NotBankAdmin(msg.sender);
        }
        _;
    }

    /// @notice Creates a new saving plan with the specified terms.
    /// @param tenorDays Duration of the plan in days (>= 1, <= uint32.max).
    /// @param aprBps Annual percentage rate in basis points (0 <= aprBps <= 10000).
    /// @param minDeposit Minimum allowed deposit in smallest token units (0 = no lower limit).
    /// @param maxDeposit Maximum allowed deposit in smallest token units (0 = no upper limit).
    /// @param penaltyBps Early withdrawal penalty in basis points (0 <= penaltyBps <= 10000).
    /// @param enabled Whether the plan is immediately open for new deposits.
    /// @return planId The sequentially assigned ID of the newly created plan.
    function createPlan(
        uint256 tenorDays,
        uint256 aprBps,
        uint256 minDeposit,
        uint256 maxDeposit,
        uint256 penaltyBps,
        bool enabled
    ) external onlyBankAdmin returns (uint256 planId) {
        if (tenorDays == 0 || tenorDays > type(uint32).max) revert InvalidTenor(tenorDays);
        if (aprBps > 10000) revert InvalidApr(aprBps);
        if (penaltyBps > 10000) revert InvalidPenalty(penaltyBps);
        if (minDeposit != 0 && maxDeposit != 0 && minDeposit > maxDeposit) {
            revert InvalidDepositLimits(minDeposit, maxDeposit);
        }

        planId = ++planCount;
        _plans[planId] = SavingPlan({
            tenorDays: uint32(tenorDays),
            aprBps: uint16(aprBps),
            minDeposit: minDeposit,
            maxDeposit: maxDeposit,
            earlyWithdrawPenaltyBps: uint16(penaltyBps),
            enabled: enabled
        });

        emit PlanCreated(planId, tenorDays, aprBps);
    }

    /// @notice Returns full details of an existing saving plan.
    /// @param planId ID of the plan to query (1 <= planId <= planCount).
    /// @return SavingPlan struct containing plan terms and status.
    function getPlan(uint256 planId) external view returns (SavingPlan memory) {
        if (planId == 0 || planId > planCount) revert PlanNotFound(planId);
        return _plans[planId];
    }

    /// @notice Updates the APR of an existing plan. Does not affect existing deposits.
    /// @param planId ID of the plan to update.
    /// @param newAprBps New APR in basis points (0 <= newAprBps <= 10000).
    function updatePlan(uint256 planId, uint256 newAprBps) external onlyBankAdmin {
        if (planId == 0 || planId > planCount) revert PlanNotFound(planId);
        if (newAprBps > 10000) revert InvalidApr(newAprBps);

        _plans[planId].aprBps = uint16(newAprBps);

        emit PlanUpdated(planId, newAprBps);
    }

    /// @notice Enables an existing plan for new deposits.
    /// @param planId ID of the plan to enable.
    function enablePlan(uint256 planId) external onlyBankAdmin {
        if (planId == 0 || planId > planCount) revert PlanNotFound(planId);
        _plans[planId].enabled = true;
        emit PlanEnabledChanged(planId, true);
    }

    /// @notice Disables an existing plan, preventing new deposits.
    /// @param planId ID of the plan to disable.
    function disablePlan(uint256 planId) external onlyBankAdmin {
        if (planId == 0 || planId > planCount) revert PlanNotFound(planId);
        _plans[planId].enabled = false;
        emit PlanEnabledChanged(planId, false);
    }
}
