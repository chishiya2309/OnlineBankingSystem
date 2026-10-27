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

const depositUnits = (amount: string): bigint => ethers.parseUnits(amount, 6);

async function deployDepositSystem(local = connection, asset = "MockUSDC") {
  const [operator, bankAdmin, alice, bob, feeReceiver] = await local.ethers.getSigners();
  const token = asset === "ConfigurableTestToken"
    ? await local.ethers.deployContract("ConfigurableTestToken", [6])
    : asset === "CoreReentrantTestToken"
      ? await local.ethers.deployContract("CoreReentrantTestToken")
      : await local.ethers.deployContract("MockUSDC");
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  const vault = await local.ethers.deployContract("VaultManager", [tokenAddress, bankAdmin.address, feeReceiver.address]);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  const savingCore = await local.ethers.deployContract("SavingCore", [vaultAddress, GRACE_PERIOD_SECONDS]);
  await savingCore.waitForDeployment();
  const savingCoreAddress = await savingCore.getAddress();
  await (await vault.connect(bankAdmin).setSavingCore(savingCoreAddress)).wait();
  await (await savingCore.connect(bankAdmin).createPlan(
    DEFAULT_TENOR_DAYS, DEFAULT_APR_BPS, 0n, 0n, DEFAULT_PENALTY_BPS, true
  )).wait();
  const amount = depositUnits("100");
  for (const user of [alice, bob]) {
    await (await token.mint(user.address, depositUnits("1000"))).wait();
    await (await token.connect(user).approve(savingCoreAddress, amount)).wait();
  }
  await (await token.mint(bankAdmin.address, depositUnits("50"))).wait();
  await (await token.connect(bankAdmin).approve(vaultAddress, depositUnits("50"))).wait();
  await (await vault.connect(bankAdmin).fundVault(depositUnits("50"))).wait();
  return { operator, bankAdmin, alice, bob, feeReceiver, token, tokenAddress, vault, vaultAddress, savingCore, savingCoreAddress, amount };
}

async function openDepositFixture() { return deployDepositSystem(); }
async function falseReturnDepositFixture() { return deployDepositSystem(depositSecurityConnection, "ConfigurableTestToken"); }
async function reentrantDepositFixture() { return deployDepositSystem(depositSecurityConnection, "CoreReentrantTestToken"); }
type DepositSystem = Awaited<ReturnType<typeof deployDepositSystem>>;

async function receiverDepositFixture() {
  const f = await deployDepositSystem(depositSecurityConnection);
  const receiver = await depositSecurityConnection.ethers.deployContract("DepositReceiverMock", [f.savingCoreAddress, f.operator.address]);
  await receiver.waitForDeployment();
  const receiverAddress = await receiver.getAddress();
  await (await f.token.mint(receiverAddress, f.amount * 2n)).wait();
  await (await receiver.approveCore(f.amount * 2n)).wait();
  return { ...f, receiver, receiverAddress };
}

async function addDepositPlan(f: DepositSystem, min = 0n, max = 0n, apr = DEFAULT_APR_BPS,
  penalty = DEFAULT_PENALTY_BPS, tenor = DEFAULT_TENOR_DAYS) {
  await (await f.savingCore.connect(f.bankAdmin).createPlan(tenor, apr, min, max, penalty, true)).wait();
  return f.savingCore.planCount();
}

async function depositLedger(f: DepositSystem, depositor = f.alice.address) {
  const count = await f.savingCore.depositCount();
  const records = [];
  const owners = [];
  for (let id = 1n; id <= count; id++) {
    records.push(Array.from(await f.savingCore.getDeposit(id)));
    owners.push(await f.savingCore.ownerOf(id));
  }
  return {
    supply: await f.token.totalSupply(),
    depositor: await f.token.balanceOf(depositor),
    core: await f.token.balanceOf(f.savingCoreAddress),
    vault: await f.token.balanceOf(f.vaultAddress),
    admin: await f.token.balanceOf(f.bankAdmin.address),
    feeReceiver: await f.token.balanceOf(f.feeReceiver.address),
    bob: await f.token.balanceOf(f.bob.address),
    allowance: await f.token.allowance(depositor, f.savingCoreAddress),
    coreVaultAllowance: await f.token.allowance(f.savingCoreAddress, f.vaultAddress),
    depositorVaultAllowance: await f.token.allowance(depositor, f.vaultAddress),
    count,
    principal: await f.savingCore.totalPrincipal(),
    nfts: await f.savingCore.balanceOf(depositor),
    records,
    owners,
  };
}

async function assertDepositAbsent(f: DepositSystem, id: bigint) {
  await expect(f.savingCore.getDeposit(id)).to.be.revertedWithCustomError(f.savingCore, "DepositNotFound").withArgs(id);
  await expect(f.savingCore.ownerOf(id)).to.be.revertedWithCustomError(f.savingCore, "ERC721NonexistentToken").withArgs(id);
}

async function assertMinedDepositRevert(label: string, tx: ContractTransactionResponse) {
  const receipt = await depositSecurityConnection.ethers.provider.getTransactionReceipt(tx.hash);
  expect(receipt, "failed transaction must have a mined receipt").not.to.equal(null);
  expect(receipt!.status).to.equal(0);
  expect(receipt!.logs).to.deep.equal([]);
  console.log(`      DEPOSIT_MINED_REVERT | ${label} | hash=${tx.hash} | block=${receipt!.blockNumber} | status=${receipt!.status} | logs=${receipt!.logs.length}`);
}

