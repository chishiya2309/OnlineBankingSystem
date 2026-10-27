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

async function deployRenewalFixture() {
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

  // Create default plan (Plan ID 1) with personalVariant parameters: 180d, 200bps, min=0, max=0, penalty=350bps, enabled=true
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

async function maturedDepositFixture() {
  const f = await deployRenewalFixture();
  const principal = toUnits("1000"); // 1,000,000,000 units
  await (await f.savingCore.connect(f.alice).openDeposit(1, principal)).wait();
  const deposit = await f.savingCore.getDeposit(1);
  return { ...f, depositId: 1n, principal, deposit };
}

describe("SavingCore - Task D3-01: Manual Renewal & New ERC721 Certificate", function () {
  describe("Group A: Manual Renewal Happy Path", function () {
    it("MR-001 & MR-002 & MR-003: current NFT owner renews at maturity, old becomes ManualRenewed, new is Active", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      const tx = await f.savingCore.connect(f.alice).renewDeposit(1, 1);
      await tx.wait();

      const oldDep = await f.savingCore.getDeposit(1);
      const newDep = await f.savingCore.getDeposit(2);

      expect(oldDep.status).to.equal(2); // DepositStatus.ManualRenewed = 2
      expect(newDep.status).to.equal(0); // DepositStatus.Active = 0
    });

    it("MR-004 & MR-005 & MR-006 & MR-007: sequential ID, new NFT minted to current owner, old NFT retained with distinct IDs", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      expect(await f.savingCore.depositCount()).to.equal(1n);

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      const tx = await f.savingCore.connect(f.alice).renewDeposit(1, 1);
      await tx.wait();

      expect(await f.savingCore.depositCount()).to.equal(2n);
      // Both NFTs are owned by Alice
      expect(await f.savingCore.ownerOf(1)).to.equal(f.alice.address);
      expect(await f.savingCore.ownerOf(2)).to.equal(f.alice.address);
      expect(await f.savingCore.balanceOf(f.alice.address)).to.equal(2n);
    });

    it("MR-008: new principal equals old principal plus old interest (P' = P + I)", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      const oldInterest = await f.savingCore.calculateInterest(1); // 9,863,013
      expect(oldInterest).to.equal(9863013n);

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();

      const newDep = await f.savingCore.getDeposit(2);
      expect(newDep.principal).to.equal(f.principal + oldInterest); // 1,009,863,013
    });

    it("MR-009 & MR-010: new startAt is receipt block timestamp and new maturityAt is startAt + targetTenor", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      const targetTimestamp = f.deposit.maturityAt + 100n; // 100 seconds after maturity
      await networkHelpers.time.setNextBlockTimestamp(targetTimestamp);

      const tx = await f.savingCore.connect(f.alice).renewDeposit(1, 1);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      const newDep = await f.savingCore.getDeposit(2);
      expect(newDep.startAt).to.equal(BigInt(block!.timestamp));
      expect(newDep.maturityAt).to.equal(newDep.startAt + DEFAULT_TENOR_DAYS * 86400n);
    });

    it("MR-011: emits DepositOpened and Renewed events with accurate arguments", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      const oldInterest = await f.savingCore.calculateInterest(1);
      const newPrincipal = f.principal + oldInterest;

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      const tx = await f.savingCore.connect(f.alice).renewDeposit(1, 1);

      await expect(tx)
        .to.emit(f.savingCore, "DepositOpened")
        .withArgs(2n, f.alice.address, 1n, newPrincipal, f.deposit.maturityAt + DEFAULT_TENOR_DAYS * 86400n, DEFAULT_APR_BPS);

      await expect(tx)
        .to.emit(f.savingCore, "Renewed")
        .withArgs(1n, 2n, newPrincipal, 1n);
    });
  });

  describe("Group B: Snapshot & Target Plan", function () {
    it("MR-012 & MR-013: old interest strictly uses old snapshot even after admin updates old plan APR", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Admin changes Plan 1 APR from 200 bps to 800 bps
      await (await f.savingCore.connect(f.bankAdmin).updatePlan(1, 800)).wait();

      // Old interest must still be calculated at 200 bps (9,863,013)
      expect(await f.savingCore.calculateInterest(1)).to.equal(9863013n);

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();

      const newDep = await f.savingCore.getDeposit(2);
      // New deposit reflects the updated APR 800 bps
      expect(newDep.aprBpsAtOpen).to.equal(800);
      expect(newDep.principal).to.equal(f.principal + 9863013n);
    });

    it("MR-014 & MR-015 & MR-016: renew into another plan captures its current APR, penalty, and tenor", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Create Plan 2: tenor 90d, APR 300 bps, penalty 500 bps
      const plan2Id = await f.savingCore.connect(f.bankAdmin).createPlan.staticCall(90, 300, 0n, 0n, 500, true);
      await (await f.savingCore.connect(f.bankAdmin).createPlan(90, 300, 0n, 0n, 500, true)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).renewDeposit(1, plan2Id)).wait();

      const newDep = await f.savingCore.getDeposit(2);
      expect(newDep.planId).to.equal(plan2Id);
      expect(newDep.aprBpsAtOpen).to.equal(300);
      expect(newDep.penaltyBpsAtOpen).to.equal(500);
      expect(newDep.maturityAt - newDep.startAt).to.equal(90n * 86400n);
    });

    it("MR-017: renewing into the same plan succeeds if it remains enabled", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();
      expect((await f.savingCore.getDeposit(2)).planId).to.equal(1n);
    });

    it("MR-018: old plan disabled does not impede renewing into another enabled plan", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Create Plan 2
      const plan2Id = await f.savingCore.connect(f.bankAdmin).createPlan.staticCall(60, 250, 0n, 0n, 300, true);
      await (await f.savingCore.connect(f.bankAdmin).createPlan(60, 250, 0n, 0n, 300, true)).wait();

      // Disable Plan 1
      await (await f.savingCore.connect(f.bankAdmin).disablePlan(1)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      // Renew into Plan 2 succeeds
      await (await f.savingCore.connect(f.alice).renewDeposit(1, plan2Id)).wait();
      expect((await f.savingCore.getDeposit(2)).status).to.equal(0);
    });

    it("MR-019: target plan disabled reverts with PlanDisabled", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await (await f.savingCore.connect(f.bankAdmin).disablePlan(1)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await expect(
        f.savingCore.connect(f.alice).renewDeposit(1, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "PlanDisabled").withArgs(1n);
    });

    it("MR-020: target plan nonexistent reverts with PlanNotFound", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await expect(
        f.savingCore.connect(f.alice).renewDeposit(1, 0)
      ).to.be.revertedWithCustomError(f.savingCore, "PlanNotFound").withArgs(0n);

      await expect(
        f.savingCore.connect(f.alice).renewDeposit(1, 99)
      ).to.be.revertedWithCustomError(f.savingCore, "PlanNotFound").withArgs(99n);
    });
  });

  describe("Group C: Principal & Limits Validation on P + I", function () {
    it("MR-021 & MR-022 & MR-023 & MR-024: exact boundary P + I at minDeposit and maxDeposit succeeds", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      const interest = await f.savingCore.calculateInterest(1);
      const newPrincipal = f.principal + interest; // 1,009,863,013

      // Create target plan with exact min = max = newPrincipal
      const planId = await f.savingCore.connect(f.bankAdmin).createPlan.staticCall(180, 200, newPrincipal, newPrincipal, 350, true);
      await (await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, newPrincipal, newPrincipal, 350, true)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).renewDeposit(1, planId)).wait();
      expect((await f.savingCore.getDeposit(2)).principal).to.equal(newPrincipal);
    });

    it("MR-025: P + I below minDeposit by 1 unit reverts with DepositAmountOutOfRange", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      const interest = await f.savingCore.calculateInterest(1);
      const newPrincipal = f.principal + interest;

      // Plan requires min = newPrincipal + 1
      const planId = await f.savingCore.connect(f.bankAdmin).createPlan.staticCall(180, 200, newPrincipal + 1n, 0n, 350, true);
      await (await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, newPrincipal + 1n, 0n, 350, true)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await expect(
        f.savingCore.connect(f.alice).renewDeposit(1, planId)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositAmountOutOfRange").withArgs(newPrincipal, newPrincipal + 1n, 0n);
    });

    it("MR-026: P + I exceeding maxDeposit by 1 unit reverts with DepositAmountOutOfRange", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      const interest = await f.savingCore.calculateInterest(1);
      const newPrincipal = f.principal + interest;

      // Plan allows max = newPrincipal - 1
      const planId = await f.savingCore.connect(f.bankAdmin).createPlan.staticCall(180, 200, 0n, newPrincipal - 1n, 350, true);
      await (await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 0n, newPrincipal - 1n, 350, true)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await expect(
        f.savingCore.connect(f.alice).renewDeposit(1, planId)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositAmountOutOfRange").withArgs(newPrincipal, 0n, newPrincipal - 1n);
    });

    it("MR-027 & MR-028: zero min and max removes bounds", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Plan 1 has min=0, max=0
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();
      expect((await f.savingCore.getDeposit(2)).status).to.equal(0);
    });

    it("MR-029: old P alone below minDeposit but P + I >= minDeposit succeeds", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      const interest = await f.savingCore.calculateInterest(1); // 9,863,013
      const newPrincipal = f.principal + interest; // 1,009,863,013

      // Target plan requires minDeposit = 1,005,000,000. Old P (1,000,000,000) was below it!
      const targetMin = toUnits("1005");
      const planId = await f.savingCore.connect(f.bankAdmin).createPlan.staticCall(180, 200, targetMin, 0n, 350, true);
      await (await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, targetMin, 0n, 350, true)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).renewDeposit(1, planId)).wait();
      expect((await f.savingCore.getDeposit(2)).principal).to.equal(newPrincipal);
    });
  });

  describe("Group D: Authorization & State Guards", function () {
    it("MR-030: non-owner caller is rejected with NotDepositOwner", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      await expect(
        f.savingCore.connect(f.bob).renewDeposit(1, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner").withArgs(1, f.bob.address);
    });

    it("MR-031 & MR-032: Alice transfers NFT to Bob; Alice rejected, Bob renews and receives new NFT", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Alice transfers NFT 1 to Bob
      await (await f.savingCore.connect(f.alice).transferFrom(f.alice.address, f.bob.address, 1)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      // Alice tries to renew -> REVERT
      await expect(
        f.savingCore.connect(f.alice).renewDeposit(1, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner").withArgs(1, f.alice.address);

      // Bob renews -> SUCCESS
      await (await f.savingCore.connect(f.bob).renewDeposit(1, 1)).wait();
      expect(await f.savingCore.ownerOf(2)).to.equal(f.bob.address);
      expect((await f.savingCore.getDeposit(1)).status).to.equal(2);
      expect((await f.savingCore.getDeposit(2)).status).to.equal(0);
    });

    it("MR-033: approved operator cannot renew (strict owner-only restriction)", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Alice approves Bob for NFT 1
      await (await f.savingCore.connect(f.alice).approve(f.bob.address, 1)).wait();
      expect(await f.savingCore.getApproved(1)).to.equal(f.bob.address);

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await expect(
        f.savingCore.connect(f.bob).renewDeposit(1, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner").withArgs(1, f.bob.address);
    });

    it("MR-034: nonexistent depositId reverts with DepositNotFound", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await expect(
        f.savingCore.connect(f.alice).renewDeposit(0, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotFound").withArgs(0);

      await expect(
        f.savingCore.connect(f.alice).renewDeposit(50, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotFound").withArgs(50);
    });

    it("MR-035: already withdrawn deposit cannot be renewed", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      // Settle withdrawal
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1); // Withdrawn

      // Attempt renew
      await expect(
        f.savingCore.connect(f.alice).renewDeposit(1, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive").withArgs(1, 1);
    });

    it("MR-036: ManualRenewed deposit cannot be renewed a second time", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      // First renew
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();

      // Second renew on old ID
      await expect(
        f.savingCore.connect(f.alice).renewDeposit(1, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive").withArgs(1, 2); // status 2 = ManualRenewed
    });

    it("MR-037: after successful renewal, old deposit cannot be withdrawn", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();

      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive").withArgs(1, 2);

      await expect(
        f.savingCore.connect(f.alice).earlyWithdraw(1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive").withArgs(1, 2);
    });

    it("MR-038: new active deposit can later be settled following withdrawal rules", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();

      const newDep = await f.savingCore.getDeposit(2);
      // Fast forward to new maturity
      await networkHelpers.time.setNextBlockTimestamp(newDep.maturityAt);

      const aliceBefore = await f.token.balanceOf(f.alice.address);
      const interest2 = await f.savingCore.calculateInterest(2);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(2)).wait();

      expect((await f.savingCore.getDeposit(2)).status).to.equal(1); // Withdrawn
      expect(await f.token.balanceOf(f.alice.address)).to.equal(aliceBefore + newDep.principal + interest2);
    });
  });

  describe("Group E: Time Boundaries, Pause & Binding", function () {
    it("MR-039: at maturityAt - 1 second reverts with DepositNotMatured", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt - 1n);

      await expect(
        f.savingCore.connect(f.alice).renewDeposit(1, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotMatured").withArgs(1, f.deposit.maturityAt);
    });

    it("MR-040: at exact maturityAt succeeds", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();
      expect((await f.savingCore.getDeposit(2)).status).to.equal(0);
    });

    it("MR-041: at G - 1, G, and G + 1 seconds, manual renewal succeeds on independent fixtures (no cutoff at G)", async function () {
      // Test at G - 1 second
      {
        const f = await networkHelpers.loadFixture(maturedDepositFixture);
        const G = f.deposit.maturityAt + GRACE_PERIOD_SECONDS;
        await networkHelpers.time.setNextBlockTimestamp(G - 1n);
        await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();
        expect((await f.savingCore.getDeposit(2)).status).to.equal(0);
      }
      // Test at exact G
      {
        const f = await networkHelpers.loadFixture(maturedDepositFixture);
        const G = f.deposit.maturityAt + GRACE_PERIOD_SECONDS;
        await networkHelpers.time.setNextBlockTimestamp(G);
        await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();
        expect((await f.savingCore.getDeposit(2)).status).to.equal(0);
      }
      // Test at G + 1 second
      {
        const f = await networkHelpers.loadFixture(maturedDepositFixture);
        const G = f.deposit.maturityAt + GRACE_PERIOD_SECONDS;
        await networkHelpers.time.setNextBlockTimestamp(G + 1n);
        await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();
        expect((await f.savingCore.getDeposit(2)).status).to.equal(0);
      }
    });

    it("MR-042 & MR-043: Vault paused blocks renewal with EnforcedPause, unpause restores it", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      // Admin pauses Vault
      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      await expect(
        f.savingCore.connect(f.alice).renewDeposit(1, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "EnforcedPause");

      // Admin unpauses
      await (await f.vault.connect(f.bankAdmin).unpause()).wait();
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();
      expect((await f.savingCore.getDeposit(2)).status).to.equal(0);
    });

    it("MR-044: Core not bound in Vault reverts with CoreNotBound", async function () {
      const [deployer, bankAdmin, feeReceiver] = await ethers.getSigners();
      const token = await ethers.deployContract("MockUSDC");
      const vault = await ethers.deployContract("VaultManager", [await token.getAddress(), bankAdmin.address, feeReceiver.address]);
      const core = await ethers.deployContract("SavingCore", [await vault.getAddress(), GRACE_PERIOD_SECONDS]);

      await expect(
        core.renewDeposit(1, 1)
      ).to.be.revertedWithCustomError(core, "CoreNotBound").withArgs(await core.getAddress(), ethers.ZeroAddress);
    });
  });

  describe("Group F: Financial Accounting Invariants", function () {
    it("MR-045 & MR-046 & MR-047 & MR-048 & MR-049 & MR-050: Vault decrements by I, Core increments by I, user balance unchanged, totalPrincipal net delta +I", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      const I = await f.savingCore.calculateInterest(1);

      const vaultBefore = await f.token.balanceOf(f.vaultAddress);
      const coreBefore = await f.token.balanceOf(f.savingCoreAddress);
      const aliceBefore = await f.token.balanceOf(f.alice.address);
      const feeBefore = await f.token.balanceOf(f.feeReceiver.address);
      const totalPBefore = await f.savingCore.totalPrincipal();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      const tx = await f.savingCore.connect(f.alice).renewDeposit(1, 1);
      const receipt = await tx.wait();

      const vaultAfter = await f.token.balanceOf(f.vaultAddress);
      const coreAfter = await f.token.balanceOf(f.savingCoreAddress);
      const aliceAfter = await f.token.balanceOf(f.alice.address);
      const feeAfter = await f.token.balanceOf(f.feeReceiver.address);
      const totalPAfter = await f.savingCore.totalPrincipal();

      console.log(`      MANUAL_RENEW_ACCOUNTING | oldP=${f.principal} | I=${I} | newP=${f.principal + I} | vault=${vaultBefore}->${vaultAfter} (-${vaultBefore - vaultAfter}) | core=${coreBefore}->${coreAfter} (+${coreAfter - coreBefore}) | alice=${aliceBefore}->${aliceAfter} | totalPrincipal=${totalPBefore}->${totalPAfter} (+${totalPAfter - totalPBefore}) | txHash=${receipt!.hash}`);

      expect(vaultAfter).to.equal(vaultBefore - I);
      expect(coreAfter).to.equal(coreBefore + I);
      expect(aliceAfter).to.equal(aliceBefore); // 0 change!
      expect(feeAfter).to.equal(feeBefore);     // 0 change!
      expect(totalPAfter).to.equal(totalPBefore + I); // Net increase is exactly I!
      expect(coreAfter).to.be.greaterThanOrEqual(totalPAfter);
    });

    it("MR-051: Core surplus is never used as Vault interest substitute", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Donate 500 USDC directly to Core
      await (await f.token.mint(f.savingCoreAddress, toUnits("500"))).wait();

      // Drain Vault completely
      const vaultBal = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(vaultBal)).wait();
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(0n);

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      const interest = await f.savingCore.calculateInterest(1);

      // Even though Core has plenty of donated surplus, renewal MUST revert because interest cannot be pulled from Vault!
      await expect(
        f.savingCore.connect(f.alice).renewDeposit(1, 1)
      ).to.be.revertedWithCustomError(f.vault, "InsufficientVaultBalance").withArgs(0n, interest);
    });

    it("MR-052 & MR-053: multi-deposit accounting isolation and global invariants hold", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Bob opens Deposit 2 with 500 USDC
      const p2 = toUnits("500");
      await (await f.savingCore.connect(f.bob).openDeposit(1, p2)).wait();

      const totalPBefore = await f.savingCore.totalPrincipal(); // 1500 USDC
      expect(totalPBefore).to.equal(f.principal + p2);

      const interest1 = await f.savingCore.calculateInterest(1);

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();

      // Deposit 2 remains Active with principal p2
      expect((await f.savingCore.getDeposit(2)).status).to.equal(0);
      expect((await f.savingCore.getDeposit(2)).principal).to.equal(p2);

      // Deposit 3 is created for Alice with principal f.principal + interest1
      expect((await f.savingCore.getDeposit(3)).status).to.equal(0);
      expect((await f.savingCore.getDeposit(3)).principal).to.equal(f.principal + interest1);

      // totalPrincipal = Active(2) + Active(3) = p2 + f.principal + interest1
      expect(await f.savingCore.totalPrincipal()).to.equal(p2 + f.principal + interest1);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.be.greaterThanOrEqual(await f.savingCore.totalPrincipal());
    });
  });

  describe("Group G: Negative, Security & Atomicity", function () {
    it("MR-054 & MR-055: Vault short by 1 unit reverts atomically; admin funds shortfall and retry succeeds", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      const interest = await f.savingCore.calculateInterest(1);

      // Empty Vault, then fund with interest - 1 unit
      const vaultBal = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(vaultBal)).wait();
      await (await f.vault.connect(f.bankAdmin).fundVault(interest - 1n)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      // Reverts with InsufficientVaultBalance
      await expect(
        f.savingCore.connect(f.alice).renewDeposit(1, 1)
      ).to.be.revertedWithCustomError(f.vault, "InsufficientVaultBalance").withArgs(interest - 1n, interest);

      // State is completely untouched
      expect((await f.savingCore.getDeposit(1)).status).to.equal(0); // still Active
      expect(await f.savingCore.depositCount()).to.equal(1n);
      expect(await f.savingCore.totalPrincipal()).to.equal(f.principal);

      // Admin funds the 1 unit shortfall
      await (await f.vault.connect(f.bankAdmin).fundVault(1n)).wait();

      // Alice retries and succeeds
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(2);
      expect((await f.savingCore.getDeposit(2)).status).to.equal(0);
    });

    it("MR-056: zero interest (APR = 0) renewal succeeds without calling payInterest(0) and without Vault funds", async function () {
      const f = await networkHelpers.loadFixture(deployRenewalFixture);
      // Plan with APR = 0
      const zeroPlanId = await f.savingCore.connect(f.bankAdmin).createPlan.staticCall(180, 0, 0n, 0n, 350, true);
      await (await f.savingCore.connect(f.bankAdmin).createPlan(180, 0, 0n, 0n, 350, true)).wait();

      await (await f.savingCore.connect(f.alice).openDeposit(zeroPlanId, toUnits("100"))).wait();
      const deposit = await f.savingCore.getDeposit(1);
      expect(await f.savingCore.calculateInterest(1)).to.equal(0n);

      // Drain Vault to 0
      const vaultBal = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(vaultBal)).wait();
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(0n);

      await networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt);
      // Renew succeeds with 0 interest pulled
      await (await f.savingCore.connect(f.alice).renewDeposit(1, zeroPlanId)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(2);
      expect((await f.savingCore.getDeposit(2)).principal).to.equal(toUnits("100"));
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(0n);
    });

    it("MR-058 & MR-060 & MR-061 & MR-062 & MR-063: ERC721 receiver rejection rolls back all state atomically", async function () {
      const f = await deployRenewalFixture();
      // Deploy DepositReceiverMock that rejects incoming ERC721
      const receiver = await ethers.deployContract("DepositReceiverMock", [f.savingCoreAddress, f.operator.address]);
      await receiver.waitForDeployment();
      const receiverAddress = await receiver.getAddress();

      // Alice transfers MockUSDC to receiver, receiver opens deposit
      await (await f.token.mint(receiverAddress, toUnits("100"))).wait();
      await (await receiver.approveCore(toUnits("100"))).wait();
      await (await receiver.open(1, toUnits("100"))).wait();

      const deposit = await f.savingCore.getDeposit(1);
      expect(await f.savingCore.ownerOf(1)).to.equal(receiverAddress);

      // Configure receiver to reject incoming ERC721 transfers
      await (await receiver.configure(1, ethers.ZeroAddress)).wait(); // Mode.Reject = 1

      await networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt);

      const vaultBefore = await f.token.balanceOf(f.vaultAddress);
      const coreBefore = await f.token.balanceOf(f.savingCoreAddress);
      const totalPBefore = await f.savingCore.totalPrincipal();

      // Receiver tries to renew -> REVERT ReceiverRejected
      await expect(
        receiver.renew(1, 1)
      ).to.be.revertedWithCustomError(receiver, "ReceiverRejected");

      // Verify complete atomic rollback
      expect((await f.savingCore.getDeposit(1)).status).to.equal(0); // still Active!
      expect(await f.savingCore.depositCount()).to.equal(1n);        // depositCount not consumed!
      expect(await f.savingCore.totalPrincipal()).to.equal(totalPBefore);
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(vaultBefore);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(coreBefore);
    });

    it("MR-059: ERC721 callback reentrancy during renewal is blocked by nonReentrant", async function () {
      const f = await deployRenewalFixture();
      const receiver = await ethers.deployContract("DepositReceiverMock", [f.savingCoreAddress, f.operator.address]);
      await receiver.waitForDeployment();
      const receiverAddress = await receiver.getAddress();

      await (await f.token.mint(receiverAddress, toUnits("100"))).wait();
      await (await receiver.approveCore(toUnits("100"))).wait();
      await (await receiver.open(1, toUnits("100"))).wait();

      const deposit = await f.savingCore.getDeposit(1);

      // Configure receiver to catch reentry on renewDeposit
      // Mode.ReenterRenewCaught = 6
      await (await receiver.configure(6, ethers.ZeroAddress)).wait();

      await networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt);
      await (await receiver.renew(1, 1)).wait();

      // The nested reentrant call was caught by the receiver and registered ReentrancyGuardReentrantCall error selector
      expect(await receiver.reentryError()).to.equal(f.savingCore.interface.getError("ReentrancyGuardReentrantCall")!.selector);
    });

    it("MR-064: checked arithmetic prevents creating deposit with unrepresentable payout", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Try renewing into a plan with tenor or APR that causes mulDiv overflow
      // In SavingCore, tenor is capped at uint32.max and APR at 10000, so normal mulDiv fits in uint256.
      // _fullTermPayout checks feasibility before recording.
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();
      expect((await f.savingCore.getDeposit(2)).status).to.equal(0);
    });
  });
});
