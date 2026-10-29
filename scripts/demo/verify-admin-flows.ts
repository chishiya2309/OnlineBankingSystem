import assert from "node:assert/strict";
import { network } from "hardhat";
import { readManifest } from "../helpers/deployment-manifest.js";

async function main() {
  console.log("================================================================");
  console.log("  VERIFYING BANK ADMIN LIFECYCLE ON LOCALHOST (CHAIN ID: 31337)");
  console.log("================================================================");

  const connection = await network.create("localhost");
  const { ethers } = connection;
  assert.equal((await ethers.provider.getNetwork()).chainId, 31337n, "Admin demo is restricted to local Hardhat");
  const signers = await ethers.getSigners();
  const bankAdmin = signers[1]; // 0x70997970C51812dc3A010C7d01b50e0d17dc79C8

  const manifest = await readManifest("localhost");
  assert(manifest, "Manifest for localhost must exist");

  const core = await ethers.getContractAt("SavingCore", manifest.contracts.SavingCore.address, bankAdmin);
  const vault = await ethers.getContractAt("VaultManager", manifest.contracts.VaultManager.address, bankAdmin);
  const mockUSDC = await ethers.getContractAt("MockUSDC", manifest.contracts.MockUSDC.address, bankAdmin);

  // 1. Verify Bank Admin role
  const vaultOwner = await vault.owner();
  console.log("VaultManager Owner:", vaultOwner);
  assert.equal(vaultOwner.toLowerCase(), (await bankAdmin.getAddress()).toLowerCase(), "Bank Admin must own VaultManager");

  // 2. Test Plan Creation
  const planCountBefore = await core.planCount();
  console.log(`Initial plan count: ${planCountBefore}`);

  console.log("Creating new 45-day admin plan...");
  const createTx = await core.createPlan(45, 600, 0, 0, 400, true);
  const createReceipt = await createTx.wait();
  assert(createReceipt, "Plan creation receipt must be mined");
  console.log(`Plan created in block ${createReceipt.blockNumber}, txHash: ${createReceipt.hash}`);

  const planCountAfter = await core.planCount();
  assert.equal(planCountAfter, planCountBefore + 1n, "planCount must increment by 1");
  const newPlanId = planCountAfter;

  // 3. Test Update Plan APR
  console.log(`Updating Plan #${newPlanId} APR from 600 bps to 750 bps...`);
  const updateTx = await core.updatePlan(newPlanId, 750);
  await updateTx.wait();
  const planData = await core.getPlan(newPlanId);
  assert.equal(planData.aprBps, 750n, "Plan APR must be updated to 750 bps");
  console.log(`Verified Plan #${newPlanId} new APR: ${planData.aprBps} bps`);

  // 4. Test Toggle Status (disable/enable)
  console.log(`Disabling Plan #${newPlanId}...`);
  await (await core.disablePlan(newPlanId)).wait();
  const disabledData = await core.getPlan(newPlanId);
  assert.equal(disabledData.enabled, false, "Plan must be disabled");

  console.log(`Re-enabling Plan #${newPlanId}...`);
  await (await core.enablePlan(newPlanId)).wait();
  const enabledData = await core.getPlan(newPlanId);
  assert.equal(enabledData.enabled, true, "Plan must be enabled");

  // 5. Test Vault Pause / Unpause
  console.log("Testing Emergency Pause...");
  await (await vault.pause()).wait();
  assert.equal(await vault.paused(), true, "Vault must be paused");

  console.log("Testing Unpause...");
  await (await vault.unpause()).wait();
  assert.equal(await vault.paused(), false, "Vault must be unpaused");

  // 6. Test Fund Vault
  const fundAmount = ethers.parseUnits("500", 6);
  console.log("Funding Vault with 500 USDC...");
  await (await mockUSDC.mint(await bankAdmin.getAddress(), fundAmount)).wait();
  await (await mockUSDC.approve(vault.target, fundAmount)).wait();
  const fundTx = await vault.fundVault(fundAmount);
  await fundTx.wait();
  console.log("Vault funded successfully!");

  console.log("\nALL BANK ADMIN CONTRACT FLOWS VERIFIED SUCCESSFULLY ON LOCALHOST!");
}

main().catch((err) => {
  console.error("Admin verification failed:", err);
  process.exit(1);
});
