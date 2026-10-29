import { network } from "hardhat";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { readManifest } from "./helpers/deployment-manifest.js";

async function main() {
  console.log("=== EXECUTING ON-CHAIN E2E DEPOSIT FLOW ON LOCALHOST (CHAIN 31337) ===");
  const connection = await network.create("localhost");
  const signers = await connection.ethers.getSigners();
  const manifest = await readManifest("localhost");
  if (!manifest) throw new Error("Manifest localhost not found");

  const depositor = signers[2]; // Account #2: 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
  const mockUSDCAddr = manifest.contracts.MockUSDC.address;
  const coreAddr = manifest.contracts.SavingCore.address;

  const mockUSDCAbi = [
    "function balanceOf(address account) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function mint(address to, uint256 amount) returns (bool)",
  ];

  const coreAbi = [
    "function planCount() view returns (uint256)",
    "function getPlan(uint256 planId) view returns (tuple(uint32 tenorDays, uint16 aprBps, uint256 minDeposit, uint256 maxDeposit, uint16 earlyWithdrawPenaltyBps, bool enabled))",
    "function openDeposit(uint256 planId, uint256 amount) returns (uint256)",
    "function depositCount() view returns (uint256)",
    "function getDeposit(uint256 depositId) view returns (tuple(uint256 planId, uint256 principal, uint256 startAt, uint256 maturityAt, uint16 aprBpsAtOpen, uint16 penaltyBpsAtOpen, uint8 status))",
    "function ownerOf(uint256 tokenId) view returns (address)",
    "event DepositOpened(uint256 indexed depositId, address indexed owner, uint256 indexed planId, uint256 principal, uint256 maturityAt, uint256 aprBpsAtOpen)",
  ];

  const mockUSDC = await connection.ethers.getContractAt("MockUSDC", mockUSDCAddr, depositor);
  const core = await connection.ethers.getContractAt("SavingCore", coreAddr, depositor);

  const initialBalance: bigint = BigInt(await mockUSDC.balanceOf(depositor.address));
  console.log(`Depositor Address:    ${depositor.address}`);
  console.log(`Initial USDC Balance: ${ethers.formatUnits(initialBalance, 6)} USDC`);

  // Step 1: Read Plan #1
  const plan1 = await core.getPlan(1);
  console.log(`Selected Plan #1: Tenor ${plan1.tenorDays}d, APR ${plan1.aprBps} bps, Enabled: ${plan1.enabled}`);

  // Step 2: Check Initial Allowance
  const initialAllowance: bigint = BigInt(await mockUSDC.allowance(depositor.address, coreAddr));
  console.log(`Initial Allowance to SavingCore: ${ethers.formatUnits(initialAllowance, 6)} USDC`);

  // Step 3: Approve 500 USDC
  const depositAmount = ethers.parseUnits("500", 6); // 500.00 USDC
  console.log(`Approving ${ethers.formatUnits(depositAmount, 6)} MockUSDC to SavingCore (${coreAddr})...`);
  const approveTx = await mockUSDC.approve(coreAddr, depositAmount);
  console.log(`Approval Tx Submitted: ${approveTx.hash}`);
  const approveReceipt = await approveTx.wait();
  assert(approveReceipt, "Approval receipt must be mined");
  console.log(`Approval Confirmed in Block: ${approveReceipt.blockNumber}, Status: ${approveReceipt.status}`);

  const postApproveAllowance: bigint = BigInt(await mockUSDC.allowance(depositor.address, coreAddr));
  console.log(`Allowance After Approval: ${ethers.formatUnits(postApproveAllowance, 6)} USDC`);

  // Step 4: Open Deposit
  console.log(`Opening Deposit for Plan #1 with ${ethers.formatUnits(depositAmount, 6)} USDC...`);
  const openTx = await core.openDeposit(1, depositAmount);
  console.log(`OpenDeposit Tx Submitted: ${openTx.hash}`);
  const openReceipt = await openTx.wait();
  assert(openReceipt, "Deposit receipt must be mined");
  console.log(`OpenDeposit Confirmed in Block: ${openReceipt.blockNumber}, Status: ${openReceipt.status}`);

  // Step 5: Parse DepositOpened Event
  let newDepositId = 0;
  for (const log of openReceipt.logs) {
    try {
      const parsed = core.interface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (parsed && parsed.name === "DepositOpened") {
        newDepositId = Number(parsed.args.depositId);
        console.log(`Parsed DepositOpened Event:`);
        console.log(`  Deposit ID:   ${newDepositId}`);
        console.log(`  Owner:        ${parsed.args.owner}`);
        console.log(`  Principal:    ${ethers.formatUnits(parsed.args.principal, 6)} USDC`);
        console.log(`  Maturity At:  ${parsed.args.maturityAt} (${new Date(Number(parsed.args.maturityAt) * 1000).toISOString()})`);
        console.log(`  APR at Open:  ${parsed.args.aprBpsAtOpen} bps`);
        break;
      }
    } catch {}
  }

  // Step 6: Query on-chain Deposit Record & NFT Certificate Owner
  const onChainDeposit = await core.getDeposit(newDepositId);
  const onChainOwner = await core.ownerOf(newDepositId);
  const finalBalance: bigint = BigInt(await mockUSDC.balanceOf(depositor.address));
  const finalAllowance: bigint = BigInt(await mockUSDC.allowance(depositor.address, coreAddr));

  console.log("\n=== ON-CHAIN EVIDENCE RECORD ===");
  console.log(`Deposit ID:         ${newDepositId}`);
  console.log(`NFT Owner:          ${onChainOwner} (Matches depositor: ${onChainOwner.toLowerCase() === depositor.address.toLowerCase()})`);
  console.log(`Deposit Status:     ${Number(onChainDeposit.status) === 0 ? "Active (0)" : onChainDeposit.status}`);
  console.log(`Remaining Balance:  ${ethers.formatUnits(finalBalance, 6)} USDC`);
  console.log(`Remaining Allow:    ${ethers.formatUnits(finalAllowance, 6)} USDC`);
  console.log(`Approve Tx Hash:    ${approveTx.hash}`);
  console.log(`Open Tx Hash:       ${openTx.hash}`);
  console.log("================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
