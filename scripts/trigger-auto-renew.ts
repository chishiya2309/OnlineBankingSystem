import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { Signer } from "ethers";
import { network } from "hardhat";
import { personalVariant } from "../config/personal-variant.js";

export interface AutoRenewTriggerOptions {
  connection?: any;
  coreAddress?: string;
  depositId?: bigint | number;
  signer?: Signer;
  skipEligibilityError?: boolean;
}

export interface AutoRenewTriggerResult {
  success: boolean;
  txHash: string;
  blockNumber: number;
  oldDepositId: bigint;
  newDepositId: bigint;
  oldPrincipal: bigint;
  oldInterest: bigint;
  newPrincipal: bigint;
  oldStatus: number;
  newStatus: number;
  originalOwner: string;
  newOwner: string;
  aprBps: number;
  penaltyBps: number;
  tenorSeconds: bigint;
  newMaturityAt: bigint;
}

export async function triggerAutoRenew(
  options: AutoRenewTriggerOptions = {}
): Promise<AutoRenewTriggerResult> {
  // If no address or deposit ID is provided, run the reproducible local demonstration fixture
  let coreAddress = options.coreAddress ?? process.env.SAVING_CORE_ADDRESS;
  let depositIdVal = options.depositId ?? (process.env.DEPOSIT_ID ? BigInt(process.env.DEPOSIT_ID) : undefined);

  if (!coreAddress || depositIdVal === undefined) {
    console.log("No SAVING_CORE_ADDRESS / DEPOSIT_ID provided. Running reproducible local demonstration fixture...");
    return await runLocalDemoFixture();
  }

  const connection = options.connection ?? (await network.create("hardhatMainnet"));
  const { ethers } = connection;
  const signers = await ethers.getSigners();
  const caller = options.signer ?? signers[5] ?? signers[0]; // stranger or default caller

  const depositId = BigInt(depositIdVal);
  if (depositId <= 0n) {
    throw new Error(`Invalid deposit ID: ${depositId}. Deposit ID must be positive.`);
  }

  if (!ethers.isAddress(coreAddress)) {
    throw new Error(`Invalid SavingCore address: ${coreAddress}`);
  }

  const core = await ethers.getContractAt("SavingCore", coreAddress, caller);
  const vaultAddress = await core.vaultManager();
  const vault = await ethers.getContractAt("VaultManager", vaultAddress, caller);
  const tokenAddress = await core.token();
  const token = await ethers.getContractAt("MockUSDC", tokenAddress, caller);

  const callerAddress = await caller.getAddress();

  console.log("=================================================");
  console.log("           AUTO RENEW TRIGGER SCRIPT             ");
  console.log("=================================================");
  console.log(`Network:             hardhatMainnet`);
  console.log(`Caller (Sender):     ${callerAddress}`);
  console.log(`SavingCore:          ${coreAddress}`);
  console.log(`VaultManager:        ${vaultAddress}`);
  console.log(`Deposit ID:          ${depositId}`);

  // Preflight check 1: Deposit existence
  const depositCount = await core.depositCount();
  if (depositId > depositCount) {
    throw new Error(`Deposit #${depositId} not found. Total deposits: ${depositCount}`);
  }

  const deposit = await core.getDeposit(depositId);
  console.log(`Old Deposit Status:  ${deposit.status} (0=Active, 1=Withdrawn, 2=ManualRenewed, 3=AutoRenewed)`);

  if (deposit.status !== 0n) {
    throw new Error(`Deposit #${depositId} is not Active (status=${deposit.status}). Cannot auto-renew.`);
  }

  const currentOwner = await core.ownerOf(depositId);
  const gracePeriodSeconds = await core.gracePeriodSeconds();
  const graceEnd = deposit.maturityAt + gracePeriodSeconds;

  const latestBlock = await ethers.provider.getBlock("latest");
  const currentBlockTime = BigInt(latestBlock?.timestamp ?? 0);

  console.log(`Current NFT Owner:   ${currentOwner}`);
  console.log(`Deposit StartAt:     ${deposit.startAt}`);
  console.log(`Deposit MaturityAt:  ${deposit.maturityAt}`);
  console.log(`Grace End:           ${graceEnd}`);
  console.log(`Current Block Time:  ${currentBlockTime}`);

  // Preflight check 2: Grace period timing
  if (currentBlockTime < graceEnd) {
    const diff = graceEnd - currentBlockTime;
    throw new Error(`Deposit #${depositId} grace period has not ended. Remaining: ${diff} seconds.`);
  }

  // Preflight check 3: Vault binding & pause
  const boundCore = await vault.savingCore();
  if (boundCore.toLowerCase() !== coreAddress.toLowerCase()) {
    throw new Error(`Core not bound in VaultManager. Vault has: ${boundCore}, expected: ${coreAddress}`);
  }

  if (await vault.paused()) {
    throw new Error("VaultManager is paused. Cannot auto-renew.");
  }

  // Preflight check 4: Interest and liquidity
  const oldInterest = await core.calculateInterest(depositId);
  const vaultBalance = await token.balanceOf(vaultAddress);
  console.log(`Old Principal:       ${deposit.principal} units`);
  console.log(`Accrued Interest:    ${oldInterest} units`);
  console.log(`Vault Liquidity:     ${vaultBalance} units`);

  if (oldInterest > 0n && vaultBalance < oldInterest) {
    throw new Error(
      `Insufficient Vault liquidity: required ${oldInterest} units, available ${vaultBalance} units.`
    );
  }

  console.log("Preflight Status:    ELIGIBLE. Submitting transaction...");

  const tx = await core.connect(caller).autoRenewDeposit(depositId);
  const receipt = await tx.wait();
  assert.ok(receipt, "Transaction receipt must exist");
  assert.equal(receipt.status, 1, "Transaction must succeed");

  // Parse events
  let newDepositId = 0n;
  let newPrincipal = 0n;

  for (const log of receipt.logs) {
    try {
      const parsed = core.interface.parseLog(log);
      if (parsed?.name === "Renewed") {
        newDepositId = BigInt(parsed.args.newDepositId);
        newPrincipal = BigInt(parsed.args.newPrincipal);
      }
    } catch {
      // not a SavingCore event
    }
  }

  assert.ok(newDepositId > 0n, "Renewed event must provide newDepositId");

  const oldPost = await core.getDeposit(depositId);
  const newPost = await core.getDeposit(newDepositId);
  const newOwner = await core.ownerOf(newDepositId);

  const oldTenor = BigInt(deposit.maturityAt) - BigInt(deposit.startAt);

  console.log("=================================================");
  console.log("           AUTO RENEWAL EXECUTION RECEIPT        ");
  console.log("=================================================");
  console.log(`Transaction Hash:    ${tx.hash}`);
  console.log(`Block Number:        ${receipt.blockNumber}`);
  console.log(`Old Deposit ID:      #${depositId} -> Status: ${oldPost.status} (AutoRenewed)`);
  console.log(`New Deposit ID:      #${newDepositId} -> Status: ${newPost.status} (Active)`);
  console.log(`Original Owner:      ${currentOwner}`);
  console.log(`New NFT Recipient:   ${newOwner}`);
  console.log(`Caller Received:     0 tokens, 0 NFTs`);
  console.log(`Old Principal:       ${deposit.principal} units`);
  console.log(`Capitalized Interest:${oldInterest} units`);
  console.log(`New Principal:       ${newPost.principal} units`);
  console.log(`Locked APR:          ${newPost.aprBpsAtOpen} bps`);
  console.log(`Locked Penalty:      ${newPost.penaltyBpsAtOpen} bps`);
  console.log(`Locked Tenor:        ${oldTenor} seconds`);
  console.log(`New StartAt:         ${newPost.startAt} (Mined block timestamp)`);
  console.log(`New MaturityAt:      ${newPost.maturityAt}`);
  console.log("Status:              SUCCESS - AUTO RENEW COMPLETED");
  console.log("=================================================");

  return {
    success: true,
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    oldDepositId: depositId,
    newDepositId,
    oldPrincipal: deposit.principal,
    oldInterest,
    newPrincipal: newPost.principal,
    oldStatus: Number(oldPost.status),
    newStatus: Number(newPost.status),
    originalOwner: currentOwner,
    newOwner,
    aprBps: Number(newPost.aprBpsAtOpen),
    penaltyBps: Number(newPost.penaltyBpsAtOpen),
    tenorSeconds: oldTenor,
    newMaturityAt: BigInt(newPost.maturityAt),
  };
}

