import assert from "node:assert/strict";
import type {
  ContractTransactionReceipt,
  ContractTransactionResponse,
  FunctionFragment,
  Interface,
} from "ethers";
import { artifacts, network } from "hardhat";

// D1-05 smoke only: fresh local fixtures, no system deployment addresses or persisted bindings.
// Run: npx.cmd hardhat run scripts/smoke-vault-manager.ts --network hardhatMainnet
let checks = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, label);
  checks += 1;
  console.log(`PASS | ${label} | expected=${String(expected)} | actual=${String(actual)}`);
}

async function mined(
  label: string,
  transaction: ContractTransactionResponse,
): Promise<ContractTransactionReceipt> {
  const receipt = await transaction.wait();
  assert.ok(receipt, `${label}: receipt must exist`);
  check(`${label}: receipt status`, receipt.status, 1);
  console.log(`TX | ${label} | hash=${transaction.hash} | block=${receipt.blockNumber}`);
  return receipt;
}

function event(
  label: string,
  receipt: ContractTransactionReceipt,
  address: string,
  abi: Interface,
  name: string,
  expectedArgs: unknown[],
): void {
  const matches = receipt.logs
    .filter((log) => log.address.toLowerCase() === address.toLowerCase())
    .map((log) => abi.parseLog(log))
    .filter((parsed) => parsed?.name === name);
  check(`${label}: ${name} count`, matches.length, 1);
  assert.ok(matches[0]);
  check(`${label}: ${name} arguments`, Array.from(matches[0].args), expectedArgs);
}

async function reverts(
  label: string,
  operation: () => Promise<unknown>,
  abi: Interface,
  errorName: string,
  args: unknown[] = [],
): Promise<void> {
  // Hardhat may return SolidityError directly, so match the exact ABI-encoded payload.
  await assert.rejects(operation, { data: abi.encodeErrorResult(errorName, args) }, label);
  checks += 1;
  console.log(`PASS | ${label} | exact error=${errorName}(${args.map(String).join(",")}) | eth_call; no mined tx`);
}

