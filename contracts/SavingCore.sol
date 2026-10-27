// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.34;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IVaultManager} from "./interfaces/IVaultManager.sol";

/// @title SavingCore
/// @notice Core term deposit engine holding principal, managing plans, and issuing deposit NFTs.
/// @dev Supports the standard MockUSDC asset; fee-on-transfer and rebasing assets are unsupported.
/// Withdrawal and renewal workflows are implemented in subsequent tasks.
contract SavingCore is ERC721, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS_DENOMINATOR = 10000;
    uint256 internal constant SECONDS_PER_DAY = 1 days;
    uint256 internal constant SECONDS_PER_YEAR = 365 days;

    enum DepositStatus {
        Active,
        Withdrawn,
        ManualRenewed,
        AutoRenewed
    }

    /// @notice Term deposit plan specification.
    struct SavingPlan {
        uint32 tenorDays;
        uint16 aprBps;
        uint256 minDeposit;
        uint256 maxDeposit;
        uint16 earlyWithdrawPenaltyBps;
        bool enabled;
    }

    /// @notice Immutable terms of a deposit; current ownership is tracked solely by ERC721.
    struct Deposit {
        uint256 planId;
        uint256 principal;
        uint256 startAt;
        uint256 maturityAt;
        uint16 aprBpsAtOpen;
        uint16 penaltyBpsAtOpen;
        DepositStatus status;
    }

    /// @notice Vault holding the interest reserve; sole authority for Bank Admin.
    IVaultManager public immutable vaultManager;

    /// @notice Underlying deposit token derived from VaultManager.
    IERC20 public immutable token;

    /// @notice System grace period in seconds before auto-renewal is permitted.
    uint256 public immutable gracePeriodSeconds;

    /// @notice Total number of saving plans created.
    uint256 public planCount;

    /// @notice Number of successfully created deposits; IDs start at one and are never reused.
    uint256 public depositCount;

    /// @notice Sum of principal belonging to all Active deposits, excluding token donations.
    uint256 public totalPrincipal;

    /// @dev Internal mapping from plan ID to SavingPlan struct.
    mapping(uint256 => SavingPlan) private _plans;
    mapping(uint256 => Deposit) private _deposits;

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
    error CoreNotBound(address expectedCore, address actualCore);
    error EnforcedPause();
    error PlanDisabled(uint256 planId);
    error AmountZero();
    error DepositAmountOutOfRange(uint256 amount, uint256 minDeposit, uint256 maxDeposit);
    error DepositNotFound(uint256 depositId);
    error DepositNotActive(uint256 depositId, DepositStatus currentStatus);
    error NotDepositOwner(uint256 depositId, address caller);
    error DepositNotMatured(uint256 depositId, uint256 maturityAt);
    error EarlyWithdrawalClosed(uint256 depositId, uint256 maturityAt);

    // --- Events ---
    event PlanCreated(uint256 indexed planId, uint256 tenorDays, uint256 aprBps);
    event PlanUpdated(uint256 indexed planId, uint256 newAprBps);
    event PlanEnabledChanged(uint256 indexed planId, bool enabled);
    event DepositOpened(
        uint256 indexed depositId,
        address indexed owner,
        uint256 indexed planId,
        uint256 principal,
        uint256 maturityAt,
        uint256 aprBpsAtOpen
    );
    event Withdrawn(
        uint256 indexed depositId,
        address indexed owner,
        uint256 principal,
        uint256 interest,
        bool isEarly
    );

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

    /// @notice Opens a term deposit funded by the caller and mints its transferable certificate.
    /// @dev Effects precede interactions; transfer or receiver failure reverts the entire operation.
    /// Principal must reach Core before the ERC721 receiver callback can run.
    /// @param planId Existing enabled plan whose terms are captured at opening.
    /// @param amount Positive principal in smallest token units, within the plan's limits.
    /// @return depositId ID shared by the deposit record and its ERC721 certificate.
    function openDeposit(uint256 planId, uint256 amount) external nonReentrant returns (uint256 depositId) {
        address actualCore = vaultManager.savingCore();
        if (actualCore != address(this)) revert CoreNotBound(address(this), actualCore);
        if (vaultManager.paused()) revert EnforcedPause();
        if (planId == 0 || planId > planCount) revert PlanNotFound(planId);

        SavingPlan memory plan = _plans[planId];
        if (!plan.enabled) revert PlanDisabled(planId);
        if (amount == 0) revert AmountZero();
        if ((plan.minDeposit != 0 && amount < plan.minDeposit)
            || (plan.maxDeposit != 0 && amount > plan.maxDeposit)) {
            revert DepositAmountOutOfRange(amount, plan.minDeposit, plan.maxDeposit);
        }

        uint256 startAt = block.timestamp;
        uint256 tenorSeconds = uint256(plan.tenorDays) * SECONDS_PER_DAY;
        uint256 maturityAt = startAt + tenorSeconds;
        // Reject terms whose eventual full-term interest or payout cannot fit in uint256.
        _fullTermPayout(amount, plan.aprBps, tenorSeconds);

        depositId = ++depositCount;
        _deposits[depositId] = Deposit({
            planId: planId,
            principal: amount,
            startAt: startAt,
            maturityAt: maturityAt,
            aprBpsAtOpen: plan.aprBps,
            penaltyBpsAtOpen: plan.earlyWithdrawPenaltyBps,
            status: DepositStatus.Active
        });
        totalPrincipal += amount;

        token.safeTransferFrom(msg.sender, address(this), amount);
        _safeMint(msg.sender, depositId);

        // A receiver may forward the NFT during safeMint; this is the initial recipient.
        emit DepositOpened(depositId, msg.sender, planId, amount, maturityAt, plan.aprBps);
    }

    /// @notice Returns the terms and status of an existing deposit, including while paused.
    function getDeposit(uint256 depositId) external view returns (Deposit memory) {
        if (depositId == 0 || depositId > depositCount) revert DepositNotFound(depositId);
        return _deposits[depositId];
    }

    /// @notice Calculates the full-term contractual interest for a deposit based on its open snapshot.
    /// @param depositId ID of the deposit (1 <= depositId <= depositCount).
    /// @return Contractual interest in smallest token units.
    function calculateInterest(uint256 depositId) external view returns (uint256) {
        if (depositId == 0 || depositId > depositCount) revert DepositNotFound(depositId);
        return _calculateInterest(_deposits[depositId]);
    }

    /// @notice Calculates the early withdrawal penalty for a deposit based on its open snapshot.
    /// @param depositId ID of the deposit (1 <= depositId <= depositCount).
    /// @return Penalty amount in smallest token units.
    function calculatePenalty(uint256 depositId) external view returns (uint256) {
        if (depositId == 0 || depositId > depositCount) revert DepositNotFound(depositId);
        return _calculatePenalty(_deposits[depositId]);
    }

    /// @notice Withdraws principal and full-term interest at or after maturity.
    /// @dev Only the current certificate owner may withdraw. Principal is paid from Core;
    /// interest is pulled from VaultManager.
    /// @param depositId ID of the active deposit to settle.
    function withdrawAtMaturity(uint256 depositId) external nonReentrant {
        address actualCore = vaultManager.savingCore();
        if (actualCore != address(this)) revert CoreNotBound(address(this), actualCore);
        if (vaultManager.paused()) revert EnforcedPause();
        if (depositId == 0 || depositId > depositCount) revert DepositNotFound(depositId);

        Deposit storage deposit = _deposits[depositId];
        if (deposit.status != DepositStatus.Active) {
            revert DepositNotActive(depositId, deposit.status);
        }
        if (ownerOf(depositId) != msg.sender) {
            revert NotDepositOwner(depositId, msg.sender);
        }
        if (block.timestamp < deposit.maturityAt) {
            revert DepositNotMatured(depositId, deposit.maturityAt);
        }

        uint256 principal = deposit.principal;
        uint256 interest = _calculateInterest(deposit);

        // Checks-Effects-Interactions: record terminal status and decrement liability before transfers
        deposit.status = DepositStatus.Withdrawn;
        totalPrincipal -= principal;

        // Pull interest from VaultManager if positive
        if (interest > 0) {
            vaultManager.payInterest(interest);
        }

        // Payout principal + interest to the current NFT owner
        token.safeTransfer(msg.sender, principal + interest);

        emit Withdrawn(depositId, msg.sender, principal, interest, false);
    }

    /// @notice Withdraws principal minus early penalty before maturity; no interest is paid.
    /// @dev Only the current certificate owner may withdraw. Net principal is paid to owner;
    /// penalty is paid to feeReceiver.
    /// @param depositId ID of the active deposit to settle early.
    function earlyWithdraw(uint256 depositId) external nonReentrant {
        address actualCore = vaultManager.savingCore();
        if (actualCore != address(this)) revert CoreNotBound(address(this), actualCore);
        if (vaultManager.paused()) revert EnforcedPause();
        if (depositId == 0 || depositId > depositCount) revert DepositNotFound(depositId);

        Deposit storage deposit = _deposits[depositId];
        if (deposit.status != DepositStatus.Active) {
            revert DepositNotActive(depositId, deposit.status);
        }
        if (ownerOf(depositId) != msg.sender) {
            revert NotDepositOwner(depositId, msg.sender);
        }
        if (block.timestamp >= deposit.maturityAt) {
            revert EarlyWithdrawalClosed(depositId, deposit.maturityAt);
        }

        uint256 principal = deposit.principal;
        uint256 penalty = _calculatePenalty(deposit);
        uint256 netPayout = principal - penalty;
        address feeReceiver = vaultManager.feeReceiver();

        // Checks-Effects-Interactions: record terminal status and remove full principal liability
        deposit.status = DepositStatus.Withdrawn;
        totalPrincipal -= principal;

        // Transfer net payout to owner if nonzero
        if (netPayout > 0) {
            token.safeTransfer(msg.sender, netPayout);
        }

        // Transfer penalty to feeReceiver if nonzero
        if (penalty > 0) {
            token.safeTransfer(feeReceiver, penalty);
        }

        emit Withdrawn(depositId, msg.sender, principal, 0, true);
    }

    /// @dev Computes full-term simple interest floored to smallest token units.
    function _calculateInterest(Deposit memory deposit) internal pure returns (uint256) {
        uint256 tenorSeconds = deposit.maturityAt - deposit.startAt;
        return Math.mulDiv(
            deposit.principal,
            uint256(deposit.aprBpsAtOpen) * tenorSeconds,
            SECONDS_PER_YEAR * BPS_DENOMINATOR
        );
    }

    /// @dev Computes early withdrawal penalty floored to smallest token units.
    function _calculatePenalty(Deposit memory deposit) internal pure returns (uint256) {
        return Math.mulDiv(
            deposit.principal,
            uint256(deposit.penaltyBpsAtOpen),
            BPS_DENOMINATOR
        );
    }

    /// @dev Feasibility check only; does not reserve interest or transfer a payout.
    function _fullTermPayout(uint256 principal, uint16 aprBps, uint256 tenorSeconds)
        internal pure returns (uint256)
    {
        uint256 interest = Math.mulDiv(
            principal, uint256(aprBps) * tenorSeconds, SECONDS_PER_YEAR * BPS_DENOMINATOR
        );
        return principal + interest;
    }
}
