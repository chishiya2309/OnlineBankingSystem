import assert from "node:assert/strict";
import type { ContractTransactionResponse } from "ethers";
import { network } from "hardhat";

// D1-04 local smoke verification; the full unit suite belongs to D1-06.
// Run: npx.cmd hardhat run scripts/smoke-mock-usdc.ts --network hardhatMainnet
function check(label: string, actual: unknown, expected: unknown): void {
  assert.equal(actual, expected, label);
  console.log(`PASS | ${label} | expected=${String(expected)} | actual=${String(actual)}`);
}

async function main(): Promise<void> {
  const connection = await network.create("hardhatMainnet");

  try {
    check("Local network type", connection.networkConfig.type, "edr-simulated");
    const { ethers } = connection;
    const [deployer, alice, bob] = await ethers.getSigners();
    const token = await ethers.deployContract("MockUSDC");
    await token.waitForDeployment();

    const tokenAddress = await token.getAddress();
    const deployment = token.deploymentTransaction();
    assert.ok(deployment, "Deployment transaction must exist");
    const deploymentReceipt = await deployment.wait();
    assert.ok(deploymentReceipt, "Deployment receipt must exist");
    check("Deployment status", deploymentReceipt.status, 1);
    console.log(`Contract: ${tokenAddress}`);
    console.log(`Deployer: ${deployer.address}; Alice: ${alice.address}; Bob: ${bob.address}`);
    console.log(`Deploy tx: ${deployment.hash}; block=${deploymentReceipt.blockNumber}`);

    async function verifyTransfer(
      label: string,
      transaction: ContractTransactionResponse,
      from: string,
      to: string,
      amount: bigint,
    ): Promise<void> {
      const receipt = await transaction.wait();
      assert.ok(receipt, `${label}: receipt must exist`);
      console.log(`${label} tx: ${transaction.hash}; block=${receipt.blockNumber}`);
      check(`${label}: receipt status`, receipt.status, 1);

      const transfers = receipt.logs
        .filter((log) => log.address.toLowerCase() === tokenAddress.toLowerCase())
        .map((log) => token.interface.parseLog(log))
        .filter((event) => event?.name === "Transfer");
      check(`${label}: Transfer event count`, transfers.length, 1);
      const event = transfers[0];
      assert.ok(event, `${label}: Transfer event must exist`);
      check(
        `${label}: Transfer(from,to,amount)`,
        `${event.args.from},${event.args.to},${String(event.args.value)}`,
        `${from},${to},${String(amount)}`,
      );
    }

    check("Name", await token.name(), "MockUSDC");
    check("Symbol", await token.symbol(), "mUSDC");
    check("Decimals", await token.decimals(), 6n);
    check("Initial total supply", await token.totalSupply(), 0n);

    const thousandTokens = ethers.parseUnits("1000", 6);
    check("1000 tokens in smallest units", thousandTokens, 1_000_000_000n);
    await verifyTransfer(
      "Mint 1000 to Alice",
      await token.mint(alice.address, thousandTokens),
      ethers.ZeroAddress,
      alice.address,
      thousandTokens,
    );
    check("Alice after 1000 mint", await token.balanceOf(alice.address), 1_000_000_000n);
    check("Supply after 1000 mint", await token.totalSupply(), 1_000_000_000n);

    check("Bob differs from deployer", bob.address !== deployer.address, true);
    const twentyFiveTokens = ethers.parseUnits("25", 6);
    await verifyTransfer(
      "Bob mints 25 to Alice",
      await token.connect(bob).mint(alice.address, twentyFiveTokens),
      ethers.ZeroAddress,
      alice.address,
      twentyFiveTokens,
    );
    check("Alice after repeated mint", await token.balanceOf(alice.address), 1_025_000_000n);
    check("Supply after Bob's mint", await token.totalSupply(), 1_025_000_000n);

    const hundredTokens = ethers.parseUnits("100", 6);
    await verifyTransfer(
      "Mint 100 to Bob",
      await token.mint(bob.address, hundredTokens),
      ethers.ZeroAddress,
      bob.address,
      hundredTokens,
    );
    check("Bob after 100 mint", await token.balanceOf(bob.address), 100_000_000n);
    check("Supply after second recipient", await token.totalSupply(), 1_125_000_000n);

    await verifyTransfer(
      "Mint one smallest unit to Bob",
      await token.mint(bob.address, 1n),
      ethers.ZeroAddress,
      bob.address,
      1n,
    );
    check("Bob after one unit mint", await token.balanceOf(bob.address), 100_000_001n);
    check("Supply after one unit mint", await token.totalSupply(), 1_125_000_001n);

    const expectedRevertData = token.interface.encodeErrorResult("ERC20InvalidReceiver", [
      ethers.ZeroAddress,
    ]);
    await assert.rejects(
      token.mint.staticCall(ethers.ZeroAddress, 1n),
      // Match the exact error payload for Hardhat's SolidityError as well as ethers errors.
      { data: expectedRevertData },
      "Mint to zero address must revert with ERC20InvalidReceiver(ZeroAddress)",
    );
    console.log("PASS | Zero recipient: ERC20InvalidReceiver(ZeroAddress) via eth_call; no mined tx");
    check("Supply after rejected mint", await token.totalSupply(), 1_125_000_001n);

    await verifyTransfer(
      "Mint zero to Alice",
      await token.mint(alice.address, 0n),
      ethers.ZeroAddress,
      alice.address,
      0n,
    );
    check("Alice after zero mint", await token.balanceOf(alice.address), 1_025_000_000n);
    check("Bob after zero mint", await token.balanceOf(bob.address), 100_000_001n);
    check("Supply after zero mint", await token.totalSupply(), 1_125_000_001n);

    const tenTokens = ethers.parseUnits("10", 6);
    await verifyTransfer(
      "Alice transfers 10 to Bob",
      await token.connect(alice).transfer(bob.address, tenTokens),
      alice.address,
      bob.address,
      tenTokens,
    );
    check("Alice after transfer", await token.balanceOf(alice.address), 1_015_000_000n);
    check("Bob after transfer", await token.balanceOf(bob.address), 110_000_001n);
    check("Supply after transfer", await token.totalSupply(), 1_125_000_001n);

    console.log("MockUSDC smoke verification: PASS. Full D1-06 unit tests and coverage: Not Executed.");
  } finally {
    await connection.close();
  }
}

try {
  await main();
} catch (error) {
  console.error("MockUSDC smoke verification: FAIL", error);
  process.exitCode = 1;
}
