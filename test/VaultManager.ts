import { expect } from "chai";
import type { BaseContract, ContractTransactionResponse, Interface } from "ethers";
import { artifacts, network } from "hardhat";

const connection = await network.create("hardhatMainnet");
const { ethers, networkHelpers } = connection;
const securityConnection = await network.create({
  network: "hardhatMainnet",
  override: { throwOnTransactionFailures: false },
});
const units = (amount: string): bigint => ethers.parseUnits(amount, 6);

async function deployVaultFixture() {
  const [deployer, bankAdmin, alice, stranger, feeReceiver, newAdmin, callerOperator] = await ethers.getSigners();
  const token = await ethers.deployContract("MockUSDC");
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  const vault = await ethers.deployContract("VaultManager", [tokenAddress, bankAdmin.address, feeReceiver.address]);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  const caller = await ethers.deployContract("VaultCallerMock", [vaultAddress, callerOperator.address]);
  await caller.waitForDeployment();
  const callerAddress = await caller.getAddress();
  return { token, vault, caller, tokenAddress, vaultAddress, callerAddress, deployer, bankAdmin, alice, stranger, feeReceiver, newAdmin, callerOperator };
}

async function seededVaultFixture() {
  const f = await deployVaultFixture();
  await (await f.token.mint(f.bankAdmin.address, units("2000"))).wait();
  return f;
}

async function fundedVaultFixture() {
  const f = await seededVaultFixture();
  await (await f.token.connect(f.bankAdmin).approve(f.vaultAddress, units("1000"))).wait();
  await (await f.vault.connect(f.bankAdmin).fundVault(units("1000"))).wait();
  return f;
}

async function boundVaultFixture() {
  const f = await fundedVaultFixture();
  await (await f.vault.connect(f.bankAdmin).setSavingCore(f.callerAddress)).wait();
  return f;
}

type VaultFixture = Awaited<ReturnType<typeof deployVaultFixture>>;
interface LedgerToken {
  balanceOf(account: string): Promise<bigint>;
  allowance(owner: string, spender: string): Promise<bigint>;
  totalSupply(): Promise<bigint>;
}

async function ledger(token: LedgerToken, accounts: string[], owner: string, spender: string) {
  return {
    balances: await Promise.all(accounts.map((address) => token.balanceOf(address))),
    allowance: await token.allowance(owner, spender),
    supply: await token.totalSupply(),
  };
}

async function state(f: VaultFixture) {
  return {
    ledger: await ledger(f.token, [f.bankAdmin.address, f.vaultAddress, f.callerAddress, f.alice.address, f.stranger.address, f.feeReceiver.address, f.newAdmin.address, f.callerOperator.address], f.bankAdmin.address, f.vaultAddress),
    owner: await f.vault.owner(), core: await f.vault.savingCore(),
    receiver: await f.vault.feeReceiver(), paused: await f.vault.paused(),
  };
}

async function rejects(
  f: VaultFixture,
  operation: () => Promise<unknown>,
  error: string,
  args: unknown[] = [],
  decoder: BaseContract = f.vault,
): Promise<void> {
  const before = await state(f);
  await expect(operation()).to.be.revertedWithCustomError(decoder, error).withArgs(...args);
  expect(await state(f)).to.deep.equal(before);
}

