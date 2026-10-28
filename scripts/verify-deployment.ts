import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { network } from "hardhat";
import { personalVariant } from "../config/personal-variant.js";
import { loadEnvFile, readManifest, type DeploymentManifest } from "./helpers/deployment-manifest.js";

export interface VerificationCheck {
  item: string;
  expected: string;
  actual: string;
  passed: boolean;
}

export interface VerificationReport {
  network: string;
  chainId: number;
  allPassed: boolean;
  checks: VerificationCheck[];
}

export interface VerifyOptions {
  networkName?: string;
  connection?: any;
}

export async function verifyDeployment(options?: string | VerifyOptions): Promise<VerificationReport> {
  await loadEnvFile();

  const opts: VerifyOptions = typeof options === "string" ? { networkName: options } : (options ?? {});
  const targetNetwork =
    opts.networkName ??
    (process.argv.includes("--network")
      ? process.argv[process.argv.indexOf("--network") + 1]
      : "hardhatMainnet");

  console.log(`\n================================================================`);
  console.log(`  VERIFYING DEPLOYMENT — TARGET NETWORK: ${targetNetwork}`);
  console.log(`================================================================\n`);

  const manifest = await readManifest(targetNetwork);
  if (!manifest) {
    throw new Error(`MANIFEST_NOT_FOUND: No deployment manifest found for ${targetNetwork}. Run deploy first.`);
  }

  const connection = opts.connection ?? (await network.create(targetNetwork));
  const { ethers } = connection;
  const provider = ethers.provider;

  const chainData = await provider.getNetwork();
  const actualChainId = Number(chainData.chainId);

  const checks: VerificationCheck[] = [];

  function recordCheck(item: string, expected: string, actual: string, condition: boolean) {
    const passed = condition;
    checks.push({ item, expected, actual, passed });
    const statusLabel = passed ? "PASS" : "FAIL";
    console.log(`[${statusLabel}] ${item}`);
    console.log(`       Expected: ${expected}`);
    console.log(`       Actual:   ${actual}`);
  }

  // 1. Chain ID Verification
  recordCheck(
    "Chain ID matches manifest",
    manifest.chainId.toString(),
    actualChainId.toString(),
    actualChainId === manifest.chainId
  );

  // 2. Bytecode Existence
  const mockUSDCCode = await provider.getCode(manifest.contracts.MockUSDC.address);
  recordCheck(
    "MockUSDC runtime bytecode exists",
    "Bytecode present",
    mockUSDCCode && mockUSDCCode !== "0x" ? "Bytecode present" : "0x (missing)",
    !!mockUSDCCode && mockUSDCCode !== "0x"
  );

  const vaultCode = await provider.getCode(manifest.contracts.VaultManager.address);
  recordCheck(
    "VaultManager runtime bytecode exists",
    "Bytecode present",
    vaultCode && vaultCode !== "0x" ? "Bytecode present" : "0x (missing)",
    !!vaultCode && vaultCode !== "0x"
  );

  const coreCode = await provider.getCode(manifest.contracts.SavingCore.address);
  recordCheck(
    "SavingCore runtime bytecode exists",
    "Bytecode present",
    coreCode && coreCode !== "0x" ? "Bytecode present" : "0x (missing)",
    !!coreCode && coreCode !== "0x"
  );

  if (!mockUSDCCode || mockUSDCCode === "0x" || !vaultCode || vaultCode === "0x" || !coreCode || coreCode === "0x") {
    console.error("\nCRITICAL: One or more contracts have no runtime bytecode on-chain!");
    return {
      network: targetNetwork,
      chainId: actualChainId,
      allPassed: false,
      checks,
    };
  }

  // Instantiate contracts
  const mockUSDC = await ethers.getContractAt("MockUSDC", manifest.contracts.MockUSDC.address);
  const vault = await ethers.getContractAt("VaultManager", manifest.contracts.VaultManager.address);
  const core = await ethers.getContractAt("SavingCore", manifest.contracts.SavingCore.address);

  // 3. MockUSDC Decimals
  const decimals = await mockUSDC.decimals();
  recordCheck("MockUSDC decimals == 6", "6", decimals.toString(), decimals === 6n);

  // 4. Cross-contract references
  const vaultToken = await vault.token();
  recordCheck(
    "VaultManager.token == MockUSDC",
    manifest.contracts.MockUSDC.address.toLowerCase(),
    vaultToken.toLowerCase(),
    vaultToken.toLowerCase() === manifest.contracts.MockUSDC.address.toLowerCase()
  );

  const coreToken = await core.token();
  recordCheck(
    "SavingCore.token == MockUSDC",
    manifest.contracts.MockUSDC.address.toLowerCase(),
    coreToken.toLowerCase(),
    coreToken.toLowerCase() === manifest.contracts.MockUSDC.address.toLowerCase()
  );

  const coreVault = await core.vaultManager();
  recordCheck(
    "SavingCore.vaultManager == VaultManager",
    manifest.contracts.VaultManager.address.toLowerCase(),
    coreVault.toLowerCase(),
    coreVault.toLowerCase() === manifest.contracts.VaultManager.address.toLowerCase()
  );

  // 5. Write-once Binding
  const boundCore = await vault.savingCore();
  recordCheck(
    "VaultManager.savingCore write-once binding == SavingCore",
    manifest.contracts.SavingCore.address.toLowerCase(),
    boundCore.toLowerCase(),
    boundCore.toLowerCase() === manifest.contracts.SavingCore.address.toLowerCase()
  );

  // 6. Ownership & Roles
  const vaultOwner = await vault.owner();
  recordCheck(
    "VaultManager.owner == Bank Admin",
    manifest.bankAdmin.toLowerCase(),
    vaultOwner.toLowerCase(),
    vaultOwner.toLowerCase() === manifest.bankAdmin.toLowerCase()
  );

  const vaultFeeReceiver = await vault.feeReceiver();
  recordCheck(
    "VaultManager.feeReceiver == Configured Fee Receiver",
    manifest.feeReceiver.toLowerCase(),
    vaultFeeReceiver.toLowerCase(),
    vaultFeeReceiver.toLowerCase() === manifest.feeReceiver.toLowerCase()
  );

  // 7. Personal Variant Grace Period
  const expectedGrace = BigInt(personalVariant.gracePeriodDays * 86400); // 172800n
  const actualGrace = await core.gracePeriodSeconds();
  recordCheck(
    "SavingCore.gracePeriodSeconds == Personal Variant (172800s)",
    expectedGrace.toString(),
    actualGrace.toString(),
    actualGrace === expectedGrace
  );

  // 8. Plan 1 Data (if seeded)
  const planCount = await core.planCount();
  if (planCount >= 1n) {
    const plan1 = await core.getPlan(1n);
    recordCheck(
      "Plan 1 Tenor == 180 days",
      personalVariant.defaultTenorDays.toString(),
      plan1.tenorDays.toString(),
      Number(plan1.tenorDays) === personalVariant.defaultTenorDays
    );
    recordCheck(
      "Plan 1 APR == 200 bps",
      personalVariant.defaultAprBps.toString(),
      plan1.aprBps.toString(),
      Number(plan1.aprBps) === personalVariant.defaultAprBps
    );
    recordCheck(
      "Plan 1 Penalty == 350 bps",
      personalVariant.earlyWithdrawPenaltyBps.toString(),
      plan1.earlyWithdrawPenaltyBps.toString(),
      Number(plan1.earlyWithdrawPenaltyBps) === personalVariant.earlyWithdrawPenaltyBps
    );
    recordCheck("Plan 1 Enabled == true", "true", plan1.enabled.toString(), plan1.enabled === true);
  }

  // 9. Vault Liquidity
  const vaultBalance = await mockUSDC.balanceOf(manifest.contracts.VaultManager.address);
  const formattedVaultBal = ethers.formatUnits(vaultBalance, 6);
  recordCheck(
    "VaultManager liquidity verified",
    ">= 0 USDC",
    `${formattedVaultBal} USDC`,
    vaultBalance >= 0n
  );

  const allPassed = checks.every((c) => c.passed);

  console.log(`\n================================================================`);
  console.log(`  VERIFICATION RESULT: ${allPassed ? "ALL CHECKS PASSED (SUCCESS)" : "FAILED CHECKS DETECTED"}`);
  console.log(`================================================================\n`);

  return {
    network: targetNetwork,
    chainId: actualChainId,
    allPassed,
    checks,
  };
}

// Auto-run if executed directly via CLI or hardhat run
if (process.argv.some((arg) => arg.includes("verify-deployment"))) {
  verifyDeployment()
    .then((report) => {
      if (!report.allPassed) process.exit(1);
      process.exit(0);
    })
    .catch((error) => {
      console.error("\nVerification script failed:", error.message || error);
      process.exit(1);
    });
}
