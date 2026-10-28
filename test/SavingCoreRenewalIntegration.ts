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

function calcInterest(principal: bigint, aprBps: bigint, tenorSeconds: bigint): bigint {
  return (principal * aprBps * tenorSeconds) / (365n * 86400n * 10000n);
}

function calcPenalty(principal: bigint, penaltyBps: bigint): bigint {
  return (principal * penaltyBps) / 10000n;
}

async function deployRenewalIntegrationFixture() {
  const [operator, bankAdmin, alice, bob, feeReceiver, stranger, charlie] = await ethers.getSigners();

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

  // Plan 1: Default (180 days, 200 bps, min=0, max=0, penalty=350 bps, enabled=true)
  await (await savingCore.connect(bankAdmin).createPlan(
    DEFAULT_TENOR_DAYS,
    DEFAULT_APR_BPS,
    0n,
    0n,
    DEFAULT_PENALTY_BPS,
    true
  )).wait();

  // Plan 2: Target plan with specific limits (90 days, 400 bps, min=500 USDC, max=5000 USDC, penalty=500 bps, enabled=true)
  await (await savingCore.connect(bankAdmin).createPlan(
    90n,
    400n,
    toUnits("500"),
    toUnits("5000"),
    500n,
    true
  )).wait();

  // Plan 3: Disabled target plan (60 days, 300 bps, min=0, max=0, penalty=200 bps, enabled=false)
  await (await savingCore.connect(bankAdmin).createPlan(
    60n,
    300n,
    0n,
    0n,
    200n,
    false
  )).wait();

  // Mint tokens to users and bank admin
  await (await token.mint(alice.address, toUnits("50000"))).wait();
  await (await token.mint(bob.address, toUnits("50000"))).wait();
  await (await token.mint(charlie.address, toUnits("50000"))).wait();
  await (await token.mint(bankAdmin.address, toUnits("100000"))).wait();

  // Approvals
  await (await token.connect(alice).approve(savingCoreAddress, ethers.MaxUint256)).wait();
  await (await token.connect(bob).approve(savingCoreAddress, ethers.MaxUint256)).wait();
  await (await token.connect(charlie).approve(savingCoreAddress, ethers.MaxUint256)).wait();
  await (await token.connect(bankAdmin).approve(vaultAddress, ethers.MaxUint256)).wait();

  // Fund Vault with substantial interest reserve (10,000 USDC)
  await (await vault.connect(bankAdmin).fundVault(toUnits("10000"))).wait();

  return {
    operator,
    bankAdmin,
    alice,
    bob,
    feeReceiver,
    stranger,
    charlie,
    token,
    tokenAddress,
    vault,
    vaultAddress,
    savingCore,
    savingCoreAddress,
  };
}

async function maturedRenewalFixture() {
  const f = await deployRenewalIntegrationFixture();
  const principal = toUnits("1000"); // 1,000,000,000 units
  await (await f.savingCore.connect(f.alice).openDeposit(1, principal)).wait();
  const deposit = await f.savingCore.getDeposit(1);
  const graceEnd = deposit.maturityAt + GRACE_PERIOD_SECONDS;
  return { ...f, depositId: 1n, principal, deposit, graceEnd };
}

