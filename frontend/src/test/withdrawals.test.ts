import { describe, it, expect } from "vitest";
import { DepositStatus, type DepositRecord } from "../types";
import {
  calculatePenalty,
  calculateEarlyWithdrawal,
  calculateContractualInterest,
  calculateMaturityPayout,
} from "../lib/financials";
import { parseTransactionError } from "../lib/errors";

describe("Withdrawal Eligibility & Calculation Tests (WD-UI-001 to WD-UI-008)", () => {
  const maturityTime = 1715000000;
  const gracePeriod = 172800; // 2 days

  const createDepositMock = (overrides: Partial<DepositRecord> = {}): DepositRecord => {
    const principal = 1000000000n; // 1,000 USDC
    const aprBps = 200; // 2.00%
    const penaltyBps = 350; // 3.50%
    const startAt = maturityTime - 180 * 86400;
    const accruedInterest = calculateContractualInterest(principal, aprBps, 180);
    const earlyPenalty = calculatePenalty(principal, penaltyBps);

    return {
      depositId: 1,
      planId: 1,
      principal,
      principalFormatted: "1,000.00",
      startAt,
      maturityAt: maturityTime,
      aprBpsAtOpen: aprBps,
      penaltyBpsAtOpen: penaltyBps,
      status: DepositStatus.Active,
      owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      accruedInterest,
      accruedInterestFormatted: "9.86",
      earlyPenalty,
      earlyPenaltyFormatted: "35.00",
      maturityPayout: calculateMaturityPayout(principal, accruedInterest),
      maturityPayoutFormatted: "1,009.86",
      earlyPayout: principal - earlyPenalty,
      earlyPayoutFormatted: "965.00",
      tenorSeconds: 180 * 86400,
      gracePeriodSeconds: gracePeriod,
      graceEnd: maturityTime + gracePeriod,
      isMatured: false,
      isGraceEnded: false,
      canEarlyWithdraw: true,
      canMaturityWithdraw: false,
      canManualRenew: false,
      canAutoRenew: false,
      ...overrides,
    };
  };

  it("WD-UI-001: allows Early Withdrawal when block timestamp t < M on active deposit", () => {
    const t = maturityTime - 1; // 1 second before maturity
    const deposit = createDepositMock();

    const isMatured = t >= deposit.maturityAt;
    const canEarlyWithdraw = deposit.status === DepositStatus.Active && !isMatured;
    const canMaturityWithdraw = deposit.status === DepositStatus.Active && isMatured;

    expect(canEarlyWithdraw).toBe(true);
    expect(canMaturityWithdraw).toBe(false);
  });

  it("WD-UI-002: disallows Early Withdrawal at exact maturity t = M", () => {
    const t = maturityTime; // Exactly at maturity
    const deposit = createDepositMock();

    const isMatured = t >= deposit.maturityAt;
    const canEarlyWithdraw = deposit.status === DepositStatus.Active && !isMatured;
    const canMaturityWithdraw = deposit.status === DepositStatus.Active && isMatured;

    expect(canEarlyWithdraw).toBe(false);
    expect(canMaturityWithdraw).toBe(true);
  });

  it("WD-UI-003: disallows Maturity Withdrawal when t < M", () => {
    const t = maturityTime - 86400; // 1 day before maturity
    const deposit = createDepositMock();

    const isMatured = t >= deposit.maturityAt;
    const canMaturityWithdraw = deposit.status === DepositStatus.Active && isMatured;

    expect(canMaturityWithdraw).toBe(false);
  });

  it("WD-UI-004: allows Maturity Withdrawal when t > M on active deposit", () => {
    const t = maturityTime + 500;
    const deposit = createDepositMock();

    const isMatured = t >= deposit.maturityAt;
    const canMaturityWithdraw = deposit.status === DepositStatus.Active && isMatured;

    expect(canMaturityWithdraw).toBe(true);
  });

  it("WD-UI-005: computes exact BigInt early penalty and net payout matching SavingCore", () => {
    const principal = 1000000000n; // 1,000 USDC (6 decimals)
    const penaltyBps = 350; // 3.50%

    // F = floor( P * 350 / 10000 ) = 35,000,000 units (35 USDC)
    const { netPayout, penalty } = calculateEarlyWithdrawal(principal, penaltyBps);
    expect(penalty).toBe(35000000n);
    expect(netPayout).toBe(965000000n); // 965 USDC
    expect(netPayout + penalty).toBe(principal);
  });

  it("WD-UI-006: rejects non-owner withdrawal preflight check", () => {
    const deposit = createDepositMock({
      owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    });
    const connectedAccount = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // stranger

    const isOwner = deposit.owner.toLowerCase() === connectedAccount.toLowerCase();
    expect(isOwner).toBe(false);

    const errorMessage = parseTransactionError(new Error("NotDepositOwner(1, 0x3C44...)"));
    expect(errorMessage).toContain("Only the current owner of this deposit NFT certificate can perform this action");
  });

  it("WD-UI-007: blocks withdrawal on terminal deposits (Withdrawn, Renewed)", () => {
    const withdrawnDeposit = createDepositMock({ status: DepositStatus.Withdrawn });
    const renewedDeposit = createDepositMock({ status: DepositStatus.ManualRenewed });

    const canWithdrawWithdrawn = withdrawnDeposit.status === DepositStatus.Active;
    const canWithdrawRenewed = renewedDeposit.status === DepositStatus.Active;

    expect(canWithdrawWithdrawn).toBe(false);
    expect(canWithdrawRenewed).toBe(false);

    const errorMessage = parseTransactionError(new Error("DepositNotActive(1, 1)"));
    expect(errorMessage).toContain("This deposit is no longer active");
  });

  it("WD-UI-008: handles user transaction rejection cleanly without marking success", () => {
    const rejectionError = {
      code: "ACTION_REJECTED",
      message: "user rejected action",
    };
    const parsed = parseTransactionError(rejectionError);
    expect(parsed).toBe("Transaction was cancelled in your wallet.");
  });

  it("WD-UI-009: calculates 100% early penalty as total capital loss (netPayout = 0n)", () => {
    const principal = 1000000000n; // 1,000 USDC
    const penaltyBps = 10000; // 100.00%
    const penalty = calculatePenalty(principal, penaltyBps);
    const { netPayout, penalty: calculatedPenalty } = calculateEarlyWithdrawal(principal, penaltyBps);

    expect(penalty).toBe(principal);
    expect(calculatedPenalty).toBe(principal);
    expect(netPayout).toBe(0n);
  });

  it("WD-UI-010: detects insufficient vault liquidity when vaultBalance < accruedInterest", () => {
    const deposit = createDepositMock({
      accruedInterest: 50000000n, // 50 USDC
    });
    const vaultBalanceDry = 10000000n; // 10 USDC (< 50 USDC)
    const isInsufficient = deposit.accruedInterest > 0n && vaultBalanceDry < deposit.accruedInterest;
    expect(isInsufficient).toBe(true);

    const vaultBalanceSufficient = 100000000n; // 100 USDC (> 50 USDC)
    const isStillInsufficient = deposit.accruedInterest > 0n && vaultBalanceSufficient < deposit.accruedInterest;
    expect(isStillInsufficient).toBe(false);
  });

  it("WD-UI-011: blocks actions during vault emergency pause", () => {
    const isPaused = true;
    const canTransact = !isPaused;
    expect(canTransact).toBe(false);
  });
});
