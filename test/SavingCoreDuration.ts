import { expect } from "chai";
import { network } from "hardhat";
import { personalVariant } from "../config/personal-variant.js";

const connection = await network.create("hardhatMainnet");
const { ethers, networkHelpers } = connection;
const P = 1_000_000000n;
const G = BigInt(personalVariant.gracePeriodDays * 86400);
const MAX_DURATION = 4294967295n * 86400n;

async function fixture() {
  const [deployer, admin, alice, bob, fee] = await ethers.getSigners();
  const token = await ethers.deployContract("MockUSDC");
  const vault = await ethers.deployContract("VaultManager", [await token.getAddress(), admin.address, fee.address]);
  const core = await ethers.deployContract("SavingCore", [await vault.getAddress(), G]);
  await vault.connect(admin).setSavingCore(await core.getAddress());
  await token.mint(admin.address, 5000_000000n);
  await token.connect(admin).approve(await vault.getAddress(), ethers.MaxUint256);
  await vault.connect(admin).fundVault(5000_000000n);
  await token.mint(alice.address, 5000_000000n);
  await token.connect(alice).approve(await core.getAddress(), ethers.MaxUint256);
  return { deployer, admin, alice, bob, fee, token, vault, core };
}

async function shortDeposit() {
  const f = await fixture();
  await f.core.connect(f.admin).createPlanSeconds(5, 200, 0, 0, 350, true);
  await f.core.connect(f.alice).openDeposit(1, P);
  return { ...f, deposit: await f.core.getDeposit(1) };
}

