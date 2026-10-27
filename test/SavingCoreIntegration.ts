import { expect } from "chai";
import type { ContractTransactionResponse } from "ethers";
import { network } from "hardhat";
import { personalVariant } from "../config/personal-variant.js";

const connection = await network.create("hardhatMainnet");
const { ethers, networkHelpers } = connection;
const depositSecurityConnection = await network.create({
  network: "hardhatMainnet",
  override: { throwOnTransactionFailures: false },
});

const GRACE_PERIOD_SECONDS = BigInt(personalVariant.gracePeriodDays * 86400); // 172800n
const DEFAULT_TENOR_DAYS = BigInt(personalVariant.defaultTenorDays); // 180n
const DEFAULT_APR_BPS = BigInt(personalVariant.defaultAprBps); // 200n
const DEFAULT_PENALTY_BPS = BigInt(personalVariant.earlyWithdrawPenaltyBps); // 350n

const toUnits = (amount: string): bigint => ethers.parseUnits(amount, 6);

async function deployIntegrationFixture() {
  const [operator, bankAdmin, alice, bob, feeReceiver, stranger] = await ethers.getSigners();

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

  // Create default plan (Plan ID 1) with personalVariant parameters
  await (await savingCore.connect(bankAdmin).createPlan(
    DEFAULT_TENOR_DAYS,
    DEFAULT_APR_BPS,
    0n,
    0n,
    DEFAULT_PENALTY_BPS,
    true
  )).wait();

  // Mint tokens to users and bank admin
  await (await token.mint(alice.address, toUnits("10000"))).wait();
  await (await token.mint(bob.address, toUnits("10000"))).wait();
  await (await token.mint(bankAdmin.address, toUnits("50000"))).wait();

  // Approvals
  await (await token.connect(alice).approve(savingCoreAddress, ethers.MaxUint256)).wait();
  await (await token.connect(bob).approve(savingCoreAddress, ethers.MaxUint256)).wait();
  await (await token.connect(bankAdmin).approve(vaultAddress, ethers.MaxUint256)).wait();

  // Fund Vault with initial interest reserve
  await (await vault.connect(bankAdmin).fundVault(toUnits("1000"))).wait();

  return {
    operator,
    bankAdmin,
    alice,
    bob,
    feeReceiver,
    stranger,
    token,
    tokenAddress,
    vault,
    vaultAddress,
    savingCore,
    savingCoreAddress,
  };
}

