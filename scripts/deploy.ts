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

export interface DeployOptions {
  networkName?: string;
  connection?: any;
  deployerSigner?: Signer;
  bankAdminSigner?: Signer;
  feeReceiverAddress?: string;
  autoSeed?: boolean;
  forceRedeploy?: boolean;
}

export interface DeploymentResult {
  manifest: DeploymentManifest;
  contracts: {
    mockUSDC: any;
    vaultManager: any;
    savingCore: any;
  };
}

function isValidPrivateKey(key?: string): boolean {
  if (!key) return false;
  const cleaned = key.startsWith("0x") ? key.slice(2) : key;
  return /^[0-9a-fA-F]{64}$/.test(cleaned);
}

async function retryCall<T>(
  action: () => Promise<T>,
  description: string,
  maxRetries = 6,
  delayMs = 3000
): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await action();
    } catch (err: any) {
      lastError = err;
      if (attempt < maxRetries) {
        console.log(`  [Retry ${attempt}/${maxRetries}] Waiting ${delayMs / 1000}s for ${description} (RPC sync lag)...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

export async function deployContracts(options: DeployOptions = {}): Promise<DeploymentResult> {
  await loadEnvFile();

  const networkName =
    options.networkName ??
    (process.argv.includes("--network")
      ? process.argv[process.argv.indexOf("--network") + 1]
      : "hardhatMainnet");

  console.log(`\n================================================================`);
  console.log(`  STARTING DEPLOYMENT — TARGET NETWORK: ${networkName}`);
  console.log(`================================================================`);

  // Sepolia Preflight Credential Guard
  if (networkName === "sepolia") {
    const hasRpc = !!process.env.SEPOLIA_RPC_URL && process.env.SEPOLIA_RPC_URL.trim() !== "";
    const hasValidKey = isValidPrivateKey(process.env.SEPOLIA_PRIVATE_KEY);
    if (!hasRpc || !hasValidKey) {
      console.error(`\n[PREFLIGHT BLOCKED] Missing or invalid Sepolia credentials:`);
      if (!hasRpc) console.error(`  - SEPOLIA_RPC_URL is not set.`);
      if (!hasValidKey) console.error(`  - SEPOLIA_PRIVATE_KEY is missing or not a valid 64-hex character private key.`);
      console.error(`\nRemediation Instructions:`);
      console.error(`  1. Copy .env.example to .env and configure your Sepolia RPC and private key, OR`);
      console.error(`  2. Set environment variables (e.g. $env:SEPOLIA_RPC_URL="...", $env:SEPOLIA_PRIVATE_KEY="..."), OR`);
      console.error(`  3. Set Hardhat keystore vars: npx hardhat keystore set SEPOLIA_RPC_URL`);
      throw new Error(`PREFLIGHT_BLOCKED_MISSING_CREDENTIALS: SEPOLIA_RPC_URL or valid 64-hex SEPOLIA_PRIVATE_KEY is missing.`);
    }
  }

  let connection;
  try {
    connection = options.connection ?? (await network.create(networkName));
  } catch (err: any) {
    if (networkName === "sepolia") {
      throw new Error(`PREFLIGHT_BLOCKED_MISSING_CREDENTIALS: Failed to initialize Sepolia network: ${err.message}`);
    }
    throw err;
  }
  const { ethers } = connection;
  const signers = await ethers.getSigners();

  if (!signers || signers.length === 0) {
    throw new Error(`No signers available on network: ${networkName}`);
  }

  const deployer = options.deployerSigner ?? signers[0];
  const provider = ethers.provider;
  const chainData = await provider.getNetwork();
  const chainId = Number(chainData.chainId);

  console.log(`Connected to Network: ${networkName} (Chain ID: ${chainId})`);
  console.log(`Deployer Address:    ${deployer.address}`);

  // Sepolia Preflight Validation (Chain ID, Balance, Gas)
  if (networkName === "sepolia") {
    if (chainId !== 11155111) {
      throw new Error(`CHAIN_ID_MISMATCH: Target is sepolia but RPC returned chainId ${chainId} (expected 11155111).`);
    }
    const balance = await provider.getBalance(deployer.address);
    console.log(`Deployer ETH Balance: ${ethers.formatEther(balance)} ETH`);
    if (balance === 0n) {
      console.error(`\n[PREFLIGHT BLOCKED] Deployer ${deployer.address} has 0 Sepolia ETH.`);
      console.error(`Please fund this address with test ETH from a Sepolia faucet before proceeding.`);
      throw new Error(`INSUFFICIENT_SEPOLIA_ETH: Deployer ${deployer.address} balance is 0.`);
    }
  }

  // Determine Bank Admin & Fee Receiver addresses
  const bankAdminSigner = options.bankAdminSigner ?? (signers.length > 1 ? signers[1] : deployer);
  const bankAdminAddress = process.env.BANK_ADMIN_ADDRESS ?? bankAdminSigner.address;
  const feeReceiverAddress = process.env.FEE_RECEIVER_ADDRESS ?? (signers.length > 2 ? signers[2].address : deployer.address);

  console.log(`Bank Admin Address:  ${bankAdminAddress}`);
  console.log(`Fee Receiver Address: ${feeReceiverAddress}`);

  // Load existing manifest for checkpoint resumption (unless forced redeploy or chainId mismatch)
  const isForceRedeploy = Boolean(options.forceRedeploy || process.argv.includes("--force") || process.env.FORCE_REDEPLOY === "true");
  const previousManifest = await readManifest(networkName);
  const canResume = !isForceRedeploy && previousManifest && previousManifest.chainId === chainId;
  const manifest: DeploymentManifest = canResume
    ? previousManifest
    : {
        network: networkName,
        chainId,
        deployedAt: new Date().toISOString(),
        deployer: deployer.address,
        bankAdmin: bankAdminAddress,
        feeReceiver: feeReceiverAddress,
        contracts: {} as any,
        binding: { verified: false },
      };

  // If force-redeploying, retain existing MockUSDC if it has bytecode to conserve gas
  if (isForceRedeploy && previousManifest?.contracts?.MockUSDC) {
    manifest.contracts.MockUSDC = previousManifest.contracts.MockUSDC;
    console.log(`[FORCE_REDEPLOY] Preserving existing MockUSDC (${previousManifest.contracts.MockUSDC.address}) to conserve gas.`);
  }

  manifest.chainId = chainId;
  manifest.deployer = deployer.address;
  manifest.bankAdmin = bankAdminAddress;
  manifest.feeReceiver = feeReceiverAddress;


  // ============================================================================
  // Phase A: Deploy MockUSDC
  // ============================================================================
  const mockUSDCFactory = await ethers.getContractFactory("MockUSDC", deployer);
  let mockUSDC: any;
  let mockUSDCAddress: string;
  let mockUSDCDepTxHash = "";
  let mockUSDCDepBlock: number | undefined;

  const existingMockUSDCAddr = manifest.contracts?.MockUSDC?.address;
  let reuseMockUSDC = false;
  if (existingMockUSDCAddr) {
    const code = await provider.getCode(existingMockUSDCAddr);
    if (code && code !== "0x") {
      reuseMockUSDC = true;
    }
  }

  if (reuseMockUSDC && existingMockUSDCAddr) {
    mockUSDCAddress = existingMockUSDCAddr;
    mockUSDC = mockUSDCFactory.attach(mockUSDCAddress);
    mockUSDCDepTxHash = manifest.contracts.MockUSDC.deploymentTxHash ?? "";
    mockUSDCDepBlock = manifest.contracts.MockUSDC.blockNumber;
    console.log(`\n--- [Phase A] MockUSDC already deployed: ${mockUSDCAddress} (resuming from checkpoint) ---`);
  } else {
    console.log(`\n--- [Phase A] Deploying MockUSDC ---`);
    mockUSDC = await mockUSDCFactory.deploy();
    await mockUSDC.waitForDeployment();
    mockUSDCAddress = await mockUSDC.getAddress();
    const mockUSDCDepTx = mockUSDC.deploymentTransaction();
    const mockUSDCDepReceipt = await mockUSDCDepTx?.wait();
    mockUSDCDepTxHash = mockUSDCDepTx?.hash ?? "";
    mockUSDCDepBlock = mockUSDCDepReceipt?.blockNumber ? Number(mockUSDCDepReceipt.blockNumber) : undefined;
    console.log(`MockUSDC Deployed: ${mockUSDCAddress}`);
    console.log(`  Tx Hash: ${mockUSDCDepTxHash}`);
    console.log(`  Block:   ${mockUSDCDepBlock}`);
  }

  // Verification of MockUSDC with retryCall
  const decimals = await retryCall(() => mockUSDC.decimals(), "MockUSDC.decimals()");
  assert.equal(decimals, 6n, "MockUSDC decimals must be 6");
  const tokenCode = await provider.getCode(mockUSDCAddress);
  assert.ok(tokenCode && tokenCode !== "0x", "MockUSDC bytecode must exist on-chain");

  manifest.contracts = manifest.contracts || ({} as any);
  manifest.contracts.MockUSDC = {
    address: mockUSDCAddress,
    deploymentTxHash: mockUSDCDepTxHash,
    blockNumber: mockUSDCDepBlock,
  };
  await saveManifest(manifest);

  // ============================================================================
  // Phase B: Deploy VaultManager
  // ============================================================================
  const vaultFactory = await ethers.getContractFactory("VaultManager", deployer);
  let vaultManager: any;
  let vaultAddress: string;
  let vaultDepTxHash = "";
  let vaultDepBlock: number | undefined;

  const existingVaultAddr = manifest.contracts?.VaultManager?.address;
  let reuseVault = false;
  if (existingVaultAddr) {
    const code = await provider.getCode(existingVaultAddr);
    if (code && code !== "0x") {
      reuseVault = true;
    }
  }

  if (reuseVault && existingVaultAddr) {
    vaultAddress = existingVaultAddr;
    vaultManager = vaultFactory.attach(vaultAddress);
    vaultDepTxHash = manifest.contracts.VaultManager.deploymentTxHash ?? "";
    vaultDepBlock = manifest.contracts.VaultManager.blockNumber;
    console.log(`\n--- [Phase B] VaultManager already deployed: ${vaultAddress} (resuming from checkpoint) ---`);
  } else {
    console.log(`\n--- [Phase B] Deploying VaultManager ---`);
    vaultManager = await vaultFactory.deploy(mockUSDCAddress, bankAdminAddress, feeReceiverAddress);
    await vaultManager.waitForDeployment();
    vaultAddress = await vaultManager.getAddress();
    const vaultDepTx = vaultManager.deploymentTransaction();
    const vaultDepReceipt = await vaultDepTx?.wait();
    vaultDepTxHash = vaultDepTx?.hash ?? "";
    vaultDepBlock = vaultDepReceipt?.blockNumber ? Number(vaultDepReceipt.blockNumber) : undefined;
    console.log(`VaultManager Deployed: ${vaultAddress}`);
    console.log(`  Tx Hash: ${vaultDepTxHash}`);
    console.log(`  Block:   ${vaultDepBlock}`);
  }

  // Verification of VaultManager with retryCall
  const vaultToken = await retryCall<string>(() => vaultManager.token(), "VaultManager.token()");
  const vaultOwner = await retryCall<string>(() => vaultManager.owner(), "VaultManager.owner()");
  const vaultFeeReceiver = await retryCall<string>(() => vaultManager.feeReceiver(), "VaultManager.feeReceiver()");
  assert.equal(vaultToken.toLowerCase(), mockUSDCAddress.toLowerCase(), "Vault token must match MockUSDC address");
  assert.equal(vaultOwner.toLowerCase(), bankAdminAddress.toLowerCase(), "Vault owner must match Bank Admin");
  assert.equal(vaultFeeReceiver.toLowerCase(), feeReceiverAddress.toLowerCase(), "Vault fee receiver must match configured address");

  manifest.contracts.VaultManager = {
    address: vaultAddress,
    deploymentTxHash: vaultDepTxHash,
    blockNumber: vaultDepBlock,
  };
  await saveManifest(manifest);

  // ============================================================================
  // Phase C: Deploy SavingCore
  // ============================================================================
  const gracePeriodSeconds = BigInt(personalVariant.gracePeriodDays * 86400); // 172800n
  const coreFactory = await ethers.getContractFactory("SavingCore", deployer);
  let savingCore: any;
  let coreAddress: string;
  let coreDepTxHash = "";
  let coreDepBlock: number | undefined;

  const existingCoreAddr = manifest.contracts?.SavingCore?.address;
  let reuseCore = false;
  if (existingCoreAddr) {
    const code = await provider.getCode(existingCoreAddr);
    if (code && code !== "0x") {
      reuseCore = true;
    }
  }

  if (reuseCore && existingCoreAddr) {
    coreAddress = existingCoreAddr;
    savingCore = coreFactory.attach(coreAddress);
    try {
      await savingCore.planDurationSeconds(0);
    } catch {
      throw new Error("LEGACY_CORE_REQUIRES_REDEPLOY: Existing SavingCore predates immutable deposit terms and short plans. Use FORCE_REDEPLOY=true to deploy a new VaultManager and SavingCore; existing deposits remain on the old contracts.");
    }
    coreDepTxHash = manifest.contracts.SavingCore.deploymentTxHash ?? "";
    coreDepBlock = manifest.contracts.SavingCore.blockNumber;
    console.log(`\n--- [Phase C] SavingCore already deployed: ${coreAddress} (resuming from checkpoint) ---`);
  } else {
    console.log(`\n--- [Phase C] Deploying SavingCore ---`);
    savingCore = await coreFactory.deploy(vaultAddress, gracePeriodSeconds);
    await savingCore.waitForDeployment();
    coreAddress = await savingCore.getAddress();
    const coreDepTx = savingCore.deploymentTransaction();
    const coreDepReceipt = await coreDepTx?.wait();
    coreDepTxHash = coreDepTx?.hash ?? "";
    coreDepBlock = coreDepReceipt?.blockNumber ? Number(coreDepReceipt.blockNumber) : undefined;
    console.log(`SavingCore Deployed: ${coreAddress}`);
    console.log(`  Tx Hash: ${coreDepTxHash}`);
    console.log(`  Block:   ${coreDepBlock}`);
  }

  // Verification of SavingCore with retryCall
  const coreVault = await retryCall<string>(() => savingCore.vaultManager(), "SavingCore.vaultManager()");
  const coreToken = await retryCall<string>(() => savingCore.token(), "SavingCore.token()");
  const coreGrace = await retryCall(() => savingCore.gracePeriodSeconds(), "SavingCore.gracePeriodSeconds()");
  assert.equal(coreVault.toLowerCase(), vaultAddress.toLowerCase(), "Core vaultManager must match VaultManager");
  assert.equal(coreToken.toLowerCase(), mockUSDCAddress.toLowerCase(), "Core token must match MockUSDC");
  assert.equal(coreGrace, gracePeriodSeconds, "Core gracePeriodSeconds must match Personal Variant (172800s)");

  manifest.contracts.SavingCore = {
    address: coreAddress,
    deploymentTxHash: coreDepTxHash,
    blockNumber: coreDepBlock,
  };
  await saveManifest(manifest);

  // ============================================================================
  // Phase D: Write-once Binding (VaultManager.setSavingCore)
  // ============================================================================
  console.log(`\n--- [Phase D] Authorizing Core Binding on VaultManager ---`);
  let bindTxHash = manifest.binding?.txHash ?? "";
  const currentBoundCore = await retryCall<string>(() => vaultManager.savingCore(), "VaultManager.savingCore()");

  if (currentBoundCore.toLowerCase() === coreAddress.toLowerCase()) {
    console.log(`SavingCore already bound to VaultManager: ${currentBoundCore}`);
  } else {
    const bindTx = await vaultManager.connect(bankAdminSigner).setSavingCore(coreAddress);
    const bindReceipt = await bindTx.wait();
    bindTxHash = bindTx.hash;

    console.log(`SavingCore Bound to VaultManager:`);
    console.log(`  Tx Hash: ${bindTxHash}`);
    console.log(`  Block:   ${bindReceipt?.blockNumber}`);

    const boundCore = await retryCall<string>(() => vaultManager.savingCore(), "VaultManager.savingCore() after bind");
    assert.equal(boundCore.toLowerCase(), coreAddress.toLowerCase(), "VaultManager savingCore must be bound to SavingCore");
    console.log(`Binding Verified on-chain: vaultManager.savingCore() == ${boundCore}`);
  }

  manifest.binding = {
    txHash: bindTxHash,
    verified: true,
  };

  // Final Manifest & Frontend Export
  manifest.deployedAt = new Date().toISOString();
  await saveManifest(manifest);
  console.log(`\nManifest saved to: deployments/${networkName}.json`);

  await exportContracts(manifest);
  console.log(`ABI and address artifacts exported to: exports/contracts/`);

  console.log(`\n================================================================`);
  console.log(`  DEPLOYMENT SUCCESSFUL`);
  console.log(`  MockUSDC:     ${mockUSDCAddress}`);
  console.log(`  VaultManager: ${vaultAddress}`);
  console.log(`  SavingCore:   ${coreAddress}`);
  console.log(`================================================================\n`);

  return {
    manifest,
    contracts: {
      mockUSDC,
      vaultManager,
      savingCore,
    },
  };
}

// Auto-run if executed directly via CLI or hardhat run
if (process.argv.some((arg) => arg.includes("deploy.ts") || arg.endsWith("deploy"))) {
  deployContracts()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("\nDeployment failed:", error.message || error);
      process.exit(1);
    });
}