describe("Immutable deposit terms and exact plan durations", function () {
  after(async () => { await connection.close(); });

  it("DUR-001: preserves the 180-day Personal Variant and two-day grace", async () => {
    const f = await networkHelpers.loadFixture(fixture);
    await f.core.connect(f.admin).createPlan(personalVariant.defaultTenorDays, 200, 0, 0, 350, true);
    expect((await f.core.getPlan(1)).tenorDays).to.equal(180n);
    expect(await f.core.planDurationSeconds(1)).to.equal(180n * 86400n);
    expect(await f.core.gracePeriodSeconds()).to.equal(172800n);
  });

  for (const seconds of [1, 5, 60, 90, 86401]) {
    it(`DUR-002-${seconds}: snapshots an exact ${seconds}-second term`, async () => {
      const f = await networkHelpers.loadFixture(fixture);
      await expect(f.core.connect(f.admin).createPlanSeconds(seconds, 200, 0, 0, 350, true))
        .to.emit(f.core, "PlanDurationSet").withArgs(1, seconds);
      await f.core.connect(f.alice).openDeposit(1, P);
      const d = await f.core.getDeposit(1);
      expect(d.maturityAt - d.startAt).to.equal(BigInt(seconds));
      expect(await f.core.planDurationSeconds(1)).to.equal(BigInt(seconds));
      expect((await f.core.getPlan(1)).tenorDays).to.equal(BigInt(Math.floor(seconds / 86400)));
    });
  }

  for (const seconds of [0n, MAX_DURATION + 1n, (1n << 256n) - 1n]) {
    it(`DUR-003: rejects invalid second duration ${seconds}`, async () => {
      const f = await networkHelpers.loadFixture(fixture);
      await expect(f.core.connect(f.admin).createPlanSeconds(seconds, 200, 0, 0, 350, true))
        .to.be.revertedWithCustomError(f.core, "InvalidTenorSeconds").withArgs(seconds);
      expect(await f.core.planCount()).to.equal(0);
    });
  }

  it("DUR-004: accepts the legacy maximum duration in seconds", async () => {
    const f = await networkHelpers.loadFixture(fixture);
    await f.core.connect(f.admin).createPlanSeconds(MAX_DURATION, 200, 0, 0, 350, true);
    expect(await f.core.planDurationSeconds(1)).to.equal(MAX_DURATION);
    expect(await f.core.planDurationSeconds(0)).to.equal(0);
  });

  it("DUR-005: restricts short plan creation to the current bank admin", async () => {
    const f = await networkHelpers.loadFixture(fixture);
    await expect(f.core.connect(f.alice).createPlanSeconds(5, 200, 0, 0, 350, true))
      .to.be.revertedWithCustomError(f.core, "NotBankAdmin");
  });

  it("DUR-006: uses the same APR, penalty and amount limits for short plans", async () => {
    const f = await networkHelpers.loadFixture(fixture);
    await expect(f.core.connect(f.admin).createPlanSeconds(5, 10001, 0, 0, 350, true)).to.be.revertedWithCustomError(f.core, "InvalidApr");
    await expect(f.core.connect(f.admin).createPlanSeconds(5, 200, 0, 0, 10001, true)).to.be.revertedWithCustomError(f.core, "InvalidPenalty");
    await expect(f.core.connect(f.admin).createPlanSeconds(5, 200, 2, 1, 350, true)).to.be.revertedWithCustomError(f.core, "InvalidDepositLimits");
    await f.core.connect(f.admin).createPlanSeconds(5, 200, P, 2n * P, 350, true);
    await expect(f.core.connect(f.alice).openDeposit(1, P - 1n)).to.be.revertedWithCustomError(f.core, "DepositAmountOutOfRange");
    await f.core.connect(f.admin).disablePlan(1);
    await expect(f.core.connect(f.alice).openDeposit(1, P)).to.be.revertedWithCustomError(f.core, "PlanDisabled");
  });

  it("DUR-007: pays exactly 3 smallest interest units at five-second maturity", async () => {
    const f = await networkHelpers.loadFixture(shortDeposit);
    expect(await f.core.calculateInterest(1)).to.equal(3n);
    await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
    const before = await f.token.balanceOf(f.alice.address);
    const vaultBefore = await f.token.balanceOf(await f.vault.getAddress());
    await expect(f.core.connect(f.alice).withdrawAtMaturity(1)).to.emit(f.core, "Withdrawn").withArgs(1, f.alice.address, P, 3, false);
    expect(await f.token.balanceOf(f.alice.address)).to.equal(before + P + 3n);
    expect(await f.token.balanceOf(await f.vault.getAddress())).to.equal(vaultBefore - 3n);
  });

  it("DUR-008: allows early withdrawal at M-1 and rejects it at M", async () => {
    const f = await networkHelpers.loadFixture(shortDeposit);
    await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt - 1n);
    await expect(f.core.connect(f.alice).earlyWithdraw(1)).to.emit(f.core, "Withdrawn").withArgs(1, f.alice.address, P, 0, true);
    expect(await f.token.balanceOf(f.fee.address)).to.equal(35_000000n);
    const g = await networkHelpers.loadFixture(shortDeposit);
    await networkHelpers.time.setNextBlockTimestamp(g.deposit.maturityAt);
    await expect(g.core.connect(g.alice).earlyWithdraw(1)).to.be.revertedWithCustomError(g.core, "EarlyWithdrawalClosed");
  });

  it("DUR-009: manually renews into an exact two-minute target", async () => {
    const f = await networkHelpers.loadFixture(shortDeposit);
    await f.core.connect(f.admin).createPlanSeconds(120, 500, 0, 0, 350, true);
    await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
    await f.core.connect(f.alice).renewDeposit(1, 2);
    const next = await f.core.getDeposit(2);
    expect(next.principal).to.equal(P + 3n);
    expect(next.maturityAt - next.startAt).to.equal(120n);
    expect(next.aprBpsAtOpen).to.equal(500n);
  });

  it("DUR-010: keeps grace, duration and owner on permissionless auto renewal", async () => {
    const f = await networkHelpers.loadFixture(shortDeposit);
    await f.core.connect(f.alice).transferFrom(f.alice.address, f.bob.address, 1);
    await f.core.connect(f.admin).disablePlan(1);
    await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt + G - 1n);
    await expect(f.core.connect(f.deployer).autoRenewDeposit(1)).to.be.revertedWithCustomError(f.core, "GracePeriodNotEnded");
    await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt + G);
    await f.core.connect(f.deployer).autoRenewDeposit(1);
    const next = await f.core.getDeposit(2);
    expect(next.principal).to.equal(P + 3n);
    expect(next.maturityAt - next.startAt).to.equal(5n);
    expect(await f.core.ownerOf(2)).to.equal(f.bob.address);
  });

  it("IMM-001: rejects the removed timeline selector even from Bank Admin", async () => {
    const f = await networkHelpers.loadFixture(shortDeposit);
    expect(f.core.interface.hasFunction("setDepositTimeline")).to.equal(false);
    const obsolete = new ethers.Interface(["function setDepositTimeline(uint256,uint256,uint256)"]);
    const before = await f.core.getDeposit(1);
    for (const signer of [f.admin, f.alice]) {
      await expect(signer.sendTransaction({ to: await f.core.getAddress(), data: obsolete.encodeFunctionData("setDepositTimeline", [1, 1, 2]) }))
        .to.revert(ethers);
      expect(await f.core.getDeposit(1)).to.deep.equal(before);
    }
  });

  it("IMM-002: every remaining plan administration action preserves open deposit terms", async () => {
    const f = await networkHelpers.loadFixture(shortDeposit);
    const before = await f.core.getDeposit(1);
    await f.core.connect(f.admin).updatePlan(1, 1000);
    await f.core.connect(f.admin).disablePlan(1);
    await f.core.connect(f.admin).enablePlan(1);
    await f.core.connect(f.admin).createPlanSeconds(1, 10000, 0, 0, 0, true);
    await f.vault.connect(f.admin).setFeeReceiver(f.bob.address);
    await f.vault.connect(f.admin).pause();
    expect(await f.core.getDeposit(1)).to.deep.equal(before);
    expect(await f.core.planDurationSeconds(1)).to.equal(5n);
    expect(await f.core.calculateInterest(1)).to.equal(3n);
  });
});
