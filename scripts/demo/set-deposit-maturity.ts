import { network } from "hardhat";
import { readManifest, loadEnvFile } from "../helpers/deployment-manifest.js";

/**
 * CLI utility to adjust deposit timeline on Sepolia (or any network),
 * allowing Bank Admin to verify deposit maturity, withdrawal, and renewals.
 *
 * Examples:
 *   npx hardhat run scripts/demo/set-deposit-maturity.ts --network sepolia -- --deposit 1 --mode mature
 *   npx hardhat run scripts/demo/set-deposit-maturity.ts --network sepolia -- --deposit 1 --mode grace
 *   npx hardhat run scripts/demo/set-deposit-maturity.ts --network sepolia -- --deposit 1 --mode custom --start 1700000000 --maturity 1700086400
 */
async function main() {
  await loadEnvFile();

  const networkName = process.argv.includes("--network")
    ? process.argv[process.argv.indexOf("--network") + 1]
    : "sepolia";

  const connection = await network.create(networkName);
  const { ethers } = connection;
  const provider = ethers.provider;
  const netData = await provider.getNetwork();
  const chainId = Number(netData.chainId);

  const args = process.argv.slice(2);
  let depositId: bigint | null = null;
  let mode: "mature" | "grace" | "custom" = "mature";
  let customStart: bigint | null = null;
  let customMaturity: bigint | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--deposit" && args[i + 1]) {
      depositId = BigInt(args[i + 1]);
      i++;
    } else if (args[i] === "--mode" && args[i + 1]) {
      const m = args[i + 1].toLowerCase();
      if (m === "mature" || m === "grace" || m === "custom") {
        mode = m;
      }
      i++;
    } else if (args[i] === "--start" && args[i + 1]) {
      customStart = BigInt(args[i + 1]);
      i++;
    } else if (args[i] === "--maturity" && args[i + 1]) {
      customMaturity = BigInt(args[i + 1]);
      i++;
    }
  }

  if (!depositId || depositId <= 0n) {
    console.error("Error: --deposit <id> is required.");
    console.error("Usage: npx hardhat run scripts/demo/set-deposit-maturity.ts --network <net> -- --deposit <id> [--mode mature|grace|custom]");
    process.exit(1);
  }

  const manifest = await readManifest(networkName);
  if (!manifest?.contracts?.SavingCore?.address || !manifest?.contracts?.VaultManager?.address) {
    throw new Error(`No deployment manifest found for network: ${networkName}. Deploy first.`);
  }

  const coreAddress = manifest.contracts.SavingCore.address;
  const vaultAddress = manifest.contracts.VaultManager.address;

  // Signers & Bank Admin matching
  const signers = await ethers.getSigners();
  const vaultContract = await ethers.getContractAt("VaultManager", vaultAddress);
  const vaultOwner = await vaultContract.owner();

  const adminSigner =
    signers.find((s: any) => s.address && s.address.toLowerCase() === vaultOwner.toLowerCase()) ??
    signers[0];

  console.log("==================================================");
  console.log("   ADMIN DEPOSIT MATURITY & TIMELINE CONTROLLER   ");
  console.log("==================================================");
  console.log(`Network:             ${networkName} (Chain ID: ${chainId})`);
  console.log(`SavingCore:          ${coreAddress}`);
  console.log(`VaultManager:        ${vaultAddress}`);
  console.log(`On-Chain Bank Admin: ${vaultOwner}`);
  console.log(`Caller Signer:       ${adminSigner.address}`);

  if (adminSigner.address.toLowerCase() !== vaultOwner.toLowerCase()) {
    console.warn(`\n[WARNING] Signer ${adminSigner.address} is NOT the Bank Admin (${vaultOwner})! Transaction may revert with NotBankAdmin.`);
  }

  const savingCore = await ethers.getContractAt("SavingCore", coreAddress, adminSigner);
  const depositCount = await savingCore.depositCount();
  if (depositId > depositCount) {
    throw new Error(`Deposit #${depositId} not found. Total deposits on-chain: ${depositCount}`);
  }

  const blockLatest = await provider.getBlock("latest");
  const now = BigInt(blockLatest?.timestamp ?? Math.floor(Date.now() / 1000));
  const gracePeriod = BigInt(await savingCore.gracePeriodSeconds());

  const dep = await savingCore.getDeposit(depositId);
  const statusNum = Number(dep.status);
  const statusNames = ["Active", "Withdrawn", "ManualRenewed", "AutoRenewed"];
  console.log(`\n--- Deposit #${depositId} Current State ---`);
  console.log(`  Principal:    ${ethers.formatUnits(dep.principal, 6)} USDC`);
  console.log(`  Status:       ${statusNames[statusNum] ?? statusNum}`);
  console.log(`  StartAt:      ${dep.startAt} (${new Date(Number(dep.startAt) * 1000).toISOString()})`);
  console.log(`  MaturityAt:   ${dep.maturityAt} (${new Date(Number(dep.maturityAt) * 1000).toISOString()})`);
  console.log(`  Block Time:   ${now} (${new Date(Number(now) * 1000).toISOString()})`);

  if (statusNum !== 0) {
    throw new Error(`Deposit #${depositId} is not Active (status = ${statusNames[statusNum]}). Only Active deposits can be adjusted.`);
  }

  const originalTenor = BigInt(dep.maturityAt) - BigInt(dep.startAt);
  let targetStart: bigint;
  let targetMaturity: bigint;

  if (mode === "mature") {
    // Mature immediately: maturityAt set to now - 5s, startAt shifted back to preserve full tenor
    targetMaturity = now - 5n;
    targetStart = targetMaturity - originalTenor;
    console.log(`\nMode: MATURE IMMEDIATELY`);
    console.log(`  Preserving full tenor: ${Number(originalTenor) / 86400} days`);
    console.log(`  New MaturityAt:        ${targetMaturity} (${new Date(Number(targetMaturity) * 1000).toISOString()})`);
    console.log(`  New StartAt:           ${targetStart} (${new Date(Number(targetStart) * 1000).toISOString()})`);
  } else if (mode === "grace") {
    // Expire grace period: maturityAt set to now - gracePeriod - 60s
    targetMaturity = now - gracePeriod - 60n;
    targetStart = targetMaturity - originalTenor;
    console.log(`\nMode: EXPIRE GRACE PERIOD (FOR AUTO-RENEWAL TESTING)`);
    console.log(`  Grace Period:          ${Number(gracePeriod) / 86400} days (${gracePeriod}s)`);
    console.log(`  New MaturityAt:        ${targetMaturity} (${new Date(Number(targetMaturity) * 1000).toISOString()})`);
    console.log(`  New StartAt:           ${targetStart} (${new Date(Number(targetStart) * 1000).toISOString()})`);
  } else {
    // Custom mode
    if (!customStart || !customMaturity) {
      throw new Error("Mode 'custom' requires both --start <timestamp> and --maturity <timestamp>.");
    }
    targetStart = customStart;
    targetMaturity = customMaturity;
    console.log(`\nMode: CUSTOM TIMELINE`);
    console.log(`  New StartAt:           ${targetStart}`);
    console.log(`  New MaturityAt:        ${targetMaturity}`);
  }

  console.log(`\nSubmitting setDepositTimeline transaction...`);
  const tx = await savingCore.setDepositTimeline(depositId, targetStart, targetMaturity);
  console.log(`  Tx Hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  Confirmed in Block: #${receipt?.blockNumber}`);

  const updatedDep = await savingCore.getDeposit(depositId);
  const updatedInterest = await savingCore.calculateInterest(depositId);

  console.log("\n==================================================");
  console.log("             UPDATE SUCCESSFUL!                   ");
  console.log("==================================================");
  console.log(`Deposit #${depositId} is now updated:`);
  console.log(`  StartAt:            ${updatedDep.startAt}`);
  console.log(`  MaturityAt:         ${updatedDep.maturityAt}`);
  console.log(`  Is Matured:         ${now >= BigInt(updatedDep.maturityAt) ? "YES (Matured)" : "NO"}`);
  console.log(`  Contractual Yield:  ${ethers.formatUnits(updatedInterest, 6)} USDC`);
  console.log(`  Grace Period End:   ${BigInt(updatedDep.maturityAt) + gracePeriod}`);
  console.log(`  Eligible AutoRenew: ${now >= BigInt(updatedDep.maturityAt) + gracePeriod ? "YES" : "NO"}`);
  console.log("==================================================\n");
}

main().catch((error) => {
  console.error("Execution failed:", error.message || error);
  process.exit(1);
});
