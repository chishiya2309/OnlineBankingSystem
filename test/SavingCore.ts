import { expect } from "chai";
import { network } from "hardhat";
import { personalVariant } from "../config/personal-variant.js";

const connection = await network.create("hardhatMainnet");
const { ethers, networkHelpers } = connection;

const GRACE_PERIOD_SECONDS = BigInt(personalVariant.gracePeriodDays * 86400); // 172800n
const DEFAULT_TENOR_DAYS = BigInt(personalVariant.defaultTenorDays); // 180n
const DEFAULT_APR_BPS = BigInt(personalVariant.defaultAprBps); // 200n
const DEFAULT_PENALTY_BPS = BigInt(personalVariant.earlyWithdrawPenaltyBps); // 350n

async function deploySavingCoreFixture() {
  const [deployer, bankAdmin, alice, stranger, feeReceiver, newAdmin] = await ethers.getSigners();

  const token = await ethers.deployContract("MockUSDC");
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();

  const vault = await ethers.deployContract("VaultManager", [tokenAddress, bankAdmin.address, feeReceiver.address]);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();

  const savingCore = await ethers.deployContract("SavingCore", [vaultAddress, GRACE_PERIOD_SECONDS]);
  await savingCore.waitForDeployment();
  const savingCoreAddress = await savingCore.getAddress();

  return {
    token,
    vault,
    savingCore,
    tokenAddress,
    vaultAddress,
    savingCoreAddress,
    deployer,
    bankAdmin,
    alice,
    stranger,
    feeReceiver,
    newAdmin,
  };
}

async function savingCoreWithPlanFixture() {
  const f = await deploySavingCoreFixture();
  const tx = await f.savingCore.connect(f.bankAdmin).createPlan(
    DEFAULT_TENOR_DAYS,
    DEFAULT_APR_BPS,
    0n,
    0n,
    DEFAULT_PENALTY_BPS,
    true
  );
  await tx.wait();
  return f;
}

