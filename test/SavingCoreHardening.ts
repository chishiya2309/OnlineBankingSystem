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

async function deployHardeningFixture() {
  const [operator, bankAdmin, alice, bob, feeReceiver, stranger, newAdmin, attacker] = await ethers.getSigners();

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
  await (await token.mint(alice.address, toUnits("20000"))).wait();
  await (await token.mint(bob.address, toUnits("20000"))).wait();
  await (await token.mint(bankAdmin.address, toUnits("50000"))).wait();
  await (await token.mint(attacker.address, toUnits("10000"))).wait();

  // Approvals
  await (await token.connect(alice).approve(savingCoreAddress, ethers.MaxUint256)).wait();
  await (await token.connect(bob).approve(savingCoreAddress, ethers.MaxUint256)).wait();
  await (await token.connect(bankAdmin).approve(vaultAddress, ethers.MaxUint256)).wait();
  await (await token.connect(attacker).approve(savingCoreAddress, ethers.MaxUint256)).wait();

  // Fund Vault with initial interest reserve (2000 USDC)
  await (await vault.connect(bankAdmin).fundVault(toUnits("2000"))).wait();

  return {
    operator,
    bankAdmin,
    alice,
    bob,
    feeReceiver,
    stranger,
    newAdmin,
    attacker,
    token,
    tokenAddress,
    vault,
    vaultAddress,
    savingCore,
    savingCoreAddress,
  };
}

async function maturedDepositFixture() {
  const f = await deployHardeningFixture();
  const principal = toUnits("1000"); // 1,000,000,000 units
  await (await f.savingCore.connect(f.alice).openDeposit(1, principal)).wait();
  const deposit = await f.savingCore.getDeposit(1);
  const graceEnd = deposit.maturityAt + GRACE_PERIOD_SECONDS;
  return { ...f, depositId: 1n, principal, deposit, graceEnd };
}