async function main(): Promise<void> {
  const connection = await network.create("hardhatMainnet");
  try {
    check("Network is local EDR", connection.networkConfig.type, "edr-simulated");
    const { ethers } = connection;
    const [operator, admin, stranger, feeReceiver, nextReceiver, nextAdmin] = await ethers.getSigners();
    const units = (amount: string): bigint => ethers.parseUnits(amount, 6);
    check("Admin differs from deployer/operator", admin.address !== operator.address, true);
    console.log(`ACTORS | operator=${operator.address} | admin=${admin.address} | stranger=${stranger.address}`);
    console.log(`ACTORS | feeReceiver=${feeReceiver.address} | nextReceiver=${nextReceiver.address} | nextAdmin=${nextAdmin.address}`);

    async function fixture(label: string) {
      console.log(`SCENARIO | ${label} | independent token/Vault/caller deployment`);
      const token = await ethers.deployContract("MockUSDC");
      await token.waitForDeployment();
      const tokenAddress = await token.getAddress();
      const vault = await ethers.deployContract("VaultManager", [tokenAddress, admin.address, feeReceiver.address]);
      await vault.waitForDeployment();
      const vaultAddress = await vault.getAddress();
      const caller = await ethers.deployContract("VaultCallerMock", [vaultAddress, operator.address]);
      await caller.waitForDeployment();
      const callerAddress = await caller.getAddress();
      console.log(`FIXTURE | ${label} | token=${tokenAddress} | vault=${vaultAddress} | caller=${callerAddress}`);
      await mined(`${label}: seed admin 2000`, await token.mint(admin.address, units("2000")));
      return { token, vault, caller, tokenAddress, vaultAddress, callerAddress };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;

    async function fund(f: Fixture, amount: bigint, label: string): Promise<void> {
      const adminBefore = await f.token.balanceOf(admin.address);
      const vaultBefore = await f.token.balanceOf(f.vaultAddress);
      await mined(`${label}: approve`, await f.token.connect(admin).approve(f.vaultAddress, amount));
      const receipt = await mined(label, await f.vault.connect(admin).fundVault(amount));
      check(`${label}: admin balance`, await f.token.balanceOf(admin.address), adminBefore - amount);
      check(`${label}: Vault balance`, await f.token.balanceOf(f.vaultAddress), vaultBefore + amount);
      event(label, receipt, f.vaultAddress, f.vault.interface, "VaultFunded", [admin.address, amount]);
      event(label, receipt, f.tokenAddress, f.token.interface, "Transfer", [admin.address, f.vaultAddress, amount]);
    }

    async function bind(f: Fixture, label: string): Promise<void> {
      const receipt = await mined(label, await f.vault.connect(admin).setSavingCore(f.callerAddress));
      check(`${label}: stored Core`, await f.vault.savingCore(), f.callerAddress);
      event(label, receipt, f.vaultAddress, f.vault.interface, "SavingCoreSet", [f.callerAddress]);
    }

    async function payout(f: Fixture, amount: bigint, label: string): Promise<void> {
      const vaultBefore = await f.token.balanceOf(f.vaultAddress);
      const coreBefore = await f.token.balanceOf(f.callerAddress);
      const adminBefore = await f.token.balanceOf(admin.address);
      const receipt = await mined(label, await f.caller.connect(operator).requestInterest(amount));
      check(`${label}: Vault balance`, await f.token.balanceOf(f.vaultAddress), vaultBefore - amount);
      check(`${label}: Core balance`, await f.token.balanceOf(f.callerAddress), coreBefore + amount);
      check(`${label}: admin unchanged`, await f.token.balanceOf(admin.address), adminBefore);
      event(label, receipt, f.vaultAddress, f.vault.interface, "InterestPaid", [f.callerAddress, amount]);
      event(label, receipt, f.tokenAddress, f.token.interface, "Transfer", [f.vaultAddress, f.callerAddress, amount]);
    }

    {
      const f = await fixture("Constructor and ABI");
      check("Constructor owner", await f.vault.owner(), admin.address);
      check("Constructor token", await f.vault.token(), f.tokenAddress);
      check("Constructor fee receiver", await f.vault.feeReceiver(), feeReceiver.address);
      check("Constructor Core", await f.vault.savingCore(), ethers.ZeroAddress);
      check("Constructor pause", await f.vault.paused(), false);
      check("Constructor Vault balance", await f.token.balanceOf(f.vaultAddress), 0n);

      const factory = await ethers.getContractFactory("VaultManager");
      const zeroAdminDeployment = await factory.getDeployTransaction(f.tokenAddress, ethers.ZeroAddress, feeReceiver.address);
      await reverts("Constructor zero admin", () => ethers.provider.call({ ...zeroAdminDeployment, from: operator.address }), f.vault.interface, "ZeroAddress");

      const vaultAbi: Interface = f.vault.interface;
      const interfaceAbi = new ethers.Interface((await artifacts.readArtifact("IVaultManager")).abi);
      check("IVaultManager function count", interfaceAbi.fragments.filter((fragment) => fragment.type === "function").length, 6);
      for (const name of ["token", "owner", "savingCore", "feeReceiver", "paused", "payInterest"]) {
        const actual = vaultAbi.getFunction(name);
        const expected = interfaceAbi.getFunction(name);
        assert.ok(actual);
        assert.ok(expected);
        check(`Interface compatibility: ${name}`, actual.format("full"), expected.format("full"));
      }
      check("Vault public API has no extra payout endpoint", f.vault.interface.fragments
        .filter((fragment) => fragment.type === "function")
        .map((fragment) => (fragment as FunctionFragment).format("sighash")).sort(), [
        "token()", "owner()", "savingCore()", "feeReceiver()", "paused()", "payInterest(uint256)",
        "setSavingCore(address)", "fundVault(uint256)", "withdrawVault(uint256)", "setFeeReceiver(address)",
        "pause()", "unpause()", "transferOwnership(address)", "renounceOwnership()",
      ].sort());
      check("renounceOwnership ABI remains nonpayable", f.vault.interface.getFunction("renounceOwnership")?.stateMutability, "nonpayable");

      const events: Record<string, [string, string, boolean][]> = {
        SavingCoreSet: [["savingCore", "address", true]],
        VaultFunded: [["admin", "address", true], ["amount", "uint256", false]],
        VaultWithdrawn: [["admin", "address", true], ["amount", "uint256", false]],
        FeeReceiverUpdated: [["previousReceiver", "address", true], ["newReceiver", "address", true]],
        InterestPaid: [["savingCore", "address", true], ["amount", "uint256", false]],
      };
      for (const [name, inputs] of Object.entries(events)) {
        const fragment = vaultAbi.getEvent(name);
        assert.ok(fragment);
        check(`Event ABI: ${name}`, fragment.inputs.map((input) => [input.name, input.type, input.indexed]), inputs);
      }
      const errors: Record<string, [string, string][]> = {
        ZeroAddress: [], InvalidContract: [["account", "address"]], InvalidTokenDecimals: [["actual", "uint8"]],
        SavingCoreAlreadySet: [["currentCore", "address"]], UnauthorizedSavingCore: [["caller", "address"]],
        AmountZero: [], InsufficientVaultBalance: [["available", "uint256"], ["required", "uint256"]],
        OwnershipRenounceDisabled: [],
      };
      for (const [name, inputs] of Object.entries(errors)) {
        const fragment = f.vault.interface.getError(name);
        assert.ok(fragment);
        check(`Error ABI: ${name}`, fragment.inputs.map((input) => [input.name, input.type]), inputs);
      }

      const unauthorized = f.vault.connect(stranger);
      const adminActions: [string, () => Promise<unknown>][] = [
        ["fundVault", () => unauthorized.fundVault.staticCall(1n)],
        ["withdrawVault", () => unauthorized.withdrawVault.staticCall(1n)],
        ["setFeeReceiver", () => unauthorized.setFeeReceiver.staticCall(nextReceiver.address)],
        ["pause", () => unauthorized.pause.staticCall()],
        ["unpause", () => unauthorized.unpause.staticCall()],
        ["setSavingCore", () => unauthorized.setSavingCore.staticCall(f.callerAddress)],
        ["transferOwnership", () => unauthorized.transferOwnership.staticCall(nextAdmin.address)],
        ["renounceOwnership", () => unauthorized.renounceOwnership.staticCall()],
      ];
      for (const [name, operation] of adminActions) {
        await reverts(`Non-admin ${name}`, operation, f.vault.interface, "OwnableUnauthorizedAccount", [stranger.address]);
      }
    }

    {
      const f = await fixture("Funding withdrawal and donation");
      await fund(f, units("1000"), "Fund 1000 before binding");
      const receipt = await mined("Withdraw 100", await f.vault.connect(admin).withdrawVault(units("100")));
      check("After withdraw: admin", await f.token.balanceOf(admin.address), units("1100"));
      check("After withdraw: Vault", await f.token.balanceOf(f.vaultAddress), units("900"));
      event("Withdraw 100", receipt, f.vaultAddress, f.vault.interface, "VaultWithdrawn", [admin.address, units("100")]);
      event("Withdraw 100", receipt, f.tokenAddress, f.token.interface, "Transfer", [f.vaultAddress, admin.address, units("100")]);

      const donation = await mined("Donate one smallest unit", await f.token.connect(admin).transfer(f.vaultAddress, 1n));
      event("Donation", donation, f.tokenAddress, f.token.interface, "Transfer", [admin.address, f.vaultAddress, 1n]);
      check("Actual liquidity includes donation", await f.token.balanceOf(f.vaultAddress), units("900") + 1n);
      const drain = await mined("Withdraw all actual liquidity", await f.vault.connect(admin).withdrawVault(units("900") + 1n));
      event("Drain baseline", drain, f.vaultAddress, f.vault.interface, "VaultWithdrawn", [admin.address, units("900") + 1n]);
      check("Admin can drain baseline interest pool", await f.token.balanceOf(f.vaultAddress), 0n);
      check("Admin funds restored after donation and drain", await f.token.balanceOf(admin.address), units("2000"));
      check("Vault operations do not mint tokens", await f.token.totalSupply(), units("2000"));
    }

    {
      const f = await fixture("Binding and payout");
      await fund(f, units("1000"), "Payout fixture fund");
      await reverts("Payout before binding", () => f.vault.connect(admin).payInterest.staticCall(1n), f.vault.interface, "UnauthorizedSavingCore", [admin.address]);
      await reverts("Bind zero", () => f.vault.connect(admin).setSavingCore.staticCall(ethers.ZeroAddress), f.vault.interface, "ZeroAddress");
      await reverts("Bind EOA", () => f.vault.connect(admin).setSavingCore.staticCall(stranger.address), f.vault.interface, "InvalidContract", [stranger.address]);
      check("Invalid bind leaves Core unset", await f.vault.savingCore(), ethers.ZeroAddress);
      await bind(f, "Bind authorized caller");

      const otherCaller = await ethers.deployContract("VaultCallerMock", [f.vaultAddress, operator.address]);
      await otherCaller.waitForDeployment();
      const otherAddress = await otherCaller.getAddress();
      await reverts("Cannot replace bound Core", () => f.vault.connect(admin).setSavingCore.staticCall(otherAddress), f.vault.interface, "SavingCoreAlreadySet", [f.callerAddress]);
      await reverts("Already-set check precedes new address validation", () => f.vault.connect(admin).setSavingCore.staticCall(ethers.ZeroAddress), f.vault.interface, "SavingCoreAlreadySet", [f.callerAddress]);
      await reverts("Admin cannot call payout", () => f.vault.connect(admin).payInterest.staticCall(1n), f.vault.interface, "UnauthorizedSavingCore", [admin.address]);
      await reverts("User cannot call payout", () => f.vault.connect(stranger).payInterest.staticCall(1n), f.vault.interface, "UnauthorizedSavingCore", [stranger.address]);
      await reverts("Unbound contract cannot call payout", () => otherCaller.connect(operator).requestInterest.staticCall(1n), f.vault.interface, "UnauthorizedSavingCore", [otherAddress]);
      await reverts("Mock wrapper restricted to fixture operator", () => f.caller.connect(admin).requestInterest.staticCall(1n), f.caller.interface, "OwnableUnauthorizedAccount", [admin.address]);
      await payout(f, units("25"), "Authorized payout 25");
      check("Payout leaves 975 in Vault", await f.token.balanceOf(f.vaultAddress), units("975"));
      check("Only bound Core received 25", await f.token.balanceOf(f.callerAddress), units("25"));
      check("Vault grants no allowance to Core", await f.token.allowance(f.vaultAddress, f.callerAddress), 0n);

      const before = await Promise.all([f.token.balanceOf(f.vaultAddress), f.token.balanceOf(f.callerAddress)]);
      await reverts("Insufficient payout by one unit", () => f.caller.connect(operator).requestInterest.staticCall(units("975") + 1n), f.vault.interface, "InsufficientVaultBalance", [units("975"), units("975") + 1n]);
      check("Balances after rejected payout simulation", await Promise.all([f.token.balanceOf(f.vaultAddress), f.token.balanceOf(f.callerAddress)]), before);
    }

    {
      const f = await fixture("Pause matrix");
      await fund(f, units("1000"), "Pause fixture fund");
      const paused = await mined("Pause", await f.vault.connect(admin).pause());
      event("Pause", paused, f.vaultAddress, f.vault.interface, "Paused", [admin.address]);
      check("Paused getter", await f.vault.paused(), true);
      await fund(f, units("100"), "Fund while paused");
      const feeUpdate = await mined("Set fee receiver while paused", await f.vault.connect(admin).setFeeReceiver(nextReceiver.address));
      event("Fee update", feeUpdate, f.vaultAddress, f.vault.interface, "FeeReceiverUpdated", [feeReceiver.address, nextReceiver.address]);
      check("Fee receiver getter while paused", await f.vault.feeReceiver(), nextReceiver.address);
      await bind(f, "Bind while paused");
      await reverts("Paused withdrawal", () => f.vault.connect(admin).withdrawVault.staticCall(units("100")), f.vault.interface, "EnforcedPause");
      await reverts("Paused payout", () => f.caller.connect(operator).requestInterest.staticCall(units("25")), f.vault.interface, "EnforcedPause");
      check("Blocked outflows retain Vault balance", await f.token.balanceOf(f.vaultAddress), units("1100"));
      check("Blocked payout leaves Core empty", await f.token.balanceOf(f.callerAddress), 0n);

      const unpaused = await mined("Unpause", await f.vault.connect(admin).unpause());
      event("Unpause", unpaused, f.vaultAddress, f.vault.interface, "Unpaused", [admin.address]);
      check("Unpaused getter", await f.vault.paused(), false);
      const withdrawn = await mined("Withdraw after unpause", await f.vault.connect(admin).withdrawVault(units("100")));
      event("Withdraw after unpause", withdrawn, f.vaultAddress, f.vault.interface, "VaultWithdrawn", [admin.address, units("100")]);
      check("Admin balance after resumed withdrawal", await f.token.balanceOf(admin.address), units("1000"));
      check("Vault balance after resumed withdrawal", await f.token.balanceOf(f.vaultAddress), units("1000"));
      await payout(f, units("25"), "Payout after unpause");
    }

    {
      const f = await fixture("Ownership");
      await fund(f, units("1000"), "Ownership fixture fund");
      const ownership = await mined("Transfer Bank Admin", await f.vault.connect(admin).transferOwnership(nextAdmin.address));
      event("Transfer Bank Admin", ownership, f.vaultAddress, f.vault.interface, "OwnershipTransferred", [admin.address, nextAdmin.address]);
      check("New Bank Admin", await f.vault.owner(), nextAdmin.address);
      await reverts("Old admin lost withdrawal permission", () => f.vault.connect(admin).withdrawVault.staticCall(1n), f.vault.interface, "OwnableUnauthorizedAccount", [admin.address]);
      await reverts("Old admin lost configuration permission", () => f.vault.connect(admin).setFeeReceiver.staticCall(nextReceiver.address), f.vault.interface, "OwnableUnauthorizedAccount", [admin.address]);
      const withdrawn = await mined("New admin withdraws 100", await f.vault.connect(nextAdmin).withdrawVault(units("100")));
      event("New admin withdrawal", withdrawn, f.vaultAddress, f.vault.interface, "VaultWithdrawn", [nextAdmin.address, units("100")]);
      check("Withdrawal paid current owner", await f.token.balanceOf(nextAdmin.address), units("100"));
      check("Former owner received no withdrawal", await f.token.balanceOf(admin.address), units("1000"));
      await mined("New admin approves", await f.token.connect(nextAdmin).approve(f.vaultAddress, units("10")));
      const funded = await mined("New admin funds 10", await f.vault.connect(nextAdmin).fundVault(units("10")));
      event("New admin funding", funded, f.vaultAddress, f.vault.interface, "VaultFunded", [nextAdmin.address, units("10")]);
      check("Funding uses current owner funds", await f.token.balanceOf(nextAdmin.address), units("90"));
      check("Vault after new owner funding", await f.token.balanceOf(f.vaultAddress), units("910"));
      await reverts("Renouncing Bank Admin disabled", () => f.vault.connect(nextAdmin).renounceOwnership.staticCall(), f.vault.interface, "OwnershipRenounceDisabled");
      check("Renounce leaves owner unchanged", await f.vault.owner(), nextAdmin.address);
    }

    console.log(`VaultManager smoke verification: PASS (${checks} assertions/probes; 5 independent fixtures).`);
    console.log("D1-06 exhaustive unit tests, transfer-failure/reentrancy fixtures and coverage: Not Executed.");
  } finally {
    await connection.close();
  }
}

try {
  await main();
} catch (error) {
  console.error("VaultManager smoke verification: FAIL", error);
  process.exitCode = 1;
}