describe("SavingCore - Saving Plan Management", function () {
  describe("Group A: Constructor & Foundation", function () {
    it("CORE-001: initializes successfully with a valid VaultManager and grace period", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      expect(await f.savingCore.vaultManager()).to.equal(f.vaultAddress);
      expect(await f.savingCore.token()).to.equal(f.tokenAddress);
      expect(await f.savingCore.gracePeriodSeconds()).to.equal(GRACE_PERIOD_SECONDS);
    });

    it("CORE-002: rejects a zero VaultManager address with ZeroAddress", async function () {
      const factory = await ethers.getContractFactory("SavingCore");
      await expect(
        factory.deploy(ethers.ZeroAddress, GRACE_PERIOD_SECONDS)
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("CORE-003: rejects an EOA VaultManager address with InvalidContract", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      const factory = await ethers.getContractFactory("SavingCore");
      await expect(
        factory.deploy(f.stranger.address, GRACE_PERIOD_SECONDS)
      ).to.be.revertedWithCustomError(factory, "InvalidContract").withArgs(f.stranger.address);
    });

    it("CORE-004: rejects zero grace period with InvalidGracePeriod", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      const factory = await ethers.getContractFactory("SavingCore");
      await expect(
        factory.deploy(f.vaultAddress, 0n)
      ).to.be.revertedWithCustomError(factory, "InvalidGracePeriod").withArgs(0n);
    });

    it("CORE-005: returns exact token, vaultManager, and gracePeriodSeconds getters", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      expect(await f.savingCore.token()).to.equal(f.tokenAddress);
      expect(await f.savingCore.vaultManager()).to.equal(f.vaultAddress);
      expect(await f.savingCore.gracePeriodSeconds()).to.equal(GRACE_PERIOD_SECONDS);
    });

    it("CORE-006: starts with planCount equal to zero", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      expect(await f.savingCore.planCount()).to.equal(0n);
    });

    it("CORE-007: exposes the exact ERC721 name and symbol", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      expect(await f.savingCore.name()).to.equal("Saving Deposit Certificate");
      expect(await f.savingCore.symbol()).to.equal("SDC");
    });
  });

  describe("Group B: createPlan()", function () {
    it("PLAN-001: Bank Admin creates a valid enabled plan", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      const tx = await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 100n, 1000n, 350, true);
      await tx.wait();

      expect(await f.savingCore.planCount()).to.equal(1n);
      const plan = await f.savingCore.getPlan(1);
      expect(plan.tenorDays).to.equal(180);
      expect(plan.aprBps).to.equal(200);
      expect(plan.minDeposit).to.equal(100n);
      expect(plan.maxDeposit).to.equal(1000n);
      expect(plan.earlyWithdrawPenaltyBps).to.equal(350);
      expect(plan.enabled).to.equal(true);
    });

    it("PLAN-002: Bank Admin creates a valid disabled plan (enabled = false)", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      const tx = await f.savingCore.connect(f.bankAdmin).createPlan(90, 150, 0n, 0n, 200, false);
      await tx.wait();

      expect(await f.savingCore.planCount()).to.equal(1n);
      const plan = await f.savingCore.getPlan(1);
      expect(plan.tenorDays).to.equal(90);
      expect(plan.aprBps).to.equal(150);
      expect(plan.minDeposit).to.equal(0n);
      expect(plan.maxDeposit).to.equal(0n);
      expect(plan.earlyWithdrawPenaltyBps).to.equal(200);
      expect(plan.enabled).to.equal(false);
    });

    it("PLAN-003: non-admin caller cannot create a plan", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      await expect(
        f.savingCore.connect(f.stranger).createPlan(180, 200, 0n, 0n, 350, true)
      ).to.be.revertedWithCustomError(f.savingCore, "NotBankAdmin").withArgs(f.stranger.address);
    });

    it("PLAN-004: rejects tenor equal to zero with InvalidTenor(0)", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      await expect(
        f.savingCore.connect(f.bankAdmin).createPlan(0, 200, 0n, 0n, 350, true)
      ).to.be.revertedWithCustomError(f.savingCore, "InvalidTenor").withArgs(0n);
    });

    it("PLAN-005: rejects tenor exceeding uint32 max with InvalidTenor", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      const overflowTenor = 4294967296n; // 2^32
      await expect(
        f.savingCore.connect(f.bankAdmin).createPlan(overflowTenor, 200, 0n, 0n, 350, true)
      ).to.be.revertedWithCustomError(f.savingCore, "InvalidTenor").withArgs(overflowTenor);
    });

    it("PLAN-006: allows APR equal to zero", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      await f.savingCore.connect(f.bankAdmin).createPlan(180, 0, 0n, 0n, 350, true);
      const plan = await f.savingCore.getPlan(1);
      expect(plan.aprBps).to.equal(0);
    });

    it("PLAN-007: allows APR equal to 10000 (100%)", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      await f.savingCore.connect(f.bankAdmin).createPlan(180, 10000, 0n, 0n, 350, true);
      const plan = await f.savingCore.getPlan(1);
      expect(plan.aprBps).to.equal(10000);
    });

    it("PLAN-008: rejects APR exceeding 10000 with InvalidApr(10001)", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      await expect(
        f.savingCore.connect(f.bankAdmin).createPlan(180, 10001, 0n, 0n, 350, true)
      ).to.be.revertedWithCustomError(f.savingCore, "InvalidApr").withArgs(10001n);
    });

    it("PLAN-009: allows early withdrawal penalty equal to zero", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 0n, 0n, 0, true);
      const plan = await f.savingCore.getPlan(1);
      expect(plan.earlyWithdrawPenaltyBps).to.equal(0);
    });

    it("PLAN-010: allows early withdrawal penalty equal to 10000 (100%)", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 0n, 0n, 10000, true);
      const plan = await f.savingCore.getPlan(1);
      expect(plan.earlyWithdrawPenaltyBps).to.equal(10000);
    });

    it("PLAN-011: rejects early withdrawal penalty exceeding 10000 with InvalidPenalty(10001)", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      await expect(
        f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 0n, 0n, 10001, true)
      ).to.be.revertedWithCustomError(f.savingCore, "InvalidPenalty").withArgs(10001n);
    });

    it("PLAN-012: rejects minDeposit > maxDeposit when both are nonzero with InvalidDepositLimits", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      await expect(
        f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 1000n, 500n, 350, true)
      ).to.be.revertedWithCustomError(f.savingCore, "InvalidDepositLimits").withArgs(1000n, 500n);
    });

    it("PLAN-013: allows minDeposit = 0 with a positive maxDeposit", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 0n, 5000n, 350, true);
      const plan = await f.savingCore.getPlan(1);
      expect(plan.minDeposit).to.equal(0n);
      expect(plan.maxDeposit).to.equal(5000n);
    });

    it("PLAN-014: allows maxDeposit = 0 with a positive minDeposit", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 500n, 0n, 350, true);
      const plan = await f.savingCore.getPlan(1);
      expect(plan.minDeposit).to.equal(500n);
      expect(plan.maxDeposit).to.equal(0n);
    });

    it("PLAN-015: allows minDeposit == maxDeposit", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 1000n, 1000n, 350, true);
      const plan = await f.savingCore.getPlan(1);
      expect(plan.minDeposit).to.equal(1000n);
      expect(plan.maxDeposit).to.equal(1000n);
    });

    it("PLAN-016: assigns sequentially increasing IDs when multiple plans are created", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      await f.savingCore.connect(f.bankAdmin).createPlan(30, 100, 0n, 0n, 50, true);
      await f.savingCore.connect(f.bankAdmin).createPlan(60, 150, 0n, 0n, 100, true);
      await f.savingCore.connect(f.bankAdmin).createPlan(90, 200, 0n, 0n, 150, true);

      expect(await f.savingCore.planCount()).to.equal(3n);
      expect((await f.savingCore.getPlan(1)).tenorDays).to.equal(30);
      expect((await f.savingCore.getPlan(2)).tenorDays).to.equal(60);
      expect((await f.savingCore.getPlan(3)).tenorDays).to.equal(90);
    });

    it("PLAN-017: failed plan creation does not increment planCount", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 0n, 0n, 350, true);
      expect(await f.savingCore.planCount()).to.equal(1n);

      await expect(
        f.savingCore.connect(f.bankAdmin).createPlan(0, 200, 0n, 0n, 350, true)
      ).to.be.revertedWithCustomError(f.savingCore, "InvalidTenor");

      expect(await f.savingCore.planCount()).to.equal(1n);
    });

    it("PLAN-018: emits PlanCreated with exact indexed planId, tenorDays, and aprBps", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      const tx = await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 0n, 0n, 350, true);
      await expect(tx)
        .to.emit(f.savingCore, "PlanCreated")
        .withArgs(1n, 180n, 200n);
    });
  });

  describe("Group C: getPlan()", function () {
    it("PLAN-019: reads an existing plan and returns accurate struct fields", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      const plan = await f.savingCore.getPlan(1);
      expect(plan.tenorDays).to.equal(180);
      expect(plan.aprBps).to.equal(200);
      expect(plan.minDeposit).to.equal(0n);
      expect(plan.maxDeposit).to.equal(0n);
      expect(plan.earlyWithdrawPenaltyBps).to.equal(350);
      expect(plan.enabled).to.equal(true);
    });

    it("PLAN-020: permits any non-admin address to call getPlan()", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      const plan = await f.savingCore.connect(f.stranger).getPlan(1);
      expect(plan.tenorDays).to.equal(180);
      expect(plan.aprBps).to.equal(200);
    });

    it("PLAN-021: reads a disabled plan successfully", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 0n, 0n, 350, false);
      const plan = await f.savingCore.getPlan(1);
      expect(plan.enabled).to.equal(false);
      expect(plan.tenorDays).to.equal(180);
    });

    it("PLAN-022: rejects planId equal to zero with PlanNotFound(0)", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      await expect(f.savingCore.getPlan(0)).to.be.revertedWithCustomError(
        f.savingCore,
        "PlanNotFound"
      ).withArgs(0n);
    });

    it("PLAN-023: rejects planId beyond planCount with PlanNotFound", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      await expect(f.savingCore.getPlan(2)).to.be.revertedWithCustomError(
        f.savingCore,
        "PlanNotFound"
      ).withArgs(2n);

      await expect(f.savingCore.getPlan(999)).to.be.revertedWithCustomError(
        f.savingCore,
        "PlanNotFound"
      ).withArgs(999n);
    });
  });

  describe("Group D: updatePlan()", function () {
    it("PLAN-024: Bank Admin updates plan APR successfully", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      await f.savingCore.connect(f.bankAdmin).updatePlan(1, 450);
      const plan = await f.savingCore.getPlan(1);
      expect(plan.aprBps).to.equal(450);
    });

    it("PLAN-025: non-admin caller cannot update plan APR", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      await expect(
        f.savingCore.connect(f.stranger).updatePlan(1, 300)
      ).to.be.revertedWithCustomError(f.savingCore, "NotBankAdmin").withArgs(f.stranger.address);
    });

    it("PLAN-026: rejects update on non-existent planId with PlanNotFound", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      await expect(
        f.savingCore.connect(f.bankAdmin).updatePlan(0, 300)
      ).to.be.revertedWithCustomError(f.savingCore, "PlanNotFound").withArgs(0n);

      await expect(
        f.savingCore.connect(f.bankAdmin).updatePlan(2, 300)
      ).to.be.revertedWithCustomError(f.savingCore, "PlanNotFound").withArgs(2n);
    });

    it("PLAN-027: rejects APR exceeding 10000 with InvalidApr(10001)", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      await expect(
        f.savingCore.connect(f.bankAdmin).updatePlan(1, 10001)
      ).to.be.revertedWithCustomError(f.savingCore, "InvalidApr").withArgs(10001n);
    });

    it("PLAN-028: allows updating APR to boundary values 0 and 10000", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      await f.savingCore.connect(f.bankAdmin).updatePlan(1, 0);
      expect((await f.savingCore.getPlan(1)).aprBps).to.equal(0);

      await f.savingCore.connect(f.bankAdmin).updatePlan(1, 10000);
      expect((await f.savingCore.getPlan(1)).aprBps).to.equal(10000);
    });

    it("PLAN-029: allows updating APR on a disabled plan", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 0n, 0n, 350, false);
      expect((await f.savingCore.getPlan(1)).enabled).to.equal(false);

      await f.savingCore.connect(f.bankAdmin).updatePlan(1, 500);
      const plan = await f.savingCore.getPlan(1);
      expect(plan.aprBps).to.equal(500);
      expect(plan.enabled).to.equal(false);
    });

    it("PLAN-030: updates only aprBps, leaving all other fields unaltered", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 100n, 5000n, 350, true);
      await f.savingCore.connect(f.bankAdmin).updatePlan(1, 400);

      const plan = await f.savingCore.getPlan(1);
      expect(plan.aprBps).to.equal(400);
      expect(plan.tenorDays).to.equal(180);
      expect(plan.minDeposit).to.equal(100n);
      expect(plan.maxDeposit).to.equal(5000n);
      expect(plan.earlyWithdrawPenaltyBps).to.equal(350);
      expect(plan.enabled).to.equal(true);
    });

    it("PLAN-031: emits PlanUpdated event with indexed planId and newAprBps", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      const tx = await f.savingCore.connect(f.bankAdmin).updatePlan(1, 550);
      await expect(tx)
        .to.emit(f.savingCore, "PlanUpdated")
        .withArgs(1n, 550n);
    });
  });

  describe("Group E: enablePlan / disablePlan", function () {
    it("PLAN-032: Bank Admin disables an enabled plan successfully", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      expect((await f.savingCore.getPlan(1)).enabled).to.equal(true);

      await f.savingCore.connect(f.bankAdmin).disablePlan(1);
      expect((await f.savingCore.getPlan(1)).enabled).to.equal(false);
    });

    it("PLAN-033: Bank Admin enables a disabled plan successfully", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      await f.savingCore.connect(f.bankAdmin).disablePlan(1);
      expect((await f.savingCore.getPlan(1)).enabled).to.equal(false);

      await f.savingCore.connect(f.bankAdmin).enablePlan(1);
      expect((await f.savingCore.getPlan(1)).enabled).to.equal(true);
    });

    it("PLAN-034: non-admin caller cannot enable or disable a plan", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      await expect(
        f.savingCore.connect(f.stranger).disablePlan(1)
      ).to.be.revertedWithCustomError(f.savingCore, "NotBankAdmin").withArgs(f.stranger.address);

      await expect(
        f.savingCore.connect(f.stranger).enablePlan(1)
      ).to.be.revertedWithCustomError(f.savingCore, "NotBankAdmin").withArgs(f.stranger.address);
    });

    it("PLAN-035: rejects enable or disable on non-existent planId with PlanNotFound", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      await expect(
        f.savingCore.connect(f.bankAdmin).disablePlan(0)
      ).to.be.revertedWithCustomError(f.savingCore, "PlanNotFound").withArgs(0n);

      await expect(
        f.savingCore.connect(f.bankAdmin).disablePlan(2)
      ).to.be.revertedWithCustomError(f.savingCore, "PlanNotFound").withArgs(2n);

      await expect(
        f.savingCore.connect(f.bankAdmin).enablePlan(0)
      ).to.be.revertedWithCustomError(f.savingCore, "PlanNotFound").withArgs(0n);

      await expect(
        f.savingCore.connect(f.bankAdmin).enablePlan(2)
      ).to.be.revertedWithCustomError(f.savingCore, "PlanNotFound").withArgs(2n);
    });

    it("PLAN-036: calling disablePlan repeatedly succeeds and emits event", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      await f.savingCore.connect(f.bankAdmin).disablePlan(1);
      const tx = await f.savingCore.connect(f.bankAdmin).disablePlan(1);
      await expect(tx)
        .to.emit(f.savingCore, "PlanEnabledChanged")
        .withArgs(1n, false);
      expect((await f.savingCore.getPlan(1)).enabled).to.equal(false);
    });

    it("PLAN-037: calling enablePlan repeatedly succeeds and emits event", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      const tx = await f.savingCore.connect(f.bankAdmin).enablePlan(1);
      await expect(tx)
        .to.emit(f.savingCore, "PlanEnabledChanged")
        .withArgs(1n, true);
      expect((await f.savingCore.getPlan(1)).enabled).to.equal(true);
    });

    it("PLAN-038: planCount does not change when enabling or disabling plans", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      expect(await f.savingCore.planCount()).to.equal(1n);
      await f.savingCore.connect(f.bankAdmin).disablePlan(1);
      expect(await f.savingCore.planCount()).to.equal(1n);
      await f.savingCore.connect(f.bankAdmin).enablePlan(1);
      expect(await f.savingCore.planCount()).to.equal(1n);
    });

    it("PLAN-039: enabling/disabling leaves tenor, APR, penalty, and limits unchanged", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 50n, 1000n, 350, true);
      await f.savingCore.connect(f.bankAdmin).disablePlan(1);

      const plan = await f.savingCore.getPlan(1);
      expect(plan.tenorDays).to.equal(180);
      expect(plan.aprBps).to.equal(200);
      expect(plan.minDeposit).to.equal(50n);
      expect(plan.maxDeposit).to.equal(1000n);
      expect(plan.earlyWithdrawPenaltyBps).to.equal(350);
      expect(plan.enabled).to.equal(false);
    });

    it("PLAN-040: emits PlanEnabledChanged with indexed planId and status boolean", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      const txDisable = await f.savingCore.connect(f.bankAdmin).disablePlan(1);
      await expect(txDisable)
        .to.emit(f.savingCore, "PlanEnabledChanged")
        .withArgs(1n, false);

      const txEnable = await f.savingCore.connect(f.bankAdmin).enablePlan(1);
      await expect(txEnable)
        .to.emit(f.savingCore, "PlanEnabledChanged")
        .withArgs(1n, true);
    });
  });

  describe("Group F: Access Control & Dynamic Ownership", function () {
    it("PLAN-041: Bank Admin distinct from deployer has management authority; deployer is rejected", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      expect(f.bankAdmin.address).not.to.equal(f.deployer.address);

      // Deployer is not Vault owner, should be rejected
      await expect(
        f.savingCore.connect(f.deployer).createPlan(180, 200, 0n, 0n, 350, true)
      ).to.be.revertedWithCustomError(f.savingCore, "NotBankAdmin").withArgs(f.deployer.address);

      // Bank Admin is Vault owner, succeeds
      const tx = await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 0n, 0n, 350, true);
      await tx.wait();
      expect(await f.savingCore.planCount()).to.equal(1n);
    });

    it("PLAN-042: Vault ownership transfers to newAdmin via transferOwnership", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      await f.vault.connect(f.bankAdmin).transferOwnership(f.newAdmin.address);
      expect(await f.vault.owner()).to.equal(f.newAdmin.address);
    });

    it("PLAN-043: newAdmin immediately possesses plan management permissions in SavingCore", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      await f.vault.connect(f.bankAdmin).transferOwnership(f.newAdmin.address);

      // newAdmin can create plan
      const txCreate = await f.savingCore.connect(f.newAdmin).createPlan(90, 150, 0n, 0n, 200, true);
      await txCreate.wait();
      expect(await f.savingCore.planCount()).to.equal(2n);

      // newAdmin can update plan
      const txUpdate = await f.savingCore.connect(f.newAdmin).updatePlan(1, 300);
      await txUpdate.wait();
      expect((await f.savingCore.getPlan(1)).aprBps).to.equal(300);

      // newAdmin can disable and enable plan
      const txDisable = await f.savingCore.connect(f.newAdmin).disablePlan(1);
      await txDisable.wait();
      expect((await f.savingCore.getPlan(1)).enabled).to.equal(false);

      const txEnable = await f.savingCore.connect(f.newAdmin).enablePlan(1);
      await txEnable.wait();
      expect((await f.savingCore.getPlan(1)).enabled).to.equal(true);
    });

    it("PLAN-044: oldAdmin immediately loses plan management permissions in SavingCore", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      await f.vault.connect(f.bankAdmin).transferOwnership(f.newAdmin.address);

      // oldAdmin attempts should revert with NotBankAdmin(bankAdmin.address)
      await expect(
        f.savingCore.connect(f.bankAdmin).createPlan(60, 100, 0n, 0n, 100, true)
      ).to.be.revertedWithCustomError(f.savingCore, "NotBankAdmin").withArgs(f.bankAdmin.address);

      await expect(
        f.savingCore.connect(f.bankAdmin).updatePlan(1, 400)
      ).to.be.revertedWithCustomError(f.savingCore, "NotBankAdmin").withArgs(f.bankAdmin.address);

      await expect(
        f.savingCore.connect(f.bankAdmin).disablePlan(1)
      ).to.be.revertedWithCustomError(f.savingCore, "NotBankAdmin").withArgs(f.bankAdmin.address);

      await expect(
        f.savingCore.connect(f.bankAdmin).enablePlan(1)
      ).to.be.revertedWithCustomError(f.savingCore, "NotBankAdmin").withArgs(f.bankAdmin.address);
    });

    it("PLAN-045: plan management functions operate properly even when VaultManager is paused", async function () {
      const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
      await f.vault.connect(f.bankAdmin).pause();
      expect(await f.vault.paused()).to.equal(true);

      // Creating a plan while Vault is paused succeeds
      const txCreate = await f.savingCore.connect(f.bankAdmin).createPlan(60, 100, 0n, 0n, 100, true);
      await txCreate.wait();
      expect(await f.savingCore.planCount()).to.equal(2n);

      // Updating a plan while Vault is paused succeeds
      const txUpdate = await f.savingCore.connect(f.bankAdmin).updatePlan(1, 250);
      await txUpdate.wait();

      // Disabling and enabling while Vault is paused succeeds
      const txDisable = await f.savingCore.connect(f.bankAdmin).disablePlan(1);
      await txDisable.wait();
      expect((await f.savingCore.getPlan(1)).enabled).to.equal(false);

      const txEnable = await f.savingCore.connect(f.bankAdmin).enablePlan(1);
      await txEnable.wait();
      expect((await f.savingCore.getPlan(1)).enabled).to.equal(true);

      // Read-only getPlan succeeds while paused
      const plan = await f.savingCore.getPlan(1);
      expect(plan.aprBps).to.equal(250);
    });

    it("PLAN-046: plan management functions operate before SavingCore is bound in VaultManager", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      // Verify vault.savingCore() is zero (unbound)
      expect(await f.vault.savingCore()).to.equal(ethers.ZeroAddress);

      // Plan operations succeed before binding
      const txCreate = await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 0n, 0n, 350, true);
      await txCreate.wait();
      expect(await f.savingCore.planCount()).to.equal(1n);

      const txUpdate = await f.savingCore.connect(f.bankAdmin).updatePlan(1, 300);
      await txUpdate.wait();

      const txDisable = await f.savingCore.connect(f.bankAdmin).disablePlan(1);
      await txDisable.wait();
      expect((await f.savingCore.getPlan(1)).enabled).to.equal(false);

      const txEnable = await f.savingCore.connect(f.bankAdmin).enablePlan(1);
      await txEnable.wait();
      expect((await f.savingCore.getPlan(1)).enabled).to.equal(true);

      const plan = await f.savingCore.getPlan(1);
      expect(plan.aprBps).to.equal(300);
      expect(plan.enabled).to.equal(true);
    });
  });
});