describe("SavingCore - Task D3-03: Security & State Hardening", function () {
  describe("Group 1: NFT Ownership & Settlement Authorization", function () {
    it("OWN-001: original depositor has settlement authority while holding NFT", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      expect(await f.savingCore.ownerOf(1)).to.equal(f.alice.address);

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      const tx = await f.savingCore.connect(f.alice).withdrawAtMaturity(1);
      await tx.wait();

      expect((await f.savingCore.getDeposit(1)).status).to.equal(1); // Withdrawn
    });

    it("OWN-002 & OWN-003: original depositor loses authority after transfer; new owner Bob can maturity withdraw", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await (await f.savingCore.connect(f.alice).transferFrom(f.alice.address, f.bob.address, 1)).wait();
      expect(await f.savingCore.ownerOf(1)).to.equal(f.bob.address);

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      // Alice tries to withdraw -> REVERT NotDepositOwner
      await expect(f.savingCore.connect(f.alice).withdrawAtMaturity(1))
        .to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner")
        .withArgs(1n, f.alice.address);

      // Bob withdraws -> SUCCESS
      const bobInitial = await f.token.balanceOf(f.bob.address);
      await (await f.savingCore.connect(f.bob).withdrawAtMaturity(1)).wait();
      expect(await f.token.balanceOf(f.bob.address)).to.equal(bobInitial + 1009863013n);
    });

    it("OWN-004: new owner Bob can early withdraw on independent fixture", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await (await f.savingCore.connect(f.alice).transferFrom(f.alice.address, f.bob.address, 1)).wait();

      // Alice tries early withdraw -> REVERT
      await expect(f.savingCore.connect(f.alice).earlyWithdraw(1))
        .to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner")
        .withArgs(1n, f.alice.address);

      // Bob early withdraws -> SUCCESS
      const bobInitial = await f.token.balanceOf(f.bob.address);
      await (await f.savingCore.connect(f.bob).earlyWithdraw(1)).wait();
      // Principal 1000 USDC - 3.5% penalty (35 USDC) = 965 USDC net payout
      expect(await f.token.balanceOf(f.bob.address)).to.equal(bobInitial + toUnits("965"));
    });

    it("OWN-005: new owner Bob can manual renew and receives new NFT certificate", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await (await f.savingCore.connect(f.alice).transferFrom(f.alice.address, f.bob.address, 1)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      // Alice tries manual renew -> REVERT
      await expect(f.savingCore.connect(f.alice).renewDeposit(1, 1))
        .to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner")
        .withArgs(1n, f.alice.address);

      // Bob manual renews -> SUCCESS
      await (await f.savingCore.connect(f.bob).renewDeposit(1, 1)).wait();
      expect(await f.savingCore.ownerOf(2)).to.equal(f.bob.address);
      expect(await f.savingCore.balanceOf(f.bob.address)).to.equal(2n);
      expect(await f.savingCore.balanceOf(f.alice.address)).to.equal(0n);
    });

    it("OWN-006: stranger can trigger auto renewal for Bob; Bob receives new NFT, stranger receives 0", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await (await f.savingCore.connect(f.alice).transferFrom(f.alice.address, f.bob.address, 1)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);

      const strangerInitial = await f.token.balanceOf(f.stranger.address);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      expect(await f.savingCore.ownerOf(2)).to.equal(f.bob.address);
      expect(await f.token.balanceOf(f.stranger.address)).to.equal(strangerInitial);
      expect(await f.savingCore.balanceOf(f.stranger.address)).to.equal(0n);
    });

    it("OWN-007: approved operator can transfer NFT but cannot financial settle", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Alice approves Bob as operator for deposit 1
      await (await f.savingCore.connect(f.alice).approve(f.bob.address, 1)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      // Bob tries withdrawAtMaturity -> REVERT NotDepositOwner
      await expect(f.savingCore.connect(f.bob).withdrawAtMaturity(1))
        .to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner")
        .withArgs(1n, f.bob.address);

      // Bob tries manual renew -> REVERT NotDepositOwner
      await expect(f.savingCore.connect(f.bob).renewDeposit(1, 1))
        .to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner")
        .withArgs(1n, f.bob.address);

      // But Bob CAN transfer the NFT to himself
      await (await f.savingCore.connect(f.bob).transferFrom(f.alice.address, f.bob.address, 1)).wait();
      expect(await f.savingCore.ownerOf(1)).to.equal(f.bob.address);

      // Now as actual owner, Bob can withdraw
      await (await f.savingCore.connect(f.bob).withdrawAtMaturity(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });

    it("OWN-008: Bank Admin cannot withdraw user's deposit or claim principal", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      await expect(f.savingCore.connect(f.bankAdmin).withdrawAtMaturity(1))
        .to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner")
        .withArgs(1n, f.bankAdmin.address);

      await expect(f.savingCore.connect(f.bankAdmin).earlyWithdraw(1))
        .to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner")
        .withArgs(1n, f.bankAdmin.address);

      await expect(f.savingCore.connect(f.bankAdmin).renewDeposit(1, 1))
        .to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner")
        .withArgs(1n, f.bankAdmin.address);
    });

    it("OWN-009: Vault ownership transfer updates admin cleanly; user NFT rights unaffected", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Transfer Vault ownership to newAdmin
      await (await f.vault.connect(f.bankAdmin).transferOwnership(f.newAdmin.address)).wait();
      expect(await f.vault.owner()).to.equal(f.newAdmin.address);

      // Old admin loses plan creation rights
      await expect(
        f.savingCore.connect(f.bankAdmin).createPlan(DEFAULT_TENOR_DAYS, DEFAULT_APR_BPS, 0n, 0n, DEFAULT_PENALTY_BPS, true)
      ).to.be.revertedWithCustomError(f.savingCore, "NotBankAdmin");

      // New admin has plan creation rights
      await (await f.savingCore.connect(f.newAdmin).createPlan(DEFAULT_TENOR_DAYS, DEFAULT_APR_BPS, 0n, 0n, DEFAULT_PENALTY_BPS, true)).wait();

      // Alice's NFT settlement rights remain completely functional
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });

    it("OWN-010: terminal NFT is soulbound and cannot be transferred under ERC721", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();

      // Terminal status 1 (Withdrawn): Alice attempts to transfer terminal NFT #1 to Bob -> REVERT
      await expect(
        f.savingCore.connect(f.alice).transferFrom(f.alice.address, f.bob.address, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "TerminalCertificateNonTransferable")
        .withArgs(1n, 1);

      await expect(
        f.savingCore.connect(f.alice)["safeTransferFrom(address,address,uint256)"](f.alice.address, f.bob.address, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "TerminalCertificateNonTransferable")
        .withArgs(1n, 1);

      // Certificate remains soulbound to Alice
      expect(await f.savingCore.ownerOf(1)).to.equal(f.alice.address);
    });

    it("OWN-010b: renewed terminal NFTs (ManualRenewed and AutoRenewed) cannot be transferred", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      // Manual renewal: deposit 1 becomes ManualRenewed (2), successor is deposit 2
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(2);

      // Alice tries to transfer old terminal certificate #1 -> REVERT
      await expect(
        f.savingCore.connect(f.alice).transferFrom(f.alice.address, f.bob.address, 1)
      ).to.be.revertedWithCustomError(f.savingCore, "TerminalCertificateNonTransferable")
        .withArgs(1n, 2);

      // Old certificate #1 remains with Alice
      expect(await f.savingCore.ownerOf(1)).to.equal(f.alice.address);

      // Successor certificate #2 is Active and CAN be transferred to Bob
      await (await f.savingCore.connect(f.alice).transferFrom(f.alice.address, f.bob.address, 2)).wait();
      expect(await f.savingCore.ownerOf(2)).to.equal(f.bob.address);
    });
  });

  describe("Group 2: Emergency Pause Matrix", function () {
    it("PAUSE-001 through PAUSE-007: all 5 Core financial methods and 2 Vault outflows revert when paused", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      expect(await f.vault.paused()).to.be.true;

      // 1. openDeposit
      await expect(f.savingCore.connect(f.alice).openDeposit(1, toUnits("500")))
        .to.be.revertedWithCustomError(f.savingCore, "EnforcedPause");

      // 2. withdrawAtMaturity
      await expect(f.savingCore.connect(f.alice).withdrawAtMaturity(1))
        .to.be.revertedWithCustomError(f.savingCore, "EnforcedPause");

      // 3. earlyWithdraw (even without Vault dependency)
      await expect(f.savingCore.connect(f.alice).earlyWithdraw(1))
        .to.be.revertedWithCustomError(f.savingCore, "EnforcedPause");

      // 4. renewDeposit
      await expect(f.savingCore.connect(f.alice).renewDeposit(1, 1))
        .to.be.revertedWithCustomError(f.savingCore, "EnforcedPause");

      // 5. autoRenewDeposit
      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(1))
        .to.be.revertedWithCustomError(f.savingCore, "EnforcedPause");

      // 6. Vault withdrawVault
      await expect(f.vault.connect(f.bankAdmin).withdrawVault(toUnits("100")))
        .to.be.revertedWithCustomError(f.vault, "EnforcedPause");

      // 7. Vault payInterest directly (when called by bound savingCore while paused)
      const vault2 = await ethers.deployContract("VaultManager", [f.tokenAddress, f.bankAdmin.address, f.feeReceiver.address]);
      const callerMock = await ethers.deployContract("VaultCallerMock", [await vault2.getAddress(), f.operator.address]);
      await (await vault2.connect(f.bankAdmin).setSavingCore(await callerMock.getAddress())).wait();
      await (await vault2.connect(f.bankAdmin).pause()).wait();
      await expect(callerMock.connect(f.operator).requestInterest(toUnits("10")))
        .to.be.revertedWithCustomError(vault2, "EnforcedPause");
    });

    it("PAUSE-008: fundVault is permitted while paused, enabling liquidity replenishment", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();

      const vaultBefore = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).fundVault(toUnits("500"))).wait();
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(vaultBefore + toUnits("500"));
    });

    it("PAUSE-009 through PAUSE-011: plan management, ERC721 transfers, and view functions remain operational while paused", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();

      // Plan management permitted
      await (await f.savingCore.connect(f.bankAdmin).updatePlan(1, 250)).wait();
      expect((await f.savingCore.getPlan(1)).aprBps).to.equal(250);
      await (await f.savingCore.connect(f.bankAdmin).disablePlan(1)).wait();
      expect((await f.savingCore.getPlan(1)).enabled).to.be.false;
      await (await f.savingCore.connect(f.bankAdmin).enablePlan(1)).wait();
      expect((await f.savingCore.getPlan(1)).enabled).to.be.true;

      // ERC721 transfer & approval permitted
      await (await f.savingCore.connect(f.alice).transferFrom(f.alice.address, f.bob.address, 1)).wait();
      expect(await f.savingCore.ownerOf(1)).to.equal(f.bob.address);
      await (await f.savingCore.connect(f.bob).approve(f.alice.address, 1)).wait();

      // View functions operational
      const dep = await f.savingCore.getDeposit(1);
      expect(dep.principal).to.equal(toUnits("1000"));
      expect(await f.savingCore.calculateInterest(1)).to.equal(9863013n);
      expect(await f.savingCore.calculatePenalty(1)).to.equal(toUnits("35"));
    });

    it("PAUSE-012: unpause restores financial functions without state corruption", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      await (await f.vault.connect(f.bankAdmin).unpause()).wait();
      expect(await f.vault.paused()).to.be.false;

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });

    it("PAUSE-013 & PAUSE-014: non-admin cannot pause/unpause; repeated pause/unpause reverts", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await expect(f.vault.connect(f.stranger).pause())
        .to.be.revertedWithCustomError(f.vault, "OwnableUnauthorizedAccount")
        .withArgs(f.stranger.address);

      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      // Repeated pause
      await expect(f.vault.connect(f.bankAdmin).pause())
        .to.be.revertedWithCustomError(f.vault, "EnforcedPause");

      await (await f.vault.connect(f.bankAdmin).unpause()).wait();
      // Repeated unpause
      await expect(f.vault.connect(f.bankAdmin).unpause())
        .to.be.revertedWithCustomError(f.vault, "ExpectedPause");
    });
  });

  describe("Group 3: Deposit Status Machine", function () {
    it("STATUS-001 through STATUS-004: verifies all 4 valid transitions", async function () {
      const f = await deployHardeningFixture();

      // 1. Open 4 separate deposits
      await (await f.savingCore.connect(f.alice).openDeposit(1, toUnits("100"))).wait(); // ID 1
      await (await f.savingCore.connect(f.alice).openDeposit(1, toUnits("100"))).wait(); // ID 2
      await (await f.savingCore.connect(f.alice).openDeposit(1, toUnits("100"))).wait(); // ID 3
      await (await f.savingCore.connect(f.alice).openDeposit(1, toUnits("100"))).wait(); // ID 4

      // Early withdraw deposit 1 -> Withdrawn (1)
      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);

      // Maturity withdraw deposit 2 -> Withdrawn (1)
      const dep2 = await f.savingCore.getDeposit(2);
      await networkHelpers.time.setNextBlockTimestamp(dep2.maturityAt);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(2)).wait();
      expect((await f.savingCore.getDeposit(2)).status).to.equal(1);

      // Manual renew deposit 3 -> ManualRenewed (2)
      await (await f.savingCore.connect(f.alice).renewDeposit(3, 1)).wait();
      expect((await f.savingCore.getDeposit(3)).status).to.equal(2);
      expect((await f.savingCore.getDeposit(5)).status).to.equal(0); // new active deposit

      // Auto renew deposit 4 -> AutoRenewed (3)
      const dep4 = await f.savingCore.getDeposit(4);
      await networkHelpers.time.setNextBlockTimestamp(dep4.maturityAt + GRACE_PERIOD_SECONDS);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(4)).wait();
      expect((await f.savingCore.getDeposit(4)).status).to.equal(3);
      expect((await f.savingCore.getDeposit(6)).status).to.equal(0); // new active deposit
    });

    it("STATUS-008: failed settlement does not alter deposit status", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Drain Vault so maturity withdraw fails
      const currentVaultBalance = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(currentVaultBalance)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await expect(f.savingCore.connect(f.alice).withdrawAtMaturity(1))
        .to.be.revertedWithCustomError(f.vault, "InsufficientVaultBalance");

      expect((await f.savingCore.getDeposit(1)).status).to.equal(0); // Remains Active
    });

    it("STATUS-011 through STATUS-013: depositCount monotonically increases, IDs never reused, non-existent reverts", async function () {
      const f = await deployHardeningFixture();
      expect(await f.savingCore.depositCount()).to.equal(0n);

      await (await f.savingCore.connect(f.alice).openDeposit(1, toUnits("100"))).wait();
      expect(await f.savingCore.depositCount()).to.equal(1n);

      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();
      expect(await f.savingCore.depositCount()).to.equal(1n); // Does not decrease on withdraw!

      await (await f.savingCore.connect(f.alice).openDeposit(1, toUnits("100"))).wait();
      expect(await f.savingCore.depositCount()).to.equal(2n); // Next sequential ID!

      // Non-existent ID reverts DepositNotFound
      await expect(f.savingCore.getDeposit(0))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotFound")
        .withArgs(0n);
      await expect(f.savingCore.getDeposit(3))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotFound")
        .withArgs(3n);
    });
  });

  describe("Group 4: Double Spend & Double Settlement Prevention", function () {
    it("DS-001: Maturity Withdraw -> Maturity Withdraw (2nd reverts)", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();

      await expect(f.savingCore.connect(f.alice).withdrawAtMaturity(1))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(1n, 1);
    });

    it("DS-002: Early Withdraw -> Early Withdraw (2nd reverts)", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();

      await expect(f.savingCore.connect(f.alice).earlyWithdraw(1))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(1n, 1);
    });

    it("DS-003: Manual Renew -> Manual Renew old ID (2nd reverts)", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();

      await expect(f.savingCore.connect(f.alice).renewDeposit(1, 1))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(1n, 2);
    });

    it("DS-004: Auto Renew -> Auto Renew old ID (2nd reverts)", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(1))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(1n, 3);
    });

    it("DS-005: Manual Renew -> Auto Renew old ID (2nd reverts)", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();

      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(1))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(1n, 2);
    });

    it("DS-006: Auto Renew -> Manual Renew old ID (2nd reverts)", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      await expect(f.savingCore.connect(f.alice).renewDeposit(1, 1))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(1n, 3);
    });

    it("DS-007: Maturity Withdraw -> Auto Renew old ID (2nd reverts)", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();

      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(1))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(1n, 1);
    });

    it("DS-008: Auto Renew -> Maturity Withdraw old ID (2nd reverts)", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();

      await expect(f.savingCore.connect(f.alice).withdrawAtMaturity(1))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(1n, 3);
    });

    it("DS-009: Maturity Withdraw -> Manual Renew old ID (2nd reverts)", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();

      await expect(f.savingCore.connect(f.alice).renewDeposit(1, 1))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(1n, 1);
    });

    it("DS-010: Manual Renew -> Maturity Withdraw old ID (2nd reverts)", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).renewDeposit(1, 1)).wait();

      await expect(f.savingCore.connect(f.alice).withdrawAtMaturity(1))
        .to.be.revertedWithCustomError(f.savingCore, "DepositNotActive")
        .withArgs(1n, 2);
    });
  });

  describe("Group 5: Reentrancy Resistance Matrix", function () {
    it("REENT-001 through REENT-005: receiver callbacks attempting reentrancy across all financial methods are blocked", async function () {
      const f = await deployHardeningFixture();
      const receiver = await ethers.deployContract("DepositReceiverMock", [f.savingCoreAddress, f.alice.address]);
      await receiver.waitForDeployment();
      const receiverAddress = await receiver.getAddress();

      await (await f.token.mint(receiverAddress, toUnits("5000"))).wait();
      await (await receiver.connect(f.alice).approveCore(ethers.MaxUint256)).wait();

      // 1. Reenter openDeposit
      await (await receiver.connect(f.alice).configure(3, ethers.ZeroAddress)).wait(); // Mode.ReenterCaught = 3
      await (await receiver.connect(f.alice).open(1, toUnits("1000"))).wait();
      const reason1 = await receiver.reentryError();
      const expectedSelector = f.savingCore.interface.getError("ReentrancyGuardReentrantCall")?.selector;
      expect(reason1.slice(0, 10)).to.equal(expectedSelector);

      // 2. Reenter renewDeposit
      const dep1 = await f.savingCore.getDeposit(1);
      await networkHelpers.time.setNextBlockTimestamp(dep1.maturityAt);
      await (await receiver.connect(f.alice).configure(6, ethers.ZeroAddress)).wait(); // Mode.ReenterRenewCaught = 6
      await (await receiver.connect(f.alice).renew(1, 1)).wait();
      const reason2 = await receiver.reentryError();
      expect(reason2.slice(0, 10)).to.equal(expectedSelector);

      // 3. Reenter autoRenewDeposit
      const dep2 = await f.savingCore.getDeposit(2);
      await networkHelpers.time.setNextBlockTimestamp(dep2.maturityAt + GRACE_PERIOD_SECONDS);
      await (await receiver.connect(f.alice).configure(8, ethers.ZeroAddress)).wait(); // Mode.ReenterAutoRenewCaught = 8
      await (await receiver.connect(f.stranger).autoRenew(2)).wait();
      const reason3 = await receiver.reentryError();
      expect(reason3.slice(0, 10)).to.equal(expectedSelector);

      // 4. Reenter withdrawAtMaturity
      const dep3 = await f.savingCore.getDeposit(3);
      await networkHelpers.time.setNextBlockTimestamp(dep3.maturityAt);
      await (await receiver.connect(f.alice).configure(10, ethers.ZeroAddress)).wait(); // Mode.ReenterMaturityWithdrawCaught = 10
      await (await receiver.connect(f.alice).renew(3, 1)).wait();
      const reason4 = await receiver.reentryError();
      expect(reason4.slice(0, 10)).to.equal(expectedSelector);

      // 5. Reenter earlyWithdraw during openDeposit callback
      await (await receiver.connect(f.alice).configure(12, ethers.ZeroAddress)).wait(); // Mode.ReenterEarlyWithdrawCaught = 12
      await (await receiver.connect(f.alice).open(1, toUnits("1000"))).wait();
      const reason5 = await receiver.reentryError();
      expect(reason5.slice(0, 10)).to.equal(expectedSelector);
    });
  });

  describe("Group 6: Events & ABI Exactness", function () {
    it("EVT-001 through EVT-003: plan events correctly emitted", async function () {
      const f = await deployHardeningFixture();

      // PlanCreated
      const createTx = await f.savingCore.connect(f.bankAdmin).createPlan(180, 200, 0, 0, 350, true);
      await expect(createTx).to.emit(f.savingCore, "PlanCreated").withArgs(2n, 180n, 200n);

      // PlanUpdated
      const updateTx = await f.savingCore.connect(f.bankAdmin).updatePlan(2, 300);
      await expect(updateTx).to.emit(f.savingCore, "PlanUpdated").withArgs(2n, 300n);

      // PlanEnabledChanged
      const disableTx = await f.savingCore.connect(f.bankAdmin).disablePlan(2);
      await expect(disableTx).to.emit(f.savingCore, "PlanEnabledChanged").withArgs(2n, false);
      const enableTx = await f.savingCore.connect(f.bankAdmin).enablePlan(2);
      await expect(enableTx).to.emit(f.savingCore, "PlanEnabledChanged").withArgs(2n, true);
    });

    it("EVT-007 & EVT-008: Withdrawn events log original principal, correct interest, and isEarly flag", async function () {
      const f = await deployHardeningFixture();
      await (await f.savingCore.connect(f.alice).openDeposit(1, toUnits("1000"))).wait();
      await (await f.savingCore.connect(f.alice).openDeposit(1, toUnits("1000"))).wait();

      // Early withdraw deposit 1
      const earlyTx = await f.savingCore.connect(f.alice).earlyWithdraw(1);
      await expect(earlyTx)
        .to.emit(f.savingCore, "Withdrawn")
        .withArgs(1n, f.alice.address, toUnits("1000"), 0n, true);

      // Maturity withdraw deposit 2
      const dep2 = await f.savingCore.getDeposit(2);
      await networkHelpers.time.setNextBlockTimestamp(dep2.maturityAt);
      const maturityTx = await f.savingCore.connect(f.alice).withdrawAtMaturity(2);
      await expect(maturityTx)
        .to.emit(f.savingCore, "Withdrawn")
        .withArgs(2n, f.alice.address, toUnits("1000"), 9863013n, false);
    });

    it("EVT-009 & EVT-011: Renewed event logs correct IDs and DepositOpened precedes Renewed", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      const tx = await f.savingCore.connect(f.alice).renewDeposit(1, 1);
      const receipt = await tx.wait();
      expect(receipt).to.not.be.null;

      // Assert event order in receipt logs
      const eventNames = receipt!.logs
        .map((log) => {
          try {
            return f.savingCore.interface.parseLog(log)?.name;
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      const depositOpenedIndex = eventNames.indexOf("DepositOpened");
      const renewedIndex = eventNames.indexOf("Renewed");

      expect(depositOpenedIndex).to.be.greaterThanOrEqual(0);
      expect(renewedIndex).to.be.greaterThan(depositOpenedIndex); // DepositOpened precedes Renewed!
    });
  });

  describe("Group 7: Financial Accounting & Invariants", function () {
    it("ACC-001 & ACC-002: direct donation increases Core surplus but never inflates totalPrincipal", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      const totalPrincipalBefore = await f.savingCore.totalPrincipal();
      const coreBalanceBefore = await f.token.balanceOf(f.savingCoreAddress);

      // Attacker donates 5000 USDC directly to SavingCore
      await (await f.token.connect(f.attacker).transfer(f.savingCoreAddress, toUnits("5000"))).wait();

      expect(await f.savingCore.totalPrincipal()).to.equal(totalPrincipalBefore); // Unchanged!
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(coreBalanceBefore + toUnits("5000"));

      // Invariant holds
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.be.greaterThan(await f.savingCore.totalPrincipal());
    });

    it("ACC-003: Core surplus is never used as Vault interest substitute", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      // Donate 5000 USDC to Core
      await (await f.token.connect(f.attacker).transfer(f.savingCoreAddress, toUnits("5000"))).wait();

      // Drain Vault to 0
      const currentVaultBalance = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(currentVaultBalance)).wait();
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(0n);

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      // Even though Core has 6000 USDC (more than enough to pay 1000 + 9.86), it MUST REVERT InsufficientVaultBalance!
      await expect(f.savingCore.connect(f.alice).withdrawAtMaturity(1))
        .to.be.revertedWithCustomError(f.vault, "InsufficientVaultBalance");
    });
  });

  describe("Group 8: Cross-Feature Integration Scenarios", function () {
    it("IT-H01: NFT transfer during pause succeeds; settlement blocked while paused, succeeds after unpause", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();

      // Transfer NFT to Bob while paused
      await (await f.savingCore.connect(f.alice).transferFrom(f.alice.address, f.bob.address, 1)).wait();
      expect(await f.savingCore.ownerOf(1)).to.equal(f.bob.address);

      // Bob tries to withdraw while paused -> REVERT EnforcedPause
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await expect(f.savingCore.connect(f.bob).withdrawAtMaturity(1))
        .to.be.revertedWithCustomError(f.savingCore, "EnforcedPause");

      // Unpause
      await (await f.vault.connect(f.bankAdmin).unpause()).wait();
      await (await f.savingCore.connect(f.bob).withdrawAtMaturity(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });

    it("IT-H02: auto renewal during pause reverts; succeeds after unpause", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(1))
        .to.be.revertedWithCustomError(f.savingCore, "EnforcedPause");

      // Unpause
      await (await f.vault.connect(f.bankAdmin).unpause()).wait();
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd + 10n);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(3);
    });

    it("IT-H07: failure & retry — Vault shortfall blocks renewal; admin funds while paused; unpause & retry succeeds", async function () {
      const f = await networkHelpers.loadFixture(maturedDepositFixture);
      const interest = await f.savingCore.calculateInterest(1);

      // Drain Vault
      const currentVaultBalance = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(currentVaultBalance)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd);
      await expect(f.savingCore.connect(f.stranger).autoRenewDeposit(1))
        .to.be.revertedWithCustomError(f.vault, "InsufficientVaultBalance");

      // Admin pauses Vault
      await (await f.vault.connect(f.bankAdmin).pause()).wait();

      // Admin funds Vault while paused
      await (await f.vault.connect(f.bankAdmin).fundVault(interest + toUnits("100"))).wait();

      // Admin unpauses
      await (await f.vault.connect(f.bankAdmin).unpause()).wait();

      // Retry auto renewal -> SUCCESS
      await networkHelpers.time.setNextBlockTimestamp(f.graceEnd + 10n);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(3);
    });

    it("IT-H08: multiple deposits accounting across mixed operations", async function () {
      const f = await deployHardeningFixture();

      // Alice, Bob, and Attacker each open deposits
      await (await f.savingCore.connect(f.alice).openDeposit(1, toUnits("1000"))).wait(); // ID 1
      await (await f.savingCore.connect(f.bob).openDeposit(1, toUnits("2000"))).wait();   // ID 2
      await (await f.savingCore.connect(f.attacker).openDeposit(1, toUnits("3000"))).wait(); // ID 3

      expect(await f.savingCore.totalPrincipal()).to.equal(toUnits("6000"));

      // 1. Alice early withdraws deposit 1 (-1000 USDC)
      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();
      expect(await f.savingCore.totalPrincipal()).to.equal(toUnits("5000"));

      // 2. Bob maturity withdraws deposit 2 (-2000 USDC)
      const dep2 = await f.savingCore.getDeposit(2);
      await networkHelpers.time.setNextBlockTimestamp(dep2.maturityAt);
      await (await f.savingCore.connect(f.bob).withdrawAtMaturity(2)).wait();
      expect(await f.savingCore.totalPrincipal()).to.equal(toUnits("3000"));

      // 3. Attacker auto renews deposit 3 (+29.589041 USDC interest)
      const dep3 = await f.savingCore.getDeposit(3);
      await networkHelpers.time.setNextBlockTimestamp(dep3.maturityAt + GRACE_PERIOD_SECONDS);
      await (await f.savingCore.connect(f.stranger).autoRenewDeposit(3)).wait();

      const dep4 = await f.savingCore.getDeposit(4);
      expect(dep4.status).to.equal(0);
      expect(await f.savingCore.totalPrincipal()).to.equal(dep4.principal);

      // Global invariant
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.be.greaterThanOrEqual(await f.savingCore.totalPrincipal());
    });
  });
});