describe("SavingCore - Open Deposit", function () {
  describe("Group A: Deposit Initialization", function () {
    it("DEP-001: starts depositCount at zero", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      expect(await f.savingCore.depositCount()).to.equal(0n);
    });
    it("DEP-002: starts totalPrincipal at zero", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      expect(await f.savingCore.totalPrincipal()).to.equal(0n);
    });
    for (const [label, id] of [["DEP-003", 1n], ["DEP-004", 0n]] as const) {
      it(`${label}: rejects nonexistent getDeposit(${id})`, async function () {
        const f = await networkHelpers.loadFixture(openDepositFixture);
        await assertDepositAbsent(f, id);
      });
    }
  });

  describe("Group B: Happy Path", function () {
    it("DEP-005/006: returns the ID and transfers principal from the caller into Core only", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      const before = await depositLedger(f);
      expect(await f.savingCore.connect(f.alice).openDeposit.staticCall(1, f.amount)).to.equal(1n);
      const tx = await f.savingCore.connect(f.alice).openDeposit(1, f.amount);
      await expect(tx).to.emit(f.token, "Transfer").withArgs(f.alice.address, f.savingCoreAddress, f.amount);
      const after = await depositLedger(f);
      expect(after.depositor).to.equal(before.depositor - f.amount);
      expect(after.core).to.equal(before.core + f.amount);
      expect(after.vault).to.equal(before.vault);
      expect(after.admin).to.equal(before.admin);
      expect(after.feeReceiver).to.equal(before.feeReceiver);
      expect(after.supply).to.equal(before.supply);
      expect(after.coreVaultAllowance).to.equal(0n);
      expect(after.depositorVaultAllowance).to.equal(0n);
    });
    it("DEP-007/008: mints exactly one ERC721 certificate owned by the depositor", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      const tx = await f.savingCore.connect(f.alice).openDeposit(1, f.amount);
      await expect(tx).to.emit(f.savingCore, "Transfer").withArgs(ethers.ZeroAddress, f.alice.address, 1n);
      expect(await f.savingCore.ownerOf(1)).to.equal(f.alice.address);
      expect(await f.savingCore.balanceOf(f.alice.address)).to.equal(1n);
      await assertDepositAbsent(f, 2n);
    });
    it("DEP-009/010: stores an Active record with the exact plan and principal", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();
      const d = await f.savingCore.getDeposit(1);
      expect(d.planId).to.equal(1n);
      expect(d.principal).to.equal(f.amount);
      expect(d.status).to.equal(0n);
      expect(d.length).to.equal(7);
    });
    it("DEP-011/012: uses the mined block timestamp and exact tenor in seconds", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      const receipt = await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      const d = await f.savingCore.getDeposit(1);
      expect(d.startAt).to.equal(BigInt(block!.timestamp));
      expect(d.maturityAt).to.equal(d.startAt + DEFAULT_TENOR_DAYS * 86400n);
    });
    it("DEP-013: snapshots the configured personal-variant APR and penalty", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();
      const d = await f.savingCore.getDeposit(1);
      expect(d.aprBpsAtOpen).to.equal(DEFAULT_APR_BPS);
      expect(d.penaltyBpsAtOpen).to.equal(DEFAULT_PENALTY_BPS);
    });
    it("DEP-014/015: increments depositCount once and totalPrincipal by the exact amount", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();
      expect(await f.savingCore.depositCount()).to.equal(1n);
      expect(await f.savingCore.totalPrincipal()).to.equal(f.amount);
    });
    it("DEP-016: emits the specified DepositOpened signature and all arguments", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      const tx = await f.savingCore.connect(f.alice).openDeposit(1, f.amount);
      const receipt = await tx.wait();
      const d = await f.savingCore.getDeposit(1);
      await expect(tx).to.emit(f.savingCore, "DepositOpened")
        .withArgs(1n, f.alice.address, 1n, f.amount, d.maturityAt, DEFAULT_APR_BPS);
      const event = f.savingCore.interface.getEvent("DepositOpened")!;
      expect(event.format("sighash")).to.equal("DepositOpened(uint256,address,uint256,uint256,uint256,uint256)");
      const log = receipt!.logs.find((entry) => entry.topics[0] === event.topicHash)!;
      expect(log.topics).to.have.length(4);
    });
  });

  describe("Group C: Plan Validation", function () {
    for (const [label, id] of [["DEP-017", 0n], ["DEP-018", 2n]] as const) {
      it(`${label}: rejects invalid plan ID ${id} without changing the ledger`, async function () {
        const f = await networkHelpers.loadFixture(openDepositFixture);
        const before = await depositLedger(f);
        await expect(f.savingCore.connect(f.alice).openDeposit(id, f.amount))
          .to.be.revertedWithCustomError(f.savingCore, "PlanNotFound").withArgs(id);
        expect(await depositLedger(f)).to.deep.equal(before);
      });
    }
    it("DEP-019: rejects a disabled plan but keeps it readable", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      await (await f.savingCore.connect(f.bankAdmin).disablePlan(1)).wait();
      const before = await depositLedger(f);
      await expect(f.savingCore.connect(f.alice).openDeposit(1, f.amount))
        .to.be.revertedWithCustomError(f.savingCore, "PlanDisabled").withArgs(1n);
      expect((await f.savingCore.getPlan(1)).enabled).to.equal(false);
      expect(await depositLedger(f)).to.deep.equal(before);
    });
    it("DEP-020: rejects a zero amount", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      const before = await depositLedger(f);
      await expect(f.savingCore.connect(f.alice).openDeposit(1, 0))
        .to.be.revertedWithCustomError(f.savingCore, "AmountZero");
      expect(await depositLedger(f)).to.deep.equal(before);
    });
    for (const [label, amount] of [["DEP-021", 9n], ["DEP-022", 21n]] as const) {
      it(`${label}: rejects amount ${amount} outside inclusive limits`, async function () {
        const f = await networkHelpers.loadFixture(openDepositFixture);
        const id = await addDepositPlan(f, 10n, 20n);
        const before = await depositLedger(f);
        await expect(f.savingCore.connect(f.alice).openDeposit(id, amount))
          .to.be.revertedWithCustomError(f.savingCore, "DepositAmountOutOfRange").withArgs(amount, 10n, 20n);
        expect(await depositLedger(f)).to.deep.equal(before);
      });
    }
    for (const [label, amount] of [["DEP-023", 10n], ["DEP-024", 20n]] as const) {
      it(`${label}: accepts the exact boundary amount ${amount}`, async function () {
        const f = await networkHelpers.loadFixture(openDepositFixture);
        const id = await addDepositPlan(f, 10n, 20n);
        await (await f.savingCore.connect(f.alice).openDeposit(id, amount)).wait();
        expect((await f.savingCore.getDeposit(1)).principal).to.equal(amount);
      });
    }
    it("DEP-025: zero minimum removes only the lower bound", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      const id = await addDepositPlan(f, 0n, 10n);
      await (await f.savingCore.connect(f.alice).openDeposit(id, 1n)).wait();
      await expect(f.savingCore.connect(f.alice).openDeposit(id, 11n))
        .to.be.revertedWithCustomError(f.savingCore, "DepositAmountOutOfRange").withArgs(11n, 0n, 10n);
    });
    it("DEP-026: zero maximum removes only the upper bound", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      const id = await addDepositPlan(f, 10n, 0n);
      await (await f.savingCore.connect(f.alice).openDeposit(id, f.amount)).wait();
      await expect(f.savingCore.connect(f.alice).openDeposit(id, 9n))
        .to.be.revertedWithCustomError(f.savingCore, "DepositAmountOutOfRange").withArgs(9n, 10n, 0n);
    });
    it("DEP-027: equal minimum and maximum accept only that exact amount", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      const id = await addDepositPlan(f, 10n, 10n);
      await (await f.savingCore.connect(f.alice).openDeposit(id, 10n)).wait();
      for (const amount of [9n, 11n]) {
        await expect(f.savingCore.connect(f.alice).openDeposit(id, amount))
          .to.be.revertedWithCustomError(f.savingCore, "DepositAmountOutOfRange").withArgs(amount, 10n, 10n);
      }
    });
  });

  describe("Group D: ERC20 Validation", function () {
    for (const [label, allowance] of [["DEP-028", depositUnits("100") - 1n], ["DEP-029", 0n]] as const) {
      it(`${label}: rejects insufficient allowance ${allowance} and preserves all state`, async function () {
        const f = await networkHelpers.loadFixture(openDepositFixture);
        await (await f.token.connect(f.alice).approve(f.savingCoreAddress, allowance)).wait();
        const before = await depositLedger(f);
        await expect(f.savingCore.connect(f.alice).openDeposit(1, f.amount))
          .to.be.revertedWithCustomError(f.token, "ERC20InsufficientAllowance")
          .withArgs(f.savingCoreAddress, allowance, f.amount);
        expect(await depositLedger(f)).to.deep.equal(before);
        await assertDepositAbsent(f, 1n);
      });
    }
    it("DEP-030: insufficient balance rolls back allowance spending and deposit effects", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      const balance = await f.token.balanceOf(f.alice.address);
      const amount = balance + 1n;
      await (await f.token.connect(f.alice).approve(f.savingCoreAddress, amount)).wait();
      const before = await depositLedger(f);
      await expect(f.savingCore.connect(f.alice).openDeposit(1, amount))
        .to.be.revertedWithCustomError(f.token, "ERC20InsufficientBalance").withArgs(f.alice.address, balance, amount);
      expect(await depositLedger(f)).to.deep.equal(before);
      await assertDepositAbsent(f, 1n);
    });
    it("DEP-031: spends an exact allowance completely", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();
      expect(await f.token.allowance(f.alice.address, f.savingCoreAddress)).to.equal(0n);
    });
    it("DEP-032: permits depositing the caller's entire balance", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      const amount = await f.token.balanceOf(f.alice.address);
      await (await f.token.connect(f.alice).approve(f.savingCoreAddress, amount)).wait();
      await (await f.savingCore.connect(f.alice).openDeposit(1, amount)).wait();
      expect(await f.token.balanceOf(f.alice.address)).to.equal(0n);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(amount);
    });
    it("DEP-033: preserves six-decimal amounts including a single smallest unit", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      const amount = depositUnits("1.000001");
      await (await f.savingCore.connect(f.alice).openDeposit(1, amount)).wait();
      await (await f.savingCore.connect(f.alice).openDeposit(1, 1n)).wait();
      expect((await f.savingCore.getDeposit(1)).principal).to.equal(1000001n);
      expect((await f.savingCore.getDeposit(2)).principal).to.equal(1n);
      expect(await f.savingCore.totalPrincipal()).to.equal(1000002n);
    });
  });

  describe("Group E: Binding & Pause", function () {
    for (const [label, wrongBinding] of [["DEP-034", false], ["DEP-035", true]] as const) {
      it(`${label}: rejects ${wrongBinding ? "a different bound contract" : "an unbound Vault"}`, async function () {
        const f = await networkHelpers.loadFixture(savingCoreWithPlanFixture);
        await (await f.token.mint(f.alice.address, depositUnits("100"))).wait();
        await (await f.token.connect(f.alice).approve(f.savingCoreAddress, depositUnits("100"))).wait();
        const actual = wrongBinding ? f.tokenAddress : ethers.ZeroAddress;
        if (wrongBinding) await (await f.vault.connect(f.bankAdmin).setSavingCore(actual)).wait();
        await expect(f.savingCore.connect(f.alice).openDeposit(1, depositUnits("100")))
          .to.be.revertedWithCustomError(f.savingCore, "CoreNotBound").withArgs(f.savingCoreAddress, actual);
        expect(await f.vault.savingCore()).to.equal(actual);
        expect(await f.savingCore.depositCount()).to.equal(0n);
        expect(await f.savingCore.totalPrincipal()).to.equal(0n);
        expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(0n);
        expect(await f.token.balanceOf(f.alice.address)).to.equal(depositUnits("100"));
        expect(await f.token.allowance(f.alice.address, f.savingCoreAddress)).to.equal(depositUnits("100"));
        await expect(f.savingCore.ownerOf(1)).to.be.revertedWithCustomError(f.savingCore, "ERC721NonexistentToken").withArgs(1n);
      });
    }
    it("DEP-036: pause rejects deposits atomically with the OZ EnforcedPause selector", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      const before = await depositLedger(f);
      await expect(f.savingCore.connect(f.alice).openDeposit(1, f.amount))
        .to.be.revertedWithCustomError(f.savingCore, "EnforcedPause");
      expect(f.savingCore.interface.getError("EnforcedPause")!.selector).to.equal(f.vault.interface.getError("EnforcedPause")!.selector);
      expect(await depositLedger(f)).to.deep.equal(before);
    });
    it("DEP-037: unpause restores deposit opening", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      await (await f.vault.connect(f.bankAdmin).unpause()).wait();
      await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();
      expect(await f.savingCore.ownerOf(1)).to.equal(f.alice.address);
    });
    it("DEP-038: paused Vault allows public record reads and plan administration", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();
      const before = await f.savingCore.getDeposit(1);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      await (await f.savingCore.connect(f.bankAdmin).updatePlan(1, 999n)).wait();
      await (await f.savingCore.connect(f.bankAdmin).disablePlan(1)).wait();
      expect(await f.savingCore.connect(f.bob).getDeposit(1)).to.deep.equal(before);
      expect((await f.savingCore.connect(f.bob).getPlan(1)).aprBps).to.equal(999n);
      await expect(f.savingCore.getDeposit(2)).to.be.revertedWithCustomError(f.savingCore, "DepositNotFound").withArgs(2n);
    });
  });

  describe("Group F: Snapshot & State Integrity", function () {
    it("DEP-039/040: old deposit retains APR while a new deposit captures the updated APR", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      await (await f.token.connect(f.alice).approve(f.savingCoreAddress, f.amount * 2n)).wait();
      await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();
      const before = await f.savingCore.getDeposit(1);
      await (await f.savingCore.connect(f.bankAdmin).updatePlan(1, 777n)).wait();
      await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();
      expect(await f.savingCore.getDeposit(1)).to.deep.equal(before);
      expect((await f.savingCore.getDeposit(2)).aprBpsAtOpen).to.equal(777n);
      expect((await f.savingCore.getPlan(1)).aprBps).to.equal(777n);
    });
    it("DEP-041: each deposit snapshots its selected plan's penalty", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      const secondPlan = await addDepositPlan(f, 0n, 0n, 111n, 888n, 7n);
      await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();
      await (await f.savingCore.connect(f.bob).openDeposit(secondPlan, f.amount)).wait();
      expect((await f.savingCore.getDeposit(1)).penaltyBpsAtOpen).to.equal(DEFAULT_PENALTY_BPS);
      const second = await f.savingCore.getDeposit(2);
      expect(second.penaltyBpsAtOpen).to.equal(888n);
      expect(second.aprBpsAtOpen).to.equal(111n);
      expect(second.maturityAt - second.startAt).to.equal(7n * 86400n);
    });
    it("DEP-042: disable and re-enable leave all existing deposit fields unchanged", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();
      const before = await f.savingCore.getDeposit(1);
      await (await f.savingCore.connect(f.bankAdmin).disablePlan(1)).wait();
      expect(await f.savingCore.getDeposit(1)).to.deep.equal(before);
      await (await f.savingCore.connect(f.bankAdmin).enablePlan(1)).wait();
      expect(await f.savingCore.getDeposit(1)).to.deep.equal(before);
    });
    it("DEP-043: multiple deposits have distinct sequential IDs and independent records", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      for (let id = 1n; id <= 3n; id++) {
        expect(await f.savingCore.connect(f.alice).openDeposit.staticCall(1, id)).to.equal(id);
        await (await f.savingCore.connect(f.alice).openDeposit(1, id)).wait();
        expect((await f.savingCore.getDeposit(id)).principal).to.equal(id);
        expect(await f.savingCore.ownerOf(id)).to.equal(f.alice.address);
      }
      expect(await f.savingCore.depositCount()).to.equal(3n);
      expect(await f.savingCore.balanceOf(f.alice.address)).to.equal(3n);
    });
    it("DEP-044: users open independently using only their own funds", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      const bobBalance = await f.token.balanceOf(f.bob.address);
      await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();
      expect(await f.token.balanceOf(f.bob.address)).to.equal(bobBalance);
      await (await f.savingCore.connect(f.bob).openDeposit(1, 2n)).wait();
      expect(await f.savingCore.ownerOf(1)).to.equal(f.alice.address);
      expect(await f.savingCore.ownerOf(2)).to.equal(f.bob.address);
      expect(await f.token.balanceOf(f.bob.address)).to.equal(bobBalance - 2n);
    });
    it("DEP-045: totalPrincipal equals the sum of all Active principal after every open", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      let sum = 0n;
      for (const [user, amount] of [[f.alice, 13n], [f.bob, f.amount], [f.alice, 1n]] as const) {
        await (await f.savingCore.connect(user).openDeposit(1, amount)).wait();
        sum += amount;
        const ledger = await depositLedger(f);
        expect(ledger.principal).to.equal(sum);
        expect(ledger.core).to.be.at.least(ledger.principal);
        const activeSum = ledger.records.reduce((total, record) => total + (record[6] === 0n ? BigInt(record[1]) : 0n), 0n);
        expect(activeSum).to.equal(sum);
      }
    });
    it("DEP-046: plan updates preserve existing certificate ownership", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();
      await (await f.savingCore.connect(f.bankAdmin).updatePlan(1, 0n)).wait();
      expect(await f.savingCore.ownerOf(1)).to.equal(f.alice.address);
    });
  });

  describe("Group G: Failure Atomicity & Security", function () {
    it("DEP-047/048/049: token false return after writes rolls back balances, allowance, records and mint", async function () {
      const f = await depositSecurityConnection.networkHelpers.loadFixture(falseReturnDepositFixture);
      const token = await depositSecurityConnection.ethers.getContractAt("ConfigurableTestToken", f.tokenAddress);
      // An existing deposit must survive failure of the next opening.
      await (await f.savingCore.connect(f.bob).openDeposit(1, 7n)).wait();
      await (await token.setFailureModes(false, true)).wait();
      const before = await depositLedger(f);
      await expect(f.savingCore.connect(f.alice).openDeposit.staticCall(1, f.amount))
        .to.be.revertedWithCustomError(f.savingCore, "SafeERC20FailedOperation").withArgs(f.tokenAddress);
      await assertMinedDepositRevert("ERC20 false after writes", await f.savingCore.connect(f.alice).openDeposit(1, f.amount, { gasLimit: 1500000n }));
      expect(await depositLedger(f)).to.deep.equal(before);
      await assertDepositAbsent(f, 2n);
      await (await token.setFailureModes(false, false)).wait();
      await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();
      expect(await f.savingCore.ownerOf(2)).to.equal(f.alice.address);
      expect(await f.savingCore.depositCount()).to.equal(2n);
    });
    it("DEP-050a: a contract without ERC721Receiver causes atomic mint rejection", async function () {
      const f = await depositSecurityConnection.networkHelpers.loadFixture(receiverDepositFixture);
      const caller = await depositSecurityConnection.ethers.deployContract("DepositCallerMock", [f.savingCoreAddress, f.operator.address]);
      await caller.waitForDeployment();
      const callerAddress = await caller.getAddress();
      await (await f.token.mint(callerAddress, f.amount)).wait();
      await (await caller.approveCore(f.amount)).wait();
      const before = await depositLedger(f, callerAddress);
      await expect(caller.open.staticCall(1, f.amount))
        .to.be.revertedWithCustomError(f.savingCore, "ERC721InvalidReceiver").withArgs(callerAddress);
      await assertMinedDepositRevert("missing ERC721Receiver", await caller.open(1, f.amount, { gasLimit: 1500000n }));
      expect(await depositLedger(f, callerAddress)).to.deep.equal(before);
      await assertDepositAbsent(f, 1n);
    });
    it("DEP-050b: a receiver returning the wrong selector rolls back the entire open", async function () {
      const f = await depositSecurityConnection.networkHelpers.loadFixture(receiverDepositFixture);
      await (await f.receiver.configure(2, ethers.ZeroAddress)).wait();
      const before = await depositLedger(f, f.receiverAddress);
      await expect(f.receiver.open.staticCall(1, f.amount))
        .to.be.revertedWithCustomError(f.savingCore, "ERC721InvalidReceiver").withArgs(f.receiverAddress);
      await assertMinedDepositRevert("wrong receiver selector", await f.receiver.open(1, f.amount, { gasLimit: 1500000n }));
      expect(await depositLedger(f, f.receiverAddress)).to.deep.equal(before);
      expect(await f.receiver.receivedId()).to.equal(0n);
      await assertDepositAbsent(f, 1n);
    });
    it("DEP-051a: caught ERC721 reentrancy reaches the guard and creates only the outer deposit", async function () {
      const f = await depositSecurityConnection.networkHelpers.loadFixture(receiverDepositFixture);
      await (await f.receiver.configure(3, ethers.ZeroAddress)).wait();
      await (await f.receiver.open(1, f.amount)).wait();
      expect(await f.receiver.reentryError()).to.equal(f.savingCore.interface.getError("ReentrancyGuardReentrantCall")!.selector);
      expect(await f.savingCore.depositCount()).to.equal(1n);
      expect(await f.savingCore.totalPrincipal()).to.equal(f.amount);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(f.amount);
      expect(await f.savingCore.ownerOf(1)).to.equal(f.receiverAddress);
      await assertDepositAbsent(f, 2n);
    });
    it("DEP-051b: propagated ERC721 reentrancy rolls back the entire mined transaction", async function () {
      const f = await depositSecurityConnection.networkHelpers.loadFixture(receiverDepositFixture);
      await (await f.receiver.configure(4, ethers.ZeroAddress)).wait();
      const before = await depositLedger(f, f.receiverAddress);
      await expect(f.receiver.open.staticCall(1, f.amount))
        .to.be.revertedWithCustomError(f.savingCore, "ReentrancyGuardReentrantCall");
      await assertMinedDepositRevert("ERC721 reentrancy", await f.receiver.open(1, f.amount, { gasLimit: 1500000n }));
      expect(await depositLedger(f, f.receiverAddress)).to.deep.equal(before);
      expect(await f.receiver.receivedId()).to.equal(0n);
      await assertDepositAbsent(f, 1n);
    });
    it("DEP-052: a reverting callback restores principal, finite allowance and receiver state", async function () {
      const f = await depositSecurityConnection.networkHelpers.loadFixture(receiverDepositFixture);
      await (await f.receiver.configure(1, ethers.ZeroAddress)).wait();
      const before = await depositLedger(f, f.receiverAddress);
      await expect(f.receiver.open.staticCall(1, f.amount)).to.be.revertedWithCustomError(f.receiver, "ReceiverRejected");
      await assertMinedDepositRevert("receiver rejection", await f.receiver.open(1, f.amount, { gasLimit: 1500000n }));
      expect(await depositLedger(f, f.receiverAddress)).to.deep.equal(before);
      expect(await f.receiver.receivedId()).to.equal(0n);
      await assertDepositAbsent(f, 1n);
    });
    it("DEP-053: donations remain surplus and never increase totalPrincipal", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      const donation = depositUnits("3.000001");
      await (await f.token.connect(f.bob).transfer(f.savingCoreAddress, donation)).wait();
      expect(await f.savingCore.totalPrincipal()).to.equal(0n);
      expect(await f.savingCore.depositCount()).to.equal(0n);
      await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(f.amount + donation);
      expect(await f.savingCore.totalPrincipal()).to.equal(f.amount);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.be.greaterThan(await f.savingCore.totalPrincipal());
    });
    it("DEP-054: successful opening conserves exact balances and principal backing", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      const before = await depositLedger(f);
      await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();
      const after = await depositLedger(f);
      expect(after.depositor + after.core + after.vault).to.equal(before.depositor + before.core + before.vault);
      expect(after.core - before.core).to.equal(f.amount);
      expect(after.principal - before.principal).to.equal(f.amount);
      expect(before.depositor - after.depositor).to.equal(f.amount);
      expect(after.vault).to.equal(before.vault);
      expect(after.core).to.be.at.least(after.principal);
      console.log(`      DEPOSIT_ACCOUNTING | depositor=${before.depositor}->${after.depositor} | core=${before.core}->${after.core} | vault=${before.vault}->${after.vault} | totalPrincipal=${before.principal}->${after.principal} | units=6-decimal`);
    });
  });

  describe("Group H: Transferable Ownership & Callbacks", function () {
    it("NFT-001: Alice transfers to Bob; ownerOf changes while record, principal and balances stay fixed", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();
      const before = await depositLedger(f);
      const tx = await f.savingCore.connect(f.alice)["safeTransferFrom(address,address,uint256)"](f.alice.address, f.bob.address, 1n);
      await expect(tx).to.emit(f.savingCore, "Transfer").withArgs(f.alice.address, f.bob.address, 1n);
      expect(await f.savingCore.ownerOf(1)).to.equal(f.bob.address);
      expect(await f.savingCore.balanceOf(f.alice.address)).to.equal(0n);
      expect(await f.savingCore.balanceOf(f.bob.address)).to.equal(1n);
      const after = await depositLedger(f);
      expect({ ...after, nfts: before.nfts, owners: before.owners }).to.deep.equal(before);
      expect(await f.savingCore.connect(f.alice).getDeposit(1)).to.deep.equal(await f.savingCore.connect(f.bob).getDeposit(1));
    });
    it("NFT-002: receiver sees backed principal and initialized NFT state before accepting mint", async function () {
      const f = await depositSecurityConnection.networkHelpers.loadFixture(receiverDepositFixture);
      await (await f.receiver.open(1, f.amount)).wait();
      expect(await f.receiver.receivedId()).to.equal(1n);
      expect(await f.receiver.callbackCoreBalance()).to.equal(f.amount);
      expect(await f.receiver.callbackTotalPrincipal()).to.equal(f.amount);
      expect(await f.receiver.callbackOwner()).to.equal(f.receiverAddress);
      expect(await f.savingCore.ownerOf(1)).to.equal(f.receiverAddress);
      expect((await f.savingCore.getDeposit(1)).status).to.equal(0n);
    });
    it("NFT-003: callback forwarding makes Bob current owner while DepositOpened keeps the initial recipient", async function () {
      const f = await depositSecurityConnection.networkHelpers.loadFixture(receiverDepositFixture);
      await (await f.receiver.configure(5, f.bob.address)).wait();
      const tx = await f.receiver.open(1, f.amount);
      const receipt = await tx.wait();
      const d = await f.savingCore.getDeposit(1);
      await expect(tx).to.emit(f.savingCore, "DepositOpened")
        .withArgs(1n, f.receiverAddress, 1n, f.amount, d.maturityAt, DEFAULT_APR_BPS);
      await expect(tx).to.emit(f.savingCore, "Transfer").withArgs(ethers.ZeroAddress, f.receiverAddress, 1n);
      await expect(tx).to.emit(f.savingCore, "Transfer").withArgs(f.receiverAddress, f.bob.address, 1n);
      expect(await f.savingCore.ownerOf(1)).to.equal(f.bob.address);
      expect(d.principal).to.equal(f.amount);
      expect(d.aprBpsAtOpen).to.equal(DEFAULT_APR_BPS);
      expect(d.penaltyBpsAtOpen).to.equal(DEFAULT_PENALTY_BPS);
      expect(d.status).to.equal(0n);
      expect(await f.savingCore.depositCount()).to.equal(1n);
      expect(await f.savingCore.totalPrincipal()).to.equal(f.amount);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(f.amount);
      const openTopic = f.savingCore.interface.getEvent("DepositOpened")!.topicHash;
      expect(receipt!.logs[receipt!.logs.length - 1].topics[0]).to.equal(openTopic);
    });
    for (const caught of [true, false]) {
      it(`SEC-${caught ? "001" : "002"}: ERC20 callback ${caught ? "catches the guard error and preserves one opening" : "propagates the guard error and atomically reverts"}`, async function () {
        const f = await depositSecurityConnection.networkHelpers.loadFixture(reentrantDepositFixture);
        const token = await depositSecurityConnection.ethers.getContractAt("CoreReentrantTestToken", f.tokenAddress);
        await (await token.mint(f.tokenAddress, 1n)).wait();
        await (await token.configure(f.savingCoreAddress, caught, true)).wait();
        if (caught) {
          await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();
          expect(await token.reentryError()).to.equal(f.savingCore.interface.getError("ReentrancyGuardReentrantCall")!.selector);
          expect(await f.savingCore.depositCount()).to.equal(1n);
          expect(await f.savingCore.totalPrincipal()).to.equal(f.amount);
          expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(f.amount);
          expect(await f.token.balanceOf(f.tokenAddress)).to.equal(1n);
          expect(await f.savingCore.ownerOf(1)).to.equal(f.alice.address);
          await assertDepositAbsent(f, 2n);
        } else {
          const before = await depositLedger(f);
          await expect(f.savingCore.connect(f.alice).openDeposit.staticCall(1, f.amount))
            .to.be.revertedWithCustomError(f.savingCore, "ReentrancyGuardReentrantCall");
          await assertMinedDepositRevert("ERC20 reentrancy", await f.savingCore.connect(f.alice).openDeposit(1, f.amount, { gasLimit: 1500000n }));
          expect(await depositLedger(f)).to.deep.equal(before);
          expect(await token.armed()).to.equal(true);
          expect(await f.token.allowance(f.tokenAddress, f.savingCoreAddress)).to.equal(ethers.MaxUint256);
          await assertDepositAbsent(f, 1n);
        }
      });
    }
  });

  describe("Group I: Arithmetic Feasibility", function () {
    it("MATH-001: full-precision mulDiv accepts a representable payout despite a 256-bit intermediate overflow", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      const amount = ethers.MaxUint256 / 4n;
      const coefficient = DEFAULT_APR_BPS * DEFAULT_TENOR_DAYS * 86400n;
      expect(amount * coefficient).to.be.greaterThan(ethers.MaxUint256);
      expect(amount + amount * coefficient / (365n * 86400n * 10000n)).to.be.at.most(ethers.MaxUint256);
      await (await f.token.mint(f.alice.address, amount)).wait();
      await (await f.token.connect(f.alice).approve(f.savingCoreAddress, amount)).wait();
      await (await f.savingCore.connect(f.alice).openDeposit(1, amount)).wait();
      expect((await f.savingCore.getDeposit(1)).principal).to.equal(amount);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(amount);
    });
    it("MATH-002: rejects overflowing full-term interest before any transfer or mint", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      const id = await addDepositPlan(f, 0n, 0n, 10000n, DEFAULT_PENALTY_BPS, 4294967295n);
      const amount = ethers.MaxUint256 / 2n;
      await (await f.token.mint(f.alice.address, amount)).wait();
      await (await f.token.connect(f.alice).approve(f.savingCoreAddress, amount)).wait();
      const before = await depositLedger(f);
      await expect(f.savingCore.connect(f.alice).openDeposit(id, amount)).to.be.revertedWithPanic(0x11);
      expect(await depositLedger(f)).to.deep.equal(before);
      await assertDepositAbsent(f, 1n);
    });
    it("MATH-003: rejects principal plus interest overflow even when interest itself fits", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      const id = await addDepositPlan(f, 0n, 0n, 10000n, DEFAULT_PENALTY_BPS, 365n);
      const amount = ethers.MaxUint256 / 2n + 1n;
      await (await f.token.mint(f.alice.address, amount)).wait();
      await (await f.token.connect(f.alice).approve(f.savingCoreAddress, amount)).wait();
      const before = await depositLedger(f);
      await expect(f.savingCore.connect(f.alice).openDeposit(id, amount)).to.be.revertedWithPanic(0x11);
      expect(await depositLedger(f)).to.deep.equal(before);
      await assertDepositAbsent(f, 1n);
    });
    it("MATH-004: accepts uint32-max tenor with zero APR and snapshots zero penalty", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      const id = await addDepositPlan(f, 0n, 0n, 0n, 0n, 4294967295n);
      await (await f.savingCore.connect(f.alice).openDeposit(id, 1n)).wait();
      const d = await f.savingCore.getDeposit(1);
      expect(d.maturityAt - d.startAt).to.equal(4294967295n * 86400n);
      expect(d.aprBpsAtOpen).to.equal(0n);
      expect(d.penaltyBpsAtOpen).to.equal(0n);
    });
    it("MATH-005: a one-unit principal with floor-rounded zero interest remains valid", async function () {
      const f = await networkHelpers.loadFixture(openDepositFixture);
      await (await f.savingCore.connect(f.alice).openDeposit(1, 1n)).wait();
      expect((await f.savingCore.getDeposit(1)).principal).to.equal(1n);
      expect(await f.savingCore.totalPrincipal()).to.equal(1n);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(1n);
    });
  });
});

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

