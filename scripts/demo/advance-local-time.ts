import { network } from "hardhat";
import { readManifest } from "../helpers/deployment-manifest.js";

/**
 * Dev-only script to advance block timestamp on Hardhat Localhost (Chain ID 31337).
 * Strictly prohibited on public testnets (Sepolia) or mainnet.
 */
async function main() {
  const connection = await network.create("localhost");
  const { ethers } = connection;

  const netData = await ethers.provider.getNetwork();
  const chainId = Number(netData.chainId);

  if (chainId !== 31337) {
    throw new Error(
      `ABORT: advance-local-time is strictly restricted to local Hardhat node (Chain ID 31337). Detected Chain ID: ${chainId}`
    );
  }

  const args = process.argv.slice(2);
  let depositId: bigint | null = null;
  let mode: "maturity" | "grace" | "seconds" | "target" = "seconds";
  let amountSeconds = 0n;
  let targetTimestamp = 0n;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--deposit" && args[i + 1]) {
      depositId = BigInt(args[i + 1]);
      mode = "maturity";
      i++;
    } else if (args[i] === "--grace" && args[i + 1]) {
      depositId = BigInt(args[i + 1]);
      mode = "grace";
      i++;
    } else if (args[i] === "--seconds" && args[i + 1]) {
      amountSeconds = BigInt(args[i + 1]);
      mode = "seconds";
      i++;
    } else if (args[i] === "--target" && args[i + 1]) {
      targetTimestamp = BigInt(args[i + 1]);
      mode = "target";
      i++;
    }
  }

  const manifest = await readManifest("localhost");
  if (!manifest?.contracts?.SavingCore) {
    throw new Error("No deployment manifest found for localhost. Run deploy:localhost first.");
  }

  const coreAddress = manifest.contracts.SavingCore.address;
  const savingCore = await ethers.getContractAt("SavingCore", coreAddress);

  const blockBefore = await ethers.provider.getBlock("latest");
  const timeBefore = BigInt(blockBefore?.timestamp ?? 0);

  console.log("==================================================");
  console.log("       LOCAL TIME ADVANCEMENT UTILITY (DEV ONLY)  ");
  console.log("==================================================");
  console.log(`Network:             Hardhat Localhost (Chain ID ${chainId})`);
  console.log(`Current Block:       #${blockBefore?.number}`);
  console.log(`Current Block Time:  ${timeBefore} (${new Date(Number(timeBefore) * 1000).toISOString()})`);

  let destinationTime = timeBefore;

  if (mode === "maturity" || mode === "grace") {
    if (!depositId) {
      throw new Error(`Deposit ID required for mode: ${mode}. Use --deposit <id> or --grace <id>`);
    }

    const depositCount = await savingCore.depositCount();
    if (depositId > depositCount || depositId <= 0n) {
      throw new Error(`Deposit #${depositId} not found. Total deposits: ${depositCount}`);
    }

    const deposit = await savingCore.getDeposit(depositId);
    const maturityAt = BigInt(deposit.maturityAt);
    const gracePeriod = BigInt(await savingCore.gracePeriodSeconds());
    const graceEnd = maturityAt + gracePeriod;

    console.log(`Deposit #${depositId}:`);
    console.log(`  Principal:         ${deposit.principal} units`);
    console.log(`  StartAt:           ${deposit.startAt}`);
    console.log(`  MaturityAt:        ${maturityAt} (${new Date(Number(maturityAt) * 1000).toISOString()})`);
    console.log(`  GraceEnd:          ${graceEnd} (${new Date(Number(graceEnd) * 1000).toISOString()})`);

    if (mode === "maturity") {
      destinationTime = maturityAt + 1n; // At or slightly past maturity
      console.log(`Advancing to MATURITY boundary: target timestamp = ${destinationTime}`);
    } else {
      destinationTime = graceEnd + 1n; // At or slightly past grace end
      console.log(`Advancing to GRACE END boundary: target timestamp = ${destinationTime}`);
    }
  } else if (mode === "seconds") {
    if (amountSeconds <= 0n) {
      amountSeconds = 180n * 86400n; // Default: 180 days
    }
    destinationTime = timeBefore + amountSeconds;
    console.log(`Advancing by ${amountSeconds} seconds (${Number(amountSeconds) / 86400} days)...`);
  } else if (mode === "target") {
    destinationTime = targetTimestamp;
    console.log(`Advancing to explicit target timestamp ${destinationTime}...`);
  }

  if (destinationTime <= timeBefore) {
    console.warn(`Destination time (${destinationTime}) is already in the past compared to current block time (${timeBefore}). No-op.`);
    return;
  }

  // Advance time and mine block
  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(destinationTime)]);
  await ethers.provider.send("evm_mine", []);

  const blockAfter = await ethers.provider.getBlock("latest");
  const timeAfter = BigInt(blockAfter?.timestamp ?? 0);

  console.log("--------------------------------------------------");
  console.log(`New Block Number:    #${blockAfter?.number}`);
  console.log(`New Block Time:      ${timeAfter} (${new Date(Number(timeAfter) * 1000).toISOString()})`);
  console.log(`Delta Advanced:      +${timeAfter - timeBefore} seconds (+${(Number(timeAfter - timeBefore) / 86400).toFixed(2)} days)`);
  console.log("Status:              SUCCESS - BLOCK MINED AT DESTINATION TIME");
  console.log("==================================================");
}

main().catch((error) => {
  console.error("Failed to advance local time:", error);
  process.exit(1);
});
