import { expect } from "chai";
import { network } from "hardhat";
import { personalVariant } from "../config/personal-variant.js";

const connection = await network.create("hardhatMainnet");
const { ethers } = connection;

const GRACE_PERIOD_SECONDS = BigInt(personalVariant.gracePeriodDays * 86400); // 172800n
const DEFAULT_TENOR_DAYS = BigInt(personalVariant.defaultTenorDays); // 180n
const DEFAULT_APR_BPS = BigInt(personalVariant.defaultAprBps); // 200n
const DEFAULT_PENALTY_BPS = BigInt(personalVariant.earlyWithdrawPenaltyBps); // 350n

async function deployFixture() {
  const [deployer, bankAdmin, alice, stranger, feeReceiver] = await ethers.getSigners();

  const token = await ethers.deployContract("MockUSDC");
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();

  const vault = await ethers.deployContract("VaultManager", [tokenAddress, bankAdmin.address, feeReceiver.address]);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();

  const savingCore = await ethers.deployContract("SavingCore", [vaultAddress, GRACE_PERIOD_SECONDS]);
  await savingCore.waitForDeployment();
  const savingCoreAddress = await savingCore.getAddress();

  // Bind core to vault
  await (await vault.connect(bankAdmin).setSavingCore(savingCoreAddress)).wait();

  // Create standard saving plan
  await (
    await savingCore.connect(bankAdmin).createPlan(
      DEFAULT_TENOR_DAYS,
      DEFAULT_APR_BPS,
      0n,
      0n,
      DEFAULT_PENALTY_BPS,
      true
    )
  ).wait();

  // Fund Vault with liquidity
  const fundAmount = ethers.parseUnits("5000", 6);
  await (await token.connect(deployer).mint(bankAdmin.address, fundAmount)).wait();
  await (await token.connect(bankAdmin).approve(vaultAddress, fundAmount)).wait();
  await (await vault.connect(bankAdmin).fundVault(fundAmount)).wait();

  // Fund Alice
  const aliceAmount = ethers.parseUnits("1000", 6);
  await (await token.connect(deployer).mint(alice.address, aliceAmount)).wait();
  await (await token.connect(alice).approve(savingCoreAddress, aliceAmount)).wait();

  // Open Deposit #1 for Alice
  await (await savingCore.connect(alice).openDeposit(1, aliceAmount)).wait();

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
    aliceAmount,
  };
}

