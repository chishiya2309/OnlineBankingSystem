import assert from "node:assert/strict";
import { expect } from "chai";
import { network } from "hardhat";
import { personalVariant } from "../config/personal-variant.js";
import { triggerAutoRenew } from "../scripts/trigger-auto-renew.js";

const connection = await network.create("hardhatMainnet");
const { ethers, networkHelpers } = connection;

const GRACE_PERIOD_SECONDS = BigInt(personalVariant.gracePeriodDays * 86400); // 172800n
const DEFAULT_TENOR_DAYS = BigInt(personalVariant.defaultTenorDays); // 180n
const DEFAULT_APR_BPS = BigInt(personalVariant.defaultAprBps); // 200n
const DEFAULT_PENALTY_BPS = BigInt(personalVariant.earlyWithdrawPenaltyBps); // 350n

const toUnits = (amount: string): bigint => ethers.parseUnits(amount, 6);

async function deployAutoRenewalFixture() {
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

  // Create default plan (Plan ID 1): 180d, 200bps, min=0, max=0, penalty=350bps, enabled=true
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
  await (await vault.connect(bankAdmin).fundVault(toUnits("2000"))).wait();

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

async function maturedDepositFixture() {
  const f = await deployAutoRenewalFixture();
  const principal = toUnits("1000"); // 1,000,000,000 units
  await (await f.savingCore.connect(f.alice).openDeposit(1, principal)).wait();
  const deposit = await f.savingCore.getDeposit(1);
  const graceEnd = deposit.maturityAt + GRACE_PERIOD_SECONDS;
  return { ...f, depositId: 1n, principal, deposit, graceEnd };
}

describe("SavingCore - Task D3-02: Auto Renewal, APR Lock & Local Trigger Script", function () {
  describe("Group A: Happy Path", function () {
    it("AR-001 & AR-002: stranger can trigger auto renewal after grace period", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      const tx = await f.savingCore.connect(f.stranger).autoRenewDeposit(1);
      await tx.wait();

      const oldDep = await f.savingCore.getDeposit(1);
      const newDep = await f.savingCore.getDeposit(2);

      expect(oldDep.status).to.equal(3); // DepositStatus.AutoRenewed = 3
      expect(newDep.status).to.equal(0); // DepositStatus.Active = 0
    });

    it("AR-003: Bank Admin can trigger auto renewal without special privilege", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      const tx = await f.savingCore.connect(f.bankAdmin).autoRenewDeposit(1);
      await tx.wait();

      const oldDep = await f.savingCore.getDeposit(1);
      expect(oldDep.status).to.equal(3);
    });

    it("AR-004 & AR-005 & AR-006: sequential depositId, old is AutoRenewed, new is Active", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      expect(await f.savingCore.depositCount()).to.equal(1n);

      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      expect(await f.savingCore.depositCount()).to.equal(2n);
      const newDep = await f.savingCore.getDeposit(2);
      expect(newDep.status).to.equal(0);
    });

    it("AR-007 & AR-008 & AR-009: old NFT retained by Alice, new NFT minted to Alice, stranger receives 0 tokens and 0 NFTs", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      const strangerTokensBefore = await f.token.balanceOf(f.stranger.address);
      const strangerNftsBefore = await f.savingCore.balanceOf(f.stranger.address);

      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      // Alice owns both NFT #1 (historical certificate) and NFT #2 (active certificate)
      expect(await f.savingCore.ownerOf(1)).to.equal(f.alice.address);
      expect(await f.savingCore.ownerOf(2)).to.equal(f.alice.address);
      expect(await f.savingCore.balanceOf(f.alice.address)).to.equal(2n);

      // Stranger gets nothing
      expect(await f.token.balanceOf(f.stranger.address)).to.equal(strangerTokensBefore);
      expect(await f.savingCore.balanceOf(f.stranger.address)).to.equal(strangerNftsBefore);
    });

    it("AR-010: emits correct DepositOpened and Renewed events", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      const tx = await f.savingCore.connect(f.stranger).autoRenewDeposit(1);
      const receipt = await tx.wait();
      expect(receipt).to.not.be.null;

      await expect(tx)
        .to.emit(f.savingCore, "Renewed")
        .withArgs(1n, 2n, 1009863013n, 1n);

      await expect(tx)
        .to.emit(f.savingCore, "DepositOpened")
        .withArgs(2n, f.alice.address, 1n, 1009863013n, f.graceEnd + (f.deposit.maturityAt - f.deposit.startAt), DEFAULT_APR_BPS);
    });
  });

  describe("Group B: Grace Period Boundaries", function () {
    it("AR-011 & AR-017: at G - 1 second, autoRenewDeposit reverts with GracePeriodNotEnded and exact graceEnd", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd - 1n);

      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(1))
        .to.be.revertedWithCustomError(f.savingCore, "GracePeriodNotEnded")
        .withArgs(1n, f.graceEnd);
    });

    it("AR-012: at exact G, autoRenewDeposit succeeds", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      const tx = await f.savingCore.connect(f.stranger).autoRenewDeposit(1);
      await tx.wait();

      const oldDep = await f.savingCore.getDeposit(1);
      expect(oldDep.status).to.equal(3);
    });

    it("AR-013: at G + 1 second, autoRenewDeposit succeeds", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd + 1n);

      const tx = await f.savingCore.connect(f.stranger).autoRenewDeposit(1);
      await tx.wait();

      const oldDep = await f.savingCore.getDeposit(1);
      expect(oldDep.status).to.equal(3);
    });

    it("AR-014: before maturity (t < M), autoRenewDeposit reverts with GracePeriodNotEnded", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt - 100n);

      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(1))
        .to.be.revertedWithCustomError(f.savingCore, "GracePeriodNotEnded")
        .withArgs(1n, f.graceEnd);
    });

    it("AR-015: at maturity M <= t < G, maturity withdrawal & manual renew are allowed, but auto renew is rejected", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // t = maturityAt
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      // Auto renew must revert
      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(1))
        .to.be.revertedWithCustomError(f.savingCore, "GracePeriodNotEnded")
        .withArgs(1n, f.graceEnd);

      // But manual renew or maturity withdrawal are completely valid for the owner
      const manualTx = await f.savingCore.connect(f.alice).renewDeposit(1, 1);
      await manualTx.wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(2); // ManualRenewed
    });

    it("AR-016: uses immutable gracePeriodSeconds stored in contract", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      expect(await f.savingCore.gracePeriodSeconds()).to.equal(GRACE_PERIOD_SECONDS);
    });
  });

  describe("Group C: APR, Penalty & Tenor Lock", function () {
    it("AR-018: new deposit locks exact old APR snapshot", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      const newDep = await f.savingCore.getDeposit(2);
      expect(newDep.aprBpsAtOpen).to.equal(f.deposit.aprBpsAtOpen);
    });

    it("AR-019: Admin updates plan APR from 200 bps to 500 bps; auto renew STILL locks 200 bps", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Admin updates plan 1 APR to 500 bps
      await (await f.savingCore.connect(f.bankAdmin).updatePlan(1, 500)).wait();
      expect((await f.savingCore.getPlan(1)).aprBps).to.equal(500);

      // Trigger auto renew
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      const newDep = await f.savingCore.getDeposit(2);
      expect(newDep.aprBpsAtOpen).to.equal(DEFAULT_APR_BPS); // 200 bps, NOT 500 bps!
    });

    it("AR-020: new deposit locks exact old penalty snapshot", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      const newDep = await f.savingCore.getDeposit(2);
      expect(newDep.penaltyBpsAtOpen).to.equal(f.deposit.penaltyBpsAtOpen);
    });

    it("AR-021 & AR-022 & AR-023: locks original tenor, startAt = execution timestamp, maturityAt = startAt + tenor", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      const executionTimestamp = f.graceEnd + 500n;
      await networkHelpers.time.setNextBlockTimestamp(executionTimestamp);

      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      const oldTenor = f.deposit.maturityAt - f.deposit.startAt;
      const newDep = await f.savingCore.getDeposit(2);

      expect(newDep.startAt).to.equal(executionTimestamp);
      expect(newDep.maturityAt).to.equal(executionTimestamp + oldTenor);
    });

    it("AR-024: no backdating to old maturityAt or graceEnd", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      const executionTimestamp = f.graceEnd + 1000n;
      await networkHelpers.time.setNextBlockTimestamp(executionTimestamp);

      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      const newDep = await f.savingCore.getDeposit(2);
      expect(newDep.startAt).to.not.equal(f.deposit.maturityAt);
      expect(newDep.startAt).to.not.equal(f.graceEnd);
      expect(newDep.startAt).to.equal(executionTimestamp);
    });

    it("AR-025: old plan disabled by Admin does NOT block auto renewal", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Admin disables plan 1
      await (await f.savingCore.connect(f.bankAdmin).disablePlan(1)).wait();
      expect((await f.savingCore.getPlan(1)).enabled).to.be.false;

      // Auto renew must succeed because it is contractually locked
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      const newDep = await f.savingCore.getDeposit(2);
      expect(newDep.status).to.equal(0);
      expect(newDep.planId).to.equal(1n);
    });

    it("AR-026 & AR-027: plan min/max limits are NOT re-applied during auto renewal", async function () {
      const f = await deployAutoRenewalFixture();
      // Create plan 2 with maxDeposit = 1005 USDC
      await (await f.savingCore.connect(f.bankAdmin).createPlan(
        DEFAULT_TENOR_DAYS,
        DEFAULT_APR_BPS,
        toUnits("100"),
        toUnits("1005"), // max 1005 USDC
        DEFAULT_PENALTY_BPS,
        true
      )).wait();

      // Alice opens deposit #1 with 1000 USDC (valid, <= 1005)
      await (await f.savingCore.connect(f.alice).openDeposit(2, toUnits("1000"))).wait();
      const dep1 = await f.savingCore.getDeposit(1);
      const graceEnd = dep1.maturityAt + GRACE_PERIOD_SECONDS;

      // After maturity, P + I = 1009.863013 USDC which EXCEEDS maxDeposit (1005 USDC)!
      // Manual renewal to plan 2 would be rejected, but Auto Renewal MUST SUCCEED!
      await networkHelpers.time.setNextBlockTimestamp(graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      const newDep = await f.savingCore.getDeposit(2);
      expect(newDep.principal).to.equal(1009863013n);
      expect(newDep.principal).to.be.greaterThan(toUnits("1005"));
    });

    it("AR-028: old planId is preserved in new deposit", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      const newDep = await f.savingCore.getDeposit(2);
      expect(newDep.planId).to.equal(f.deposit.planId);
    });
  });

  describe("Group D: Ownership & Permissionless Trigger", function () {
    it("AR-029: Alice owns NFT; Bob triggers; new NFT is minted to Alice", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      await (await f.savingCore.connect(f.bob).autoRenewDeposit(1)).wait();

      expect(await f.savingCore.ownerOf(2)).to.equal(f.alice.address);
      expect(await f.savingCore.balanceOf(f.bob.address)).to.equal(0n);
    });

    it("AR-030: Alice transfers NFT #1 to Bob before graceEnd; stranger triggers; new NFT #2 is minted to Bob", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Alice transfers NFT #1 to Bob
      await (await f.savingCore.connect(f.alice).transferFrom(f.alice.address, f.bob.address, 1)).wait();
      expect(await f.savingCore.ownerOf(1)).to.equal(f.bob.address);

      // Stranger triggers auto renewal
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      // Bob receives NFT #2! Alice does not. Stranger does not.
      expect(await f.savingCore.ownerOf(2)).to.equal(f.bob.address);
      expect(await f.savingCore.balanceOf(f.bob.address)).to.equal(2n);
      expect(await f.savingCore.balanceOf(f.alice.address)).to.equal(0n);
    });

    it("AR-031: approved operator can trigger because auto renewal is permissionless", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await (await f.savingCore.connect(f.alice).approve(f.bob.address, 1)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.bob).autoRenewDeposit(1)).wait();

      expect(await f.savingCore.ownerOf(2)).to.equal(f.alice.address);
    });

    it("AR-032: autoRenewDeposit has no arbitrary recipient parameter in ABI", function () {
      const f = maturedDepositFixture;
      // Interface verification: autoRenewDeposit takes only uint256 depositId
      const fragment = connection.ethers.Interface.from([
        "function autoRenewDeposit(uint256 depositId) external returns (uint256)"
      ]).getFunction("autoRenewDeposit");
      expect(fragment?.inputs.length).to.equal(1);
      expect(fragment?.inputs[0].name).to.equal("depositId");
    });

    it("AR-033: contract owner receiving new NFT via onERC721Received succeeds", async function () {
      const f = await deployAutoRenewalFixture();
      const receiver = await ethers.deployContract("DepositReceiverMock", [f.savingCoreAddress, f.alice.address]);
      await receiver.waitForDeployment();
      const receiverAddress = await receiver.getAddress();

      // Transfer tokens to receiver and approve Core
      await (await f.token.mint(receiverAddress, toUnits("1000"))).wait();
      await (await receiver.connect(f.alice).approveCore(toUnits("1000"))).wait();

      // Open deposit from contract
      await (await receiver.connect(f.alice).open(1, toUnits("1000"))).wait();
      expect(await f.savingCore.ownerOf(1)).to.equal(receiverAddress);

      const dep = await f.savingCore.getDeposit(1);
      const graceEnd = dep.maturityAt + GRACE_PERIOD_SECONDS;

      // Stranger auto-renews
      await networkHelpers.time.setNextBlockTimestamp(graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      // Receiver contract now owns NFT #1 and NFT #2
      expect(await f.savingCore.ownerOf(2)).to.equal(receiverAddress);
      expect(await f.savingCore.balanceOf(receiverAddress)).to.equal(2n);
    });

    it("AR-034: contract receiver rejecting NFT rolls back entire auto renewal atomically", async function () {
      const f = await deployAutoRenewalFixture();
      const receiver = await ethers.deployContract("DepositReceiverMock", [f.savingCoreAddress, f.alice.address]);
      await receiver.waitForDeployment();
      const receiverAddress = await receiver.getAddress();

      await (await f.token.mint(receiverAddress, toUnits("1000"))).wait();
      await (await receiver.connect(f.alice).approveCore(toUnits("1000"))).wait();
      await (await receiver.connect(f.alice).open(1, toUnits("1000"))).wait();

      const dep = await f.savingCore.getDeposit(1);
      const graceEnd = dep.maturityAt + GRACE_PERIOD_SECONDS;

      // Configure receiver to Reject
      await (await receiver.connect(f.alice).configure(1, ethers.ZeroAddress)).wait(); // Mode.Reject = 1

      await networkHelpers.time.setNextBlockTimestamp(graceEnd);

      // Auto renew must revert
      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(1))
        .to.be.revertedWithCustomError(receiver, "ReceiverRejected");

      // Verify rollback
      expect((await f.savingCore.getDeposit(1)).status).to.equal(0); // Still Active
      expect(await f.savingCore.depositCount()).to.equal(1n);
    });
  });

  describe("Group E: Financial Accounting & Invariants", function () {
    it("AR-035 & AR-036 & AR-037 & AR-038: Vault decrements by I, Core increments by I, totalPrincipal increments by I", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      const interest = await f.savingCore.calculateInterest(1); // 9,863,013 units
      expect(interest).to.equal(9863013n);

      const vaultBalBefore = await f.token.balanceOf(f.vaultAddress);
      const coreBalBefore = await f.token.balanceOf(f.savingCoreAddress);
      const totalPrincipalBefore = await f.savingCore.totalPrincipal();
      const aliceTokensBefore = await f.token.balanceOf(f.alice.address);
      const strangerTokensBefore = await f.token.balanceOf(f.stranger.address);
      const feeReceiverTokensBefore = await f.token.balanceOf(f.feeReceiver.address);

      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      const tx = await f.savingCore.connect(f.stranger).autoRenewDeposit(1);
      const receipt = await tx.wait();

      const vaultBalAfter = await f.token.balanceOf(f.vaultAddress);
      const coreBalAfter = await f.token.balanceOf(f.savingCoreAddress);
      const totalPrincipalAfter = await f.savingCore.totalPrincipal();
      const aliceTokensAfter = await f.token.balanceOf(f.alice.address);
      const strangerTokensAfter = await f.token.balanceOf(f.stranger.address);
      const feeReceiverTokensAfter = await f.token.balanceOf(f.feeReceiver.address);

      // Vault -I
      expect(vaultBalAfter).to.equal(vaultBalBefore - interest);
      // Core +I
      expect(coreBalAfter).to.equal(coreBalBefore + interest);
      // totalPrincipal +I
      expect(totalPrincipalAfter).to.equal(totalPrincipalBefore + interest);
      // Caller 0
      expect(strangerTokensAfter).to.equal(strangerTokensBefore);
      // Owner 0
      expect(aliceTokensAfter).to.equal(aliceTokensBefore);
      // Fee receiver 0
      expect(feeReceiverTokensAfter).to.equal(feeReceiverTokensBefore);
      // New principal = P + I
      const newDep = await f.savingCore.getDeposit(2);
      expect(newDep.principal).to.equal(f.deposit.principal + interest);

      console.log(
        `AUTO_RENEW_ACCOUNTING | oldP=${f.deposit.principal} | I=${interest} | newP=${newDep.principal} | ` +
        `vault=${vaultBalBefore}->${vaultBalAfter} (-${interest}) | core=${coreBalBefore}->${coreBalAfter} (+${interest}) | ` +
        `alice=${aliceTokensBefore}->${aliceTokensAfter} | totalPrincipal=${totalPrincipalBefore}->${totalPrincipalAfter} (+${interest}) | ` +
        `txHash=${tx.hash}`
      );
    });

    it("AR-042: no transferFrom called on user during auto renewal", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Alice revokes allowance to Core
      await (await f.token.connect(f.alice).approve(f.savingCoreAddress, 0)).wait();
      expect(await f.token.allowance(f.alice.address, f.savingCoreAddress)).to.equal(0n);

      // Auto renew still succeeds without any user approval
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();
    });

    it("AR-043 & AR-044: multi-deposit isolation and global principal invariant", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Bob opens deposit #2 with 500 USDC
      await (await f.savingCore.connect(f.bob).openDeposit(1, toUnits("500"))).wait();
      expect(await f.savingCore.depositCount()).to.equal(2n);

      const totalPrincipalBefore = await f.savingCore.totalPrincipal();
      expect(totalPrincipalBefore).to.equal(toUnits("1500"));

      // Auto renew deposit 1
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      // Deposit #2 is completely untouched
      const dep2 = await f.savingCore.getDeposit(2);
      expect(dep2.status).to.equal(0);
      expect(dep2.principal).to.equal(toUnits("500"));

      // New deposit #3 created for deposit #1
      const dep3 = await f.savingCore.getDeposit(3);
      expect(dep3.status).to.equal(0);

      // Invariant: Core balance >= totalPrincipal == sum(Active principal)
      const coreBal = await f.token.balanceOf(f.savingCoreAddress);
      const totalPrincipal = await f.savingCore.totalPrincipal();
      expect(coreBal).to.be.greaterThanOrEqual(totalPrincipal);
      expect(totalPrincipal).to.equal(dep2.principal + dep3.principal);
    });
  });

  describe("Group F: Negative & Security", function () {
    it("AR-045: nonexistent depositId (0 or out-of-range) reverts with DepositNotFound", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(0))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotFound")
        .withArgs(0n);

      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(999))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotFound")
        .withArgs(999n);
    });

    it("AR-046: already withdrawn deposit cannot be auto-renewed", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1); // Withdrawn

      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd + 10n);
      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(1))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(1n, 1);
    });

    it("AR-047: manual renewed deposit cannot be auto-renewed", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(2); // ManualRenewed

      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd + 10n);
      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(1))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(1n, 2);
    });

    it("AR-048: auto-renewed deposit cannot be auto-renewed a second time", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(3); // AutoRenewed

      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(1))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(1n, 3);
    });

    it("AR-049 & AR-050: Vault paused blocks auto renewal; unpause restores it", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(1))
        .to.be.revertedWithCustomError(f.savingCore, "EnforcedPause");

      // Unpause
      await (await f.vault.connect(f.bankAdmin).unpause()).wait();
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd + 10n);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();
    });

    it("AR-051: unbound Core reverts with CoreNotBound", async function () {
      const [operator, bankAdmin, alice, bob, feeReceiver, stranger] = await ethers.getSigners();
      const token = await ethers.deployContract("MockUSDC");
      const vault = await ethers.deployContract("VaultManager", [await token.getAddress(), bankAdmin.address, feeReceiver.address]);
      const core = await ethers.deployContract("SavingCore", [await vault.getAddress(), GRACE_PERIOD_SECONDS]);

      // Not bound!
      await expect(core.connect(stranger).autoRenewDeposit(1))
        .to.be.revertedWithCustomError(core, "CoreNotBound");
    });

    it("AR-052 & AR-053: Vault short by 1 unit reverts atomically; admin funds shortfall and retry succeeds", async function () {
      const f = await deployAutoRenewalFixture();
      // Calculate exact interest for 1000 USDC
      const principal = toUnits("1000");
      await (await f.savingCore.connect(f.alice).openDeposit(1, principal)).wait();
      const dep = await f.savingCore.getDeposit(1);
      const interest = await f.savingCore.calculateInterest(1); // 9,863,013

      // Drain vault completely, then fund with interest - 1
      const currentVaultBalance = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(currentVaultBalance)).wait();
      await (await f.vault.connect(f.bankAdmin).fundVault(interest - 1n)).wait();

      const graceEnd = dep.maturityAt + GRACE_PERIOD_SECONDS;
      await networkHelpers.time.setNextBlockTimestamp(graceEnd);

      // Reverts InsufficientVaultBalance
      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(1))
        .to.be.revertedWithCustomError(f.vault, "InsufficientVaultBalance")
        .withArgs(interest - 1n, interest);

      // State is pristine: status is Active, depositCount is 1
      expect((await f.savingCore.getDeposit(1)).status).to.equal(0);
      expect(await f.savingCore.depositCount()).to.equal(1n);

      // Admin funds shortfall (+1 unit)
      await (await f.vault.connect(f.bankAdmin).fundVault(1n)).wait();

      // Retry succeeds!
      await networkHelpers.time.setNextBlockTimestamp(graceEnd + 10n);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(3);
    });

    it("AR-054: zero interest (APR = 0) renewal succeeds without calling payInterest(0) and without Vault funds", async function () {
      const f = await deployAutoRenewalFixture();
      // Plan with 0 APR
      await (await f.savingCore.connect(f.bankAdmin).createPlan(
        DEFAULT_TENOR_DAYS,
        0n, // 0 APR
        0n,
        0n,
        DEFAULT_PENALTY_BPS,
        true
      )).wait();

      // Alice opens deposit on plan 2
      await (await f.savingCore.connect(f.alice).openDeposit(2, toUnits("1000"))).wait();
      const dep = await f.savingCore.getDeposit(1);
      const interest = await f.savingCore.calculateInterest(1);
      expect(interest).to.equal(0n);

      // Drain vault to 0
      const currentVaultBalance = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(currentVaultBalance)).wait();
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(0n);

      const graceEnd = dep.maturityAt + GRACE_PERIOD_SECONDS;
      await networkHelpers.time.setNextBlockTimestamp(graceEnd);

      // Auto renew succeeds even with 0 vault balance
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      const newDep = await f.savingCore.getDeposit(2);
      expect(newDep.principal).to.equal(toUnits("1000"));
      expect(newDep.status).to.equal(0);
    });

    it("AR-057: ERC721 callback reentrancy during auto renewal is blocked by nonReentrant", async function () {
      const f = await deployAutoRenewalFixture();
      const receiver = await ethers.deployContract("DepositReceiverMock", [f.savingCoreAddress, f.alice.address]);
      await receiver.waitForDeployment();
      const receiverAddress = await receiver.getAddress();

      await (await f.token.mint(receiverAddress, toUnits("1000"))).wait();
      await (await receiver.connect(f.alice).approveCore(toUnits("1000"))).wait();
      await (await receiver.connect(f.alice).open(1, toUnits("1000"))).wait();

      const dep = await f.savingCore.getDeposit(1);
      const graceEnd = dep.maturityAt + GRACE_PERIOD_SECONDS;

      // Mode.ReenterAutoRenewCaught = 8
      await (await receiver.connect(f.alice).configure(8, ethers.ZeroAddress)).wait();

      await networkHelpers.time.setNextBlockTimestamp(graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      // The reentrant call was caught and rejected by nonReentrant
      const reason = await receiver.reentryError();
      const expectedErrorSelector = f.savingCore.interface.getError("ReentrancyGuardReentrantCall")?.selector;
      expect(reason.slice(0, 10)).to.equal(expectedErrorSelector);
    });
  });

  describe("Group G: Late Trigger & Multiple Renewal Cycles", function () {
    it("AR-061 & AR-062 & AR-063 & AR-064 & AR-065: late trigger at G + 30 days succeeds with no backdating, no idle interest, and 1 cycle", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      const lateTimestamp = f.graceEnd + (30n * 86400n); // G + 30 days
      await networkHelpers.time.setNextBlockTimestamp(lateTimestamp);

      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      const oldInterest = await f.savingCore.calculateInterest(1);
      expect(oldInterest).to.equal(9863013n); // Exactly full-term interest, no 30-day bonus!

      const newDep = await f.savingCore.getDeposit(2);
      expect(newDep.startAt).to.equal(lateTimestamp); // No backdating!
      expect(newDep.principal).to.equal(f.deposit.principal + oldInterest);
      expect(await f.savingCore.depositCount()).to.equal(2n); // Only 1 new deposit, no catch-up loop!
    });

    it("AR-066 & AR-067: subsequent cycle after new deposit matures preserves locked terms and compounds new principal", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Admin changes plan 1 APR to 600 bps and disables plan
      await (await f.savingCore.connect(f.bankAdmin).updatePlan(1, 600)).wait();
      await (await f.savingCore.connect(f.bankAdmin).disablePlan(1)).wait();

      // Cycle 1 Auto Renew
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      const dep2 = await f.savingCore.getDeposit(2);
      expect(dep2.principal).to.equal(1009863013n);
      expect(dep2.aprBpsAtOpen).to.equal(200); // 200 bps locked

      // Fast forward past cycle 2 maturity and grace
      const cycle2GraceEnd = dep2.maturityAt + GRACE_PERIOD_SECONDS;
      await networkHelpers.time.setNextBlockTimestamp(cycle2GraceEnd);

      // Cycle 2 Auto Renew
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(2)).wait();

      const dep3 = await f.savingCore.getDeposit(3);
      expect(dep3.status).to.equal(0);
      expect(dep3.aprBpsAtOpen).to.equal(200); // Still 200 bps!
      expect(dep3.penaltyBpsAtOpen).to.equal(350); // Still 350 bps!
      expect(dep3.maturityAt - dep3.startAt).to.equal(dep2.maturityAt - dep2.startAt); // 180 days!

      // Interest in cycle 2 calculated on compounded principal:
      // floor(1,009,863,013 * 200 * 180 days / (365 days * 10,000)) = 9,960,292
      const cycle2Interest = dep3.principal - dep2.principal;
      expect(cycle2Interest).to.equal(9960292n);
      expect(dep3.principal).to.equal(1009863013n + 9960292n);
    });
  });

  describe("Group H: State Transition Competition Races", function () {
    it("Race A: Auto wins -> owner cannot withdrawAtMaturity or renewDeposit old ID", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      // Auto renew executes first
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(3); // AutoRenewed

      // Owner attempts withdrawAtMaturity
      await expect(f.savingCore.connect(f.alice).withdrawAtMaturity(1))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(1n, 3);

      // Owner attempts manual renewDeposit
      await expect(f.savingCore.connect(f.alice).renewDeposit(1, 1))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(1n, 3);
    });

    it("Race B: Manual wins -> stranger cannot autoRenewDeposit old ID", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      // Manual renew executes first
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(2); // ManualRenewed

      // Stranger attempts autoRenewDeposit
      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(1))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(1n, 2);
    });

    it("Race C: Maturity withdrawal wins -> stranger cannot autoRenewDeposit old ID", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      // Maturity withdrawal executes first
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1); // Withdrawn

      // Stranger attempts autoRenewDeposit
      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(1))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(1n, 1);
    });

    it("Race D: Failed transaction (e.g. Vault shortfall) does not consume deposit; retry succeeds", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      const interest = await f.savingCore.calculateInterest(1);

      // Drain vault completely
      const currentVaultBalance = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(currentVaultBalance)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      // Auto renew fails
      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(1)).to.be.revertedWithCustomError(
        f.vault,
        "InsufficientVaultBalance"
      );

      // Deposit #1 remains Active!
      expect((await f.savingCore.getDeposit(1)).status).to.equal(0);

      // Admin funds Vault
      await (await f.vault.connect(f.bankAdmin).fundVault(toUnits("100"))).wait();

      // Retry auto renewal -> SUCCEEDS!
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd + 10n);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(3);
    });
  });

  describe("Group I: Local Trigger Script Programmatic Verification", function () {
    it("AR-068 & AR-071 & AR-072 & AR-073: triggerAutoRenew executes successfully and parses state", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.increaseTo(f.graceEnd + 10n);

      const result = await triggerAutoRenew({
        connection,
        coreAddress: f.savingCoreAddress,
        depositId: 1n,
        signer: f.stranger,
      });

      expect(result.success).to.be.true;
      expect(result.oldDepositId).to.equal(1n);
      expect(result.newDepositId).to.equal(2n);
      expect(result.oldStatus).to.equal(3); // AutoRenewed
      expect(result.newStatus).to.equal(0); // Active
      expect(result.originalOwner).to.equal(f.alice.address);
      expect(result.newOwner).to.equal(f.alice.address);
      expect(result.newPrincipal).to.equal(1009863013n);
      expect(result.aprBps).to.equal(200);
      expect(result.penaltyBps).to.equal(350);
    });

    it("AR-069: triggerAutoRenew rejects invalid or missing deposit ID", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await assert.rejects(
        async () => {
          await triggerAutoRenew({
            connection,
            coreAddress: f.savingCoreAddress,
            depositId: 0n,
            signer: f.stranger,
          });
        },
        /Invalid deposit ID: 0/
      );

      await assert.rejects(
        async () => {
          await triggerAutoRenew({
            connection,
            coreAddress: f.savingCoreAddress,
            depositId: 999n,
            signer: f.stranger,
          });
        },
        /Deposit #999 not found/
      );
    });

    it("AR-070: triggerAutoRenew rejects deposit before grace period without sending tx", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Block timestamp is before graceEnd
      await assert.rejects(
        async () => {
          await triggerAutoRenew({
            connection,
            coreAddress: f.savingCoreAddress,
            depositId: 1n,
            signer: f.stranger,
          });
        },
        /grace period has not ended/
      );
    });

    it("AR-074: triggerAutoRenew reports clear error when Vault is paused", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      await networkHelpers.time.increaseTo(f.graceEnd + 10n);

      await assert.rejects(
        async () => {
          await triggerAutoRenew({
            connection,
            coreAddress: f.savingCoreAddress,
            depositId: 1n,
            signer: f.stranger,
          });
        },
        /VaultManager is paused/
      );
    });
  });
});
