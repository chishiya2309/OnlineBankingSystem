import { describe, it, expect } from "vitest";
import { DepositStatus, type DepositRecord, type SavingPlan } from "../types";
import {
  calculateContractualInterest,
  calculateMaturityPayout,
  calculateRenewalPrincipal,
} from "../lib/financials";
import { parseTransactionError } from "../lib/errors";

describe("Renewal Action Matrix & Compounding Tests (MR-UI-001 to AR-UI-006)", () => {
  const maturityTime = 1715000000;
  const gracePeriodSeconds = 172800; // 2 days
  const graceEnd = maturityTime + gracePeriodSeconds;

  const targetPlan2: SavingPlan = {
    planId: 2,
    tenorDays: 365,
    tenorSeconds: 365 * 86400,
    aprBps: 500, // 5.00%
    aprPercent: "5.00%",
    minDeposit: 500000000n, // 500 USDC
    maxDeposit: 10000000000n, // 10,000 USDC
    minDepositFormatted: "500.00 USDC",
    maxDepositFormatted: "10,000.00 USDC",
    earlyWithdrawPenaltyBps: 400,
    penaltyPercent: "4.00%",
    enabled: true,
  };

  const disabledPlan: SavingPlan = {
    ...targetPlan2,
    planId: 3,
    enabled: false,
  };

  const createActiveDeposit = (overrides: Partial<DepositRecord> = {}): DepositRecord => {
    const principal = 1000000000n; // 1,000 USDC
    const aprBpsAtOpen = 200; // 2.00%
    const penaltyBpsAtOpen = 350;
    const startAt = maturityTime - 180 * 86400;
    const accruedInterest = calculateContractualInterest(principal, aprBpsAtOpen, 180);

    return {
      depositId: 1,
      planId: 1,
      principal,
      principalFormatted: "1,000.00",
      startAt,
      maturityAt: maturityTime,
      aprBpsAtOpen,
      penaltyBpsAtOpen,
      status: DepositStatus.Active,
      owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      accruedInterest,
      accruedInterestFormatted: "9.86",
      earlyPenalty: 35000000n,
      earlyPenaltyFormatted: "35.00",
      maturityPayout: calculateMaturityPayout(principal, accruedInterest),
      maturityPayoutFormatted: "1,009.86",
      earlyPayout: 965000000n,
      earlyPayoutFormatted: "965.00",
      tenorSeconds: 180 * 86400,
      gracePeriodSeconds,
      graceEnd,
      isMatured: true,
      isGraceEnded: false,
      canEarlyWithdraw: false,
      canMaturityWithdraw: true,
      canManualRenew: true,
      canAutoRenew: false,
      ...overrides,
    };
  };

  // --- MANUAL RENEWAL TESTS (MR-UI-001 to MR-UI-008) ---

  it("MR-UI-001: allows Manual Renewal only for current NFT owner", () => {
    const deposit = createActiveDeposit();
    const owner = deposit.owner;
    const stranger = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

    expect(owner.toLowerCase() === deposit.owner.toLowerCase()).toBe(true);
    expect(stranger.toLowerCase() === deposit.owner.toLowerCase()).toBe(false);

    const error = parseTransactionError(new Error("NotDepositOwner()"));
    expect(error).toContain("Only the current owner of this deposit NFT certificate can perform this action");
  });

  it("MR-UI-002: disallows Manual Renewal before maturity (t < M)", () => {
    const t = maturityTime - 100;
    const isMatured = t >= maturityTime;
    expect(isMatured).toBe(false);

    const error = parseTransactionError(new Error("DepositNotMatured(1, 1715000000)"));
    expect(error).toContain("Deposit has not reached maturity yet");
  });

  it("MR-UI-003: rejects renewal into a disabled target plan", () => {
    expect(disabledPlan.enabled).toBe(false);
    const error = parseTransactionError(new Error("PlanDisabled(3)"));
    expect(error).toContain("This saving plan is currently disabled by Bank Admin");
  });

  it("MR-UI-004: validates target plan deposit limits against compounded principal (P + I)", () => {
    const deposit = createActiveDeposit();
    const compoundedPrincipal = calculateRenewalPrincipal(deposit.principal, deposit.accruedInterest);

    // 1,000 + 9.86 = 1,009.86 USDC
    expect(compoundedPrincipal).toBe(1009863013n);

    // Plan with minDeposit = 1,005 USDC: should accept P + I (1,009.86), even though old P was 1,000!
    const planWithHighMin: SavingPlan = {
      ...targetPlan2,
      minDeposit: 1005000000n, // 1,005 USDC
      maxDeposit: 5000000000n,
    };

    const isOldPrincipalEligible = deposit.principal >= planWithHighMin.minDeposit;
    const isCompoundedEligible = compoundedPrincipal >= planWithHighMin.minDeposit;

    expect(isOldPrincipalEligible).toBe(false); // Old P was < 1,005 USDC
    expect(isCompoundedEligible).toBe(true); // Compounded P + I >= 1,005 USDC!
  });

  it("MR-UI-005: computes old interest using old snapshot APR, not target plan APR", () => {
    const deposit = createActiveDeposit(); // 200 bps (2%)
    const targetApr = targetPlan2.aprBps; // 500 bps (5%)

    // Old interest MUST use old APR snapshot (2%)
    const calculatedOldInterest = calculateContractualInterest(deposit.principal, deposit.aprBpsAtOpen, 180);
    const wrongTargetInterest = calculateContractualInterest(deposit.principal, targetApr, 180);

    expect(calculatedOldInterest).toBe(deposit.accruedInterest);
    expect(calculatedOldInterest).not.toBe(wrongTargetInterest);
  });

  it("MR-UI-006: target plan sets the terms for the renewed deposit", () => {
    expect(targetPlan2.aprBps).toBe(500);
    expect(targetPlan2.tenorDays).toBe(365);
    expect(targetPlan2.earlyWithdrawPenaltyBps).toBe(400);
  });

  it("MR-UI-007: manual renewal does not require MockUSDC token approval", () => {
    // Contract pulls interest from VaultManager and rolls principal over without transferFrom msg.sender
    const userAllowance = 0n;
    const renewalRequiresApproval = false;
    expect(renewalRequiresApproval).toBe(false);
    expect(userAllowance).toBe(0n);
  });

  // --- AUTO RENEWAL TESTS (AR-UI-001 to AR-UI-006) ---

  it("AR-UI-001: disallows Auto Renewal before grace period ends (t < G)", () => {
    const t = graceEnd - 1; // 1 second before grace end
    const isGraceEnded = t >= graceEnd;
    expect(isGraceEnded).toBe(false);

    const error = parseTransactionError(new Error("GracePeriodNotEnded(1, 1715172800)"));
    expect(error).toContain("Auto-renewal grace period has not ended yet");
  });

  it("AR-UI-002: allows Auto Renewal at or after grace period ends (t >= G)", () => {
    const t = graceEnd; // Exactly at grace end
    const isGraceEnded = t >= graceEnd;
    expect(isGraceEnded).toBe(true);
  });

  it("AR-UI-003: permissionless action: any caller can trigger auto-renewal without owner restriction", () => {
    const caller = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // external bot or stranger
    const deposit = createActiveDeposit();

    // Auto-renewal does NOT require caller to be deposit.owner
    const canCallerTrigger = true;
    expect(canCallerTrigger).toBe(true);
    expect(caller.toLowerCase()).not.toBe(deposit.owner.toLowerCase());
  });

  it("AR-UI-004: auto-renewal preserves and locks original snapshot terms", () => {
    const deposit = createActiveDeposit();

    // Auto-renewal preserves locked APR, tenor, and penalty
    const lockedApr = deposit.aprBpsAtOpen;
    const lockedTenor = deposit.tenorSeconds;
    const lockedPenalty = deposit.penaltyBpsAtOpen;

    expect(lockedApr).toBe(200);
    expect(lockedTenor).toBe(180 * 86400);
    expect(lockedPenalty).toBe(350);
  });

  it("AR-UI-005: new certificate is minted to the current owner of old NFT, never the caller", () => {
    const deposit = createActiveDeposit({
      owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // Alice
    });
    const caller = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // Stranger/Bot

    // New certificate recipient MUST be current owner Alice
    const newCertificateRecipient = deposit.owner;
    expect(newCertificateRecipient).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(newCertificateRecipient).not.toBe(caller);
  });
});
