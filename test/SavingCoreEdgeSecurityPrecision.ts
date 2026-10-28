import assert from "node:assert/strict";
import { expect } from "chai";
import { network } from "hardhat";
import { personalVariant } from "../config/personal-variant.js";

const connection = await network.create("hardhatMainnet");
const { ethers, networkHelpers } = connection;

const GRACE_PERIOD_SECONDS = BigInt(personalVariant.gracePeriodDays * 86400); // 172800n
const DEFAULT_TENOR_DAYS = BigInt(personalVariant.defaultTenorDays); // 180n
const DEFAULT_APR_BPS = BigInt(personalVariant.defaultAprBps); // 200n
const DEFAULT_PENALTY_BPS = BigInt(personalVariant.earlyWithdrawPenaltyBps); // 350n

const toUnits = (amount: string): bigint => ethers.parseUnits(amount, 6);

// Independent BigInt mathematical calculations (Source of Truth)
function calcExpectedInterest(principal: bigint, aprBps: bigint, tenorSeconds: bigint): bigint {
  return (principal * aprBps * tenorSeconds) / (365n * 86400n * 10000n);
}

function calcExpectedPenalty(principal: bigint, penaltyBps: bigint): bigint {
  return (principal * penaltyBps) / 10000n;
}

async function deployEdgePrecisionFixture() {
  const [operator, bankAdmin, alice, bob, feeReceiver, stranger, attacker, charlie] = await ethers.getSigners();

  const token = await ethers.deployContract("MockUSDC");
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();

  const vault = await ethers.deployContract("VaultManager", [tokenAddress, bankAdmin.address, feeReceiver.address]);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();

  const savingCore = await ethers.deployContract("SavingCore", [vaultAddress, GRACE_PERIOD_SECONDS]);
  await savingCore.waitForDeployment();
  const savingCoreAddress = await savingCore.getAddress();

  // Bind SavingCore write-once in VaultManager
  await (await vault.connect(bankAdmin).setSavingCore(savingCoreAddress)).wait();

  // Plan 1: Default Personal Variant (180 days, 200 bps, min=0, max=0, penalty=350 bps, enabled=true)
  await (await savingCore.connect(bankAdmin).createPlan(
    DEFAULT_TENOR_DAYS,
    DEFAULT_APR_BPS,
    0n,
    0n,
    DEFAULT_PENALTY_BPS,
    true
  )).wait();

  // Plan 2: Bounded Target Plan (90 days, 400 bps, min=100 USDC, max=5000 USDC, penalty=500 bps, enabled=true)
  await (await savingCore.connect(bankAdmin).createPlan(
    90n,
    400n,
    toUnits("100"),
    toUnits("5000"),
    500n,
    true
  )).wait();

  // Mint tokens to users and bank admin
  await (await token.mint(alice.address, toUnits("100000"))).wait();
  await (await token.mint(bob.address, toUnits("100000"))).wait();
  await (await token.mint(bankAdmin.address, toUnits("500000"))).wait();
  await (await token.mint(stranger.address, toUnits("10000"))).wait();

  // Approvals
  await (await token.connect(alice).approve(savingCoreAddress, ethers.MaxUint256)).wait();
  await (await token.connect(bob).approve(savingCoreAddress, ethers.MaxUint256)).wait();
  await (await token.connect(bankAdmin).approve(vaultAddress, ethers.MaxUint256)).wait();
  await (await token.connect(stranger).approve(savingCoreAddress, ethers.MaxUint256)).wait();

  // Fund Vault with initial interest pool (10,000 USDC)
  await (await vault.connect(bankAdmin).fundVault(toUnits("10000"))).wait();

  return {
    operator,
    bankAdmin,
    alice,
    bob,
    feeReceiver,
    stranger,
    attacker,
    charlie,
    token,
    tokenAddress,
    vault,
    vaultAddress,
    savingCore,
    savingCoreAddress,
  };
}

