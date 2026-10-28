import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Signer } from "ethers";
import { network } from "hardhat";
import { personalVariant } from "../config/personal-variant.js";
import {
  exportContracts,
  loadEnvFile,
  readManifest,
  saveManifest,
  type DeploymentManifest,
} from "./helpers/deployment-manifest.js";
import { deployContracts } from "./deploy.js";

export interface SeedOptions {
  networkName?: string;
  connection?: any;
  manifest?: DeploymentManifest;
  bankAdminSigner?: Signer;
  userSigner?: Signer;
  skipSampleDeposit?: boolean;
}

export interface SeedResult {
  manifest: DeploymentManifest;
  plansCreated: number;
  vaultFunded: bigint;
  demoMinted: bigint;
  sampleDepositCreated: boolean;
}

export async function seedContracts(options: SeedOptions = {}): Promise<SeedResult> {
  await loadEnvFile();

  const networkName =
    options.networkName ??
    (process.argv.includes("--network")
      ? process.argv[process.argv.indexOf("--network") + 1]
      : "hardhatMainnet");

  console.log(`\n================================================================`);
  console.log(`  STARTING SEEDING — TARGET NETWORK: ${networkName}`);
  console.log(`================================================================`);

  const connection = options.connection ?? (await network.create(networkName));
  const { ethers } = connection;
  const signers = await ethers.getSigners();
  const provider = ethers.provider;

  let manifest = options.manifest ?? (await readManifest(networkName));

  // If on ephemeral local chain without an existing deployment with code, deploy fresh first
  if (!manifest) {
    console.log(`No deployment manifest found for ${networkName}. Running deploy first...`);
    const deployRes = await deployContracts({ networkName, connection });
    manifest = deployRes.manifest;
  } else {
    // Check if code actually exists at the manifest addresses
    const code = await provider.getCode(manifest.contracts.SavingCore.address);
    if (!code || code === "0x") {
      console.log(`Ephemeral chain detected (no bytecode at manifest address). Deploying fresh...`);
      const deployRes = await deployContracts({ networkName, connection });
      manifest = deployRes.manifest;
    }
  }

  const mockUSDCAddress = manifest.contracts.MockUSDC.address;
  const vaultAddress = manifest.contracts.VaultManager.address;
  const coreAddress = manifest.contracts.SavingCore.address;

  // Signers & Roles
  const deployer: any = signers[0];
  const vaultReader = await ethers.getContractAt("VaultManager", vaultAddress);
  let expectedAdmin = manifest?.bankAdmin;
  try {
    const ownerOnChain = await vaultReader.owner();
    if (ownerOnChain && ownerOnChain !== ethers.ZeroAddress) {
      expectedAdmin = ownerOnChain;
    }
  } catch {
    // fallback to manifest
  }

  let bankAdmin: any = options.bankAdminSigner;
  if (!bankAdmin) {
    const matchingSigner = signers.find(
      (s: any) => s.address && s.address.toLowerCase() === expectedAdmin?.toLowerCase()
    );
    bankAdmin = matchingSigner ?? deployer;
  }
  const bankAdminAddress: string = bankAdmin.address ?? (await bankAdmin.getAddress());

  const userSigner: any = options.userSigner ?? (signers.length > 2 ? signers[2] : deployer);
  const userSignerAddress: string = userSigner.address ?? (await userSigner.getAddress());
  const demoRecipient = process.env.DEMO_USER_ADDRESS ?? userSignerAddress;

  const mockUSDC = await ethers.getContractAt("MockUSDC", mockUSDCAddress, deployer);
  const vault = await ethers.getContractAt("VaultManager", vaultAddress, bankAdmin);
  const core = await ethers.getContractAt("SavingCore", coreAddress, bankAdmin);


  let plansCreated = 0;
  let vaultFunded = 0n;
  let demoMinted = 0n;
  let sampleDepositCreated = false;

  // ============================================================================
  // Step 1: Saving Plans (Idempotent)
  // ============================================================================
  console.log(`\n--- [Seed 1] Saving Plans ---`);
  const currentPlanCount = await core.planCount();
  console.log(`Current Plan Count on-chain: ${currentPlanCount}`);

  if (currentPlanCount === 0n) {
    // Plan 1: Default Personal Variant Plan
    console.log(`Creating Plan 1 (Default: ${personalVariant.defaultTenorDays}d, ${personalVariant.defaultAprBps} bps APR, ${personalVariant.earlyWithdrawPenaltyBps} bps penalty, enabled)...`);
    const tx1 = await core.createPlan(
      BigInt(personalVariant.defaultTenorDays),
      BigInt(personalVariant.defaultAprBps),
      0n,
      0n,
      BigInt(personalVariant.earlyWithdrawPenaltyBps),
      true
    );
    await tx1.wait();
    plansCreated += 1;

    // Plan 2: Secondary Plan for Manual Renewal Demo
    console.log(`Creating Plan 2 (Secondary: 360d, 500 bps APR, 350 bps penalty, enabled)...`);
    const tx2 = await core.createPlan(360n, 500n, 0n, 0n, 350n, true);
    await tx2.wait();
    plansCreated += 1;

    // Plan 3: Disabled Plan for Testing/Demo Status
    console.log(`Creating Plan 3 (Status Demo: 90d, 150 bps APR, 350 bps penalty, disabled)...`);
    const tx3 = await core.createPlan(90n, 150n, 0n, 0n, 350n, false);
    await tx3.wait();
    plansCreated += 1;

    console.log(`Successfully created ${plansCreated} saving plans.`);
  } else {
    console.log(`SKIPPED — Saving plans already created (planCount = ${currentPlanCount}).`);
  }

  // ============================================================================
  // Step 2: Mint MockUSDC Demo Balances (Idempotent)
  // ============================================================================
  console.log(`\n--- [Seed 2] Mint Demo MockUSDC ---`);
  const TARGET_USER_BALANCE = ethers.parseUnits("10000", 6); // 10,000 USDC

  const currentRecipientBalance: bigint = BigInt(await mockUSDC.balanceOf(demoRecipient));
  console.log(`Recipient ${demoRecipient} current balance: ${ethers.formatUnits(currentRecipientBalance, 6)} USDC`);

  if (currentRecipientBalance < TARGET_USER_BALANCE) {
    const mintAmount: bigint = TARGET_USER_BALANCE - currentRecipientBalance;
    console.log(`Minting ${ethers.formatUnits(mintAmount, 6)} MockUSDC to ${demoRecipient}...`);
    const mintTx = await mockUSDC.mint(demoRecipient, mintAmount);
    await mintTx.wait();
    demoMinted += BigInt(mintAmount);
    console.log(`Mint successful.`);
  } else {
    console.log(`SKIPPED — Demo recipient already has sufficient balance (${ethers.formatUnits(currentRecipientBalance, 6)} USDC).`);
  }

  // ============================================================================
  // Step 3: Fund Vault with Interest Liquidity (Idempotent)
  // ============================================================================
  console.log(`\n--- [Seed 3] Fund VaultManager ---`);
  const TARGET_VAULT_LIQUIDITY = ethers.parseUnits("5000", 6); // 5,000 USDC
  const currentVaultBalance: bigint = BigInt(await mockUSDC.balanceOf(vaultAddress));
  console.log(`Current Vault Liquidity: ${ethers.formatUnits(currentVaultBalance, 6)} USDC`);

  if (currentVaultBalance < TARGET_VAULT_LIQUIDITY) {
    const fundAmount: bigint = TARGET_VAULT_LIQUIDITY - currentVaultBalance;
    console.log(`Funding Vault with ${ethers.formatUnits(fundAmount, 6)} MockUSDC from Bank Admin ${bankAdminAddress}...`);

    // Ensure Bank Admin has enough tokens
    const adminBal: bigint = BigInt(await mockUSDC.balanceOf(bankAdminAddress));
    if (adminBal < fundAmount) {
      const adminMint: bigint = fundAmount - adminBal;
      const mTx = await mockUSDC.mint(bankAdminAddress, adminMint);
      await mTx.wait();
    }

    // Approve & Fund
    const appTx = await mockUSDC.connect(bankAdmin).approve(vaultAddress, fundAmount);
    await appTx.wait();

    const fundTx = await vault.connect(bankAdmin).fundVault(fundAmount);
    await fundTx.wait();
    vaultFunded += BigInt(fundAmount);

    const newVaultBal = await mockUSDC.balanceOf(vaultAddress);
    console.log(`Vault successfully funded. New balance: ${ethers.formatUnits(newVaultBal, 6)} USDC`);
  } else {
    console.log(`SKIPPED — Vault already funded with sufficient liquidity (${ethers.formatUnits(currentVaultBalance, 6)} USDC).`);
  }

  // ============================================================================
  // Step 4: Optional Sample Deposit (Idempotent)
  // ============================================================================
  console.log(`\n--- [Seed 4] Sample Deposit ---`);
  const currentDepositCount = await core.depositCount();
  console.log(`Current Deposit Count on-chain: ${currentDepositCount}`);

  if (!options.skipSampleDeposit && currentDepositCount === 0n && networkName !== "sepolia") {
    const depositAmount = ethers.parseUnits("1000", 6); // 1,000 USDC
    console.log(`Creating sample deposit of ${ethers.formatUnits(depositAmount, 6)} USDC for user ${userSigner.address}...`);

    // Ensure user has tokens and allowance
    const userBal = await mockUSDC.balanceOf(userSigner.address);
    if (userBal < depositAmount) {
      await (await mockUSDC.mint(userSigner.address, depositAmount)).wait();
    }
    await (await mockUSDC.connect(userSigner).approve(coreAddress, depositAmount)).wait();

    const openTx = await core.connect(userSigner).openDeposit(1n, depositAmount);
    await openTx.wait();
    sampleDepositCreated = true;

    const newCount = await core.depositCount();
    console.log(`Sample Deposit #1 created successfully! Total Active Deposits: ${newCount}`);
  } else {
    console.log(`SKIPPED — Sample deposit creation skipped (depositCount = ${currentDepositCount} or live testnet).`);
  }

  // Update Manifest Seed Metadata
  manifest.seed = {
    verified: true,
    seededAt: new Date().toISOString(),
    planCount: Number(await core.planCount()),
    vaultFundedAmount: ethers.formatUnits(await mockUSDC.balanceOf(vaultAddress), 6),
    demoUserMinted: ethers.formatUnits(await mockUSDC.balanceOf(demoRecipient), 6),
    sampleDepositId: sampleDepositCreated ? 1 : undefined,
  };

  await saveManifest(manifest);
  await exportContracts(manifest);

  console.log(`\n================================================================`);
  console.log(`  SEEDING COMPLETED SUCCESSFULLY`);
  console.log(`  Plans:          ${manifest.seed.planCount}`);
  console.log(`  Vault Balance:  ${manifest.seed.vaultFundedAmount} USDC`);
  console.log(`  Demo User:      ${manifest.seed.demoUserMinted} USDC (${demoRecipient})`);
  console.log(`================================================================\n`);

  return {
    manifest,
    plansCreated,
    vaultFunded,
    demoMinted,
    sampleDepositCreated,
  };
}

// Auto-run if executed directly via CLI or hardhat run
if (process.argv.some((arg) => arg.includes("seed.ts") || arg.endsWith("seed"))) {
  seedContracts()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("\nSeeding failed:", error.message || error);
      process.exit(1);
    });
}