describe("Task D3-04: Renewal Integration & Boundary Testing", function () {
  // =========================================================================
  // GROUP 1: EXACT RENEWAL & MATURITY TIME BOUNDARIES
  // =========================================================================
  describe("Group 1: Exact Renewal & Maturity Time Boundaries", function () {
    it("BND-R01: manual renew at maturityAt - 1 second reverts with DepositNotMatured", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt - 1n);

      await expect(
        f.savingCore.connect(f.alice).renewDeposit(f.depositId, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotMatured")
        .withArgs(f.depositId, f.deposit.maturityAt);

      // Verify state was not modified
      expect((await f.savingCore.getDeposit(f.depositId)).status).to.equal(0); // Active
      expect(await f.savingCore.depositCount()).to.equal(1n);
    });

    it("BND-R02: manual renew at exact maturityAt succeeds", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      const tx = await f.savingCore.connect(f.alice).renewDeposit(f.depositId, 1);
      const receipt = await tx.wait();
      assert(receipt);

      const oldDep = await f.savingCore.getDeposit(f.depositId);
      const newDep = await f.savingCore.getDeposit(2);

      expect(oldDep.status).to.equal(2); // ManualRenewed
      expect(newDep.status).to.equal(0); // Active
      expect(newDep.startAt).to.equal(f.deposit.maturityAt);
      expect(await f.savingCore.ownerOf(2)).to.equal(f.alice.address);
    });

    it("BND-R03: auto renew at graceEnd - 1 second reverts with GracePeriodNotEnded", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd - 1n);

      await expect(
        f.savingCore.connect(f.stranger).autoRenewDeposit(f.depositId)
      ).to.be.revertedWithCustomError(f.savingCore, "GracePeriodNotEnded")
        .withArgs(f.depositId, f.graceEnd);

      expect((await f.savingCore.getDeposit(f.depositId)).status).to.equal(0); // Active
      expect(await f.savingCore.depositCount()).to.equal(1n);
    });

    it("BND-R04: auto renew at exact graceEnd succeeds", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      const tx = await f.savingCore.connect(f.stranger).autoRenewDeposit(f.depositId);
      const receipt = await tx.wait();
      assert(receipt);

      const oldDep = await f.savingCore.getDeposit(f.depositId);
      const newDep = await f.savingCore.getDeposit(2);

      expect(oldDep.status).to.equal(3); // AutoRenewed
      expect(newDep.status).to.equal(0); // Active
      expect(newDep.startAt).to.equal(f.graceEnd);
      expect(await f.savingCore.ownerOf(2)).to.equal(f.alice.address);
    });

    it("BND-R05: auto renew at graceEnd + 1 second succeeds on independent fixture", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd + 1n);

      const tx = await f.savingCore.connect(f.stranger).autoRenewDeposit(f.depositId);
      await tx.wait();

      const oldDep = await f.savingCore.getDeposit(f.depositId);
      const newDep = await f.savingCore.getDeposit(2);

      expect(oldDep.status).to.equal(3); // AutoRenewed
      expect(newDep.status).to.equal(0); // Active
      expect(newDep.startAt).to.equal(f.graceEnd + 1n);
    });

    it("BND-R06: manual renew at graceEnd is still permitted (no upper cutoff at G)", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      const tx = await f.savingCore.connect(f.alice).renewDeposit(f.depositId, 1);
      await tx.wait();

      const oldDep = await f.savingCore.getDeposit(f.depositId);
      const newDep = await f.savingCore.getDeposit(2);

      expect(oldDep.status).to.equal(2); // ManualRenewed
      expect(newDep.status).to.equal(0); // Active
    });

    it("BND-R07: maturity withdrawal at graceEnd is still permitted (no expiration)", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      const tx = await f.savingCore.connect(f.alice).withdrawAtMaturity(f.depositId);
      await tx.wait();

      const oldDep = await f.savingCore.getDeposit(f.depositId);
      expect(oldDep.status).to.equal(1); // Withdrawn
    });

    it("BND-R08: late trigger at graceEnd + 30 days only creates 1 cycle, no backdating or extra interest", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      const lateTimestamp = f.graceEnd + 30n * 86400n;
      await networkHelpers.time.setNextBlockTimestamp(lateTimestamp);

      const tx = await f.savingCore.connect(f.stranger).autoRenewDeposit(f.depositId);
      await tx.wait();

      const oldDep = await f.savingCore.getDeposit(f.depositId);
      const newDep = await f.savingCore.getDeposit(2);

      // Only one new deposit created
      expect(await f.savingCore.depositCount()).to.equal(2n);
      expect(oldDep.status).to.equal(3); // AutoRenewed
      expect(newDep.status).to.equal(0); // Active

      // Timestamp reflects transaction execution, not backdated to graceEnd
      expect(newDep.startAt).to.equal(lateTimestamp);
      expect(newDep.maturityAt).to.equal(lateTimestamp + DEFAULT_TENOR_DAYS * 86400n);

      // Old interest paid is strictly the 180-day interest, not 180 + 32 days
      const expectedOldInterest = calcInterest(f.principal, DEFAULT_APR_BPS, DEFAULT_TENOR_DAYS * 86400n);
      expect(expectedOldInterest).to.equal(9863013n);
      expect(newDep.principal).to.equal(f.principal + expectedOldInterest);
    });
  });

  // =========================================================================
  // GROUP 2: MANUAL RENEWAL END-TO-END INTEGRATION
  // =========================================================================
  describe("Group 2: Manual Renewal End-to-End Integration", function () {
    it("INT-M01: full manual renewal flow: events, balances, and lineage", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      const expectedInterest = calcInterest(f.principal, DEFAULT_APR_BPS, DEFAULT_TENOR_DAYS * 86400n); // 9,863,013n
      const expectedNewPrincipal = f.principal + expectedInterest; // 1,009,863,013n

      const vaultBefore = await f.token.balanceOf(f.vaultAddress);
      const coreBefore = await f.token.balanceOf(f.savingCoreAddress);
      const aliceBefore = await f.token.balanceOf(f.alice.address);
      const totalPrincipalBefore = await f.savingCore.totalPrincipal();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      const tx = await f.savingCore.connect(f.alice).renewDeposit(f.depositId, 1);
      const receipt = await tx.wait();
      assert(receipt);

      // Verify event emission and ordering: DepositOpened emitted BEFORE Renewed
      const coreLogs = receipt.logs
        .filter((log) => log.address.toLowerCase() === f.savingCoreAddress.toLowerCase())
        .map((log) => {
          try {
            return f.savingCore.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .filter((parsed): parsed is NonNullable<typeof parsed> => parsed !== null);

      const openedIndex = coreLogs.findIndex((log) => log.name === "DepositOpened");
      const renewedIndex = coreLogs.findIndex((log) => log.name === "Renewed");
      expect(openedIndex).to.be.greaterThanOrEqual(0);
      expect(renewedIndex).to.be.greaterThan(openedIndex);

      // Balance deltas
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(vaultBefore - expectedInterest);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(coreBefore + expectedInterest);
      expect(await f.token.balanceOf(f.alice.address)).to.equal(aliceBefore); // No token transfer to/from user
      expect(await f.savingCore.totalPrincipal()).to.equal(totalPrincipalBefore + expectedInterest);

      // NFT ownership
      expect(await f.savingCore.ownerOf(1)).to.equal(f.alice.address); // Old NFT retained
      expect(await f.savingCore.ownerOf(2)).to.equal(f.alice.address); // New NFT minted to Alice
    });

    it("INT-M02: manual renew to different plan (Plan 1 -> Plan 2) applies target terms", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      // Renew into Plan 2 (90 days, 400 bps, penalty 500 bps)
      const tx = await f.savingCore.connect(f.alice).renewDeposit(f.depositId, 2);
      await tx.wait();

      const newDep = await f.savingCore.getDeposit(2);
      expect(newDep.planId).to.equal(2n);
      expect(newDep.aprBpsAtOpen).to.equal(400);
      expect(newDep.penaltyBpsAtOpen).to.equal(500);
      expect(newDep.maturityAt - newDep.startAt).to.equal(90n * 86400n);
    });

    it("INT-M03: target limits on compounded principal (P + I) boundary checks", async function () {
      const f = await networkHelpers.loadFixture(deployRenewalIntegrationFixture);

      // Create Plan with min=1000 USDC, max=1010 USDC
      await (await f.savingCore.connect(f.bankAdmin).createPlan(
        30n,
        100n,
        toUnits("1000"),
        toUnits("1010"),
        100n,
        true
      )).wait();
      const boundedPlanId = 4n;

      // Alice opens deposit #1 with 1000 USDC on Plan 1
      await (await f.savingCore.connect(f.alice).openDeposit(1, toUnits("1000"))).wait();
      const dep1 = await f.savingCore.getDeposit(1);
      await networkHelpers.time.setNextBlockTimestamp(dep1.maturityAt);

      // P + I = 1,009,863,013 (approx 1009.86 USDC), which is within [1000, 1010] -> succeeds!
      await (await f.savingCore.connect(f.alice).renewDeposit(1, boundedPlanId)).wait();

      // Now create Plan with max=1005 USDC (below P + I)
      await (await f.savingCore.connect(f.bankAdmin).createPlan(
        30n,
        100n,
        toUnits("1000"),
        toUnits("1005"),
        100n,
        true
      )).wait();
      const strictMaxPlanId = 5n;

      // Alice opens deposit #3 with 1000 USDC on Plan 1
      await (await f.savingCore.connect(f.alice).openDeposit(1, toUnits("1000"))).wait();
      const dep3 = await f.savingCore.getDeposit(3);
      await networkHelpers.time.setNextBlockTimestamp(dep3.maturityAt);

      // P + I = 1,009,863,013 > 1,005,000,000 -> reverts with DepositAmountOutOfRange
      await expect(
        f.savingCore.connect(f.alice).renewDeposit(3, strictMaxPlanId)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositAmountOutOfRange")
        .withArgs(1009863013n, toUnits("1000"), toUnits("1005"));

      // Target disabled reverts PlanDisabled
      await expect(
        f.savingCore.connect(f.alice).renewDeposit(3, 3) // Plan 3 is disabled
      ).to.be.revertedWithCustomError(f.savingCore, "PlanDisabled")
        .withArgs(3n);

      // Target non-existent reverts PlanNotFound
      await expect(
        f.savingCore.connect(f.alice).renewDeposit(3, 999)
      ).to.be.revertedWithCustomError(f.savingCore, "PlanNotFound")
        .withArgs(999n);
    });
  });

  // =========================================================================
  // GROUP 3: AUTO RENEWAL END-TO-END INTEGRATION
  // =========================================================================
  describe("Group 3: Auto Renewal End-to-End Integration", function () {
    it("INT-A01: full permissionless auto renewal: stranger caller receives 0 assets, Alice receives NFT", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      const expectedInterest = calcInterest(f.principal, DEFAULT_APR_BPS, DEFAULT_TENOR_DAYS * 86400n);

      const strangerTokensBefore = await f.token.balanceOf(f.stranger.address);
      const aliceTokensBefore = await f.token.balanceOf(f.alice.address);

      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      const tx = await f.savingCore.connect(f.stranger).autoRenewDeposit(f.depositId);
      await tx.wait();

      expect(await f.token.balanceOf(f.stranger.address)).to.equal(strangerTokensBefore);
      expect(await f.token.balanceOf(f.alice.address)).to.equal(aliceTokensBefore);
      expect(await f.savingCore.balanceOf(f.stranger.address)).to.equal(0n);
      expect(await f.savingCore.ownerOf(2)).to.equal(f.alice.address);
    });

    it("INT-A02: APR and terms lock after admin updates APR and disables plan", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);

      // Bank Admin updates Plan 1 to 500 bps and disables Plan 1
      await (await f.savingCore.connect(f.bankAdmin).updatePlan(1, 500)).wait();
      await (await f.savingCore.connect(f.bankAdmin).disablePlan(1)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      const tx = await f.savingCore.connect(f.stranger).autoRenewDeposit(f.depositId);
      await tx.wait();

      const newDep = await f.savingCore.getDeposit(2);
      // Auto renewal locked original 200 bps, not 500 bps
      expect(newDep.aprBpsAtOpen).to.equal(DEFAULT_APR_BPS);
      expect(newDep.penaltyBpsAtOpen).to.equal(DEFAULT_PENALTY_BPS);
      expect(newDep.maturityAt - newDep.startAt).to.equal(DEFAULT_TENOR_DAYS * 86400n);
      expect(newDep.status).to.equal(0); // Active
    });

    it("INT-A03: late auto renewal at graceEnd + 30 days retains contractual interest and updates startAt", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      const triggerTime = f.graceEnd + 30n * 86400n;
      await networkHelpers.time.setNextBlockTimestamp(triggerTime);

      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(f.depositId)).wait();

      const newDep = await f.savingCore.getDeposit(2);
      expect(newDep.startAt).to.equal(triggerTime);
      expect(newDep.maturityAt).to.equal(triggerTime + DEFAULT_TENOR_DAYS * 86400n);
    });

    it("INT-A04: NFT transfer before auto renewal: new NFT is minted to current owner Bob", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);

      // Alice transfers NFT to Bob
      await (await f.savingCore.connect(f.alice).transferFrom(f.alice.address, f.bob.address, f.depositId)).wait();
      expect(await f.savingCore.ownerOf(f.depositId)).to.equal(f.bob.address);

      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(f.depositId)).wait();

      // Bob receives new NFT #2 and still owns old NFT #1
      expect(await f.savingCore.ownerOf(1)).to.equal(f.bob.address);
      expect(await f.savingCore.ownerOf(2)).to.equal(f.bob.address);
      expect(await f.savingCore.balanceOf(f.alice.address)).to.equal(0n);
    });
  });

  // =========================================================================
  // GROUP 4: MULTI-CYCLE RENEWAL INTEGRATION (KEY NEW FOCUS)
  // =========================================================================
  describe("Group 4: Multi-Cycle Renewal Integration", function () {
    it("INT-C01: multi-cycle Auto -> Auto (#1 -> #2 -> #3) compounding interest and locking terms", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);

      // --- Cycle 1 -> Cycle 2 (Auto Renew) ---
      const I1 = calcInterest(f.principal, DEFAULT_APR_BPS, DEFAULT_TENOR_DAYS * 86400n); // 9,863,013n
      const P2 = f.principal + I1; // 1,009,863,013n

      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      const dep2 = await f.savingCore.getDeposit(2);
      expect(dep2.principal).to.equal(P2);
      expect(dep2.status).to.equal(0); // Active
      expect((await f.savingCore.getDeposit(1)).status).to.equal(3); // AutoRenewed

      // --- Cycle 2 -> Cycle 3 (Auto Renew) ---
      const dep2TenorSeconds = dep2.maturityAt - dep2.startAt;
      const I2 = calcInterest(P2, BigInt(dep2.aprBpsAtOpen), dep2TenorSeconds); // 9,960,292n
      const P3 = P2 + I2; // 1,019,823,305n
      const dep2GraceEnd = dep2.maturityAt + GRACE_PERIOD_SECONDS;

      await networkHelpers.time.setNextBlockTimestamp(dep2GraceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(2)).wait();

      const dep3 = await f.savingCore.getDeposit(3);
      expect(dep3.principal).to.equal(P3);
      expect(dep3.status).to.equal(0); // Active
      expect((await f.savingCore.getDeposit(2)).status).to.equal(3); // AutoRenewed

      // Verify all 3 NFTs exist and belong to Alice
      expect(await f.savingCore.ownerOf(1)).to.equal(f.alice.address);
      expect(await f.savingCore.ownerOf(2)).to.equal(f.alice.address);
      expect(await f.savingCore.ownerOf(3)).to.equal(f.alice.address);
      expect(await f.savingCore.depositCount()).to.equal(3n);

      // Verify global totalPrincipal
      expect(await f.savingCore.totalPrincipal()).to.equal(P3);
    });

    it("INT-C02: multi-cycle Manual -> Auto (#1 [Plan 1] -> #2 [Plan 2] -> #3 [Locked Plan 2])", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);

      // Manual renew #1 to Plan 2 (90d, 400 bps, penalty 500 bps)
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 2)).wait();

      const dep2 = await f.savingCore.getDeposit(2);
      expect(dep2.planId).to.equal(2n);
      expect(dep2.aprBpsAtOpen).to.equal(400);
      expect(dep2.penaltyBpsAtOpen).to.equal(500);

      // Bank Admin updates Plan 2 to 800 bps - this update should NOT affect future auto renewal
      await (await f.savingCore.connect(f.bankAdmin).updatePlan(2, 800)).wait();

      // Auto renew #2 to #3
      const dep2GraceEnd = dep2.maturityAt + GRACE_PERIOD_SECONDS;
      await networkHelpers.time.setNextBlockTimestamp(dep2GraceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(2)).wait();

      const dep3 = await f.savingCore.getDeposit(3);
      // Dep #3 locked Plan 2 terms from deposit #2 (400 bps), NOT current 800 bps
      expect(dep3.planId).to.equal(2n);
      expect(dep3.aprBpsAtOpen).to.equal(400);
      expect(dep3.penaltyBpsAtOpen).to.equal(500);
      expect(dep3.maturityAt - dep3.startAt).to.equal(90n * 86400n);
      expect(dep3.status).to.equal(0); // Active
    });

    it("INT-C03: multi-cycle Auto -> Manual (#1 [Plan 1] -> #2 [Locked Plan 1] -> #3 [Plan 2])", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);

      // Auto renew #1 to #2
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      const dep2 = await f.savingCore.getDeposit(2);
      expect(dep2.status).to.equal(0); // Active
      expect(dep2.aprBpsAtOpen).to.equal(DEFAULT_APR_BPS);

      // Manual renew #2 to Plan 2 at dep2.maturityAt
      await networkHelpers.time.setNextBlockTimestamp(dep2.maturityAt);
      await (await f.savingCore.connect(f.alice).renewDeposit(2, 2)).wait();

      const dep3 = await f.savingCore.getDeposit(3);
      expect(dep3.planId).to.equal(2n);
      expect(dep3.aprBpsAtOpen).to.equal(400);
      expect(dep3.penaltyBpsAtOpen).to.equal(500);
      expect(dep3.status).to.equal(0); // Active

      expect((await f.savingCore.getDeposit(1)).status).to.equal(3); // AutoRenewed
      expect((await f.savingCore.getDeposit(2)).status).to.equal(2); // ManualRenewed
    });

    it("INT-C04: settlement of renewed active deposit (maturity withdrawal & early withdrawal)", async function () {
      // Path A: Maturity withdrawal of renewed deposit
      {
        const f = await networkHelpers.loadFixture(maturedRenewalFixture);
        await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
        await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

        const dep2 = await f.savingCore.getDeposit(2);
        const P2 = dep2.principal;
        const I2 = calcInterest(P2, BigInt(dep2.aprBpsAtOpen), dep2.maturityAt - dep2.startAt);

        const aliceTokensBefore = await f.token.balanceOf(f.alice.address);
        await networkHelpers.time.setNextBlockTimestamp(dep2.maturityAt);
        await (await f.savingCore.connect(f.alice).withdrawAtMaturity(2)).wait();

        expect(await f.token.balanceOf(f.alice.address)).to.equal(aliceTokensBefore + P2 + I2);
        expect((await f.savingCore.getDeposit(2)).status).to.equal(1); // Withdrawn

        // Historical ID 1 cannot be withdrawn
        await expect(
          f.savingCore.connect(f.alice).withdrawAtMaturity(1)
        ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
          .withArgs(1n, 3); // AutoRenewed
      }

      // Path B: Early withdrawal of renewed deposit
      {
        const f = await networkHelpers.loadFixture(maturedRenewalFixture);
        await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
        await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

        const dep2 = await f.savingCore.getDeposit(2);
        const P2 = dep2.principal;
        const penalty = calcPenalty(P2, BigInt(dep2.penaltyBpsAtOpen));
        const netPrincipal = P2 - penalty;

        const aliceTokensBefore = await f.token.balanceOf(f.alice.address);
        const feeReceiverBefore = await f.token.balanceOf(f.feeReceiver.address);

        // Early withdraw before dep2.maturityAt
        await networkHelpers.time.setNextBlockTimestamp(dep2.startAt + 100n);
        await (await f.savingCore.connect(f.alice).earlyWithdraw(2)).wait();

        expect(await f.token.balanceOf(f.alice.address)).to.equal(aliceTokensBefore + netPrincipal);
        expect(await f.token.balanceOf(f.feeReceiver.address)).to.equal(feeReceiverBefore + penalty);
        expect((await f.savingCore.getDeposit(2)).status).to.equal(1); // Withdrawn
      }
    });
  });

  // =========================================================================
  // GROUP 5: NEGATIVE INTEGRATION & STATE PRESERVATION MATRIX
  // =========================================================================
  describe("Group 5: Negative Integration & State Preservation Matrix", function () {
    it("NEG-001 & NEG-002: original depositor or approved operator cannot manual renew after transfer", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);

      // Alice approves operator Charlie, then transfers NFT to Bob
      await (await f.savingCore.connect(f.alice).approve(f.charlie.address, f.depositId)).wait();
      await (await f.savingCore.connect(f.alice).transferFrom(f.alice.address, f.bob.address, f.depositId)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      // Alice cannot renew
      await expect(
        f.savingCore.connect(f.alice).renewDeposit(f.depositId, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner")
        .withArgs(f.depositId, f.alice.address);

      // Approved operator Charlie cannot renew
      await expect(
        f.savingCore.connect(f.charlie).renewDeposit(f.depositId, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner")
        .withArgs(f.depositId, f.charlie.address);
    });

    it("NEG-004 to NEG-007: terminal or nonexistent deposits cannot renew", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);

      // Withdrawn deposit
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(f.depositId)).wait();

      await expect(
        f.savingCore.connect(f.alice).renewDeposit(f.depositId, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(f.depositId, 1); // Withdrawn

      await expect(
        f.savingCore.connect(f.stranger).autoRenewDeposit(f.depositId)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(f.depositId, 1);

      // Nonexistent deposit
      await expect(
        f.savingCore.connect(f.alice).renewDeposit(999, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotFound")
        .withArgs(999n);
    });

    it("NEG-008 to NEG-011: pause blocks renewal, unpause restores it", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);

      // Bank Admin pauses Vault
      await (await f.vault.connect(f.bankAdmin).pause()).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      // Manual renew blocked
      await expect(
        f.savingCore.connect(f.alice).renewDeposit(f.depositId, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "EnforcedPause");

      // Auto renew blocked
      await expect(
        f.savingCore.connect(f.stranger).autoRenewDeposit(f.depositId)
      ).to.be.revertedWithCustomError(f.savingCore, "EnforcedPause");

      // Admin can still fundVault while paused
      await (await f.vault.connect(f.bankAdmin).fundVault(toUnits("100"))).wait();

      // Unpause restores auto renew
      await (await f.vault.connect(f.bankAdmin).unpause()).wait();
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(f.depositId)).wait();
    });

    it("NEG-012 to NEG-014: Vault liquidity shortfall of 1 unit reverts atomically and retry succeeds after funding", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      const expectedInterest = calcInterest(f.principal, DEFAULT_APR_BPS, DEFAULT_TENOR_DAYS * 86400n); // 9,863,013n

      // Drain Vault liquidity so it has exactly expectedInterest - 1 unit
      const currentVaultBalance = await f.token.balanceOf(f.vaultAddress);
      const targetBalance = expectedInterest - 1n;
      await (await f.vault.connect(f.bankAdmin).withdrawVault(currentVaultBalance - targetBalance)).wait();
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(targetBalance);

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      // Renewal reverts with InsufficientVaultBalance
      await expect(
        f.savingCore.connect(f.alice).renewDeposit(f.depositId, 1)
      ).to.be.revertedWithCustomError(f.vault, "InsufficientVaultBalance")
        .withArgs(targetBalance, expectedInterest);

      // Verify atomic state preservation
      expect((await f.savingCore.getDeposit(f.depositId)).status).to.equal(0); // Active
      expect(await f.savingCore.depositCount()).to.equal(1n);

      // Admin funds the missing 1 unit
      await (await f.vault.connect(f.bankAdmin).fundVault(1n)).wait();
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(expectedInterest);

      // Retry renewal succeeds
      await (await f.savingCore.connect(f.alice).renewDeposit(f.depositId, 1)).wait();
      expect((await f.savingCore.getDeposit(f.depositId)).status).to.equal(2); // ManualRenewed
    });

    it("NEG-020: ERC721 receiver rejection rolls back renewal atomically", async function () {
      const f = await networkHelpers.loadFixture(deployRenewalIntegrationFixture);

      // Deploy rejecting receiver mock
      const receiver = await ethers.deployContract("DepositReceiverMock", [f.savingCoreAddress, f.operator.address]);
      await receiver.waitForDeployment();
      const receiverAddress = await receiver.getAddress();

      // Mint tokens to receiver and open deposit
      await (await f.token.mint(receiverAddress, toUnits("100"))).wait();
      await (await receiver.approveCore(toUnits("100"))).wait();
      await (await receiver.open(1, toUnits("100"))).wait();

      const dep = await f.savingCore.getDeposit(1);
      expect(await f.savingCore.ownerOf(1)).to.equal(receiverAddress);

      // Configure receiver to reject incoming ERC721
      await (await receiver.configure(1, ethers.ZeroAddress)).wait(); // Mode.Reject = 1

      await networkHelpers.time.setNextBlockTimestamp(dep.maturityAt);

      const vaultBefore = await f.token.balanceOf(f.vaultAddress);
      const coreBefore = await f.token.balanceOf(f.savingCoreAddress);
      const totalPBefore = await f.savingCore.totalPrincipal();

      // Attempt manual renew via receiver -> Reverts with ReceiverRejected
      await expect(
        receiver.renew(1, 1)
      ).to.be.revertedWithCustomError(receiver, "ReceiverRejected");

      // Entire state preserved
      expect((await f.savingCore.getDeposit(1)).status).to.equal(0); // Active
      expect(await f.savingCore.depositCount()).to.equal(1n);
      expect(await f.savingCore.totalPrincipal()).to.equal(totalPBefore);
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(vaultBefore);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(coreBefore);
    });

    it("NEG-021: ERC721 receiver callback reentrancy during renewal is blocked by nonReentrant", async function () {
      const f = await networkHelpers.loadFixture(deployRenewalIntegrationFixture);
      const receiver = await ethers.deployContract("DepositReceiverMock", [f.savingCoreAddress, f.operator.address]);
      await receiver.waitForDeployment();
      const receiverAddress = await receiver.getAddress();

      await (await f.token.mint(receiverAddress, toUnits("100"))).wait();
      await (await receiver.approveCore(toUnits("100"))).wait();
      await (await receiver.open(1, toUnits("100"))).wait();

      const dep = await f.savingCore.getDeposit(1);

      // Mode.ReenterRenewCaught = 6
      await (await receiver.configure(6, ethers.ZeroAddress)).wait();

      await networkHelpers.time.setNextBlockTimestamp(dep.maturityAt);
      await (await receiver.renew(1, 1)).wait();

      expect(await receiver.reentryError()).to.equal(
        f.savingCore.interface.getError("ReentrancyGuardReentrantCall")!.selector
      );
    });
  });

  // =========================================================================
  // GROUP 6: COMPETING TRANSACTIONS & STATE EXCLUSIVITY
  // =========================================================================
  describe("Group 6: Competing Transactions & State Exclusivity", function () {
    it("COMP-001: Manual Renew first -> Auto Renew second reverts with DepositNotActive", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      await (await f.savingCore.connect(f.alice).renewDeposit(f.depositId, 1)).wait();

      await expect(
        f.savingCore.connect(f.stranger).autoRenewDeposit(f.depositId)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(f.depositId, 2); // ManualRenewed
    });

    it("COMP-002: Auto Renew first -> Manual Renew second reverts with DepositNotActive", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(f.depositId)).wait();

      await expect(
        f.savingCore.connect(f.alice).renewDeposit(f.depositId, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(f.depositId, 3); // AutoRenewed
    });

    it("COMP-003: Maturity Withdraw first -> Auto Renew second reverts with DepositNotActive", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(f.depositId)).wait();

      await expect(
        f.savingCore.connect(f.stranger).autoRenewDeposit(f.depositId)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(f.depositId, 1); // Withdrawn
    });

    it("COMP-004: Auto Renew first -> Maturity Withdraw second reverts with DepositNotActive", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(f.depositId)).wait();

      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(f.depositId)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(f.depositId, 3); // AutoRenewed
    });

    it("COMP-005: Manual Renew first -> Maturity Withdraw second reverts with DepositNotActive", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      await (await f.savingCore.connect(f.alice).renewDeposit(f.depositId, 1)).wait();

      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(f.depositId)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(f.depositId, 2); // ManualRenewed
    });

    it("COMP-006: Maturity Withdraw first -> Manual Renew second reverts with DepositNotActive", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(f.depositId)).wait();

      await expect(
        f.savingCore.connect(f.alice).renewDeposit(f.depositId, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(f.depositId, 1); // Withdrawn
    });
  });

  // =========================================================================
  // GROUP 7: FINANCIAL ACCOUNTING & INVARIANTS VERIFICATION
  // =========================================================================
  describe("Group 7: Financial Accounting & Invariants Verification", function () {
    it("ACC-INT-001: global invariant: Core balance >= totalPrincipal = sum(active deposit principals)", async function () {
      const f = await networkHelpers.loadFixture(deployRenewalIntegrationFixture);

      // Open 3 deposits
      await (await f.savingCore.connect(f.alice).openDeposit(1, toUnits("1000"))).wait(); // ID 1
      await (await f.savingCore.connect(f.bob).openDeposit(1, toUnits("2000"))).wait();   // ID 2
      await (await f.savingCore.connect(f.charlie).openDeposit(1, toUnits("3000"))).wait(); // ID 3

      expect(await f.savingCore.totalPrincipal()).to.equal(toUnits("6000"));
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(toUnits("6000"));

      // Auto renew deposit 1
      const dep1 = await f.savingCore.getDeposit(1);
      await networkHelpers.time.setNextBlockTimestamp(dep1.maturityAt + GRACE_PERIOD_SECONDS);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait(); // ID 4 (Active)

      const dep4 = await f.savingCore.getDeposit(4);
      const expectedTotalPrincipal = toUnits("2000") + toUnits("3000") + dep4.principal;

      expect(await f.savingCore.totalPrincipal()).to.equal(expectedTotalPrincipal);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.be.greaterThanOrEqual(expectedTotalPrincipal);

      // Matured withdraw deposit 2
      await (await f.savingCore.connect(f.bob).withdrawAtMaturity(2)).wait();

      const totalAfterWithdraw = toUnits("3000") + dep4.principal;
      expect(await f.savingCore.totalPrincipal()).to.equal(totalAfterWithdraw);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.be.greaterThanOrEqual(totalAfterWithdraw);
    });

    it("ACC-INT-002: direct donation to Core creates surplus without modifying totalPrincipal", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      const totalPrincipalBefore = await f.savingCore.totalPrincipal();
      const coreBalanceBefore = await f.token.balanceOf(f.savingCoreAddress);

      // Donate 500 USDC directly to Core
      await (await f.token.mint(f.savingCoreAddress, toUnits("500"))).wait();

      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(coreBalanceBefore + toUnits("500"));
      expect(await f.savingCore.totalPrincipal()).to.equal(totalPrincipalBefore); // Unchanged
    });
  });

  // =========================================================================
  // GROUP 8: EVENT ORDERING & NFT LINEAGE VERIFICATION
  // =========================================================================
  describe("Group 8: Event Ordering & NFT Lineage Verification", function () {
    it("EVT-INT-001: DepositOpened event strictly precedes Renewed event with exact parameters", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      const tx = await f.savingCore.connect(f.stranger).autoRenewDeposit(f.depositId);
      const receipt = await tx.wait();
      assert(receipt);

      const coreLogs = receipt.logs
        .filter((log) => log.address.toLowerCase() === f.savingCoreAddress.toLowerCase())
        .map((log) => {
          try {
            return f.savingCore.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .filter((parsed): parsed is NonNullable<typeof parsed> => parsed !== null);

      const openedIndex = coreLogs.findIndex((log) => log.name === "DepositOpened");
      const renewedIndex = coreLogs.findIndex((log) => log.name === "Renewed");

      expect(openedIndex).to.be.greaterThanOrEqual(0);
      expect(renewedIndex).to.be.greaterThan(openedIndex);

      const parsedOpened = coreLogs[openedIndex];
      expect(parsedOpened.args.depositId).to.equal(2n);
      expect(parsedOpened.args.owner).to.equal(f.alice.address);
      expect(parsedOpened.args.principal).to.equal(1009863013n);

      const parsedRenewed = coreLogs[renewedIndex];
      expect(parsedRenewed.args.oldDepositId).to.equal(1n);
      expect(parsedRenewed.args.newDepositId).to.equal(2n);
      expect(parsedRenewed.args.newPrincipal).to.equal(1009863013n);
    });

    it("EVT-INT-002: no duplicate NFTs minted and no Withdrawn event emitted during renewal", async function () {
      const f = await networkHelpers.loadFixture(maturedRenewalFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      const tx = await f.savingCore.connect(f.alice).renewDeposit(f.depositId, 1);
      const receipt = await tx.wait();
      assert(receipt);

      // Confirm no Withdrawn event emitted
      const withdrawnEvent = receipt.logs
        .filter((log) => log.address.toLowerCase() === f.savingCoreAddress.toLowerCase())
        .map((log) => {
          try {
            return f.savingCore.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed?.name === "Withdrawn");
      expect(withdrawnEvent).to.be.undefined;

      // Unique token IDs
      expect(await f.savingCore.ownerOf(1)).to.equal(f.alice.address);
      expect(await f.savingCore.ownerOf(2)).to.equal(f.alice.address);
    });
  });
});