describe("SavingCore - Task D2-04: Comprehensive Integration & Verification", function () {
  describe("Group A: Cross-Feature Integration Scenarios", function () {
    it("IT-001: Full Happy Path (Plan -> Open Deposit -> Fund Vault -> Maturity Withdrawal)", async function () {
      const f = await networkHelpers.loadFixture(deployIntegrationFixture);
      const principal = toUnits("1000"); // 1,000,000,000 units (Personal Variant)

      const aliceInitial = await f.token.balanceOf(f.alice.address);
      const coreInitial = await f.token.balanceOf(f.savingCoreAddress);
      const vaultInitial = await f.token.balanceOf(f.vaultAddress);

      // 1. Open deposit
      const openTx = await f.savingCore.connect(f.alice).openDeposit(1, principal);
      const openReceipt = await openTx.wait();
      const depositId = 1n;

      const deposit = await f.savingCore.getDeposit(depositId);
      expect(deposit.planId).to.equal(1n);
      expect(deposit.principal).to.equal(principal);
      expect(deposit.status).to.equal(0); // Active
      expect(deposit.aprBpsAtOpen).to.equal(DEFAULT_APR_BPS);
      expect(deposit.penaltyBpsAtOpen).to.equal(DEFAULT_PENALTY_BPS);
      expect(await f.savingCore.ownerOf(depositId)).to.equal(f.alice.address);
      expect(await f.savingCore.totalPrincipal()).to.equal(principal);

      // Verify token movements after open
      expect(await f.token.balanceOf(f.alice.address)).to.equal(aliceInitial - principal);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(coreInitial + principal);
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(vaultInitial); // Vault untouched!

      // 2. Expected interest at maturity:
      // I = floor(1_000_000_000 * 200 * 15552000 / (31536000 * 10000)) = 9,863,013
      const expectedInterest = 9863013n;
      expect(await f.savingCore.calculateInterest(depositId)).to.equal(expectedInterest);

      // 3. Fast-forward to maturityAt
      await networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt);

      // 4. Withdraw at maturity
      const withdrawTx = await f.savingCore.connect(f.alice).withdrawAtMaturity(depositId);
      const withdrawReceipt = await withdrawTx.wait();

      // Assert event emitted
      await expect(withdrawTx)
        .to.emit(f.savingCore, "Withdrawn")
        .withArgs(depositId, f.alice.address, principal, expectedInterest, false);

      // Assert final state & balances
      const depositAfter = await f.savingCore.getDeposit(depositId);
      expect(depositAfter.status).to.equal(1); // Withdrawn
      expect(await f.savingCore.ownerOf(depositId)).to.equal(f.alice.address); // NFT retained!
      expect(await f.savingCore.totalPrincipal()).to.equal(0n); // liability cleared

      expect(await f.token.balanceOf(f.alice.address)).to.equal(aliceInitial + expectedInterest);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(coreInitial);
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(vaultInitial - expectedInterest);
    });

    it("IT-002: Full Early Withdrawal Path (Open -> Early Withdrawal -> Net Payout + Fee -> Vault untouched)", async function () {
      const f = await networkHelpers.loadFixture(deployIntegrationFixture);
      const principal = toUnits("1000"); // 1,000,000,000 units

      const aliceInitial = await f.token.balanceOf(f.alice.address);
      const feeInitial = await f.token.balanceOf(f.feeReceiver.address);
      const vaultInitial = await f.token.balanceOf(f.vaultAddress);

      await (await f.savingCore.connect(f.alice).openDeposit(1, principal)).wait();
      const depositId = 1n;

      // Expected penalty:
      // F = floor(1_000_000_000 * 350 / 10000) = 35,000,000 units
      // Net payout = 1_000_000_000 - 35,000,000 = 965,000,000 units
      const expectedPenalty = 35000000n;
      const expectedNetPayout = 965000000n;
      expect(await f.savingCore.calculatePenalty(depositId)).to.equal(expectedPenalty);

      // Early withdraw before maturity
      const withdrawTx = await f.savingCore.connect(f.alice).earlyWithdraw(depositId);
      await expect(withdrawTx)
        .to.emit(f.savingCore, "Withdrawn")
        .withArgs(depositId, f.alice.address, principal, 0n, true);

      // Assert state & balances
      expect((await f.savingCore.getDeposit(depositId)).status).to.equal(1); // Withdrawn
      expect(await f.savingCore.ownerOf(depositId)).to.equal(f.alice.address); // NFT retained
      expect(await f.savingCore.totalPrincipal()).to.equal(0n); // Liability cleared

      expect(await f.token.balanceOf(f.alice.address)).to.equal(aliceInitial - principal + expectedNetPayout);
      expect(await f.token.balanceOf(f.feeReceiver.address)).to.equal(feeInitial + expectedPenalty);
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(vaultInitial); // Vault 100% untouched
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(0n);
    });

    it("IT-003: APR Snapshot Integrity across Plan Updates", async function () {
      const f = await networkHelpers.loadFixture(deployIntegrationFixture);
      const principal = toUnits("1000");

      // 1. Alice opens Deposit 1 under Plan 1 (APR = 200 bps)
      await (await f.savingCore.connect(f.alice).openDeposit(1, principal)).wait();
      const deposit1 = await f.savingCore.getDeposit(1);
      expect(deposit1.aprBpsAtOpen).to.equal(200);

      // 2. Admin updates Plan 1 APR to 500 bps (5.00%)
      await (await f.savingCore.connect(f.bankAdmin).updatePlan(1, 500)).wait();
      expect((await f.savingCore.getPlan(1)).aprBps).to.equal(500);

      // 3. Bob opens Deposit 2 under Plan 1 (now with APR = 500 bps)
      await (await f.savingCore.connect(f.bob).openDeposit(1, principal)).wait();
      const deposit2 = await f.savingCore.getDeposit(2);
      expect(deposit2.aprBpsAtOpen).to.equal(500);

      // 4. Verify interest calculations:
      // Deposit 1: 1_000_000_000 * 200 * 180 / (365 * 10000) = 9,863,013
      // Deposit 2: 1_000_000_000 * 500 * 180 / (365 * 10000) = 24,657,534
      const interest1 = await f.savingCore.calculateInterest(1);
      const interest2 = await f.savingCore.calculateInterest(2);
      expect(interest1).to.equal(9863013n);
      expect(interest2).to.equal(24657534n);

      // 5. Fast forward and settle Deposit 1 at maturity
      await networkHelpers.time.setNextBlockTimestamp(deposit1.maturityAt);
      const aliceBalBefore = await f.token.balanceOf(f.alice.address);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();
      expect(await f.token.balanceOf(f.alice.address)).to.equal(aliceBalBefore + principal + interest1);

      // 6. Fast forward and settle Deposit 2 at maturity
      await networkHelpers.time.setNextBlockTimestamp(deposit2.maturityAt);
      const bobBalBefore = await f.token.balanceOf(f.bob.address);
      await (await f.savingCore.connect(f.bob).withdrawAtMaturity(2)).wait();
      expect(await f.token.balanceOf(f.bob.address)).to.equal(bobBalBefore + principal + interest2);
    });

    it("IT-004: NFT Transfer Before Settlement (Alice -> Bob; Alice blocked, Bob settles)", async function () {
      const f = await networkHelpers.loadFixture(deployIntegrationFixture);
      const principal = toUnits("1000");

      await (await f.savingCore.connect(f.alice).openDeposit(1, principal)).wait();
      const depositId = 1n;

      // Alice transfers NFT to Bob via standard ERC721
      await (await f.savingCore.connect(f.alice).transferFrom(f.alice.address, f.bob.address, depositId)).wait();
      expect(await f.savingCore.ownerOf(depositId)).to.equal(f.bob.address);

      const deposit = await f.savingCore.getDeposit(depositId);
      await networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt);

      // Alice tries to withdraw -> REVERT NotDepositOwner
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(depositId)
      ).to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner").withArgs(depositId, f.alice.address);

      // Bob withdraws -> SUCCESS
      const bobBefore = await f.token.balanceOf(f.bob.address);
      const interest = await f.savingCore.calculateInterest(depositId);
      await (await f.savingCore.connect(f.bob).withdrawAtMaturity(depositId)).wait();

      expect(await f.token.balanceOf(f.bob.address)).to.equal(bobBefore + principal + interest);
      expect((await f.savingCore.getDeposit(depositId)).status).to.equal(1);
      expect(await f.savingCore.ownerOf(depositId)).to.equal(f.bob.address); // Bob retains historical NFT
    });

    it("IT-005: Multiple Active Deposits & Ledger Invariants", async function () {
      const f = await networkHelpers.loadFixture(deployIntegrationFixture);
      const p1 = toUnits("500");
      const p2 = toUnits("1000");
      const p3 = toUnits("1500");

      await (await f.savingCore.connect(f.alice).openDeposit(1, p1)).wait(); // Deposit 1
      await (await f.savingCore.connect(f.bob).openDeposit(1, p2)).wait();   // Deposit 2
      await (await f.savingCore.connect(f.alice).openDeposit(1, p3)).wait(); // Deposit 3

      expect(await f.savingCore.depositCount()).to.equal(3n);
      expect(await f.savingCore.totalPrincipal()).to.equal(p1 + p2 + p3);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(p1 + p2 + p3);

      // Settle Deposit 2 early
      await (await f.savingCore.connect(f.bob).earlyWithdraw(2)).wait();

      // Verify Deposit 1 and 3 remain Active
      expect((await f.savingCore.getDeposit(1)).status).to.equal(0); // Active
      expect((await f.savingCore.getDeposit(2)).status).to.equal(1); // Withdrawn
      expect((await f.savingCore.getDeposit(3)).status).to.equal(0); // Active

      // Verify totalPrincipal equals sum of Active deposits (p1 + p3)
      expect(await f.savingCore.totalPrincipal()).to.equal(p1 + p3);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.be.greaterThanOrEqual(await f.savingCore.totalPrincipal());
    });

    it("IT-006: Pause & Recovery Flow (Vault paused blocks outflows, unpause restores)", async function () {
      const f = await networkHelpers.loadFixture(deployIntegrationFixture);
      const principal = toUnits("1000");

      await (await f.savingCore.connect(f.alice).openDeposit(1, principal)).wait();
      const deposit = await f.savingCore.getDeposit(1);

      // Admin pauses VaultManager
      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      expect(await f.vault.paused()).to.equal(true);

      // Early withdrawal blocked
      await expect(
        f.savingCore.connect(f.alice).earlyWithdraw(1)
      ).to.be.revertedWithCustomError(f.savingCore, "EnforcedPause");

      // Advance to maturity: maturity withdrawal also blocked
      await networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt);
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.savingCore, "EnforcedPause");

      // Plan management and funding remain permitted while paused
      await (await f.savingCore.connect(f.bankAdmin).createPlan(90, 150, 0n, 0n, 200, true)).wait();
      await (await f.vault.connect(f.bankAdmin).fundVault(toUnits("100"))).wait();

      // Admin unpauses VaultManager
      await (await f.vault.connect(f.bankAdmin).unpause()).wait();
      expect(await f.vault.paused()).to.equal(false);

      // User retries withdrawal and succeeds
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });

    it("IT-007: Failure Rollback & Retry (Vault short by 1 unit -> revert -> fund -> retry succeeds)", async function () {
      const f = await networkHelpers.loadFixture(deployIntegrationFixture);
      const principal = toUnits("1000");

      await (await f.savingCore.connect(f.alice).openDeposit(1, principal)).wait();
      const deposit = await f.savingCore.getDeposit(1);
      const interest = await f.savingCore.calculateInterest(1); // 9,863,013

      // Drain Vault completely, then fund with interest - 1 unit
      const vaultBal = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(vaultBal)).wait();
      await (await f.vault.connect(f.bankAdmin).fundVault(interest - 1n)).wait();
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(interest - 1n);

      await networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt);

      // Payout fails with InsufficientVaultBalance
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.vault, "InsufficientVaultBalance").withArgs(interest - 1n, interest);

      // Verify complete rollback: status still Active, totalPrincipal untouched
      expect((await f.savingCore.getDeposit(1)).status).to.equal(0);
      expect(await f.savingCore.totalPrincipal()).to.equal(principal);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(principal);

      // Admin funds the remaining 1 unit
      await (await f.vault.connect(f.bankAdmin).fundVault(1n)).wait();
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(interest);

      // Alice retries and succeeds
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
      expect(await f.savingCore.totalPrincipal()).to.equal(0n);
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(0n);
    });

    it("IT-008: Snapshot & Plan Disable (Disable plan rejects new deposits, preserves existing settlement)", async function () {
      const f = await networkHelpers.loadFixture(deployIntegrationFixture);
      const principal = toUnits("1000");

      // Alice opens deposit under Plan 1
      await (await f.savingCore.connect(f.alice).openDeposit(1, principal)).wait();

      // Admin updates APR to 999 and disables Plan 1
      await (await f.savingCore.connect(f.bankAdmin).updatePlan(1, 999)).wait();
      await (await f.savingCore.connect(f.bankAdmin).disablePlan(1)).wait();
      expect((await f.savingCore.getPlan(1)).enabled).to.equal(false);

      // Bob tries to open deposit under disabled plan -> REVERT PlanDisabled
      await expect(
        f.savingCore.connect(f.bob).openDeposit(1, principal)
      ).to.be.revertedWithCustomError(f.savingCore, "PlanDisabled").withArgs(1n);

      // Alice's existing deposit still uses snapshot 200 bps
      const deposit = await f.savingCore.getDeposit(1);
      expect(deposit.aprBpsAtOpen).to.equal(200);
      expect(await f.savingCore.calculateInterest(1)).to.equal(9863013n);

      // Alice can withdraw at maturity without issues
      await networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });
  });

  describe("Group B: Exact Time Boundary Verification", function () {
    it("TIME-001: At maturityAt - 1 second, earlyWithdraw SUCCEEDS and withdrawAtMaturity REVERTS", async function () {
      const f = await networkHelpers.loadFixture(deployIntegrationFixture);
      await (await f.savingCore.connect(f.alice).openDeposit(1, toUnits("100"))).wait();
      const deposit = await f.savingCore.getDeposit(1);

      // 1. Check at maturityAt - 1 second:
      await networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt - 1n);

      // withdrawAtMaturity must revert with DepositNotMatured
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotMatured").withArgs(1, deposit.maturityAt);

      // earlyWithdraw must succeed
      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });

    it("TIME-002: At exact maturityAt, withdrawAtMaturity SUCCEEDS and earlyWithdraw REVERTS", async function () {
      const f = await networkHelpers.loadFixture(deployIntegrationFixture);
      await (await f.savingCore.connect(f.alice).openDeposit(1, toUnits("100"))).wait();
      const deposit = await f.savingCore.getDeposit(1);

      // 2. Check at exact maturityAt:
      await networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt);

      // earlyWithdraw must revert with EarlyWithdrawalClosed
      await expect(
        f.savingCore.connect(f.alice).earlyWithdraw(1)
      ).to.be.revertedWithCustomError(f.savingCore, "EarlyWithdrawalClosed").withArgs(1, deposit.maturityAt);

      // withdrawAtMaturity must succeed
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });

    it("TIME-003: At maturityAt + 1 second, withdrawAtMaturity SUCCEEDS and earlyWithdraw REVERTS", async function () {
      const f = await networkHelpers.loadFixture(deployIntegrationFixture);
      await (await f.savingCore.connect(f.alice).openDeposit(1, toUnits("100"))).wait();
      const deposit = await f.savingCore.getDeposit(1);

      // 3. Check at maturityAt + 1 second:
      await networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt + 1n);

      // earlyWithdraw must revert with EarlyWithdrawalClosed
      await expect(
        f.savingCore.connect(f.alice).earlyWithdraw(1)
      ).to.be.revertedWithCustomError(f.savingCore, "EarlyWithdrawalClosed").withArgs(1, deposit.maturityAt);

      // withdrawAtMaturity must succeed
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });
  });

  describe("Group C: Mathematical Precision & Personal Variant Boundaries", function () {
    it("BND-001: Personal Variant 1000 MockUSDC yields exact floor interest and penalty", async function () {
      const f = await networkHelpers.loadFixture(deployIntegrationFixture);
      const principal = 1000000000n; // 1,000,000,000 smallest units = 1000 MockUSDC

      await (await f.savingCore.connect(f.alice).openDeposit(1, principal)).wait();

      // Theoretical formulas:
      // I = floor(1_000_000_000 * 200 * 15552000 / (31536000 * 10000)) = 9,863,013
      // F = floor(1_000_000_000 * 350 / 10000) = 35,000,000
      const interest = await f.savingCore.calculateInterest(1);
      const penalty = await f.savingCore.calculatePenalty(1);

      expect(interest).to.equal(9863013n);
      expect(penalty).to.equal(35000000n);

      // Payout expectations
      const maturityPayout = principal + interest; // 1,009,863,013 units = 1009.863013 MockUSDC
      const earlyNetPayout = principal - penalty;   // 965,000,000 units = 965.0 MockUSDC

      expect(maturityPayout).to.equal(1009863013n);
      expect(earlyNetPayout).to.equal(965000000n);
    });

    it("BND-002: Boundary APRs: 0 bps and 10000 bps (100% APR)", async function () {
      const f = await networkHelpers.loadFixture(deployIntegrationFixture);
      const principal = toUnits("100");

      // Plan with APR = 0
      const planZeroApr = await f.savingCore.connect(f.bankAdmin).createPlan.staticCall(180, 0, 0n, 0n, 350, true);
      await (await f.savingCore.connect(f.bankAdmin).createPlan(180, 0, 0n, 0n, 350, true)).wait();
      await (await f.savingCore.connect(f.alice).openDeposit(planZeroApr, principal)).wait();
      expect(await f.savingCore.calculateInterest(1)).to.equal(0n);

      // Plan with APR = 10000 (100% APR, 365 days)
      const planFullApr = await f.savingCore.connect(f.bankAdmin).createPlan.staticCall(365, 10000, 0n, 0n, 350, true);
      await (await f.savingCore.connect(f.bankAdmin).createPlan(365, 10000, 0n, 0n, 350, true)).wait();
      await (await f.savingCore.connect(f.alice).openDeposit(planFullApr, principal)).wait();
      expect(await f.savingCore.calculateInterest(2)).to.equal(principal);
    });

    it("BND-003: Boundary Penalties: 0 bps and 10000 bps (100% penalty)", async function () {
      const f = await networkHelpers.loadFixture(deployIntegrationFixture);
      const principal = toUnits("100");

      // Penalty = 0
      const planZeroPen = await f.savingCore.connect(f.bankAdmin).createPlan.staticCall(180, 200, 0n, 0n, 0, true);
      await (await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 0n, 0n, 0, true)).wait();
      await (await f.savingCore.connect(f.alice).openDeposit(planZeroPen, principal)).wait();
      expect(await f.savingCore.calculatePenalty(1)).to.equal(0n);

      // Penalty = 10000
      const planFullPen = await f.savingCore.connect(f.bankAdmin).createPlan.staticCall(180, 200, 0n, 0n, 10000, true);
      await (await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 0n, 0n, 10000, true)).wait();
      await (await f.savingCore.connect(f.alice).openDeposit(planFullPen, principal)).wait();
      expect(await f.savingCore.calculatePenalty(2)).to.equal(principal);
    });

    it("BND-004: 1 unit principal creates valid deposit with 0 floored interest", async function () {
      const f = await networkHelpers.loadFixture(deployIntegrationFixture);
      await (await f.savingCore.connect(f.alice).openDeposit(1, 1n)).wait();

      expect((await f.savingCore.getDeposit(1)).principal).to.equal(1n);
      expect(await f.savingCore.calculateInterest(1)).to.equal(0n);
      expect(await f.savingCore.calculatePenalty(1)).to.equal(0n);
      expect(await f.savingCore.totalPrincipal()).to.equal(1n);
    });
  });

  describe("Group D: Financial Accounting Invariants & Audit Evidence", function () {
    it("ACC-001: Open Deposit Financial Evidence & Invariant Assertion", async function () {
      const f = await networkHelpers.loadFixture(deployIntegrationFixture);
      const P = toUnits("500");

      const aliceBefore = await f.token.balanceOf(f.alice.address);
      const coreBefore = await f.token.balanceOf(f.savingCoreAddress);
      const vaultBefore = await f.token.balanceOf(f.vaultAddress);
      const totalPBefore = await f.savingCore.totalPrincipal();

      const tx = await f.savingCore.connect(f.alice).openDeposit(1, P);
      const receipt = await tx.wait();

      const aliceAfter = await f.token.balanceOf(f.alice.address);
      const coreAfter = await f.token.balanceOf(f.savingCoreAddress);
      const vaultAfter = await f.token.balanceOf(f.vaultAddress);
      const totalPAfter = await f.savingCore.totalPrincipal();

      console.log(`      OPEN_DEPOSIT_ACCOUNTING | P=${P} | alice=${aliceBefore}->${aliceAfter} | core=${coreBefore}->${coreAfter} | vault=${vaultBefore}->${vaultAfter} | totalPrincipal=${totalPBefore}->${totalPAfter} | txHash=${receipt!.hash}`);

      expect(aliceAfter).to.equal(aliceBefore - P);
      expect(coreAfter).to.equal(coreBefore + P);
      expect(vaultAfter).to.equal(vaultBefore);
      expect(totalPAfter).to.equal(totalPBefore + P);

      // Global invariant
      expect(coreAfter).to.be.greaterThanOrEqual(totalPAfter);
    });

    it("ACC-002: Maturity Withdrawal Financial Evidence & Invariant Assertion", async function () {
      const f = await networkHelpers.loadFixture(deployIntegrationFixture);
      const P = toUnits("500");
      await (await f.savingCore.connect(f.alice).openDeposit(1, P)).wait();
      const deposit = await f.savingCore.getDeposit(1);
      const I = await f.savingCore.calculateInterest(1);

      const aliceBefore = await f.token.balanceOf(f.alice.address);
      const coreBefore = await f.token.balanceOf(f.savingCoreAddress);
      const vaultBefore = await f.token.balanceOf(f.vaultAddress);
      const totalPBefore = await f.savingCore.totalPrincipal();

      await networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt);
      const tx = await f.savingCore.connect(f.alice).withdrawAtMaturity(1);
      const receipt = await tx.wait();

      const aliceAfter = await f.token.balanceOf(f.alice.address);
      const coreAfter = await f.token.balanceOf(f.savingCoreAddress);
      const vaultAfter = await f.token.balanceOf(f.vaultAddress);
      const totalPAfter = await f.savingCore.totalPrincipal();

      console.log(`      MATURITY_WITHDRAW_ACCOUNTING | P=${P} | I=${I} | alice=${aliceBefore}->${aliceAfter} | core=${coreBefore}->${coreAfter} | vault=${vaultBefore}->${vaultAfter} | totalPrincipal=${totalPBefore}->${totalPAfter} | txHash=${receipt!.hash}`);

      expect(aliceAfter).to.equal(aliceBefore + P + I);
      expect(coreAfter).to.equal(coreBefore - P);
      expect(vaultAfter).to.equal(vaultBefore - I);
      expect(totalPAfter).to.equal(totalPBefore - P);

      // Global invariant
      expect(coreAfter).to.be.greaterThanOrEqual(totalPAfter);
    });

    it("ACC-003: Early Withdrawal Financial Evidence & Invariant Assertion", async function () {
      const f = await networkHelpers.loadFixture(deployIntegrationFixture);
      const P = toUnits("500");
      await (await f.savingCore.connect(f.alice).openDeposit(1, P)).wait();
      const F = await f.savingCore.calculatePenalty(1);
      const netPayout = P - F;

      const aliceBefore = await f.token.balanceOf(f.alice.address);
      const coreBefore = await f.token.balanceOf(f.savingCoreAddress);
      const vaultBefore = await f.token.balanceOf(f.vaultAddress);
      const feeBefore = await f.token.balanceOf(f.feeReceiver.address);
      const totalPBefore = await f.savingCore.totalPrincipal();

      const tx = await f.savingCore.connect(f.alice).earlyWithdraw(1);
      const receipt = await tx.wait();

      const aliceAfter = await f.token.balanceOf(f.alice.address);
      const coreAfter = await f.token.balanceOf(f.savingCoreAddress);
      const vaultAfter = await f.token.balanceOf(f.vaultAddress);
      const feeAfter = await f.token.balanceOf(f.feeReceiver.address);
      const totalPAfter = await f.savingCore.totalPrincipal();

      console.log(`      EARLY_WITHDRAW_ACCOUNTING | P=${P} | F=${F} | alice=${aliceBefore}->${aliceAfter} | core=${coreBefore}->${coreAfter} | vault=${vaultBefore}->${vaultAfter} | feeReceiver=${feeBefore}->${feeAfter} | totalPrincipal=${totalPBefore}->${totalPAfter} | txHash=${receipt!.hash}`);

      expect(aliceAfter).to.equal(aliceBefore + netPayout);
      expect(feeAfter).to.equal(feeBefore + F);
      expect(coreAfter).to.equal(coreBefore - P);
      expect(vaultAfter).to.equal(vaultBefore);
      expect(totalPAfter).to.equal(totalPBefore - P);

      // Global invariant
      expect(coreAfter).to.be.greaterThanOrEqual(totalPAfter);
    });

    it("ACC-004: Failed Liquidity Revert Financial Evidence & Invariant Assertion", async function () {
      const f = await networkHelpers.loadFixture(deployIntegrationFixture);
      const P = toUnits("500");
      await (await f.savingCore.connect(f.alice).openDeposit(1, P)).wait();
      const deposit = await f.savingCore.getDeposit(1);
      const I = await f.savingCore.calculateInterest(1);

      // Drain Vault to cause shortfall
      const vaultBal = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(vaultBal)).wait();

      const aliceBefore = await f.token.balanceOf(f.alice.address);
      const coreBefore = await f.token.balanceOf(f.savingCoreAddress);
      const vaultBefore = await f.token.balanceOf(f.vaultAddress);
      const totalPBefore = await f.savingCore.totalPrincipal();

      await networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt);
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.vault, "InsufficientVaultBalance").withArgs(0n, I);

      const aliceAfter = await f.token.balanceOf(f.alice.address);
      const coreAfter = await f.token.balanceOf(f.savingCoreAddress);
      const vaultAfter = await f.token.balanceOf(f.vaultAddress);
      const totalPAfter = await f.savingCore.totalPrincipal();

      console.log(`      FAILED_MATURITY_ACCOUNTING | P=${P} | I=${I} | alice=${aliceBefore}->${aliceAfter} | core=${coreBefore}->${coreAfter} | vault=${vaultBefore}->${vaultAfter} | totalPrincipal=${totalPBefore}->${totalPAfter} | status=0->0 | REVERT_CONFIRMED`);

      expect(aliceAfter).to.equal(aliceBefore);
      expect(coreAfter).to.equal(coreBefore);
      expect(vaultAfter).to.equal(vaultBefore);
      expect(totalPAfter).to.equal(totalPBefore);
      expect((await f.savingCore.getDeposit(1)).status).to.equal(0); // remains Active

      // Global invariant
      expect(coreAfter).to.be.greaterThanOrEqual(totalPAfter);
    });
  });
});