describe("SavingCore - Admin Timeline Override (Sepolia Maturity Verification)", () => {
  it("TIMELINE-001: rejects non-admin calling setDepositTimeline", async () => {
    const { savingCore, stranger } = await deployFixture();

    const now = Math.floor(Date.now() / 1000);
    await expect(
      savingCore.connect(stranger).setDepositTimeline(1, now - 1000, now + 1000)
    ).to.be.revertedWithCustomError(savingCore, "NotBankAdmin");
  });

  it("TIMELINE-002: rejects non-existent deposit ID", async () => {
    const { savingCore, bankAdmin } = await deployFixture();

    const now = Math.floor(Date.now() / 1000);
    await expect(
      savingCore.connect(bankAdmin).setDepositTimeline(999, now - 1000, now + 1000)
    ).to.be.revertedWithCustomError(savingCore, "DepositNotFound");

    await expect(
      savingCore.connect(bankAdmin).setDepositTimeline(0, now - 1000, now + 1000)
    ).to.be.revertedWithCustomError(savingCore, "DepositNotFound");
  });

  it("TIMELINE-003: rejects invalid timeline where maturityAt <= startAt", async () => {
    const { savingCore, bankAdmin } = await deployFixture();

    const now = Math.floor(Date.now() / 1000);
    // Equal
    await expect(
      savingCore.connect(bankAdmin).setDepositTimeline(1, now, now)
    ).to.be.revertedWithCustomError(savingCore, "InvalidDepositTimeline");

    // Reversed
    await expect(
      savingCore.connect(bankAdmin).setDepositTimeline(1, now + 100, now)
    ).to.be.revertedWithCustomError(savingCore, "InvalidDepositTimeline");
  });

  it("TIMELINE-004: successfully updates timeline and emits DepositTimelineUpdated", async () => {
    const { savingCore, bankAdmin } = await deployFixture();

    const depBefore = await savingCore.getDeposit(1);
    const originalTenor = depBefore.maturityAt - depBefore.startAt;

    const block = await ethers.provider.getBlock("latest");
    const currentBlockTime = BigInt(block?.timestamp ?? Math.floor(Date.now() / 1000));

    const newMaturityAt = currentBlockTime - 10n;
    const newStartAt = newMaturityAt - originalTenor;

    const tx = await savingCore.connect(bankAdmin).setDepositTimeline(1, newStartAt, newMaturityAt);
    await expect(tx)
      .to.emit(savingCore, "DepositTimelineUpdated")
      .withArgs(1, depBefore.startAt, depBefore.maturityAt, newStartAt, newMaturityAt);

    const depAfter = await savingCore.getDeposit(1);
    expect(depAfter.startAt).to.equal(newStartAt);
    expect(depAfter.maturityAt).to.equal(newMaturityAt);
  });

  it("TIMELINE-005: enables withdrawAtMaturity with full interest on live chain without time-warp", async () => {
    const { savingCore, token, bankAdmin, alice, aliceAmount } = await deployFixture();

    const depBefore = await savingCore.getDeposit(1);
    const originalTenor = depBefore.maturityAt - depBefore.startAt;
    const expectedInterest = await savingCore.calculateInterest(1);
    expect(expectedInterest).to.be.greaterThan(0n);

    // Shift timeline to past maturity
    const block = await ethers.provider.getBlock("latest");
    const now = BigInt(block?.timestamp ?? 0);
    const newMaturityAt = now - 5n;
    const newStartAt = newMaturityAt - originalTenor;

    await (await savingCore.connect(bankAdmin).setDepositTimeline(1, newStartAt, newMaturityAt)).wait();

    // Alice withdraws at maturity immediately
    const balBefore = await token.balanceOf(alice.address);
    const withdrawTx = await savingCore.connect(alice).withdrawAtMaturity(1);
    await expect(withdrawTx)
      .to.emit(savingCore, "Withdrawn")
      .withArgs(1, alice.address, aliceAmount, expectedInterest, false);

    const balAfter = await token.balanceOf(alice.address);
    expect(balAfter - balBefore).to.equal(aliceAmount + expectedInterest);

    const depSettled = await savingCore.getDeposit(1);
    expect(depSettled.status).to.equal(1n); // Withdrawn
  });

  it("TIMELINE-006: rejects setDepositTimeline on already withdrawn or renewed deposit", async () => {
    const { savingCore, bankAdmin, alice } = await deployFixture();

    const block = await ethers.provider.getBlock("latest");
    const now = BigInt(block?.timestamp ?? 0);
    const depBefore = await savingCore.getDeposit(1);
    const tenor = depBefore.maturityAt - depBefore.startAt;

    await (await savingCore.connect(bankAdmin).setDepositTimeline(1, now - tenor - 5n, now - 5n)).wait();
    await (await savingCore.connect(alice).withdrawAtMaturity(1)).wait();

    // Attempting to modify settled deposit
    await expect(
      savingCore.connect(bankAdmin).setDepositTimeline(1, now - 100n, now + 100n)
    ).to.be.revertedWithCustomError(savingCore, "DepositNotActive");
  });

  it("TIMELINE-007: enables renewDeposit into new plan when matured", async () => {
    const { savingCore, bankAdmin, alice, aliceAmount } = await deployFixture();

    const depBefore = await savingCore.getDeposit(1);
    const tenor = depBefore.maturityAt - depBefore.startAt;
    const expectedInterest = await savingCore.calculateInterest(1);

    const block = await ethers.provider.getBlock("latest");
    const now = BigInt(block?.timestamp ?? 0);
    await (await savingCore.connect(bankAdmin).setDepositTimeline(1, now - tenor - 5n, now - 5n)).wait();

    // Alice renews into plan 1
    const renewTx = await savingCore.connect(alice).renewDeposit(1, 1);
    const expectedNewPrincipal = aliceAmount + expectedInterest;
    await expect(renewTx)
      .to.emit(savingCore, "Renewed")
      .withArgs(1, 2, expectedNewPrincipal, 1);

    const oldDep = await savingCore.getDeposit(1);
    expect(oldDep.status).to.equal(2n); // ManualRenewed

    const newDep = await savingCore.getDeposit(2);
    expect(newDep.principal).to.equal(expectedNewPrincipal);
    expect(newDep.status).to.equal(0n); // Active
  });

  it("TIMELINE-008: enables autoRenewDeposit after grace period ended", async () => {
    const { savingCore, bankAdmin, alice, aliceAmount } = await deployFixture();

    const depBefore = await savingCore.getDeposit(1);
    const tenor = depBefore.maturityAt - depBefore.startAt;
    const expectedInterest = await savingCore.calculateInterest(1);

    const block = await ethers.provider.getBlock("latest");
    const now = BigInt(block?.timestamp ?? 0);

    // Shift timeline so now > maturityAt + gracePeriodSeconds
    const newMaturityAt = now - GRACE_PERIOD_SECONDS - 60n;
    const newStartAt = newMaturityAt - tenor;
    await (await savingCore.connect(bankAdmin).setDepositTimeline(1, newStartAt, newMaturityAt)).wait();

    // Anyone (permissionless) triggers auto-renew for deposit 1
    const [_, __, ___, stranger] = await ethers.getSigners();
    const autoTx = await savingCore.connect(stranger).autoRenewDeposit(1);

    const expectedNewPrincipal = aliceAmount + expectedInterest;
    await expect(autoTx)
      .to.emit(savingCore, "Renewed")
      .withArgs(1, 2, expectedNewPrincipal, 1);

    const oldDep = await savingCore.getDeposit(1);
    expect(oldDep.status).to.equal(3n); // AutoRenewed

    const newDep = await savingCore.getDeposit(2);
    expect(newDep.principal).to.equal(expectedNewPrincipal);
    expect(await savingCore.ownerOf(2)).to.equal(alice.address);
  });
});