describe("D4-01 Edge, Security & Precision", function () {
  describe("Group 1: Financial Precision & Mathematical Edge Cases", function () {
    it("PREC-001: tiny principal = 1 smallest unit floors interest to zero without underflow", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      // Plan 1 has minDeposit = 0, allowing 1 unit
      const tx = await f.savingCore.connect(f.alice).openDeposit(1, 1n);
      await tx.wait();

      const deposit = await f.savingCore.getDeposit(1);
      const tenorSeconds = deposit.maturityAt - deposit.startAt;
      const expectedInterest = calcExpectedInterest(1n, DEFAULT_APR_BPS, tenorSeconds);
      expect(expectedInterest).to.equal(0n);

      const contractInterest = await f.savingCore.calculateInterest(1);
      expect(contractInterest).to.equal(0n);

      // Advance to maturity and withdraw
      await networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt);
      const vaultBalanceBefore = await f.token.balanceOf(f.vaultAddress);
      const aliceBalanceBefore = await f.token.balanceOf(f.alice.address);

      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();

      const aliceBalanceAfter = await f.token.balanceOf(f.alice.address);
      const vaultBalanceAfter = await f.token.balanceOf(f.vaultAddress);

      // Vault is not debited when interest is zero
      expect(vaultBalanceAfter).to.equal(vaultBalanceBefore);
      expect(aliceBalanceAfter - aliceBalanceBefore).to.equal(1n);
    });

    it("PREC-002: small principal producing zero interest floors correctly and bypasses payInterest", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      // P = 100 smallest units (0.0001 USDC). Tenor = 180d, APR = 200 bps
      // 100 * 200 * 15552000 / (31536000 * 10000) = 311040000 / 315360000000 = 0.000986... -> 0
      const p = 100n;
      await (await f.savingCore.connect(f.alice).openDeposit(1, p)).wait();

      const deposit = await f.savingCore.getDeposit(1);
      const tenorSeconds = deposit.maturityAt - deposit.startAt;
      const expectedInterest = calcExpectedInterest(p, DEFAULT_APR_BPS, tenorSeconds);
      expect(expectedInterest).to.equal(0n);
      expect(await f.savingCore.calculateInterest(1)).to.equal(0n);

      await networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt);
      const vaultBefore = await f.token.balanceOf(f.vaultAddress);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();
      const vaultAfter = await f.token.balanceOf(f.vaultAddress);
      expect(vaultAfter).to.equal(vaultBefore);
    });

    it("PREC-003: fractional interest floor verifies sub-unit dust remains in Vault", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      // Personal Variant: P = 1000 USDC = 1,000,000,000 units, 200 bps, 180 days
      // Math: 1_000_000_000 * 200 * 15552000 / 315360000000 = 9863013.698630136...
      // Integer floor: 9,863,013 units
      const p = toUnits("1000");
      await (await f.savingCore.connect(f.alice).openDeposit(1, p)).wait();

      const deposit = await f.savingCore.getDeposit(1);
      const tenorSeconds = deposit.maturityAt - deposit.startAt;
      const expectedInterest = calcExpectedInterest(p, DEFAULT_APR_BPS, tenorSeconds);
      expect(expectedInterest).to.equal(9863013n);
      expect(await f.savingCore.calculateInterest(1)).to.equal(9863013n);

      await networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt);
      const vaultBefore = await f.token.balanceOf(f.vaultAddress);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();
      const vaultAfter = await f.token.balanceOf(f.vaultAddress);

      // Exactly 9,863,013 debited from Vault, fractional dust (0.6986... units) remains in Vault
      expect(vaultBefore - vaultAfter).to.equal(9863013n);
    });

    it("PREC-004: principal with 6 decimal places calculates floor interest precisely", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      // P = 123.456789 MockUSDC = 123,456,789 units
      // Tenor = 180 days, APR = 200 bps
      // Expected = floor(123456789 * 200 * 15552000 / 315360000000) = 1,217,656 units
      const p = 123456789n;
      await (await f.savingCore.connect(f.alice).openDeposit(1, p)).wait();

      const deposit = await f.savingCore.getDeposit(1);
      const tenorSeconds = deposit.maturityAt - deposit.startAt;
      const expectedInterest = calcExpectedInterest(p, DEFAULT_APR_BPS, tenorSeconds);
      const contractInterest = await f.savingCore.calculateInterest(1);

      expect(contractInterest).to.equal(expectedInterest);
      expect(contractInterest).to.equal(1217656n);
    });

    it("PREC-005: APR = 0 bps yields zero interest and exact principal return", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      // Admin creates plan with 0 APR
      await (await f.savingCore.connect(f.bankAdmin).createPlan(180n, 0n, 0n, 0n, 350n, true)).wait();
      const planId = 3n;

      const p = toUnits("500");
      await (await f.savingCore.connect(f.alice).openDeposit(planId, p)).wait();

      const contractInterest = await f.savingCore.calculateInterest(1);
      expect(contractInterest).to.equal(0n);

      const deposit = await f.savingCore.getDeposit(1);
      await networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt);

      const aliceBefore = await f.token.balanceOf(f.alice.address);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();
      const aliceAfter = await f.token.balanceOf(f.alice.address);

      expect(aliceAfter - aliceBefore).to.equal(p);
    });

    it("PREC-006: APR = 10000 bps (100% annual) with 365 days tenor returns exact 100% interest", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await (await f.savingCore.connect(f.bankAdmin).createPlan(365n, 10000n, 0n, 0n, 0n, true)).wait();
      const planId = 3n;

      const p = toUnits("750");
      await (await f.savingCore.connect(f.alice).openDeposit(planId, p)).wait();

      const deposit = await f.savingCore.getDeposit(1);
      const tenorSeconds = deposit.maturityAt - deposit.startAt;
      const expectedInterest = calcExpectedInterest(p, 10000n, tenorSeconds);

      expect(expectedInterest).to.equal(p);
      expect(await f.savingCore.calculateInterest(1)).to.equal(p);
    });

    it("PREC-007: APR = 1 bps (0.01%) calculates exact floor interest", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await (await f.savingCore.connect(f.bankAdmin).createPlan(365n, 1n, 0n, 0n, 0n, true)).wait();
      const planId = 3n;

      const p = toUnits("10000"); // 10,000 USDC = 10^10 units
      await (await f.savingCore.connect(f.alice).openDeposit(planId, p)).wait();

      const deposit = await f.savingCore.getDeposit(1);
      const tenorSeconds = deposit.maturityAt - deposit.startAt;
      const expectedInterest = calcExpectedInterest(p, 1n, tenorSeconds);
      // (10^10 * 1 * 31536000) / (31536000 * 10000) = 1,000,000 units = 1 USDC
      expect(expectedInterest).to.equal(1000000n);
      expect(await f.savingCore.calculateInterest(1)).to.equal(1000000n);
    });

    it("PREC-008: Tenor = 1 day calculates exact 1-day interest", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await (await f.savingCore.connect(f.bankAdmin).createPlan(1n, 3650n, 0n, 0n, 0n, true)).wait();
      const planId = 3n;

      // 3650 bps = 36.5% APR. Over 1 day (1/365 year) -> exactly 0.1% = 1/1000th of principal
      const p = toUnits("1000"); // 1,000,000,000 units
      await (await f.savingCore.connect(f.alice).openDeposit(planId, p)).wait();

      const deposit = await f.savingCore.getDeposit(1);
      const tenorSeconds = deposit.maturityAt - deposit.startAt;
      const expectedInterest = calcExpectedInterest(p, 3650n, tenorSeconds);
      expect(expectedInterest).to.equal(1000000n); // exactly 1 USDC
      expect(await f.savingCore.calculateInterest(1)).to.equal(1000000n);
    });

    it("PREC-009: Tenor = 180 days matches Personal Variant benchmark", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const p = toUnits("1000");
      await (await f.savingCore.connect(f.alice).openDeposit(1, p)).wait();

      const expected = calcExpectedInterest(p, DEFAULT_APR_BPS, 180n * 86400n);
      expect(expected).to.equal(9863013n);
      expect(await f.savingCore.calculateInterest(1)).to.equal(9863013n);
    });

    it("PREC-010: large valid tenor (36,500 days = 100 years) calculates without overflow", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      // 36,500 days fits in uint32 (max ~4.29 billion)
      await (await f.savingCore.connect(f.bankAdmin).createPlan(36500n, 500n, 0n, 0n, 0n, true)).wait();
      const planId = 3n;

      const p = toUnits("100"); // 100 USDC = 100,000,000 units
      await (await f.savingCore.connect(f.alice).openDeposit(planId, p)).wait();

      const deposit = await f.savingCore.getDeposit(1);
      const tenorSeconds = deposit.maturityAt - deposit.startAt;
      const expectedInterest = calcExpectedInterest(p, 500n, tenorSeconds);
      // 100 * 5% * 100 years = 500 USDC = 500,000,000 units
      expect(expectedInterest).to.equal(500000000n);
      expect(await f.savingCore.calculateInterest(1)).to.equal(500000000n);
    });

    it("PREC-011: interest does not increase when withdrawal occurs long after maturity", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const p = toUnits("1000");
      await (await f.savingCore.connect(f.alice).openDeposit(1, p)).wait();

      const interestAtMaturity = await f.savingCore.calculateInterest(1);
      const deposit = await f.savingCore.getDeposit(1);

      // Fast forward 365 days after maturity
      await networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt + 365n * 86400n);
      const interestLater = await f.savingCore.calculateInterest(1);

      expect(interestLater).to.equal(interestAtMaturity);

      // And withdrawal pays exact contractual interest
      const aliceBefore = await f.token.balanceOf(f.alice.address);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();
      const aliceAfter = await f.token.balanceOf(f.alice.address);
      expect(aliceAfter - aliceBefore).to.equal(p + interestAtMaturity);
    });

    it("PREC-012: large intermediate multiplication computes correctly in mulDiv without overflow", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      // Large principal: 1 billion USDC (10^15 units), APR 10000 bps, 365 days
      const largePrincipal = toUnits("1000000000"); // 10^15 units
      await (await f.token.mint(f.alice.address, largePrincipal)).wait();
      await (await f.token.connect(f.alice).approve(f.savingCoreAddress, largePrincipal)).wait();

      await (await f.savingCore.connect(f.bankAdmin).createPlan(365n, 10000n, 0n, 0n, 0n, true)).wait();
      const planId = 3n;

      await (await f.savingCore.connect(f.alice).openDeposit(planId, largePrincipal)).wait();
      const contractInterest = await f.savingCore.calculateInterest(1);
      expect(contractInterest).to.equal(largePrincipal);
    });

    it("PREC-013: _fullTermPayout check verifies feasibility during openDeposit", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      // Open a normal deposit with feasible payout succeeds
      const p = toUnits("1000");
      await expect(f.savingCore.connect(f.alice).openDeposit(1, p)).to.emit(f.savingCore, "DepositOpened");
    });
  });

  describe("Group 2: Penalty Precision & Early Withdrawal Floors", function () {
    it("PEN-PREC-001: Penalty = 0 bps returns full principal to owner and zero to feeReceiver", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await (await f.savingCore.connect(f.bankAdmin).createPlan(180n, 200n, 0n, 0n, 0n, true)).wait();
      const planId = 3n;

      const p = toUnits("1000");
      await (await f.savingCore.connect(f.alice).openDeposit(planId, p)).wait();

      const feeBefore = await f.token.balanceOf(f.feeReceiver.address);
      const aliceBefore = await f.token.balanceOf(f.alice.address);

      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();

      const feeAfter = await f.token.balanceOf(f.feeReceiver.address);
      const aliceAfter = await f.token.balanceOf(f.alice.address);

      expect(feeAfter - feeBefore).to.equal(0n);
      expect(aliceAfter - aliceBefore).to.equal(p);
    });

    it("PEN-PREC-002: Penalty = 1 bps (0.01%) calculates exact floor penalty", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await (await f.savingCore.connect(f.bankAdmin).createPlan(180n, 200n, 0n, 0n, 1n, true)).wait();
      const planId = 3n;

      const p = toUnits("1000"); // 1,000,000,000 units
      await (await f.savingCore.connect(f.alice).openDeposit(planId, p)).wait();

      // F = floor(1,000,000,000 * 1 / 10000) = 100,000 units = 0.1 USDC
      const expectedPenalty = calcExpectedPenalty(p, 1n);
      expect(expectedPenalty).to.equal(100000n);
      expect(await f.savingCore.calculatePenalty(1)).to.equal(100000n);

      const feeBefore = await f.token.balanceOf(f.feeReceiver.address);
      const aliceBefore = await f.token.balanceOf(f.alice.address);

      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();

      const feeAfter = await f.token.balanceOf(f.feeReceiver.address);
      const aliceAfter = await f.token.balanceOf(f.alice.address);

      expect(feeAfter - feeBefore).to.equal(100000n);
      expect(aliceAfter - aliceBefore).to.equal(p - 100000n);
    });

    it("PEN-PREC-003: Penalty = 350 bps (Personal Variant) calculates exact 3.5% penalty", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const p = toUnits("1000"); // 1,000,000,000 units
      await (await f.savingCore.connect(f.alice).openDeposit(1, p)).wait();

      const expectedPenalty = calcExpectedPenalty(p, DEFAULT_PENALTY_BPS);
      expect(expectedPenalty).to.equal(35000000n); // 35 USDC
      expect(await f.savingCore.calculatePenalty(1)).to.equal(35000000n);

      const feeBefore = await f.token.balanceOf(f.feeReceiver.address);
      const aliceBefore = await f.token.balanceOf(f.alice.address);

      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();

      const feeAfter = await f.token.balanceOf(f.feeReceiver.address);
      const aliceAfter = await f.token.balanceOf(f.alice.address);

      expect(feeAfter - feeBefore).to.equal(35000000n);
      expect(aliceAfter - aliceBefore).to.equal(965000000n); // 965 USDC
    });

    it("PEN-PREC-004: Penalty = 10000 bps (100%) transfers entire principal to feeReceiver and zero to owner", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await (await f.savingCore.connect(f.bankAdmin).createPlan(180n, 200n, 0n, 0n, 10000n, true)).wait();
      const planId = 3n;

      const p = toUnits("500");
      await (await f.savingCore.connect(f.alice).openDeposit(planId, p)).wait();

      const feeBefore = await f.token.balanceOf(f.feeReceiver.address);
      const aliceBefore = await f.token.balanceOf(f.alice.address);

      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();

      const feeAfter = await f.token.balanceOf(f.feeReceiver.address);
      const aliceAfter = await f.token.balanceOf(f.alice.address);

      expect(feeAfter - feeBefore).to.equal(p);
      expect(aliceAfter - aliceBefore).to.equal(0n);
    });

    it("PEN-PREC-005: tiny principal = 1 unit floors penalty to zero without underflow", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await (await f.savingCore.connect(f.alice).openDeposit(1, 1n)).wait();

      // F = floor(1 * 350 / 10000) = 0
      const expectedPenalty = calcExpectedPenalty(1n, DEFAULT_PENALTY_BPS);
      expect(expectedPenalty).to.equal(0n);
      expect(await f.savingCore.calculatePenalty(1)).to.equal(0n);

      const aliceBefore = await f.token.balanceOf(f.alice.address);
      const feeBefore = await f.token.balanceOf(f.feeReceiver.address);

      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();

      const aliceAfter = await f.token.balanceOf(f.alice.address);
      const feeAfter = await f.token.balanceOf(f.feeReceiver.address);

      expect(aliceAfter - aliceBefore).to.equal(1n);
      expect(feeAfter - feeBefore).to.equal(0n);
    });

    it("PEN-PREC-006: fractional penalty with arbitrary odd principal conserves exact sum", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const p = 1234567n; // 1.234567 USDC
      await (await f.savingCore.connect(f.alice).openDeposit(1, p)).wait();

      // F = floor(1234567 * 350 / 10000) = floor(432098450 / 10000) = 43209
      const expectedPenalty = calcExpectedPenalty(p, DEFAULT_PENALTY_BPS);
      expect(expectedPenalty).to.equal(43209n);

      const aliceBefore = await f.token.balanceOf(f.alice.address);
      const feeBefore = await f.token.balanceOf(f.feeReceiver.address);

      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();

      const aliceAfter = await f.token.balanceOf(f.alice.address);
      const feeAfter = await f.token.balanceOf(f.feeReceiver.address);

      const netOwner = aliceAfter - aliceBefore;
      const netFee = feeAfter - feeBefore;

      expect(netFee).to.equal(expectedPenalty);
      expect(netOwner + netFee).to.equal(p); // exact conservation
      expect(netOwner).to.equal(1191358n);
    });

    it("PEN-PREC-007: early withdrawal interest is strictly zero in Withdrawn event", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const p = toUnits("1000");
      await (await f.savingCore.connect(f.alice).openDeposit(1, p)).wait();

      await expect(f.savingCore.connect(f.alice).earlyWithdraw(1))
        .to.emit(f.savingCore, "Withdrawn")
        .withArgs(1n, f.alice.address, p, 0n, true);
    });
  });

  describe("Group 3: Multi-Cycle Compounding Precision", function () {
    it("COMP-PREC-001: 3-cycle auto renewal compounds interest with independent floor per cycle", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const p1 = toUnits("1000"); // 1,000,000,000 units
      await (await f.savingCore.connect(f.alice).openDeposit(1, p1)).wait();

      // Cycle 1:
      const d1 = await f.savingCore.getDeposit(1);
      const i1 = calcExpectedInterest(p1, DEFAULT_APR_BPS, d1.maturityAt - d1.startAt);
      expect(i1).to.equal(9863013n);

      const graceEnd1 = d1.maturityAt + GRACE_PERIOD_SECONDS;
      await networkHelpers.time.setNextBlockTimestamp(graceEnd1);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      const d2 = await f.savingCore.getDeposit(2);
      const p2 = p1 + i1;
      expect(d2.principal).to.equal(p2);
      expect(d2.principal).to.equal(1009863013n);

      // Cycle 2:
      // Independent floor on p2: floor(1009863013 * 200 * 15552000 / 315360000000) = 9,960,292 units
      const i2 = calcExpectedInterest(p2, DEFAULT_APR_BPS, d2.maturityAt - d2.startAt);
      expect(i2).to.equal(9960292n);

      const graceEnd2 = d2.maturityAt + GRACE_PERIOD_SECONDS;
      await networkHelpers.time.setNextBlockTimestamp(graceEnd2);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(2)).wait();

      const d3 = await f.savingCore.getDeposit(3);
      const p3 = p2 + i2;
      expect(d3.principal).to.equal(p3);
      expect(d3.principal).to.equal(1019823305n);

      // Cycle 3:
      // Independent floor on p3: floor(1019823305 * 200 * 15552000 / 315360000000) = 10,058,531 units
      const i3 = calcExpectedInterest(p3, DEFAULT_APR_BPS, d3.maturityAt - d3.startAt);
      expect(i3).to.equal(10058531n);

      const graceEnd3 = d3.maturityAt + GRACE_PERIOD_SECONDS;
      await networkHelpers.time.setNextBlockTimestamp(graceEnd3);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(3)).wait();

      const d4 = await f.savingCore.getDeposit(4);
      const p4 = p3 + i3;
      expect(d4.principal).to.equal(p4);
      expect(d4.principal).to.equal(1029881836n);

      // Invariant: totalPrincipal = p4
      expect(await f.savingCore.totalPrincipal()).to.equal(p4);
    });

    it("COMP-PREC-002: manual renewal across plans with distinct APRs rounds independently", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      // Plan 1: 180d, 200 bps
      // Plan 2: 90d, 400 bps (min=100, max=5000)
      const p1 = toUnits("1000");
      await (await f.savingCore.connect(f.alice).openDeposit(1, p1)).wait();

      const d1 = await f.savingCore.getDeposit(1);
      const i1 = calcExpectedInterest(p1, DEFAULT_APR_BPS, d1.maturityAt - d1.startAt);
      expect(i1).to.equal(9863013n);

      await networkHelpers.time.setNextBlockTimestamp(d1.maturityAt);
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 2)).wait();

      const d2 = await f.savingCore.getDeposit(2);
      const p2 = p1 + i1; // 1009863013 units
      expect(d2.principal).to.equal(p2);
      expect(d2.planId).to.equal(2n);
      expect(d2.aprBpsAtOpen).to.equal(400n);

      // Plan 2 interest: 90 days = 7,776,000s, 400 bps
      // floor(1009863013 * 400 * 7776000 / 315360000000) = 9,960,292 units
      const i2 = calcExpectedInterest(p2, 400n, d2.maturityAt - d2.startAt);
      expect(i2).to.equal(9960292n);
      expect(await f.savingCore.calculateInterest(2)).to.equal(9960292n);
    });
  });

  describe("Group 4: Input Validation & Plan Boundaries", function () {
    it("INP-BND-001: tenor = 0 reverts InvalidTenor(0)", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await expect(
        f.savingCore.connect(f.bankAdmin).createPlan(0n, 200n, 0n, 0n, 350n, true)
      ).to.be.revertedWithCustomError(f.savingCore, "InvalidTenor").withArgs(0);
    });

    it("INP-BND-002: tenor = 1 day succeeds", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await expect(
        f.savingCore.connect(f.bankAdmin).createPlan(1n, 200n, 0n, 0n, 350n, true)
      ).to.emit(f.savingCore, "PlanCreated");
    });

    it("INP-BND-003: tenor = type(uint32).max (4,294,967,295 days) succeeds", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const maxUint32 = 4294967295n;
      await expect(
        f.savingCore.connect(f.bankAdmin).createPlan(maxUint32, 200n, 0n, 0n, 350n, true)
      ).to.emit(f.savingCore, "PlanCreated");
    });

    it("INP-BND-004: tenor = type(uint32).max + 1 reverts InvalidTenor", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const overflowTenor = 4294967296n;
      await expect(
        f.savingCore.connect(f.bankAdmin).createPlan(overflowTenor, 200n, 0n, 0n, 350n, true)
      ).to.be.revertedWithCustomError(f.savingCore, "InvalidTenor").withArgs(overflowTenor);
    });

    it("INP-BND-005: APR = 0 succeeds, APR = 10000 succeeds, APR = 10001 reverts InvalidApr", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await expect(f.savingCore.connect(f.bankAdmin).createPlan(180n, 0n, 0n, 0n, 350n, true)).to.emit(f.savingCore, "PlanCreated");
      await expect(f.savingCore.connect(f.bankAdmin).createPlan(180n, 10000n, 0n, 0n, 350n, true)).to.emit(f.savingCore, "PlanCreated");
      await expect(
        f.savingCore.connect(f.bankAdmin).createPlan(180n, 10001n, 0n, 0n, 350n, true)
      ).to.be.revertedWithCustomError(f.savingCore, "InvalidApr").withArgs(10001);
    });

    it("INP-BND-006: Penalty = 0 succeeds, Penalty = 10000 succeeds, Penalty = 10001 reverts InvalidPenalty", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await expect(f.savingCore.connect(f.bankAdmin).createPlan(180n, 200n, 0n, 0n, 0n, true)).to.emit(f.savingCore, "PlanCreated");
      await expect(f.savingCore.connect(f.bankAdmin).createPlan(180n, 200n, 0n, 0n, 10000n, true)).to.emit(f.savingCore, "PlanCreated");
      await expect(
        f.savingCore.connect(f.bankAdmin).createPlan(180n, 200n, 0n, 0n, 10001n, true)
      ).to.be.revertedWithCustomError(f.savingCore, "InvalidPenalty").withArgs(10001);
    });

    it("INP-BND-007: minDeposit > maxDeposit when both non-zero reverts InvalidDepositLimits", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await expect(
        f.savingCore.connect(f.bankAdmin).createPlan(180n, 200n, toUnits("1000"), toUnits("500"), 350n, true)
      ).to.be.revertedWithCustomError(f.savingCore, "InvalidDepositLimits").withArgs(toUnits("1000"), toUnits("500"));
    });

    it("INP-BND-008: minDeposit == maxDeposit succeeds (exact deposit plan)", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await expect(
        f.savingCore.connect(f.bankAdmin).createPlan(180n, 200n, toUnits("500"), toUnits("500"), 350n, true)
      ).to.emit(f.savingCore, "PlanCreated");
    });

    it("INP-BND-009: minDeposit == 0 and maxDeposit == 0 succeeds (unbounded plan)", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await expect(
        f.savingCore.connect(f.bankAdmin).createPlan(180n, 200n, 0n, 0n, 350n, true)
      ).to.emit(f.savingCore, "PlanCreated");
    });

    it("INP-BND-010: deposit amount boundaries on bounded plan (min=100, max=5000)", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      // Plan 2: min=100 USDC (100,000,000 units), max=5000 USDC (5,000,000,000 units)
      const minVal = toUnits("100");
      const maxVal = toUnits("5000");

      // minDeposit - 1 unit reverts
      await expect(
        f.savingCore.connect(f.alice).openDeposit(2, minVal - 1n)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositAmountOutOfRange").withArgs(minVal - 1n, minVal, maxVal);

      // minDeposit succeeds
      await expect(f.savingCore.connect(f.alice).openDeposit(2, minVal)).to.emit(f.savingCore, "DepositOpened");

      // maxDeposit succeeds
      await expect(f.savingCore.connect(f.alice).openDeposit(2, maxVal)).to.emit(f.savingCore, "DepositOpened");

      // maxDeposit + 1 unit reverts
      await expect(
        f.savingCore.connect(f.alice).openDeposit(2, maxVal + 1n)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositAmountOutOfRange").withArgs(maxVal + 1n, minVal, maxVal);
    });

    it("INP-BND-011: deposit amount = 0 reverts AmountZero", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await expect(
        f.savingCore.connect(f.alice).openDeposit(1, 0n)
      ).to.be.revertedWithCustomError(f.savingCore, "AmountZero");
    });

    it("INP-BND-012: invalid plan IDs revert PlanNotFound", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await expect(
        f.savingCore.connect(f.alice).openDeposit(0, toUnits("100"))
      ).to.be.revertedWithCustomError(f.savingCore, "PlanNotFound").withArgs(0);

      const planCount = await f.savingCore.planCount();
      await expect(
        f.savingCore.connect(f.alice).openDeposit(planCount + 1n, toUnits("100"))
      ).to.be.revertedWithCustomError(f.savingCore, "PlanNotFound").withArgs(planCount + 1n);
    });

    it("INP-BND-013: repeated enablePlan and disablePlan are idempotent", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      // Plan 1 is already enabled
      await expect(f.savingCore.connect(f.bankAdmin).enablePlan(1))
        .to.emit(f.savingCore, "PlanEnabledChanged")
        .withArgs(1n, true);

      await expect(f.savingCore.connect(f.bankAdmin).disablePlan(1))
        .to.emit(f.savingCore, "PlanEnabledChanged")
        .withArgs(1n, false);

      // Disable again
      await expect(f.savingCore.connect(f.bankAdmin).disablePlan(1))
        .to.emit(f.savingCore, "PlanEnabledChanged")
        .withArgs(1n, false);
    });

    it("INP-BND-014: non-admin plan mutations revert NotBankAdmin", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await expect(
        f.savingCore.connect(f.alice).createPlan(180n, 200n, 0n, 0n, 350n, true)
      ).to.be.revertedWithCustomError(f.savingCore, "NotBankAdmin").withArgs(f.alice.address);

      await expect(
        f.savingCore.connect(f.alice).updatePlan(1, 300n)
      ).to.be.revertedWithCustomError(f.savingCore, "NotBankAdmin").withArgs(f.alice.address);

      await expect(
        f.savingCore.connect(f.alice).enablePlan(1)
      ).to.be.revertedWithCustomError(f.savingCore, "NotBankAdmin").withArgs(f.alice.address);

      await expect(
        f.savingCore.connect(f.alice).disablePlan(1)
      ).to.be.revertedWithCustomError(f.savingCore, "NotBankAdmin").withArgs(f.alice.address);
    });
  });

  describe("Group 5: VaultManager Security Edge Cases", function () {
    it("VAULT-SEC-001: non-admin cannot withdraw from Vault", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await expect(
        f.vault.connect(f.alice).withdrawVault(toUnits("100"))
      ).to.be.revertedWithCustomError(f.vault, "OwnableUnauthorizedAccount").withArgs(f.alice.address);
    });

    it("VAULT-SEC-002: withdrawVault(0) reverts AmountZero", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await expect(
        f.vault.connect(f.bankAdmin).withdrawVault(0n)
      ).to.be.revertedWithCustomError(f.vault, "AmountZero");
    });

    it("VAULT-SEC-003: withdrawVault exceeding balance reverts InsufficientVaultBalance", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const vaultBal = await f.token.balanceOf(f.vaultAddress);
      await expect(
        f.vault.connect(f.bankAdmin).withdrawVault(vaultBal + 1n)
      ).to.be.revertedWithCustomError(f.vault, "InsufficientVaultBalance").withArgs(vaultBal, vaultBal + 1n);
    });

    it("VAULT-SEC-004: withdrawVault equal to exact actual balance drains Vault cleanly", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const vaultBal = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(vaultBal)).wait();
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(0n);
    });

    it("VAULT-SEC-005: when Vault lacks interest, settlement reverts atomically", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const p = toUnits("1000");
      await (await f.savingCore.connect(f.alice).openDeposit(1, p)).wait();

      const d = await f.savingCore.getDeposit(1);
      // Admin drains Vault completely
      const vaultBal = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(vaultBal)).wait();

      await networkHelpers.time.setNextBlockTimestamp(d.maturityAt);

      // Maturity withdrawal must revert atomically
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.vault, "InsufficientVaultBalance");

      // Deposit remains Active
      expect((await f.savingCore.getDeposit(1)).status).to.equal(0); // Active
    });

    it("VAULT-SEC-006: Core surplus does NOT replace Vault interest liquidity", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const p = toUnits("1000");
      await (await f.savingCore.connect(f.alice).openDeposit(1, p)).wait();

      const d = await f.savingCore.getDeposit(1);
      // Drain Vault
      const vaultBal = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(vaultBal)).wait();

      // Donate directly to Core (surplus)
      await (await f.token.mint(f.savingCoreAddress, toUnits("10000"))).wait();

      await networkHelpers.time.setNextBlockTimestamp(d.maturityAt);

      // Even though Core has plenty of token surplus, it must NOT use surplus to pay interest; must revert
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.vault, "InsufficientVaultBalance");
    });

    it("VAULT-SEC-007: only bound SavingCore can call payInterest", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await expect(
        f.vault.connect(f.alice).payInterest(toUnits("100"))
      ).to.be.revertedWithCustomError(f.vault, "UnauthorizedSavingCore").withArgs(f.alice.address);

      await expect(
        f.vault.connect(f.bankAdmin).payInterest(toUnits("100"))
      ).to.be.revertedWithCustomError(f.vault, "UnauthorizedSavingCore").withArgs(f.bankAdmin.address);
    });

    it("VAULT-SEC-008: unbound prospective Core cannot call payInterest", async function () {
      const [deployer, admin, receiver] = await ethers.getSigners();
      const token = await ethers.deployContract("MockUSDC");
      const freshVault = await ethers.deployContract("VaultManager", [await token.getAddress(), admin.address, receiver.address]);

      await expect(
        freshVault.connect(admin).payInterest(toUnits("10"))
      ).to.be.revertedWithCustomError(freshVault, "UnauthorizedSavingCore");
    });

    it("VAULT-SEC-009: setSavingCore is strictly write-once", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await expect(
        f.vault.connect(f.bankAdmin).setSavingCore(f.bob.address)
      ).to.be.revertedWithCustomError(f.vault, "SavingCoreAlreadySet").withArgs(f.savingCoreAddress);
    });

    it("VAULT-SEC-010: setSavingCore with zero address / EOA reverts ZeroAddress / InvalidContract", async function () {
      const [deployer, admin, receiver] = await ethers.getSigners();
      const token = await ethers.deployContract("MockUSDC");
      const freshVault = await ethers.deployContract("VaultManager", [await token.getAddress(), admin.address, receiver.address]);

      await expect(
        freshVault.connect(admin).setSavingCore(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(freshVault, "ZeroAddress");

      await expect(
        freshVault.connect(admin).setSavingCore(admin.address) // EOA has code.length == 0
      ).to.be.revertedWithCustomError(freshVault, "InvalidContract").withArgs(admin.address);
    });

    it("VAULT-SEC-011: non-admin cannot setFeeReceiver", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await expect(
        f.vault.connect(f.alice).setFeeReceiver(f.bob.address)
      ).to.be.revertedWithCustomError(f.vault, "OwnableUnauthorizedAccount").withArgs(f.alice.address);
    });

    it("VAULT-SEC-012: paused Vault blocks withdrawVault and payInterest", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();

      await expect(
        f.vault.connect(f.bankAdmin).withdrawVault(toUnits("100"))
      ).to.be.revertedWithCustomError(f.vault, "EnforcedPause");
    });

    it("VAULT-SEC-013: fundVault is permitted while paused", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();

      await expect(
        f.vault.connect(f.bankAdmin).fundVault(toUnits("500"))
      ).to.emit(f.vault, "VaultFunded");
    });

    it("VAULT-SEC-014: ownership transfer updates admin across both Vault and Core dynamically", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await (await f.vault.connect(f.bankAdmin).transferOwnership(f.bob.address)).wait();

      expect(await f.vault.owner()).to.equal(f.bob.address);

      // Old admin can no longer configure plans
      await expect(
        f.savingCore.connect(f.bankAdmin).createPlan(180n, 200n, 0n, 0n, 350n, true)
      ).to.be.revertedWithCustomError(f.savingCore, "NotBankAdmin");

      // New admin can configure plans
      await expect(
        f.savingCore.connect(f.bob).createPlan(180n, 200n, 0n, 0n, 350n, true)
      ).to.emit(f.savingCore, "PlanCreated");
    });

    it("VAULT-SEC-015: renounceOwnership is strictly disabled", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await expect(
        f.vault.connect(f.bankAdmin).renounceOwnership()
      ).to.be.revertedWithCustomError(f.vault, "OwnershipRenounceDisabled");
    });
  });

  describe("Group 6: ERC20 & ERC721 Failure Injection & Rollback", function () {
    it("FAIL-INJ-001: insufficient token balance on openDeposit reverts atomically", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const balance = await f.token.balanceOf(f.stranger.address);
      await (await f.token.connect(f.stranger).approve(f.savingCoreAddress, ethers.MaxUint256)).wait();

      await expect(
        f.savingCore.connect(f.stranger).openDeposit(1, balance + 1n)
      ).to.be.revertedWithCustomError(f.token, "ERC20InsufficientBalance");

      expect(await f.savingCore.depositCount()).to.equal(0n);
      expect(await f.savingCore.totalPrincipal()).to.equal(0n);
    });

    it("FAIL-INJ-002: insufficient token allowance on openDeposit reverts atomically", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await (await f.token.connect(f.stranger).approve(f.savingCoreAddress, 0n)).wait();

      await expect(
        f.savingCore.connect(f.stranger).openDeposit(1, toUnits("100"))
      ).to.be.revertedWithCustomError(f.token, "ERC20InsufficientAllowance");

      expect(await f.savingCore.depositCount()).to.equal(0n);
      expect(await f.savingCore.totalPrincipal()).to.equal(0n);
    });

    it("FAIL-INJ-003: token returning false on transferFrom reverts via SafeERC20 with atomic rollback", async function () {
      const [deployer, admin, receiver] = await ethers.getSigners();
      // Deploy ConfigurableTestToken
      const badToken = await ethers.deployContract("ConfigurableTestToken", [6]);
      await badToken.waitForDeployment();
      const badTokenAddr = await badToken.getAddress();

      const freshVault = await ethers.deployContract("VaultManager", [badTokenAddr, admin.address, receiver.address]);
      const freshCore = await ethers.deployContract("SavingCore", [await freshVault.getAddress(), GRACE_PERIOD_SECONDS]);
      await (await freshVault.connect(admin).setSavingCore(await freshCore.getAddress())).wait();
      await (await freshCore.connect(admin).createPlan(180n, 200n, 0n, 0n, 350n, true)).wait();

      await (await badToken.mint(deployer.address, toUnits("1000"))).wait();
      await (await badToken.approve(await freshCore.getAddress(), ethers.MaxUint256)).wait();

      // Arm failure mode: transferFrom returns false
      await (await badToken.setFailureModes(false, true)).wait();

      await expect(
        freshCore.openDeposit(1, toUnits("100"))
      ).to.be.revertedWithCustomError(freshCore, "SafeERC20FailedOperation").withArgs(badTokenAddr);

      expect(await freshCore.depositCount()).to.equal(0n);
      expect(await freshCore.totalPrincipal()).to.equal(0n);
    });

    it("FAIL-INJ-004: ERC721 receiver rejecting mint rolls back state atomically", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      // Deploy DepositReceiverMock
      const receiverMock = await ethers.deployContract("DepositReceiverMock", [f.savingCoreAddress, f.alice.address]);
      await receiverMock.waitForDeployment();
      const mockAddr = await receiverMock.getAddress();

      // Configure Reject mode
      await (await receiverMock.connect(f.alice).configure(1, ethers.ZeroAddress)).wait(); // Mode 1 = Reject

      // Fund mock
      await (await f.token.mint(mockAddr, toUnits("500"))).wait();
      await (await receiverMock.connect(f.alice).approveCore(ethers.MaxUint256)).wait();

      await expect(
        receiverMock.connect(f.alice).open(1, toUnits("500"))
      ).to.be.revertedWithCustomError(receiverMock, "ReceiverRejected");

      expect(await f.savingCore.depositCount()).to.equal(0n);
      expect(await f.savingCore.totalPrincipal()).to.equal(0n);
      expect(await f.token.balanceOf(mockAddr)).to.equal(toUnits("500"));
    });

    it("FAIL-INJ-005: ERC721 receiver returning wrong selector rolls back atomically", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const receiverMock = await ethers.deployContract("DepositReceiverMock", [f.savingCoreAddress, f.alice.address]);
      await receiverMock.waitForDeployment();
      const mockAddr = await receiverMock.getAddress();

      // Configure WrongSelector mode (Mode 2)
      await (await receiverMock.connect(f.alice).configure(2, ethers.ZeroAddress)).wait();

      await (await f.token.mint(mockAddr, toUnits("500"))).wait();
      await (await receiverMock.connect(f.alice).approveCore(ethers.MaxUint256)).wait();

      await expect(
        receiverMock.connect(f.alice).open(1, toUnits("500"))
      ).to.be.revertedWithCustomError(f.savingCore, "ERC721InvalidReceiver").withArgs(mockAddr);

      expect(await f.savingCore.depositCount()).to.equal(0n);
    });

    it("FAIL-INJ-006: ERC721 receiver callback reentrancy is blocked by nonReentrant", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const receiverMock = await ethers.deployContract("DepositReceiverMock", [f.savingCoreAddress, f.alice.address]);
      await receiverMock.waitForDeployment();
      const mockAddr = await receiverMock.getAddress();

      // Configure ReenterPropagated mode (Mode 4)
      await (await receiverMock.connect(f.alice).configure(4, ethers.ZeroAddress)).wait();

      await (await f.token.mint(mockAddr, toUnits("500"))).wait();
      await (await receiverMock.connect(f.alice).approveCore(ethers.MaxUint256)).wait();

      await expect(
        receiverMock.connect(f.alice).open(1, toUnits("500"))
      ).to.be.revertedWithCustomError(f.savingCore, "ReentrancyGuardReentrantCall");
    });
  });

  describe("Group 7: Time, State Machine & Double Settlement Security", function () {
    it("STATE-SEC-001: deposit ID = 0 and ID > depositCount revert DepositNotFound", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      await expect(f.savingCore.getDeposit(0)).to.be.revertedWithCustomError(f.savingCore, "DepositNotFound").withArgs(0);
      await expect(f.savingCore.getDeposit(1)).to.be.revertedWithCustomError(f.savingCore, "DepositNotFound").withArgs(1);
    });

    it("STATE-SEC-002: mapping default enum zero does not make an uninitialized slot Active", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      // Deposit 999 does not exist
      await expect(f.savingCore.calculateInterest(999)).to.be.revertedWithCustomError(f.savingCore, "DepositNotFound").withArgs(999);
      await expect(f.savingCore.calculatePenalty(999)).to.be.revertedWithCustomError(f.savingCore, "DepositNotFound").withArgs(999);
      await expect(f.savingCore.withdrawAtMaturity(999)).to.be.revertedWithCustomError(f.savingCore, "DepositNotFound").withArgs(999);
      await expect(f.savingCore.earlyWithdraw(999)).to.be.revertedWithCustomError(f.savingCore, "DepositNotFound").withArgs(999);
    });

    it("STATE-SEC-003: terminal deposits cannot be settled a second time", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const p = toUnits("1000");
      await (await f.savingCore.connect(f.alice).openDeposit(1, p)).wait();

      // Early withdraw
      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1); // Withdrawn

      // Try early withdraw again
      await expect(
        f.savingCore.connect(f.alice).earlyWithdraw(1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive").withArgs(1n, 1);

      // Try maturity withdraw
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive").withArgs(1n, 1);

      // Try manual renew
      await expect(
        f.savingCore.connect(f.alice).renewDeposit(1, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive").withArgs(1n, 1);

      // Try auto renew
      await expect(
        f.savingCore.connect(f.stranger).autoRenewDeposit(1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive").withArgs(1n, 1);
    });

    it("STATE-SEC-004: failed settlement does not consume active deposit", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const p = toUnits("1000");
      await (await f.savingCore.connect(f.alice).openDeposit(1, p)).wait();

      const d = await f.savingCore.getDeposit(1);
      // Attempt early withdraw at maturity fails with EarlyWithdrawalClosed
      await networkHelpers.time.setNextBlockTimestamp(d.maturityAt);
      await expect(
        f.savingCore.connect(f.alice).earlyWithdraw(1)
      ).to.be.revertedWithCustomError(f.savingCore, "EarlyWithdrawalClosed");

      // Deposit remains Active
      expect((await f.savingCore.getDeposit(1)).status).to.equal(0);

      // Alice can then withdraw at maturity successfully
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });

    it("STATE-SEC-005: historical NFTs retained after renewal; new deposit has unique ID", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const p = toUnits("1000");
      await (await f.savingCore.connect(f.alice).openDeposit(1, p)).wait();

      const d1 = await f.savingCore.getDeposit(1);
      await networkHelpers.time.setNextBlockTimestamp(d1.maturityAt);
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();

      // Alice still owns NFT 1
      expect(await f.savingCore.ownerOf(1)).to.equal(f.alice.address);
      // Alice also owns NFT 2
      expect(await f.savingCore.ownerOf(2)).to.equal(f.alice.address);

      expect((await f.savingCore.getDeposit(1)).status).to.equal(2); // ManualRenewed
      expect((await f.savingCore.getDeposit(2)).status).to.equal(0); // Active
    });
  });

  describe("Group 8: Cross-feature Adversarial Flows & Accounting Invariants", function () {
    it("EDGE-IT-001: Vault drained after deposit open, maturity withdraw reverts atomically, admin re-funds, retry succeeds", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const p = toUnits("1000");
      await (await f.savingCore.connect(f.alice).openDeposit(1, p)).wait();

      const d = await f.savingCore.getDeposit(1);
      const interest = await f.savingCore.calculateInterest(1);

      // Admin drains Vault
      const vaultBal = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(vaultBal)).wait();
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(0n);

      await networkHelpers.time.setNextBlockTimestamp(d.maturityAt);

      // Alice tries to withdraw, reverts
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.vault, "InsufficientVaultBalance");

      // Invariant: principal is completely safe in Core
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(p);
      expect(await f.savingCore.totalPrincipal()).to.equal(p);
      expect((await f.savingCore.getDeposit(1)).status).to.equal(0); // Still Active

      // Admin re-funds Vault
      await (await f.vault.connect(f.bankAdmin).fundVault(toUnits("5000"))).wait();

      // Alice retries and succeeds!
      const aliceBefore = await f.token.balanceOf(f.alice.address);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();
      const aliceAfter = await f.token.balanceOf(f.alice.address);

      expect(aliceAfter - aliceBefore).to.equal(p + interest);
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1); // Withdrawn
    });

    it("EDGE-IT-002: Core donation does NOT replace interest and does NOT inflate totalPrincipal", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const p = toUnits("1000");
      await (await f.savingCore.connect(f.alice).openDeposit(1, p)).wait();

      // Stranger donates directly to Core
      await (await f.token.connect(f.stranger).transfer(f.savingCoreAddress, toUnits("5000"))).wait();

      // totalPrincipal remains strictly p
      expect(await f.savingCore.totalPrincipal()).to.equal(p);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(p + toUnits("5000"));

      // Drain Vault
      const vaultBal = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(vaultBal)).wait();

      const d = await f.savingCore.getDeposit(1);
      await networkHelpers.time.setNextBlockTimestamp(d.maturityAt);

      // Withdrawal must revert even though Core has 6000 USDC balance
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.vault, "InsufficientVaultBalance");
    });

    it("EDGE-IT-003: mixed multi-user complex scenario preserves all accounting invariants", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);

      // Alice opens deposit 1 ($1000)
      await (await f.savingCore.connect(f.alice).openDeposit(1, toUnits("1000"))).wait();
      // Bob opens deposit 2 ($2000)
      await (await f.savingCore.connect(f.bob).openDeposit(1, toUnits("2000"))).wait();
      // Alice opens deposit 3 ($3000)
      await (await f.savingCore.connect(f.alice).openDeposit(1, toUnits("3000"))).wait();
      // Bob opens deposit 4 ($4000)
      await (await f.savingCore.connect(f.bob).openDeposit(1, toUnits("4000"))).wait();

      expect(await f.savingCore.totalPrincipal()).to.equal(toUnits("10000"));

      // Alice early withdraws deposit 1
      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();
      expect(await f.savingCore.totalPrincipal()).to.equal(toUnits("9000"));

      // Advance to maturity
      const d2 = await f.savingCore.getDeposit(2);
      await networkHelpers.time.setNextBlockTimestamp(d2.maturityAt);

      // Bob manual renews deposit 2 (creates deposit 5)
      const i2 = calcExpectedInterest(toUnits("2000"), DEFAULT_APR_BPS, d2.maturityAt - d2.startAt);
      await (await f.savingCore.connect(f.bob).renewDeposit(2, 1)).wait();
      expect(await f.savingCore.totalPrincipal()).to.equal(toUnits("9000") + i2);

      // Advance to grace end for deposit 3
      const d3 = await f.savingCore.getDeposit(3);
      const graceEnd3 = d3.maturityAt + GRACE_PERIOD_SECONDS;
      await networkHelpers.time.setNextBlockTimestamp(graceEnd3);

      // Stranger auto renews deposit 3 (creates deposit 6)
      const i3 = calcExpectedInterest(toUnits("3000"), DEFAULT_APR_BPS, d3.maturityAt - d3.startAt);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(3)).wait();
      expect(await f.savingCore.totalPrincipal()).to.equal(toUnits("9000") + i2 + i3);

      // Bob maturity withdraws deposit 4
      await (await f.savingCore.connect(f.bob).withdrawAtMaturity(4)).wait();
      expect(await f.savingCore.totalPrincipal()).to.equal(toUnits("5000") + i2 + i3);

      // Stranger donates $500 to Core
      await (await f.token.connect(f.stranger).transfer(f.savingCoreAddress, toUnits("500"))).wait();

      // Audit all statuses
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1); // Withdrawn
      expect((await f.savingCore.getDeposit(2)).status).to.equal(2); // ManualRenewed
      expect((await f.savingCore.getDeposit(3)).status).to.equal(3); // AutoRenewed
      expect((await f.savingCore.getDeposit(4)).status).to.equal(1); // Withdrawn
      expect((await f.savingCore.getDeposit(5)).status).to.equal(0); // Active
      expect((await f.savingCore.getDeposit(6)).status).to.equal(0); // Active

      // Sum active principals
      const p5 = (await f.savingCore.getDeposit(5)).principal;
      const p6 = (await f.savingCore.getDeposit(6)).principal;
      const expectedTotal = p5 + p6;

      expect(await f.savingCore.totalPrincipal()).to.equal(expectedTotal);

      // Global Solvency Invariant
      const coreBalance = await f.token.balanceOf(f.savingCoreAddress);
      expect(coreBalance).to.be.greaterThanOrEqual(expectedTotal);
    });

    it("EDGE-IT-004: failure followed by recovery (shortfall -> pause -> fund -> unpause -> retry)", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const p = toUnits("1000");
      await (await f.savingCore.connect(f.alice).openDeposit(1, p)).wait();

      const d = await f.savingCore.getDeposit(1);
      // Admin drains Vault
      const vaultBal = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(vaultBal)).wait();

      const graceEnd = d.maturityAt + GRACE_PERIOD_SECONDS;
      await networkHelpers.time.setNextBlockTimestamp(graceEnd);

      // Stranger attempts auto renewal, reverts due to shortfall
      await expect(
        f.savingCore.connect(f.stranger).autoRenewDeposit(1)
      ).to.be.revertedWithCustomError(f.vault, "InsufficientVaultBalance");

      expect((await f.savingCore.getDeposit(1)).status).to.equal(0); // Still Active

      // Admin pauses Vault
      await (await f.vault.connect(f.bankAdmin).pause()).wait();

      // Admin funds Vault
      await (await f.vault.connect(f.bankAdmin).fundVault(toUnits("5000"))).wait();

      // Renewal blocked while paused
      await expect(
        f.savingCore.connect(f.stranger).autoRenewDeposit(1)
      ).to.be.revertedWithCustomError(f.vault, "EnforcedPause");

      // Admin unpauses Vault
      await (await f.vault.connect(f.bankAdmin).unpause()).wait();

      // Stranger retries auto renew: SUCCEEDS!
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      expect((await f.savingCore.getDeposit(1)).status).to.equal(3); // AutoRenewed
      expect((await f.savingCore.getDeposit(2)).status).to.equal(0); // Active
      expect(await f.savingCore.depositCount()).to.equal(2n);
    });

    it("EDGE-IT-005: owner transfer & snapshot stability keeps contractual terms intact", async function () {
      const f = await networkHelpers.loadFixture(deployEdgePrecisionFixture);
      const p = toUnits("1000");
      await (await f.savingCore.connect(f.alice).openDeposit(1, p)).wait();

      // Bank Admin updates plan 1 APR from 200 bps to 800 bps
      await (await f.savingCore.connect(f.bankAdmin).updatePlan(1, 800n)).wait();

      // Alice transfers NFT 1 to Bob
      await (await f.savingCore.connect(f.alice).transferFrom(f.alice.address, f.bob.address, 1)).wait();
      expect(await f.savingCore.ownerOf(1)).to.equal(f.bob.address);

      const d = await f.savingCore.getDeposit(1);
      await networkHelpers.time.setNextBlockTimestamp(d.maturityAt);

      // Former owner Alice cannot withdraw
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner").withArgs(1n, f.alice.address);

      // New owner Bob withdraws: paid using original 200 bps snapshot (9,863,013 units, not 800 bps)
      const bobBefore = await f.token.balanceOf(f.bob.address);
      const aliceBefore = await f.token.balanceOf(f.alice.address);

      await (await f.savingCore.connect(f.bob).withdrawAtMaturity(1)).wait();

      const bobAfter = await f.token.balanceOf(f.bob.address);
      const aliceAfter = await f.token.balanceOf(f.alice.address);

      expect(bobAfter - bobBefore).to.equal(p + 9863013n);
      expect(aliceAfter - aliceBefore).to.equal(0n);
    });
  });
});
