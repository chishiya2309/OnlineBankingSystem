import assert from "node:assert/strict";
import { network } from "hardhat";
import { readManifest } from "../helpers/deployment-manifest.js";

async function main() {
  const connection = await network.create("localhost");
  const { ethers } = connection;

  const netData = await ethers.provider.getNetwork();
  const chainId = Number(netData.chainId);
  if (chainId !== 31337) {
    throw new Error(`Restricted to localhost (Chain ID 31337). Current: ${chainId}`);
  }

  const manifest = await readManifest("localhost");
  if (!manifest?.contracts?.SavingCore || !manifest?.contracts?.MockUSDC || !manifest?.contracts?.VaultManager) {
    throw new Error("Missing deployment manifest for localhost.");
  }

  const mockUSDC = await ethers.getContractAt("MockUSDC", manifest.contracts.MockUSDC.address);
  const savingCore = await ethers.getContractAt("SavingCore", manifest.contracts.SavingCore.address);
  const vaultManager = await ethers.getContractAt("VaultManager", manifest.contracts.VaultManager.address);

  const signers = await ethers.getSigners();
  const bankAdmin = signers[1];
  const alice = signers[2];
  const bob = signers[3];
  const charlie = signers[4];
  const dave = signers[5];
  const eve = signers[6];
  const botCaller = signers[7];

  console.log("================================================================");
  console.log("       E2E REAL ON-CHAIN ACCEPTANCE VERIFICATION RUNNER         ");
  console.log("================================================================");
  console.log(`SavingCore:     ${manifest.contracts.SavingCore.address}`);
  console.log(`MockUSDC:       ${manifest.contracts.MockUSDC.address}`);
  console.log(`VaultManager:   ${manifest.contracts.VaultManager.address}`);
  console.log(`Bank Admin:     ${await bankAdmin.getAddress()}`);

  // ---------------------------------------------------------------
  // SCENARIO A — Portfolio Discovery on Existing Seeded Deposit #1
  // ---------------------------------------------------------------
  console.log("\n----------------------------------------------------------------");
  console.log("SCENARIO A: Portfolio Discovery on Seeded Deposit #1");
  console.log("----------------------------------------------------------------");
  const deposit1 = await savingCore.getDeposit(1);
  const owner1 = await savingCore.ownerOf(1);
  console.log(`Deposit #1 Owner:    ${owner1}`);
  console.log(`Deposit #1 Principal:${deposit1.principal} (${ethers.formatUnits(deposit1.principal, 6)} USDC)`);
  console.log(`Deposit #1 Status:   ${deposit1.status} (0=Active)`);
  assert.equal(deposit1.status, 0n, "Deposit #1 must be Active");
  assert.equal(owner1.toLowerCase(), (await alice.getAddress()).toLowerCase(), "Owner must be Alice");
  console.log("Scenario A PASS: Seeded deposit discovered with matching principal, status, and owner.");

  // ---------------------------------------------------------------
  // SCENARIO B — Early Withdrawal (t < M)
  // ---------------------------------------------------------------
  console.log("\n----------------------------------------------------------------");
  console.log("SCENARIO B: Early Withdrawal (t < M)");
  console.log("----------------------------------------------------------------");
  const bobAddr = await bob.getAddress();
  const feeReceiver = await vaultManager.feeReceiver();
  const principalB = 1000_000000n; // 1,000 USDC

  await (await mockUSDC.mint(bobAddr, principalB)).wait();
  await (await mockUSDC.connect(bob).approve(manifest.contracts.SavingCore.address, principalB)).wait();
  const openTxB = await savingCore.connect(bob).openDeposit(1, principalB);
  await openTxB.wait();
  const depositIdB = await savingCore.depositCount();

  const depositB = await savingCore.getDeposit(depositIdB);
  const blockB = await ethers.provider.getBlock("latest");
  const currentTB = BigInt(blockB?.timestamp ?? 0);
  console.log(`Opened Deposit #${depositIdB} for Bob: Principal = 1,000.0 USDC, MaturityAt = ${depositB.maturityAt}`);
  console.log(`Current Block Timestamp = ${currentTB} (< MaturityAt ${depositB.maturityAt})`);
  assert.ok(currentTB < BigInt(depositB.maturityAt), "Must be before maturity for early withdraw");

  const bobBalBefore = await mockUSDC.balanceOf(bobAddr);
  const feeBalBefore = await mockUSDC.balanceOf(feeReceiver);

  const withdrawTxB = await savingCore.connect(bob).earlyWithdraw(depositIdB);
  const withdrawReceiptB = await withdrawTxB.wait();
  console.log(`Early Withdrawal Tx Hash: ${withdrawReceiptB?.hash}`);

  const depositBPost = await savingCore.getDeposit(depositIdB);
  const bobBalAfter = await mockUSDC.balanceOf(bobAddr);
  const feeBalAfter = await mockUSDC.balanceOf(feeReceiver);

  console.log(`Deposit #${depositIdB} Post Status: ${depositBPost.status} (1=Withdrawn)`);
  console.log(`Bob Net Payout:     ${ethers.formatUnits(bobBalAfter - bobBalBefore, 6)} USDC (Expected: 965.0 USDC)`);
  console.log(`Fee Receiver Penalty: ${ethers.formatUnits(feeBalAfter - feeBalBefore, 6)} USDC (Expected: 35.0 USDC)`);

  assert.equal(depositBPost.status, 1n, "Deposit must transition to Withdrawn (1)");
  assert.equal(bobBalAfter - bobBalBefore, 965_000000n, "Bob must receive principal - penalty (965 USDC)");
  assert.equal(feeBalAfter - feeBalBefore, 35_000000n, "Fee receiver must receive penalty (35 USDC)");
  console.log("Scenario B PASS: Early withdrawal executed with exact penalty and net payout.");

  // ---------------------------------------------------------------
  // SCENARIO C — Maturity Withdrawal (t >= M)
  // ---------------------------------------------------------------
  console.log("\n----------------------------------------------------------------");
  console.log("SCENARIO C: Maturity Withdrawal (t >= M)");
  console.log("----------------------------------------------------------------");
  const charlieAddr = await charlie.getAddress();
  const principalC = 1000_000000n;

  await (await mockUSDC.mint(charlieAddr, principalC)).wait();
  await (await mockUSDC.connect(charlie).approve(manifest.contracts.SavingCore.address, principalC)).wait();
  const openTxC = await savingCore.connect(charlie).openDeposit(1, principalC);
  await openTxC.wait();
  const depositIdC = await savingCore.depositCount();

  const depositC = await savingCore.getDeposit(depositIdC);
  console.log(`Opened Deposit #${depositIdC} for Charlie: Principal = 1,000.0 USDC, MaturityAt = ${depositC.maturityAt}`);

  // Advance time to Maturity + 1
  const targetTC = BigInt(depositC.maturityAt) + 1n;
  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(targetTC)]);
  await ethers.provider.send("evm_mine", []);
  console.log(`Advanced local time to t = ${targetTC} (>= MaturityAt)`);

  const charlieBalBefore = await mockUSDC.balanceOf(charlieAddr);
  const withdrawTxC = await savingCore.connect(charlie).withdrawAtMaturity(depositIdC);
  const withdrawReceiptC = await withdrawTxC.wait();
  console.log(`Maturity Withdrawal Tx Hash: ${withdrawReceiptC?.hash}`);

  const depositCPost = await savingCore.getDeposit(depositIdC);
  const charlieBalAfter = await mockUSDC.balanceOf(charlieAddr);
  const expectedPayoutC = 1009_863013n; // P + I

  console.log(`Deposit #${depositIdC} Post Status: ${depositCPost.status} (1=Withdrawn)`);
  console.log(`Charlie Total Payout: ${ethers.formatUnits(charlieBalAfter - charlieBalBefore, 6)} USDC (Expected: ~1009.86 USDC)`);

  assert.equal(depositCPost.status, 1n, "Deposit must transition to Withdrawn (1)");
  assert.equal(charlieBalAfter - charlieBalBefore, expectedPayoutC, "Charlie must receive P + I");
  console.log("Scenario C PASS: Maturity withdrawal settled with full contractual interest.");

  // ---------------------------------------------------------------
  // SCENARIO D — Manual Renewal (P + I compounded into Plan 2)
  // ---------------------------------------------------------------
  console.log("\n----------------------------------------------------------------");
  console.log("SCENARIO D: Manual Renewal (t >= M into Plan 2)");
  console.log("----------------------------------------------------------------");
  const daveAddr = await dave.getAddress();
  const principalD = 1000_000000n;

  await (await mockUSDC.mint(daveAddr, principalD)).wait();
  await (await mockUSDC.connect(dave).approve(manifest.contracts.SavingCore.address, principalD)).wait();
  const openTxD = await savingCore.connect(dave).openDeposit(1, principalD);
  await openTxD.wait();
  const depositIdD = await savingCore.depositCount();

  const depositD = await savingCore.getDeposit(depositIdD);
  const targetTD = BigInt(depositD.maturityAt) + 1n;
  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(targetTD)]);
  await ethers.provider.send("evm_mine", []);
  console.log(`Opened Deposit #${depositIdD} for Dave. Advanced time to maturity: ${targetTD}`);

  // Manual renew into Plan 2 (360d, 5.00% APR)
  const renewTxD = await savingCore.connect(dave).renewDeposit(depositIdD, 2);
  const renewReceiptD = await renewTxD.wait();
  console.log(`Manual Renewal Tx Hash: ${renewReceiptD?.hash}`);

  const depositDPost = await savingCore.getDeposit(depositIdD);
  const newDepositIdD = await savingCore.depositCount();
  const depositDNew = await savingCore.getDeposit(newDepositIdD);
  const newOwnerD = await savingCore.ownerOf(newDepositIdD);

  console.log(`Old Deposit #${depositIdD} Status: ${depositDPost.status} (2=ManualRenewed)`);
  console.log(`New Deposit #${newDepositIdD} Status: ${depositDNew.status} (0=Active)`);
  console.log(`New Principal:      ${ethers.formatUnits(depositDNew.principal, 6)} USDC (Compounded P + I)`);
  console.log(`New Plan:           Plan #${depositDNew.planId} (${depositDNew.aprBpsAtOpen} bps APR)`);
  console.log(`New NFT Owner:      ${newOwnerD}`);

  assert.equal(depositDPost.status, 2n, "Old deposit must be ManualRenewed (2)");
  assert.equal(depositDNew.status, 0n, "New deposit must be Active (0)");
  assert.equal(depositDNew.principal, 1009_863013n, "New principal must equal compounded P + I");
  assert.equal(Number(depositDNew.aprBpsAtOpen), 500, "New APR must be 500 bps (5.00%) from Plan 2");
  assert.equal(newOwnerD.toLowerCase(), daveAddr.toLowerCase(), "New NFT must belong to Dave");
  console.log("Scenario D PASS: Manual renewal compounded P + I into Plan 2 without requiring MockUSDC approval.");

  // ---------------------------------------------------------------
  // SCENARIO E — Auto Renewal (t >= G, permissionless caller)
  // ---------------------------------------------------------------
  console.log("\n----------------------------------------------------------------");
  console.log("SCENARIO E: Auto Renewal (t >= G, permissionless caller)");
  console.log("----------------------------------------------------------------");
  const eveAddr = await eve.getAddress();
  const botAddr = await botCaller.getAddress();
  const principalE = 1000_000000n;

  await (await mockUSDC.mint(eveAddr, principalE)).wait();
  await (await mockUSDC.connect(eve).approve(manifest.contracts.SavingCore.address, principalE)).wait();
  const openTxE = await savingCore.connect(eve).openDeposit(1, principalE);
  await openTxE.wait();
  const depositIdE = await savingCore.depositCount();

  const depositE = await savingCore.getDeposit(depositIdE);
  const gracePeriod = await savingCore.gracePeriodSeconds();
  const graceEndE = BigInt(depositE.maturityAt) + BigInt(gracePeriod);

  // Advance time to Grace End + 1
  const targetTE = graceEndE + 1n;
  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(targetTE)]);
  await ethers.provider.send("evm_mine", []);
  console.log(`Opened Deposit #${depositIdE} for Eve. Advanced time past grace period to ${targetTE}`);

  // Bot triggers auto renewal
  console.log(`External Bot (${botAddr}) executing autoRenewDeposit(#${depositIdE})...`);
  const autoRenewTxE = await savingCore.connect(botCaller).autoRenewDeposit(depositIdE);
  const autoRenewReceiptE = await autoRenewTxE.wait();
  console.log(`Auto Renewal Tx Hash: ${autoRenewReceiptE?.hash}`);

  const depositEPost = await savingCore.getDeposit(depositIdE);
  const newDepositIdE = await savingCore.depositCount();
  const depositENew = await savingCore.getDeposit(newDepositIdE);
  const newOwnerE = await savingCore.ownerOf(newDepositIdE);

  console.log(`Old Deposit #${depositIdE} Status: ${depositEPost.status} (3=AutoRenewed)`);
  console.log(`New Deposit #${newDepositIdE} Status: ${depositENew.status} (0=Active)`);
  console.log(`New Principal:      ${ethers.formatUnits(depositENew.principal, 6)} USDC (Compounded P + I)`);
  console.log(`Locked APR:         ${depositENew.aprBpsAtOpen} bps (Preserved from old snapshot)`);
  console.log(`New NFT Owner:      ${newOwnerE} (Original owner Eve, NOT the Bot Caller!)`);

  assert.equal(depositEPost.status, 3n, "Old deposit must be AutoRenewed (3)");
  assert.equal(depositENew.status, 0n, "New deposit must be Active (0)");
  assert.equal(depositENew.principal, 1009_863013n, "Compounded P + I");
  assert.equal(depositENew.aprBpsAtOpen, depositE.aprBpsAtOpen, "APR locked from old snapshot");
  assert.equal(newOwnerE.toLowerCase(), eveAddr.toLowerCase(), "New NFT must be minted to Eve, not the bot caller");
  assert.notEqual(newOwnerE.toLowerCase(), botAddr.toLowerCase(), "Caller receives no NFT");
  console.log("Scenario E PASS: Auto renewal executed permissionlessly with terms preserved and NFT issued to original owner.");

  console.log("\n================================================================");
  console.log("       ALL E2E ACCEPTANCE SCENARIOS PASSED WITH FLYING COLORS   ");
  console.log("================================================================");
}

main().catch((err) => {
  console.error("E2E Acceptance failed:", err);
  process.exit(1);
});
