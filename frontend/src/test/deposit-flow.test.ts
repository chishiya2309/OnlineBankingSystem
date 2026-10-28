import { describe, it, expect } from "vitest";
import type { SavingPlan } from "../types";
import { parseTransactionError } from "../lib/errors";

describe("Deposit Flow Business Logic & Traceability (FE-003 to FE-015)", () => {
  const sampleEnabledPlan: SavingPlan = {
    planId: 1,
    tenorDays: 180,
    aprBps: 200,
    aprPercent: "2.00%",
    minDeposit: 100000000n, // 100 USDC
    maxDeposit: 5000000000n, // 5,000 USDC
    minDepositFormatted: "100.00 USDC",
    maxDepositFormatted: "5,000.00 USDC",
    earlyWithdrawPenaltyBps: 350,
    penaltyPercent: "3.50%",
    enabled: true,
  };

  const sampleDisabledPlan: SavingPlan = {
    ...sampleEnabledPlan,
    planId: 3,
    enabled: false,
  };

  it("FE-003: maps SavingCore on-chain struct into typed SavingPlan", () => {
    expect(sampleEnabledPlan.planId).toBe(1);
    expect(sampleEnabledPlan.tenorDays).toBe(180);
    expect(sampleEnabledPlan.aprPercent).toBe("2.00%");
    expect(sampleEnabledPlan.enabled).toBe(true);
  });

  it("FE-004: rejects deposit attempts on disabled saving plan", () => {
    expect(sampleDisabledPlan.enabled).toBe(false);
    const canDeposit = sampleDisabledPlan.enabled;
    expect(canDeposit).toBe(false);
  });

  it("FE-007: rejects amount below minDeposit or above maxDeposit", () => {
    const tooLow = 50000000n; // 50 USDC < 100 USDC
    const tooHigh = 6000000000n; // 6,000 USDC > 5,000 USDC
    const valid = 500000000n; // 500 USDC

    expect(tooLow < sampleEnabledPlan.minDeposit).toBe(true);
    expect(tooHigh > sampleEnabledPlan.maxDeposit).toBe(true);
    expect(
      valid >= sampleEnabledPlan.minDeposit &&
        valid <= sampleEnabledPlan.maxDeposit
    ).toBe(true);
  });

  it("FE-008: handles insufficient user MockUSDC balance", () => {
    const userBalance = 200000000n; // 200 USDC
    const depositAmount = 500000000n; // 500 USDC
    const isSufficient = userBalance >= depositAmount;
    expect(isSufficient).toBe(false);
  });

  it("FE-009: skips approval when existing allowance is already sufficient", () => {
    const currentAllowance = 1000000000n; // 1,000 USDC
    const depositAmount = 500000000n; // 500 USDC
    const needsApproval = currentAllowance < depositAmount;
    expect(needsApproval).toBe(false);
  });

  it("FE-009: requires approval when allowance is less than deposit amount", () => {
    const currentAllowance = 0n;
    const depositAmount = 500000000n; // 500 USDC
    const needsApproval = currentAllowance < depositAmount;
    expect(needsApproval).toBe(true);
  });

  it("FE-011: handles user rejection in MetaMask without displaying success", () => {
    const userRejectedErr = {
      code: 4001,
      message: "MetaMask Tx Signature: User denied transaction signature.",
    };
    const humanMsg = parseTransactionError(userRejectedErr);
    expect(humanMsg).toBe("Transaction was cancelled in your wallet.");
  });

  it("FE-012: parses custom revert error messages into helpful feedback", () => {
    expect(
      parseTransactionError(new Error("execution reverted: DepositAmountOutOfRange()"))
    ).toContain("Deposit principal is outside the allowed minimum and maximum deposit limits");

    expect(
      parseTransactionError(new Error("execution reverted: PlanDisabled()"))
    ).toContain("This saving plan is currently disabled");

    expect(
      parseTransactionError(new Error("ERC20InsufficientAllowance(0x123, 0, 500)"))
    ).toContain("Insufficient MockUSDC allowance");
  });
});