async function assertMinedWithdrawRevert(label: string, tx: ContractTransactionResponse) {
  const receipt = await depositSecurityConnection.ethers.provider.getTransactionReceipt(tx.hash);
  expect(receipt, "failed transaction must have a mined receipt").not.to.equal(null);
  expect(receipt!.status).to.equal(0);
  expect(receipt!.logs).to.deep.equal([]);
  console.log(`      WITHDRAW_MINED_REVERT | ${label} | hash=${tx.hash} | block=${receipt!.blockNumber} | status=${receipt!.status} | logs=${receipt!.logs.length}`);
}

describe("SavingCore - Task D2-03: Interest, Penalty & Withdrawal Flows", function () {
  async function activeDepositFixture() {
    const f = await deployDepositSystem();
    const tx = await f.savingCore.connect(f.alice).openDeposit(1, f.amount);
    await tx.wait();
    const deposit = await f.savingCore.getDeposit(1);
    return { ...f, depositId: 1n, deposit };
  }

  describe("Group A: Interest Calculation", function () {
    it("INT-001: APR 200 bps, tenor 180 days returns exact contractual interest", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      // P = 100_000_000, APR = 200 bps, tenor = 180 days (15552000s)
      // I = 100_000_000 * 200 * 15552000 / (31536000 * 10000) = 986301
      const interest = await f.savingCore.calculateInterest(1);
      expect(interest).to.equal(986301n);
    });

    it("INT-002: updatePlan APR does not alter calculateInterest on existing deposit snapshot", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      const interestBefore = await f.savingCore.calculateInterest(1);
      await (await f.savingCore.connect(f.bankAdmin).updatePlan(1, 800)).wait();
      expect((await f.savingCore.getPlan(1)).aprBps).to.equal(800);
      expect(await f.savingCore.calculateInterest(1)).to.equal(interestBefore);
    });

    it("INT-003: APR 0 returns zero interest", async function () {
      const f = await networkHelpers.loadFixture(deployDepositSystem);
      const planId = await addDepositPlan(f, 0n, 0n, 0n, 350n, 180n);
      await (await f.savingCore.connect(f.alice).openDeposit(planId, f.amount)).wait();
      expect(await f.savingCore.calculateInterest(1)).to.equal(0n);
    });

    it("INT-004: APR 10000 bps (100%) returns exact 100% annual interest", async function () {
      const f = await networkHelpers.loadFixture(deployDepositSystem);
      // 365 days tenor at 10000 bps = exact 100% principal
      const planId = await addDepositPlan(f, 0n, 0n, 10000n, 350n, 365n);
      await (await f.savingCore.connect(f.alice).openDeposit(planId, f.amount)).wait();
      expect(await f.savingCore.calculateInterest(1)).to.equal(f.amount);
    });

    it("INT-005: floor integer division rounds down and preserves dust in Vault", async function () {
      const f = await networkHelpers.loadFixture(deployDepositSystem);
      // 1000 USDC = 1_000_000_000 units. Math exact = 9863013.698... Floored = 9863013
      await (await f.token.connect(f.alice).approve(f.savingCoreAddress, depositUnits("1000"))).wait();
      await (await f.savingCore.connect(f.alice).openDeposit(1, depositUnits("1000"))).wait();
      expect(await f.savingCore.calculateInterest(1)).to.equal(9863013n);
    });

    it("INT-006: 1 unit principal produces zero interest without underflow", async function () {
      const f = await networkHelpers.loadFixture(deployDepositSystem);
      await (await f.savingCore.connect(f.alice).openDeposit(1, 1n)).wait();
      expect(await f.savingCore.calculateInterest(1)).to.equal(0n);
    });

    it("INT-007: large principal does not overflow intermediate mulDiv", async function () {
      const f = await networkHelpers.loadFixture(deployDepositSystem);
      const largePrincipal = depositUnits("1000000000"); // 1 billion USDC (10^15 smallest units)
      await (await f.token.mint(f.alice.address, largePrincipal)).wait();
      await (await f.token.connect(f.alice).approve(f.savingCoreAddress, largePrincipal)).wait();
      const planId = await addDepositPlan(f, 0n, 0n, 10000n, 0n, 365n);
      await (await f.savingCore.connect(f.alice).openDeposit(planId, largePrincipal)).wait();
      expect(await f.savingCore.calculateInterest(1)).to.equal(largePrincipal);
    });

    it("INT-008: late withdrawal (time >> maturityAt) does not accrue additional interest", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      const interestAtMaturity = await f.savingCore.calculateInterest(1);
      // Advance 100 days past maturity
      await networkHelpers.time.increaseTo(f.deposit.maturityAt + 100n * 86400n);
      expect(await f.savingCore.calculateInterest(1)).to.equal(interestAtMaturity);
    });

    it("INT-009: disabling plan does not alter calculateInterest on existing deposit", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      const interestBefore = await f.savingCore.calculateInterest(1);
      await (await f.savingCore.connect(f.bankAdmin).disablePlan(1)).wait();
      expect(await f.savingCore.calculateInterest(1)).to.equal(interestBefore);
    });

    it("INT-010: calculateInterest rejects nonexistent depositId with DepositNotFound", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await expect(f.savingCore.calculateInterest(0)).to.be.revertedWithCustomError(f.savingCore, "DepositNotFound").withArgs(0);
      await expect(f.savingCore.calculateInterest(2)).to.be.revertedWithCustomError(f.savingCore, "DepositNotFound").withArgs(2);
    });
  });

  describe("Group B: Penalty Calculation", function () {
    it("PEN-001: penalty 350 bps returns exact 3.5% penalty", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      // P = 100_000_000, penalty = 350 bps -> 3_500_000
      expect(await f.savingCore.calculatePenalty(1)).to.equal(3500000n);
    });

    it("PEN-002: creating new plan does not alter calculatePenalty on existing deposit snapshot", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      const penaltyBefore = await f.savingCore.calculatePenalty(1);
      await addDepositPlan(f, 0n, 0n, 200n, 700n, 180n);
      expect(await f.savingCore.calculatePenalty(1)).to.equal(penaltyBefore);
    });

    it("PEN-003: penalty 0 bps returns zero penalty", async function () {
      const f = await networkHelpers.loadFixture(deployDepositSystem);
      const planId = await addDepositPlan(f, 0n, 0n, 200n, 0n, 180n);
      await (await f.savingCore.connect(f.alice).openDeposit(planId, f.amount)).wait();
      expect(await f.savingCore.calculatePenalty(1)).to.equal(0n);
    });

    it("PEN-004: penalty 10000 bps (100%) returns 100% of principal", async function () {
      const f = await networkHelpers.loadFixture(deployDepositSystem);
      const planId = await addDepositPlan(f, 0n, 0n, 200n, 10000n, 180n);
      await (await f.savingCore.connect(f.alice).openDeposit(planId, f.amount)).wait();
      expect(await f.savingCore.calculatePenalty(1)).to.equal(f.amount);
    });

    it("PEN-005: floor integer division rounds down penalty", async function () {
      const f = await networkHelpers.loadFixture(deployDepositSystem);
      // 100001 units at 350 bps: 100001 * 350 / 10000 = 3500.035 -> 3500
      await (await f.savingCore.connect(f.alice).openDeposit(1, 100001n)).wait();
      expect(await f.savingCore.calculatePenalty(1)).to.equal(3500n);
    });

    it("PEN-006: penalty never exceeds principal", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      const penalty = await f.savingCore.calculatePenalty(1);
      expect(penalty).to.be.lessThanOrEqual(f.deposit.principal);
    });

    it("PEN-007: calculatePenalty rejects nonexistent depositId with DepositNotFound", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await expect(f.savingCore.calculatePenalty(0)).to.be.revertedWithCustomError(f.savingCore, "DepositNotFound").withArgs(0);
      await expect(f.savingCore.calculatePenalty(99)).to.be.revertedWithCustomError(f.savingCore, "DepositNotFound").withArgs(99);
    });
  });

  describe("Group C: Maturity Withdrawal", function () {
    it("WD-M01: withdrawAtMaturity succeeds exactly at maturityAt", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      const tx = await f.savingCore.connect(f.alice).withdrawAtMaturity(1);
      await tx.wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });

    it("WD-M02: withdrawAtMaturity succeeds after maturityAt", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt + 86400n);
      const tx = await f.savingCore.connect(f.alice).withdrawAtMaturity(1);
      await tx.wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });

    it("WD-M03: withdrawAtMaturity before maturityAt reverts with DepositNotMatured", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotMatured").withArgs(1, f.deposit.maturityAt);
    });

    it("WD-M04: exact boundary at maturityAt - 1 second reverts, maturityAt succeeds", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt - 1n);
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotMatured").withArgs(1, f.deposit.maturityAt);

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      const tx = await f.savingCore.connect(f.alice).withdrawAtMaturity(1);
      await tx.wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });

    it("WD-M05 & WD-M06 & WD-M07 & WD-M08 & WD-M09: conserves all balances and decrements liabilities", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      const interest = await f.savingCore.calculateInterest(1);
      const P = f.deposit.principal;
      const I = interest;

      const aliceBefore = await f.token.balanceOf(f.alice.address);
      const coreBefore = await f.token.balanceOf(f.savingCoreAddress);
      const vaultBefore = await f.token.balanceOf(f.vaultAddress);
      const feeBefore = await f.token.balanceOf(f.feeReceiver.address);
      const totalPrincipalBefore = await f.savingCore.totalPrincipal();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();

      expect(await f.token.balanceOf(f.alice.address)).to.equal(aliceBefore + P + I);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(coreBefore - P);
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(vaultBefore - I);
      expect(await f.token.balanceOf(f.feeReceiver.address)).to.equal(feeBefore);
      expect(await f.savingCore.totalPrincipal()).to.equal(totalPrincipalBefore - P);
    });

    it("WD-M10: updates deposit status to Withdrawn", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();
      const updated = await f.savingCore.getDeposit(1);
      expect(updated.status).to.equal(1); // DepositStatus.Withdrawn = 1
    });

    it("WD-M11: emits Withdrawn event with accurate fields", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      const interest = await f.savingCore.calculateInterest(1);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await expect(f.savingCore.connect(f.alice).withdrawAtMaturity(1))
        .to.emit(f.savingCore, "Withdrawn")
        .withArgs(1n, f.alice.address, f.deposit.principal, interest, false);
    });

    it("WD-M12: double maturity withdrawal reverts with DepositNotActive", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();

      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive").withArgs(1, 1); // status 1 = Withdrawn
    });

    it("WD-M13: insufficient Vault liquidity causes entire transaction to revert atomically", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      // Admin drains Vault
      const vaultBalance = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(vaultBalance)).wait();
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(0n);

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      const interest = await f.savingCore.calculateInterest(1);
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.vault, "InsufficientVaultBalance").withArgs(0n, interest);

      // Verify no changes occurred
      expect((await f.savingCore.getDeposit(1)).status).to.equal(0); // still Active
      expect(await f.savingCore.totalPrincipal()).to.equal(f.deposit.principal);
    });

    it("WD-M14: after Admin funds Vault, user retry succeeds", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      const vaultBalance = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(vaultBalance)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      const interest = await f.savingCore.calculateInterest(1);
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.vault, "InsufficientVaultBalance").withArgs(0n, interest);

      // Admin funds Vault
      await (await f.token.mint(f.bankAdmin.address, depositUnits("100"))).wait();
      await (await f.token.connect(f.bankAdmin).approve(f.vaultAddress, depositUnits("100"))).wait();
      await (await f.vault.connect(f.bankAdmin).fundVault(depositUnits("100"))).wait();

      // Alice retries and succeeds
      const tx = await f.savingCore.connect(f.alice).withdrawAtMaturity(1);
      await tx.wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });

    it("WD-M15: zero interest (APR = 0) succeeds without requiring Vault liquidity", async function () {
      const f = await networkHelpers.loadFixture(deployDepositSystem);
      const planId = await addDepositPlan(f, 0n, 0n, 0n, 350n, 180n);
      await (await f.savingCore.connect(f.alice).openDeposit(planId, f.amount)).wait();

      // Drain Vault to 0
      const vaultBal = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(vaultBal)).wait();
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(0n);

      const deposit = await f.savingCore.getDeposit(1);
      await networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt);

      const aliceBefore = await f.token.balanceOf(f.alice.address);
      const tx = await f.savingCore.connect(f.alice).withdrawAtMaturity(1);
      await tx.wait();
      expect(await f.token.balanceOf(f.alice.address)).to.equal(aliceBefore + f.amount);
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(0n);
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });

    it("WD-M16: plan disabled or updated after opening does not impede maturity withdrawal", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await (await f.savingCore.connect(f.bankAdmin).disablePlan(1)).wait();
      await (await f.savingCore.connect(f.bankAdmin).updatePlan(1, 999)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      const tx = await f.savingCore.connect(f.alice).withdrawAtMaturity(1);
      await tx.wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });
  });

  describe("Group D: Early Withdrawal", function () {
    it("WD-E01: earlyWithdraw succeeds before maturity", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      const tx = await f.savingCore.connect(f.alice).earlyWithdraw(1);
      await tx.wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });

    it("WD-E02: earlyWithdraw succeeds at maturityAt - 1 second", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt - 1n);
      const tx = await f.savingCore.connect(f.alice).earlyWithdraw(1);
      await tx.wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });

    it("WD-E03: earlyWithdraw at maturityAt reverts with EarlyWithdrawalClosed", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await expect(
        f.savingCore.connect(f.alice).earlyWithdraw(1)
      ).to.be.revertedWithCustomError(f.savingCore, "EarlyWithdrawalClosed").withArgs(1, f.deposit.maturityAt);
    });

    it("WD-E04 & WD-E05 & WD-E06 & WD-E07 & WD-E08 & WD-E09: distributes net payout and penalty, leaving Vault untouched", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      const P = f.deposit.principal;
      const penalty = await f.savingCore.calculatePenalty(1);
      const netPayout = P - penalty;

      const aliceBefore = await f.token.balanceOf(f.alice.address);
      const coreBefore = await f.token.balanceOf(f.savingCoreAddress);
      const vaultBefore = await f.token.balanceOf(f.vaultAddress);
      const feeBefore = await f.token.balanceOf(f.feeReceiver.address);
      const totalPrincipalBefore = await f.savingCore.totalPrincipal();

      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();

      expect(await f.token.balanceOf(f.alice.address)).to.equal(aliceBefore + netPayout);
      expect(await f.token.balanceOf(f.feeReceiver.address)).to.equal(feeBefore + penalty);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(coreBefore - P);
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(vaultBefore); // unchanged!
      expect(await f.savingCore.totalPrincipal()).to.equal(totalPrincipalBefore - P); // decremented by full P!
    });

    it("WD-E10: updates deposit status to Withdrawn", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });

    it("WD-E11: emits Withdrawn event with interest=0 and isEarly=true", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await expect(f.savingCore.connect(f.alice).earlyWithdraw(1))
        .to.emit(f.savingCore, "Withdrawn")
        .withArgs(1n, f.alice.address, f.deposit.principal, 0n, true);
    });

    it("WD-E12: double early withdrawal reverts with DepositNotActive", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();
      await expect(
        f.savingCore.connect(f.alice).earlyWithdraw(1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive").withArgs(1, 1);
    });

    it("WD-E13: zero penalty pays 100% principal to owner and 0 to feeReceiver", async function () {
      const f = await networkHelpers.loadFixture(deployDepositSystem);
      const planId = await addDepositPlan(f, 0n, 0n, 200n, 0n, 180n);
      await (await f.savingCore.connect(f.alice).openDeposit(planId, f.amount)).wait();

      const aliceBefore = await f.token.balanceOf(f.alice.address);
      const feeBefore = await f.token.balanceOf(f.feeReceiver.address);

      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();
      expect(await f.token.balanceOf(f.alice.address)).to.equal(aliceBefore + f.amount);
      expect(await f.token.balanceOf(f.feeReceiver.address)).to.equal(feeBefore);
    });

    it("WD-E14: 100% penalty pays 100% principal to feeReceiver and 0 to owner", async function () {
      const f = await networkHelpers.loadFixture(deployDepositSystem);
      const planId = await addDepositPlan(f, 0n, 0n, 200n, 10000n, 180n);
      await (await f.savingCore.connect(f.alice).openDeposit(planId, f.amount)).wait();

      const aliceBefore = await f.token.balanceOf(f.alice.address);
      const feeBefore = await f.token.balanceOf(f.feeReceiver.address);

      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();
      expect(await f.token.balanceOf(f.alice.address)).to.equal(aliceBefore);
      expect(await f.token.balanceOf(f.feeReceiver.address)).to.equal(feeBefore + f.amount);
    });

    it("WD-E15: plan disabled does not impede early withdrawal of existing deposit", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await (await f.savingCore.connect(f.bankAdmin).disablePlan(1)).wait();
      const tx = await f.savingCore.connect(f.alice).earlyWithdraw(1);
      await tx.wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });
  });

  describe("Group E: Authorization & NFT Ownership", function () {
    it("AUTH-001: original depositor withdraws when still owning NFT", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      expect(await f.savingCore.ownerOf(1)).to.equal(f.alice.address);
      const tx = await f.savingCore.connect(f.alice).earlyWithdraw(1);
      await tx.wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });

    it("AUTH-002: non-owner caller is rejected with NotDepositOwner", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await expect(
        f.savingCore.connect(f.bob).earlyWithdraw(1)
      ).to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner").withArgs(1, f.bob.address);

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await expect(
        f.savingCore.connect(f.bob).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner").withArgs(1, f.bob.address);
    });

    it("AUTH-003 & AUTH-004 & AUTH-005: Alice transfers NFT to Bob; Alice loses access, Bob gains maturity withdrawal access", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      // Alice transfers certificate to Bob
      await (await f.savingCore.connect(f.alice).transferFrom(f.alice.address, f.bob.address, 1)).wait();
      expect(await f.savingCore.ownerOf(1)).to.equal(f.bob.address);

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      // Alice is rejected
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner").withArgs(1, f.alice.address);

      // Bob withdraws and receives the funds
      const bobBefore = await f.token.balanceOf(f.bob.address);
      const interest = await f.savingCore.calculateInterest(1);
      await (await f.savingCore.connect(f.bob).withdrawAtMaturity(1)).wait();
      expect(await f.token.balanceOf(f.bob.address)).to.equal(bobBefore + f.deposit.principal + interest);
    });

    it("AUTH-006 & AUTH-007: Bob executes early withdrawal after transfer and receives net payout", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await (await f.savingCore.connect(f.alice).transferFrom(f.alice.address, f.bob.address, 1)).wait();

      const bobBefore = await f.token.balanceOf(f.bob.address);
      const aliceBefore = await f.token.balanceOf(f.alice.address);
      const penalty = await f.savingCore.calculatePenalty(1);
      const netPayout = f.deposit.principal - penalty;

      await (await f.savingCore.connect(f.bob).earlyWithdraw(1)).wait();
      expect(await f.token.balanceOf(f.bob.address)).to.equal(bobBefore + netPayout);
      expect(await f.token.balanceOf(f.alice.address)).to.equal(aliceBefore); // Alice receives nothing
    });

    it("AUTH-008: approved operator cannot settle withdrawal (owner-only restriction)", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      // Alice approves Bob for token 1
      await (await f.savingCore.connect(f.alice).approve(f.bob.address, 1)).wait();
      expect(await f.savingCore.getApproved(1)).to.equal(f.bob.address);

      // Operator Bob cannot early withdraw
      await expect(
        f.savingCore.connect(f.bob).earlyWithdraw(1)
      ).to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner").withArgs(1, f.bob.address);

      // Operator Bob cannot maturity withdraw
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await expect(
        f.savingCore.connect(f.bob).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.savingCore, "NotDepositOwner").withArgs(1, f.bob.address);
    });

    it("AUTH-009: nonexistent depositId (0 or beyond count) reverts with DepositNotFound", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(0)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotFound").withArgs(0);

      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(50)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotFound").withArgs(50);

      await expect(
        f.savingCore.connect(f.alice).earlyWithdraw(0)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotFound").withArgs(0);

      await expect(
        f.savingCore.connect(f.alice).earlyWithdraw(50)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotFound").withArgs(50);
    });

    it("AUTH-010: cannot withdraw deposit in terminal status", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();

      await expect(
        f.savingCore.connect(f.alice).earlyWithdraw(1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive").withArgs(1, 1);

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotActive").withArgs(1, 1);
    });
  });

  describe("Group F: Pause & Binding", function () {
    it("SEC-001: Vault paused blocks maturity withdrawal with EnforcedPause", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.savingCore, "EnforcedPause");
    });

    it("SEC-002: Vault paused blocks early withdrawal with EnforcedPause", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();

      await expect(
        f.savingCore.connect(f.alice).earlyWithdraw(1)
      ).to.be.revertedWithCustomError(f.savingCore, "EnforcedPause");
    });

    it("SEC-003: unpausing Vault restores withdrawal functionality", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      await expect(f.savingCore.connect(f.alice).earlyWithdraw(1)).to.be.revertedWithCustomError(f.savingCore, "EnforcedPause");

      await (await f.vault.connect(f.bankAdmin).unpause()).wait();
      const tx = await f.savingCore.connect(f.alice).earlyWithdraw(1);
      await tx.wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
    });

    it("SEC-004: unbound Core rejected with CoreNotBound", async function () {
      const f = await networkHelpers.loadFixture(deploySavingCoreFixture);
      // In deploySavingCoreFixture, Vault has not called setSavingCore(savingCore)
      expect(await f.vault.savingCore()).to.equal(ethers.ZeroAddress);

      // Direct call on unbound core reverts with CoreNotBound
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.savingCore, "CoreNotBound").withArgs(f.savingCoreAddress, ethers.ZeroAddress);

      await expect(
        f.savingCore.connect(f.alice).earlyWithdraw(1)
      ).to.be.revertedWithCustomError(f.savingCore, "CoreNotBound").withArgs(f.savingCoreAddress, ethers.ZeroAddress);
    });

    it("SEC-005: failed withdrawal due to pause leaves principal ledger and balances unchanged", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();

      const totalPrincipalBefore = await f.savingCore.totalPrincipal();
      const coreBalBefore = await f.token.balanceOf(f.savingCoreAddress);

      await expect(f.savingCore.connect(f.alice).earlyWithdraw(1)).to.be.revertedWithCustomError(f.savingCore, "EnforcedPause");

      expect(await f.savingCore.totalPrincipal()).to.equal(totalPrincipalBefore);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(coreBalBefore);
      expect((await f.savingCore.getDeposit(1)).status).to.equal(0);
    });
  });

  describe("Group G: Atomicity, Security & Accounting Invariants", function () {
    it("SEC-006: Vault interest payout failure reverts entire transaction atomically", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      // Empty the vault
      const bal = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(bal)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      const aliceBalBefore = await f.token.balanceOf(f.alice.address);
      const coreBalBefore = await f.token.balanceOf(f.savingCoreAddress);
      const totalPrincipalBefore = await f.savingCore.totalPrincipal();
      const interest = await f.savingCore.calculateInterest(1);

      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.vault, "InsufficientVaultBalance").withArgs(0n, interest);

      expect(await f.token.balanceOf(f.alice.address)).to.equal(aliceBalBefore);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(coreBalBefore);
      expect(await f.savingCore.totalPrincipal()).to.equal(totalPrincipalBefore);
      expect((await f.savingCore.getDeposit(1)).status).to.equal(0);
    });

    it("SEC-007: token transfer failure on fee transfer rolls back early withdrawal atomically", async function () {
      const f = await depositSecurityConnection.networkHelpers.loadFixture(falseReturnDepositFixture);
      await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();

      const token = await depositSecurityConnection.ethers.getContractAt("ConfigurableTestToken", f.tokenAddress);
      await (await token.setFailureModes(true, false)).wait(); // fail transfer

      const coreBefore = await f.token.balanceOf(f.savingCoreAddress);
      const totalPrincipalBefore = await f.savingCore.totalPrincipal();

      await expect(f.savingCore.connect(f.alice).earlyWithdraw.staticCall(1))
        .to.be.revertedWithCustomError(f.savingCore, "SafeERC20FailedOperation").withArgs(f.tokenAddress);
      await assertMinedWithdrawRevert("fee transfer failure", await f.savingCore.connect(f.alice).earlyWithdraw(1, { gasLimit: 1500000n }));

      expect(await f.savingCore.totalPrincipal()).to.equal(totalPrincipalBefore);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(coreBefore);
      expect((await f.savingCore.getDeposit(1)).status).to.equal(0);
    });

    it("SEC-008: token transfer failure on principal payout rolls back maturity withdrawal atomically", async function () {
      const f = await depositSecurityConnection.networkHelpers.loadFixture(falseReturnDepositFixture);
      await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();

      const deposit = await f.savingCore.getDeposit(1);
      await depositSecurityConnection.networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt);

      const token = await depositSecurityConnection.ethers.getContractAt("ConfigurableTestToken", f.tokenAddress);
      await (await token.setFailureModes(true, false)).wait();

      await expect(f.savingCore.connect(f.alice).withdrawAtMaturity.staticCall(1))
        .to.be.revertedWithCustomError(f.savingCore, "SafeERC20FailedOperation").withArgs(f.tokenAddress);
      await assertMinedWithdrawRevert("principal payout failure", await f.savingCore.connect(f.alice).withdrawAtMaturity(1, { gasLimit: 1500000n }));

      expect(await f.savingCore.totalPrincipal()).to.equal(f.amount);
      expect((await f.savingCore.getDeposit(1)).status).to.equal(0);
    });

    it("SEC-009: ERC20 callback reentrancy during withdrawal is blocked by nonReentrant", async function () {
      const f = await depositSecurityConnection.networkHelpers.loadFixture(reentrantDepositFixture);
      await (await f.savingCore.connect(f.alice).openDeposit(1, f.amount)).wait();

      const deposit = await f.savingCore.getDeposit(1);
      await depositSecurityConnection.networkHelpers.time.setNextBlockTimestamp(deposit.maturityAt);

      const token = await depositSecurityConnection.ethers.getContractAt("CoreReentrantTestToken", f.tokenAddress);
      // Configure attack: on transfer, attempt reentering withdrawAtMaturity(1)
      await (await token.configureAttack(
        f.savingCoreAddress,
        1, // AttackType.WithdrawMaturity
        1n,
        true, // catch reentry
        true  // armed
      )).wait();

      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();
      // The nested reentrant call was caught by the token and registered ReentrancyGuardReentrantCall
      expect(await token.reentryError()).to.equal(f.savingCore.interface.getError("ReentrancyGuardReentrantCall")!.selector);
    });

    it("SEC-010 & SEC-011 & SEC-012: failed transaction preserves deposit status, totalPrincipal and NFT ownership", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.savingCore, "DepositNotMatured");

      expect((await f.savingCore.getDeposit(1)).status).to.equal(0);
      expect(await f.savingCore.totalPrincipal()).to.equal(f.deposit.principal);
      expect(await f.savingCore.ownerOf(1)).to.equal(f.alice.address);
    });

    it("SEC-013: multiple active deposits remain unaffected when one deposit is settled", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      // Bob opens deposit 2
      await (await f.savingCore.connect(f.bob).openDeposit(1, f.amount)).wait();
      expect(await f.savingCore.depositCount()).to.equal(2n);
      expect(await f.savingCore.totalPrincipal()).to.equal(f.amount * 2n);

      // Alice early withdraws deposit 1
      await (await f.savingCore.connect(f.alice).earlyWithdraw(1)).wait();
      expect((await f.savingCore.getDeposit(1)).status).to.equal(1);
      expect((await f.savingCore.getDeposit(2)).status).to.equal(0); // Bob's deposit remains active!
      expect(await f.savingCore.totalPrincipal()).to.equal(f.amount);
    });

    it("SEC-014: direct donation / surplus to Core is never used as interest substitute", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      // Donate 100 USDC to Core
      await (await f.token.mint(f.savingCoreAddress, depositUnits("100"))).wait();
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(f.amount + depositUnits("100"));

      // Empty Vault
      const vaultBal = await f.token.balanceOf(f.vaultAddress);
      await (await f.vault.connect(f.bankAdmin).withdrawVault(vaultBal)).wait();

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);

      // Even though Core has plenty of surplus tokens, withdrawal MUST revert because interest cannot be pulled from Vault!
      const interest = await f.savingCore.calculateInterest(1);
      await expect(
        f.savingCore.connect(f.alice).withdrawAtMaturity(1)
      ).to.be.revertedWithCustomError(f.vault, "InsufficientVaultBalance").withArgs(0n, interest);
    });

    it("SEC-015: token.balanceOf(Core) >= totalPrincipal holds after settlement and with donations", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      // Donate 10 USDC to Core
      await (await f.token.mint(f.savingCoreAddress, depositUnits("10"))).wait();
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.be.greaterThanOrEqual(await f.savingCore.totalPrincipal());

      // Alice withdraws
      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      await (await f.savingCore.connect(f.alice).withdrawAtMaturity(1)).wait();

      // Total principal is now 0, Core still holds the donation
      expect(await f.savingCore.totalPrincipal()).to.equal(0n);
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.equal(depositUnits("10"));
      expect(await f.token.balanceOf(f.savingCoreAddress)).to.be.greaterThanOrEqual(await f.savingCore.totalPrincipal());
    });
  });

  describe("Real Transaction Accounting Evidence (Part E)", function () {
    it("EVID-001: Maturity Withdrawal Accounting Log", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      const P = f.deposit.principal;
      const I = await f.savingCore.calculateInterest(1);

      const coreBefore = await f.token.balanceOf(f.savingCoreAddress);
      const vaultBefore = await f.token.balanceOf(f.vaultAddress);
      const ownerBefore = await f.token.balanceOf(f.alice.address);
      const feeBefore = await f.token.balanceOf(f.feeReceiver.address);
      const totalPBefore = await f.savingCore.totalPrincipal();
      const statusBefore = (await f.savingCore.getDeposit(1)).status;

      await networkHelpers.time.setNextBlockTimestamp(f.deposit.maturityAt);
      const tx = await f.savingCore.connect(f.alice).withdrawAtMaturity(1);
      const receipt = await tx.wait();

      const coreAfter = await f.token.balanceOf(f.savingCoreAddress);
      const vaultAfter = await f.token.balanceOf(f.vaultAddress);
      const ownerAfter = await f.token.balanceOf(f.alice.address);
      const feeAfter = await f.token.balanceOf(f.feeReceiver.address);
      const totalPAfter = await f.savingCore.totalPrincipal();
      const statusAfter = (await f.savingCore.getDeposit(1)).status;

      console.log(`      WITHDRAW_MATURITY_ACCOUNTING | P=${P} | I=${I} | core=${coreBefore}->${coreAfter} | vault=${vaultBefore}->${vaultAfter} | owner=${ownerBefore}->${ownerAfter} | feeReceiver=${feeBefore}->${feeAfter} | totalPrincipal=${totalPBefore}->${totalPAfter} | status=${statusBefore}->${statusAfter} | txHash=${receipt!.hash}`);

      expect(coreAfter).to.equal(coreBefore - P);
      expect(vaultAfter).to.equal(vaultBefore - I);
      expect(ownerAfter).to.equal(ownerBefore + P + I);
      expect(feeAfter).to.equal(feeBefore);
      expect(totalPAfter).to.equal(totalPBefore - P);
      expect(statusAfter).to.equal(1);
    });

    it("EVID-002: Early Withdrawal Accounting Log", async function () {
      const f = await networkHelpers.loadFixture(activeDepositFixture);
      const P = f.deposit.principal;
      const F = await f.savingCore.calculatePenalty(1);

      const coreBefore = await f.token.balanceOf(f.savingCoreAddress);
      const vaultBefore = await f.token.balanceOf(f.vaultAddress);
      const ownerBefore = await f.token.balanceOf(f.alice.address);
      const feeBefore = await f.token.balanceOf(f.feeReceiver.address);
      const totalPBefore = await f.savingCore.totalPrincipal();
      const statusBefore = (await f.savingCore.getDeposit(1)).status;

      const tx = await f.savingCore.connect(f.alice).earlyWithdraw(1);
      const receipt = await tx.wait();

      const coreAfter = await f.token.balanceOf(f.savingCoreAddress);
      const vaultAfter = await f.token.balanceOf(f.vaultAddress);
      const ownerAfter = await f.token.balanceOf(f.alice.address);
      const feeAfter = await f.token.balanceOf(f.feeReceiver.address);
      const totalPAfter = await f.savingCore.totalPrincipal();
      const statusAfter = (await f.savingCore.getDeposit(1)).status;

      console.log(`      WITHDRAW_EARLY_ACCOUNTING | P=${P} | F=${F} | core=${coreBefore}->${coreAfter} | vault=${vaultBefore}->${vaultAfter} | owner=${ownerBefore}->${ownerAfter} | feeReceiver=${feeBefore}->${feeAfter} | totalPrincipal=${totalPBefore}->${totalPAfter} | status=${statusBefore}->${statusAfter} | txHash=${receipt!.hash}`);

      expect(coreAfter).to.equal(coreBefore - P);
      expect(vaultAfter).to.equal(vaultBefore);
      expect(ownerAfter).to.equal(ownerBefore + P - F);
      expect(feeAfter).to.equal(feeBefore + F);
      expect(totalPAfter).to.equal(totalPBefore - P);
      expect(statusAfter).to.equal(1);
    });
  });
});