export async function runLocalDemoFixture(): Promise<AutoRenewTriggerResult> {
  const connection = await network.create("hardhatMainnet");
  const { ethers, networkHelpers } = connection;
  const [operator, bankAdmin, alice, bob, feeReceiver, stranger] = await ethers.getSigners();

  const toUnits = (amount: string): bigint => ethers.parseUnits(amount, 6);
  const GRACE_PERIOD_SECONDS = BigInt(personalVariant.gracePeriodDays * 86400); // 172800n
  const DEFAULT_TENOR_DAYS = BigInt(personalVariant.defaultTenorDays); // 180n
  const DEFAULT_APR_BPS = BigInt(personalVariant.defaultAprBps); // 200n
  const DEFAULT_PENALTY_BPS = BigInt(personalVariant.earlyWithdrawPenaltyBps); // 350n

  console.log("[DEMO FIXTURE] Deploying local contracts for demonstration...");
  const token = await ethers.deployContract("MockUSDC");
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();

  const vault = await ethers.deployContract("VaultManager", [tokenAddress, bankAdmin.address, feeReceiver.address]);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();

  const core = await ethers.deployContract("SavingCore", [vaultAddress, GRACE_PERIOD_SECONDS]);
  await core.waitForDeployment();
  const coreAddress = await core.getAddress();

  await (await vault.connect(bankAdmin).setSavingCore(coreAddress)).wait();

  await (await core.connect(bankAdmin).createPlan(
    DEFAULT_TENOR_DAYS,
    DEFAULT_APR_BPS,
    0n,
    0n,
    DEFAULT_PENALTY_BPS,
    true
  )).wait();

  // Fund user & Vault
  await (await token.mint(alice.address, toUnits("5000"))).wait();
  await (await token.mint(bankAdmin.address, toUnits("5000"))).wait();
  await (await token.connect(alice).approve(coreAddress, ethers.MaxUint256)).wait();
  await (await token.connect(bankAdmin).approve(vaultAddress, ethers.MaxUint256)).wait();
  await (await vault.connect(bankAdmin).fundVault(toUnits("1000"))).wait();

  // Alice opens deposit #1 (1000 USDC)
  const openTx = await core.connect(alice).openDeposit(1, toUnits("1000"));
  await openTx.wait();

  const deposit1 = await core.getDeposit(1);
  const graceEnd = deposit1.maturityAt + GRACE_PERIOD_SECONDS;

  console.log(`[DEMO FIXTURE] Deposit #1 created. Maturity: ${deposit1.maturityAt}, GraceEnd: ${graceEnd}`);

  // Advance time past graceEnd and mine a block at that timestamp
  await networkHelpers.time.increaseTo(graceEnd + 10n);

  console.log(`[DEMO FIXTURE] Advanced time past graceEnd to ${graceEnd + 10n}. Triggering script...`);

  // Run triggerAutoRenew using stranger as caller on the same connection
  return await triggerAutoRenew({
    connection,
    coreAddress,
    depositId: 1n,
    signer: stranger,
  });
}

// If invoked directly from CLI or hardhat run
if (process.argv.some((arg) => arg.includes("trigger-auto-renew"))) {
  try {
    await triggerAutoRenew();
  } catch (err) {
    console.error("Auto Renew Trigger execution failed:", err);
    process.exitCode = 1;
  }
}