describe("VaultManager", function () {
  after(async function () {
    await connection.close();
    await securityConnection.close();
  });

  describe("Constructor", function () {
    it("VAULT-001: initializes the explicit admin, asset and empty unbound state", async function () {
      const f = await networkHelpers.loadFixture(deployVaultFixture);
      expect(f.bankAdmin.address).not.to.equal(f.deployer.address);
      expect(await f.vault.owner()).to.equal(f.bankAdmin.address);
      expect(await f.vault.token()).to.equal(f.tokenAddress);
      expect(await f.vault.feeReceiver()).to.equal(f.feeReceiver.address);
      expect(await f.vault.savingCore()).to.equal(ethers.ZeroAddress);
      expect(await f.vault.paused()).to.equal(false);
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(0n);
      expect(await f.token.totalSupply()).to.equal(0n);
    });

    for (const [id, field] of [["002", "token"], ["003", "admin"], ["004", "receiver"]] as const) {
      it(`VAULT-${id}: rejects zero ${field} with ZeroAddress`, async function () {
        const f = await networkHelpers.loadFixture(deployVaultFixture);
        const factory = await ethers.getContractFactory("VaultManager");
        const args = [field === "token" ? ethers.ZeroAddress : f.tokenAddress, field === "admin" ? ethers.ZeroAddress : f.bankAdmin.address, field === "receiver" ? ethers.ZeroAddress : f.feeReceiver.address] as const;
        await rejects(f, () => factory.deploy(...args), "ZeroAddress");
      });
    }

    it("VAULT-005: rejects an EOA asset", async function () {
      const f = await networkHelpers.loadFixture(deployVaultFixture);
      const factory = await ethers.getContractFactory("VaultManager");
      await rejects(f, () => factory.deploy(f.stranger.address, f.bankAdmin.address, f.feeReceiver.address), "InvalidContract", [f.stranger.address]);
    });

    it("VAULT-006: rejects a deployed token with eighteen decimals", async function () {
      const f = await networkHelpers.loadFixture(deployVaultFixture);
      const invalidToken = await ethers.deployContract("ConfigurableTestToken", [18]);
      await invalidToken.waitForDeployment();
      const factory = await ethers.getContractFactory("VaultManager");
      await rejects(f, () => factory.deploy(invalidToken.getAddress(), f.bankAdmin.address, f.feeReceiver.address), "InvalidTokenDecimals", [18n]);
    });

    it("VAULT-007: propagates failed metadata instead of accepting the dependency", async function () {
      const f = await networkHelpers.loadFixture(deployVaultFixture);
      const invalidToken = await ethers.deployContract("MetadataFailureMock");
      await invalidToken.waitForDeployment();
      const factory = await ethers.getContractFactory("VaultManager");
      await rejects(f, () => factory.deploy(invalidToken.getAddress(), f.bankAdmin.address, f.feeReceiver.address), "MetadataUnavailable", [], invalidToken);
    });
  });

  describe("Funding", function () {
    it("VAULT-008: funds the exact amount and spends the granted allowance", async function () {
      const f = await networkHelpers.loadFixture(seededVaultFixture);
      const amount = units("1000");
      await (await f.token.connect(f.bankAdmin).approve(f.vaultAddress, amount)).wait();
      const transaction = await f.vault.connect(f.bankAdmin).fundVault(amount);
      await expect(transaction).to.emit(f.vault, "VaultFunded").withArgs(f.bankAdmin.address, amount);
      await expect(transaction).to.emit(f.token, "Transfer").withArgs(f.bankAdmin.address, f.vaultAddress, amount);
      expect(await f.token.balanceOf(f.bankAdmin.address)).to.equal(amount);
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(amount);
      expect(await f.token.balanceOf(f.callerAddress)).to.equal(0n);
      expect(await f.token.allowance(f.bankAdmin.address, f.vaultAddress)).to.equal(0n);
      expect(await f.token.totalSupply()).to.equal(units("2000"));
    });

    it("VAULT-009: rejects non-admin funding", async function () {
      const f = await networkHelpers.loadFixture(seededVaultFixture);
      await rejects(f, () => f.vault.connect(f.stranger).fundVault(1n), "OwnableUnauthorizedAccount", [f.stranger.address]);
    });

    it("VAULT-010: rejects zero funding", async function () {
      const f = await networkHelpers.loadFixture(seededVaultFixture);
      await rejects(f, () => f.vault.connect(f.bankAdmin).fundVault(0n), "AmountZero");
    });

    it("VAULT-011: preserves balances and allowance when approval is one unit short", async function () {
      const f = await networkHelpers.loadFixture(seededVaultFixture);
      const amount = units("1000");
      await (await f.token.connect(f.bankAdmin).approve(f.vaultAddress, amount - 1n)).wait();
      await rejects(f, () => f.vault.connect(f.bankAdmin).fundVault(amount), "ERC20InsufficientAllowance", [f.vaultAddress, amount - 1n, amount], f.token);
    });

    it("VAULT-012: rolls back allowance spending when the admin has no tokens", async function () {
      const f = await networkHelpers.loadFixture(deployVaultFixture);
      await (await f.token.connect(f.bankAdmin).approve(f.vaultAddress, 1n)).wait();
      await rejects(f, () => f.vault.connect(f.bankAdmin).fundVault(1n), "ERC20InsufficientBalance", [f.bankAdmin.address, 0n, 1n], f.token);
    });

    it("VAULT-013: permits funding while paused", async function () {
      const f = await networkHelpers.loadFixture(seededVaultFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      await (await f.token.connect(f.bankAdmin).approve(f.vaultAddress, units("100"))).wait();
      await expect(f.vault.connect(f.bankAdmin).fundVault(units("100"))).to.emit(f.vault, "VaultFunded").withArgs(f.bankAdmin.address, units("100"));
      expect(await f.token.balanceOf(f.bankAdmin.address)).to.equal(units("1900"));
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(units("100"));
      expect(await f.vault.paused()).to.equal(true);
    });

    it("VAULT-014: permits one-unit funding before Core binding", async function () {
      const f = await networkHelpers.loadFixture(seededVaultFixture);
      await (await f.token.connect(f.bankAdmin).approve(f.vaultAddress, 1n)).wait();
      await expect(f.vault.connect(f.bankAdmin).fundVault(1n)).to.emit(f.vault, "VaultFunded").withArgs(f.bankAdmin.address, 1n);
      expect(await f.token.balanceOf(f.bankAdmin.address)).to.equal(units("2000") - 1n);
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(1n);
      expect(await f.vault.savingCore()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Withdrawal", function () {
    it("VAULT-015: returns withdrawn liquidity only to the current admin", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      const transaction = await f.vault.connect(f.bankAdmin).withdrawVault(units("100"));
      await expect(transaction).to.emit(f.vault, "VaultWithdrawn").withArgs(f.bankAdmin.address, units("100"));
      await expect(transaction).to.emit(f.token, "Transfer").withArgs(f.vaultAddress, f.bankAdmin.address, units("100"));
      expect(await f.token.balanceOf(f.bankAdmin.address)).to.equal(units("1100"));
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(units("900"));
      expect(await f.token.totalSupply()).to.equal(units("2000"));
    });

    it("VAULT-016: rejects a stranger withdrawal", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await rejects(f, () => f.vault.connect(f.stranger).withdrawVault(1n), "OwnableUnauthorizedAccount", [f.stranger.address]);
    });

    it("VAULT-017: rejects zero withdrawal", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await rejects(f, () => f.vault.connect(f.bankAdmin).withdrawVault(0n), "AmountZero");
    });

    it("VAULT-018: rejects a withdrawal one unit above actual liquidity", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      const available = units("1000");
      await rejects(f, () => f.vault.connect(f.bankAdmin).withdrawVault(available + 1n), "InsufficientVaultBalance", [available, available + 1n]);
    });

    it("VAULT-019: rejects withdrawal while paused", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      await rejects(f, () => f.vault.connect(f.bankAdmin).withdrawVault(1n), "EnforcedPause");
    });

    it("VAULT-020: includes a direct one-unit donation and allows draining actual balance", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await expect(f.token.connect(f.bankAdmin).transfer(f.vaultAddress, 1n)).to.emit(f.token, "Transfer").withArgs(f.bankAdmin.address, f.vaultAddress, 1n);
      const actual = units("1000") + 1n;
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(actual);
      await expect(f.vault.connect(f.bankAdmin).withdrawVault(actual)).to.emit(f.vault, "VaultWithdrawn").withArgs(f.bankAdmin.address, actual);
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(0n);
      expect(await f.token.balanceOf(f.bankAdmin.address)).to.equal(units("2000"));
    });
  });

  describe("Fee receiver", function () {
    it("VAULT-021: changes the receiver without moving money", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      const before = await state(f);
      await expect(f.vault.connect(f.bankAdmin).setFeeReceiver(f.alice.address)).to.emit(f.vault, "FeeReceiverUpdated").withArgs(f.feeReceiver.address, f.alice.address);
      expect(await state(f)).to.deep.equal({ ...before, receiver: f.alice.address });
    });

    it("VAULT-022: rejects a non-admin receiver change", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await rejects(f, () => f.vault.connect(f.stranger).setFeeReceiver(f.alice.address), "OwnableUnauthorizedAccount", [f.stranger.address]);
    });

    it("VAULT-023: rejects a zero receiver", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await rejects(f, () => f.vault.connect(f.bankAdmin).setFeeReceiver(ethers.ZeroAddress), "ZeroAddress");
    });

    it("VAULT-024: changes the receiver while paused", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      const before = await state(f);
      await expect(f.vault.connect(f.bankAdmin).setFeeReceiver(f.alice.address)).to.emit(f.vault, "FeeReceiverUpdated").withArgs(f.feeReceiver.address, f.alice.address);
      expect(await state(f)).to.deep.equal({ ...before, receiver: f.alice.address });
    });

    it("VAULT-025: emits a same-value receiver update", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      const before = await state(f);
      await expect(f.vault.connect(f.bankAdmin).setFeeReceiver(f.feeReceiver.address)).to.emit(f.vault, "FeeReceiverUpdated").withArgs(f.feeReceiver.address, f.feeReceiver.address);
      expect(await state(f)).to.deep.equal(before);
    });
  });

  describe("Pause matrix", function () {
    it("VAULT-026: pauses with the standard event", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      const before = await state(f);
      await expect(f.vault.connect(f.bankAdmin).pause()).to.emit(f.vault, "Paused").withArgs(f.bankAdmin.address);
      expect(await state(f)).to.deep.equal({ ...before, paused: true });
    });

    it("VAULT-027: unpauses and restores withdrawal", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      await expect(f.vault.connect(f.bankAdmin).unpause()).to.emit(f.vault, "Unpaused").withArgs(f.bankAdmin.address);
      expect(await f.vault.paused()).to.equal(false);
      await expect(f.vault.connect(f.bankAdmin).withdrawVault(1n)).to.emit(f.vault, "VaultWithdrawn").withArgs(f.bankAdmin.address, 1n);
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(units("1000") - 1n);
      expect(await f.token.balanceOf(f.bankAdmin.address)).to.equal(units("1000") + 1n);
    });

    it("VAULT-028: rejects non-admin pause", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await rejects(f, () => f.vault.connect(f.stranger).pause(), "OwnableUnauthorizedAccount", [f.stranger.address]);
    });

    it("VAULT-029: rejects non-admin unpause even when paused", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      await rejects(f, () => f.vault.connect(f.stranger).unpause(), "OwnableUnauthorizedAccount", [f.stranger.address]);
    });

    it("VAULT-030: rejects repeated pause", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      await rejects(f, () => f.vault.connect(f.bankAdmin).pause(), "EnforcedPause");
    });

    it("VAULT-031: rejects unpause while already running", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await rejects(f, () => f.vault.connect(f.bankAdmin).unpause(), "ExpectedPause");
    });

    it("VAULT-032: blocks outflows but permits funding, configuration and getters", async function () {
      const f = await networkHelpers.loadFixture(boundVaultFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      await rejects(f, () => f.vault.connect(f.bankAdmin).withdrawVault(1n), "EnforcedPause");
      await rejects(f, () => f.caller.connect(f.callerOperator).requestInterest(1n), "EnforcedPause");
      await rejects(f, () => f.vault.connect(f.stranger).withdrawVault(1n), "OwnableUnauthorizedAccount", [f.stranger.address]);
      await rejects(f, () => f.vault.connect(f.bankAdmin).payInterest(1n), "UnauthorizedSavingCore", [f.bankAdmin.address]);
      await (await f.token.connect(f.bankAdmin).approve(f.vaultAddress, units("100"))).wait();
      await expect(f.vault.connect(f.bankAdmin).fundVault(units("100"))).to.emit(f.vault, "VaultFunded").withArgs(f.bankAdmin.address, units("100"));
      await expect(f.vault.connect(f.bankAdmin).setFeeReceiver(f.alice.address)).to.emit(f.vault, "FeeReceiverUpdated").withArgs(f.feeReceiver.address, f.alice.address);
      expect(await f.vault.token()).to.equal(f.tokenAddress);
      expect(await f.vault.owner()).to.equal(f.bankAdmin.address);
      expect(await f.vault.savingCore()).to.equal(f.callerAddress);
      expect(await f.vault.feeReceiver()).to.equal(f.alice.address);
      expect(await f.vault.paused()).to.equal(true);
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(units("1100"));
      expect(await f.token.balanceOf(f.bankAdmin.address)).to.equal(units("900"));
      expect(await f.token.balanceOf(f.callerAddress)).to.equal(0n);
    });
  });

  describe("SavingCore binding", function () {
    it("VAULT-033: binds a deployed caller with the specified event", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      const before = await state(f);
      await expect(f.vault.connect(f.bankAdmin).setSavingCore(f.callerAddress)).to.emit(f.vault, "SavingCoreSet").withArgs(f.callerAddress);
      expect(await state(f)).to.deep.equal({ ...before, core: f.callerAddress });
    });

    it("VAULT-034: rejects non-admin binding", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await rejects(f, () => f.vault.connect(f.stranger).setSavingCore(f.callerAddress), "OwnableUnauthorizedAccount", [f.stranger.address]);
    });

    it("VAULT-035: rejects binding zero", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await rejects(f, () => f.vault.connect(f.bankAdmin).setSavingCore(ethers.ZeroAddress), "ZeroAddress");
    });

    it("VAULT-036: rejects binding an EOA", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await rejects(f, () => f.vault.connect(f.bankAdmin).setSavingCore(f.alice.address), "InvalidContract", [f.alice.address]);
    });

    it("VAULT-037: rejects every rebind before validating the new address", async function () {
      const f = await networkHelpers.loadFixture(boundVaultFixture);
      for (const replacement of [f.tokenAddress, f.callerAddress, ethers.ZeroAddress]) {
        await rejects(f, () => f.vault.connect(f.bankAdmin).setSavingCore(replacement), "SavingCoreAlreadySet", [f.callerAddress]);
      }
    });

    it("VAULT-038: allows the first binding while paused", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      const before = await state(f);
      await expect(f.vault.connect(f.bankAdmin).setSavingCore(f.callerAddress)).to.emit(f.vault, "SavingCoreSet").withArgs(f.callerAddress);
      expect(await state(f)).to.deep.equal({ ...before, core: f.callerAddress });
    });
  });

  describe("Interest payout", function () {
    it("VAULT-039: pays the bound contract and conserves all balances", async function () {
      const f = await networkHelpers.loadFixture(boundVaultFixture);
      const transaction = await f.caller.connect(f.callerOperator).requestInterest(units("25"));
      await expect(transaction).to.emit(f.vault, "InterestPaid").withArgs(f.callerAddress, units("25"));
      await expect(transaction).to.emit(f.token, "Transfer").withArgs(f.vaultAddress, f.callerAddress, units("25"));
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(units("975"));
      expect(await f.token.balanceOf(f.callerAddress)).to.equal(units("25"));
      expect(await f.token.balanceOf(f.bankAdmin.address)).to.equal(units("1000"));
      expect(await f.token.totalSupply()).to.equal(units("2000"));
    });

    it("VAULT-040: rejects the Bank Admin as a direct payout caller", async function () {
      const f = await networkHelpers.loadFixture(boundVaultFixture);
      await rejects(f, () => f.vault.connect(f.bankAdmin).payInterest(1n), "UnauthorizedSavingCore", [f.bankAdmin.address]);
    });

    it("VAULT-041: rejects a stranger as a direct payout caller", async function () {
      const f = await networkHelpers.loadFixture(boundVaultFixture);
      await rejects(f, () => f.vault.connect(f.stranger).payInterest(1n), "UnauthorizedSavingCore", [f.stranger.address]);
    });

    it("VAULT-042: rejects a different deployed contract", async function () {
      const f = await networkHelpers.loadFixture(boundVaultFixture);
      const other = await ethers.deployContract("VaultCallerMock", [f.vaultAddress, f.callerOperator.address]);
      await other.waitForDeployment();
      await rejects(f, () => other.connect(f.callerOperator).requestInterest(1n), "UnauthorizedSavingCore", [await other.getAddress()]);
    });

    it("VAULT-043: rejects the prospective Core before binding", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await rejects(f, () => f.caller.connect(f.callerOperator).requestInterest(1n), "UnauthorizedSavingCore", [f.callerAddress]);
    });

    it("VAULT-044: rejects a payout one unit above balance", async function () {
      const f = await networkHelpers.loadFixture(boundVaultFixture);
      const available = units("1000");
      await rejects(f, () => f.caller.connect(f.callerOperator).requestInterest(available + 1n), "InsufficientVaultBalance", [available, available + 1n]);
    });

    it("VAULT-045: rejects zero interest", async function () {
      const f = await networkHelpers.loadFixture(boundVaultFixture);
      await rejects(f, () => f.caller.connect(f.callerOperator).requestInterest(0n), "AmountZero");
    });

    it("VAULT-046: rejects paused payout and restores it after unpause", async function () {
      const f = await networkHelpers.loadFixture(boundVaultFixture);
      await (await f.vault.connect(f.bankAdmin).pause()).wait();
      await rejects(f, () => f.caller.connect(f.callerOperator).requestInterest(1n), "EnforcedPause");
      await (await f.vault.connect(f.bankAdmin).unpause()).wait();
      await expect(f.caller.connect(f.callerOperator).requestInterest(1n)).to.emit(f.vault, "InterestPaid").withArgs(f.callerAddress, 1n);
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(units("1000") - 1n);
      expect(await f.token.balanceOf(f.callerAddress)).to.equal(1n);
    });

    it("VAULT-047: pays exact full balance to Core, never admin or transaction origin", async function () {
      const f = await networkHelpers.loadFixture(boundVaultFixture);
      const observers = [f.deployer.address, f.bankAdmin.address, f.alice.address, f.stranger.address, f.callerOperator.address, f.feeReceiver.address];
      const before = await Promise.all(observers.map((address) => f.token.balanceOf(address)));
      await expect(f.caller.connect(f.callerOperator).requestInterest(units("1000"))).to.emit(f.token, "Transfer").withArgs(f.vaultAddress, f.callerAddress, units("1000"));
      expect(await Promise.all(observers.map((address) => f.token.balanceOf(address)))).to.deep.equal(before);
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(0n);
      expect(await f.token.balanceOf(f.callerAddress)).to.equal(units("1000"));
      const abi: Interface = f.vault.interface;
      expect(abi.getFunction("payInterest")?.inputs.map((input) => input.type)).to.deep.equal(["uint256"]);
    });

    it("VAULT-048: a bound contract cannot pull Vault funds without allowance", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      const puller = await ethers.deployContract("VaultPullAttemptMock", [f.vaultAddress, f.callerOperator.address]);
      await puller.waitForDeployment();
      const pullerAddress = await puller.getAddress();
      await (await f.vault.connect(f.bankAdmin).setSavingCore(pullerAddress)).wait();
      expect(await f.token.allowance(f.vaultAddress, pullerAddress)).to.equal(0n);
      await rejects(f, () => puller.connect(f.callerOperator).attemptPull(1n), "ERC20InsufficientAllowance", [pullerAddress, 0n, 1n], f.token);
      expect(await f.token.balanceOf(pullerAddress)).to.equal(0n);
      expect(await f.token.allowance(f.vaultAddress, pullerAddress)).to.equal(0n);
    });
  });

  describe("Ownership and interface", function () {
    it("VAULT-049: transfers the sole Bank Admin role with the standard event", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      const before = await state(f);
      await expect(f.vault.connect(f.bankAdmin).transferOwnership(f.newAdmin.address)).to.emit(f.vault, "OwnershipTransferred").withArgs(f.bankAdmin.address, f.newAdmin.address);
      expect(await state(f)).to.deep.equal({ ...before, owner: f.newAdmin.address });
    });

    for (const action of ["fund", "withdraw", "fee", "pause", "unpause", "bind", "transfer", "renounce"] as const) {
      it(`VAULT-050 [${action}]: former owner loses management permission`, async function () {
        const f = await networkHelpers.loadFixture(boundVaultFixture);
        await (await f.vault.connect(f.bankAdmin).transferOwnership(f.newAdmin.address)).wait();
        const former = f.vault.connect(f.bankAdmin);
        const operations = {
          fund: () => former.fundVault(1n), withdraw: () => former.withdrawVault(1n),
          fee: () => former.setFeeReceiver(f.alice.address), pause: () => former.pause(),
          unpause: () => former.unpause(), bind: () => former.setSavingCore(f.tokenAddress),
          transfer: () => former.transferOwnership(f.alice.address), renounce: () => former.renounceOwnership(),
        };
        await rejects(f, operations[action], "OwnableUnauthorizedAccount", [f.bankAdmin.address]);
      });
    }

    it("VAULT-051: the new admin funds, withdraws, configures, pauses and binds", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await (await f.vault.connect(f.bankAdmin).transferOwnership(f.newAdmin.address)).wait();
      const admin = f.vault.connect(f.newAdmin);
      await expect(admin.withdrawVault(units("100"))).to.emit(f.vault, "VaultWithdrawn").withArgs(f.newAdmin.address, units("100"));
      expect(await f.token.balanceOf(f.newAdmin.address)).to.equal(units("100"));
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(units("900"));
      await (await f.token.connect(f.newAdmin).approve(f.vaultAddress, units("10"))).wait();
      await expect(admin.fundVault(units("10"))).to.emit(f.vault, "VaultFunded").withArgs(f.newAdmin.address, units("10"));
      expect(await f.token.balanceOf(f.newAdmin.address)).to.equal(units("90"));
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(units("910"));
      expect(await f.token.allowance(f.newAdmin.address, f.vaultAddress)).to.equal(0n);
      await expect(admin.setFeeReceiver(f.alice.address)).to.emit(f.vault, "FeeReceiverUpdated").withArgs(f.feeReceiver.address, f.alice.address);
      await expect(admin.pause()).to.emit(f.vault, "Paused").withArgs(f.newAdmin.address);
      await expect(admin.unpause()).to.emit(f.vault, "Unpaused").withArgs(f.newAdmin.address);
      await expect(admin.setSavingCore(f.callerAddress)).to.emit(f.vault, "SavingCoreSet").withArgs(f.callerAddress);
      expect(await f.vault.owner()).to.equal(f.newAdmin.address);
      expect(await f.vault.paused()).to.equal(false);
      expect(await f.vault.feeReceiver()).to.equal(f.alice.address);
      expect(await f.vault.savingCore()).to.equal(f.callerAddress);
    });

    it("VAULT-052: rejects transferring ownership to zero", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await rejects(f, () => f.vault.connect(f.bankAdmin).transferOwnership(ethers.ZeroAddress), "OwnableInvalidOwner", [ethers.ZeroAddress]);
    });

    it("VAULT-053: prohibits current-owner renounce", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await rejects(f, () => f.vault.connect(f.bankAdmin).renounceOwnership(), "OwnershipRenounceDisabled");
    });

    it("VAULT-054: rejects non-admin renounce before the disabled-role check", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await rejects(f, () => f.vault.connect(f.stranger).renounceOwnership(), "OwnableUnauthorizedAccount", [f.stranger.address]);
    });

    it("VAULT-055: rejects a non-admin ownership transfer", async function () {
      const f = await networkHelpers.loadFixture(fundedVaultFixture);
      await rejects(f, () => f.vault.connect(f.stranger).transferOwnership(f.newAdmin.address), "OwnableUnauthorizedAccount", [f.stranger.address]);
    });

    it("VAULT-056: ownership transfer neither grants payout nor permits rebinding", async function () {
      const f = await networkHelpers.loadFixture(boundVaultFixture);
      await (await f.vault.connect(f.bankAdmin).transferOwnership(f.newAdmin.address)).wait();
      await rejects(f, () => f.vault.connect(f.newAdmin).payInterest(1n), "UnauthorizedSavingCore", [f.newAdmin.address]);
      await rejects(f, () => f.vault.connect(f.newAdmin).setSavingCore(f.tokenAddress), "SavingCoreAlreadySet", [f.callerAddress]);
      await expect(f.caller.connect(f.callerOperator).requestInterest(1n)).to.emit(f.vault, "InterestPaid").withArgs(f.callerAddress, 1n);
      expect(await f.token.balanceOf(f.callerAddress)).to.equal(1n);
      expect(await f.token.balanceOf(f.vaultAddress)).to.equal(units("1000") - 1n);
      expect(await f.token.balanceOf(f.newAdmin.address)).to.equal(0n);
    });

    it("VAULT-057: preserves the six-function interface and specified indexed events", async function () {
      const f = await networkHelpers.loadFixture(deployVaultFixture);
      const expected = new ethers.Interface((await artifacts.readArtifact("IVaultManager")).abi);
      const actual: Interface = f.vault.interface;
      for (const name of ["token", "owner", "savingCore", "feeReceiver", "paused", "payInterest"]) {
        expect(actual.getFunction(name)?.format("full")).to.equal(expected.getFunction(name)?.format("full"));
      }
      const events: Record<string, [string, string, boolean][]> = {
        SavingCoreSet: [["savingCore", "address", true]],
        VaultFunded: [["admin", "address", true], ["amount", "uint256", false]],
        VaultWithdrawn: [["admin", "address", true], ["amount", "uint256", false]],
        FeeReceiverUpdated: [["previousReceiver", "address", true], ["newReceiver", "address", true]],
        InterestPaid: [["savingCore", "address", true], ["amount", "uint256", false]],
      };
      for (const [name, inputs] of Object.entries(events)) {
        expect(actual.getEvent(name)?.inputs.map((input) => [input.name, input.type, input.indexed])).to.deep.equal(inputs);
      }
      expect(actual.getFunction("renounceOwnership")?.stateMutability).to.equal("nonpayable");
    });

    it("VAULT-058: the caller wrapper is restricted to its operator", async function () {
      const f = await networkHelpers.loadFixture(boundVaultFixture);
      await rejects(f, () => f.caller.connect(f.bankAdmin).requestInterest(1n), "OwnableUnauthorizedAccount", [f.bankAdmin.address], f.caller);
    });
  });

  describe("Security P2: real mined rollback", function () {
    async function falseReturnFixture() {
      const local = securityConnection.ethers;
      const [deployer, bankAdmin, , , feeReceiver, , callerOperator] = await local.getSigners();
      const token = await local.deployContract("ConfigurableTestToken", [6]);
      await token.waitForDeployment();
      const tokenAddress = await token.getAddress();
      const vault = await local.deployContract("VaultManager", [tokenAddress, bankAdmin.address, feeReceiver.address]);
      await vault.waitForDeployment();
      const vaultAddress = await vault.getAddress();
      const caller = await local.deployContract("VaultCallerMock", [vaultAddress, callerOperator.address]);
      await caller.waitForDeployment();
      const callerAddress = await caller.getAddress();
      await (await token.mint(bankAdmin.address, units("2000"))).wait();
      await (await token.connect(bankAdmin).approve(vaultAddress, units("1000"))).wait();
      await (await vault.connect(bankAdmin).fundVault(units("1000"))).wait();
      await (await vault.connect(bankAdmin).setSavingCore(callerAddress)).wait();
      return { token, vault, caller, tokenAddress, vaultAddress, callerAddress, deployer, bankAdmin, callerOperator, feeReceiver };
    }

    async function reentrantFixture() {
      const local = securityConnection.ethers;
      const [operator, , , , feeReceiver] = await local.getSigners();
      const token = await local.deployContract("ReentrantTestToken");
      await token.waitForDeployment();
      const tokenAddress = await token.getAddress();
      // The token is the admin AND bound Core: its callbacks pass the role guards.
      const vault = await local.deployContract("VaultManager", [tokenAddress, tokenAddress, feeReceiver.address]);
      await vault.waitForDeployment();
      const vaultAddress = await vault.getAddress();
      await (await token.configureVault(vaultAddress)).wait();
      await (await token.mint(tokenAddress, units("2000"))).wait();
      await (await token.execute(0, units("1000"))).wait();
      return { token, vault, tokenAddress, vaultAddress, operator, feeReceiver };
    }

    async function minedRevert(label: string, transaction: ContractTransactionResponse): Promise<void> {
      // Explicit gas bypasses estimation; this connection returns hashes for failed mined txs.
      const receipt = await securityConnection.ethers.provider.getTransactionReceipt(transaction.hash);
      expect(receipt, "failed transaction must have a mined receipt").not.to.equal(null);
      expect(receipt!.status).to.equal(0);
      expect(receipt!.logs).to.deep.equal([]);
      console.log(`      MINED_REVERT | ${label} | hash=${transaction.hash} | block=${receipt!.blockNumber} | status=${receipt!.status} | logs=${receipt!.logs.length}`);
    }

    for (const [index, operation] of ["fund", "withdraw", "payout"].entries()) {
      it(`P2-00${index + 1}: ${operation} rolls back a token false return after ERC20 writes`, async function () {
        const f = await securityConnection.networkHelpers.loadFixture(falseReturnFixture);
        const amount = units("25");
        if (operation === "fund") {
          await (await f.token.connect(f.bankAdmin).approve(f.vaultAddress, amount)).wait();
        }
        await (await f.token.setFailureModes(operation !== "fund", operation === "fund")).wait();
        const accounts = [f.bankAdmin.address, f.vaultAddress, f.callerAddress, f.callerOperator.address];
        const before = await ledger(f.token, accounts, f.bankAdmin.address, f.vaultAddress);
        const vaultBefore = [await f.vault.owner(), await f.vault.savingCore(), await f.vault.feeReceiver(), await f.vault.paused()];
        const simulate = () => operation === "fund"
          ? f.vault.connect(f.bankAdmin).fundVault.staticCall(amount)
          : operation === "withdraw" ? f.vault.connect(f.bankAdmin).withdrawVault.staticCall(amount)
            : f.caller.connect(f.callerOperator).requestInterest.staticCall(amount);
        const send = () => operation === "fund"
          ? f.vault.connect(f.bankAdmin).fundVault(amount, { gasLimit: 1_000_000n })
          : operation === "withdraw" ? f.vault.connect(f.bankAdmin).withdrawVault(amount, { gasLimit: 1_000_000n })
            : f.caller.connect(f.callerOperator).requestInterest(amount, { gasLimit: 1_000_000n });

        await expect(simulate()).to.be.revertedWithCustomError(f.vault, "SafeERC20FailedOperation").withArgs(f.tokenAddress);
        await minedRevert(`P2-00${index + 1} ${operation} false return`, await send());
        expect(await ledger(f.token, accounts, f.bankAdmin.address, f.vaultAddress)).to.deep.equal(before);
        expect([await f.vault.owner(), await f.vault.savingCore(), await f.vault.feeReceiver(), await f.vault.paused()]).to.deep.equal(vaultBefore);
        expect(await f.token.failTransfer()).to.equal(operation !== "fund");
        expect(await f.token.failTransferFrom()).to.equal(operation === "fund");

        await (await f.token.setFailureModes(false, false)).wait();
        const transaction = await send();
        const eventName = operation === "fund" ? "VaultFunded" : operation === "withdraw" ? "VaultWithdrawn" : "InterestPaid";
        const recipient = operation === "payout" ? f.callerAddress : f.bankAdmin.address;
        await expect(transaction).to.emit(f.vault, eventName).withArgs(recipient, amount);
        expect((await transaction.wait())?.status).to.equal(1);
        expect(await f.token.balanceOf(f.bankAdmin.address)).to.equal(units("1000") + (operation === "fund" ? -amount : operation === "withdraw" ? amount : 0n));
        expect(await f.token.balanceOf(f.vaultAddress)).to.equal(units("1000") + (operation === "fund" ? amount : -amount));
        expect(await f.token.balanceOf(f.callerAddress)).to.equal(operation === "payout" ? amount : 0n);
        expect(await f.token.balanceOf(f.callerOperator.address)).to.equal(0n);
        expect(await f.token.allowance(f.bankAdmin.address, f.vaultAddress)).to.equal(0n);
        expect(await f.token.totalSupply()).to.equal(units("2000"));
      });
    }

    for (const [operation, name] of ["fund", "withdraw", "payout"].entries()) {
      it(`P2-00${operation + 4}: authorized ${name} callback reaches the reentrancy guard`, async function () {
        const f = await securityConnection.networkHelpers.loadFixture(reentrantFixture);
        const amount = units("25");
        expect(await f.vault.owner()).to.equal(f.tokenAddress);
        expect(await f.vault.savingCore()).to.equal(f.tokenAddress);
        await (await f.token.setAttack(operation, true)).wait();
        const accounts = [f.tokenAddress, f.vaultAddress, f.operator.address, f.feeReceiver.address];
        const before = await ledger(f.token, accounts, f.tokenAddress, f.vaultAddress);
        const vaultBefore = [await f.vault.owner(), await f.vault.savingCore(), await f.vault.feeReceiver(), await f.vault.paused()];

        await expect(f.token.execute.staticCall(operation, amount)).to.be.revertedWithCustomError(f.vault, "ReentrancyGuardReentrantCall");
        await minedRevert(`P2-00${operation + 4} ${name} reentrancy`, await f.token.execute(operation, amount, { gasLimit: 1_000_000n }));
        expect(await ledger(f.token, accounts, f.tokenAddress, f.vaultAddress)).to.deep.equal(before);
        expect([await f.vault.owner(), await f.vault.savingCore(), await f.vault.feeReceiver(), await f.vault.paused()]).to.deep.equal(vaultBefore);
        expect(await f.token.armed()).to.equal(true);
        expect(await f.token.attackOperation()).to.equal(BigInt(operation));

        await (await f.token.setAttack(operation, false)).wait();
        const transaction = await f.token.execute(operation, amount);
        const eventName = operation === 0 ? "VaultFunded" : operation === 1 ? "VaultWithdrawn" : "InterestPaid";
        await expect(transaction).to.emit(f.vault, eventName).withArgs(f.tokenAddress, amount);
        expect((await transaction.wait())?.status).to.equal(1);
        expect(await f.token.balanceOf(f.tokenAddress)).to.equal(units("1000") + (operation === 0 ? -amount : amount));
        expect(await f.token.balanceOf(f.vaultAddress)).to.equal(units("1000") + (operation === 0 ? amount : -amount));
        expect(await f.token.balanceOf(f.operator.address)).to.equal(0n);
        expect(await f.token.allowance(f.tokenAddress, f.vaultAddress)).to.equal(ethers.MaxUint256);
        expect(await f.token.totalSupply()).to.equal(units("2000"));
      });
    }
  });
});
