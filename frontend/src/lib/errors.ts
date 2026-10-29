/**
 * Error decoding and human-readable formatting for Web3 & Solidity contract reverts.
 */
import { Interface } from "ethers";
import SavingCore from "../contracts/SavingCore.json";
import VaultManager from "../contracts/VaultManager.json";
import MockUSDC from "../contracts/MockUSDC.json";

const errorInterfaces = [SavingCore, VaultManager, MockUSDC].map(contract => new Interface(contract.abi));

function decodedErrorName(error: any): string {
  if (error.revert?.name) return String(error.revert.name);
  const candidates = [error.data, error.error?.data, error.info?.error?.data, error.cause?.data];
  for (const candidate of candidates) {
    const data = typeof candidate === "string" ? candidate : candidate?.data ?? candidate?.result;
    if (typeof data !== "string" || !/^0x[0-9a-f]+$/i.test(data)) continue;
    for (const contract of errorInterfaces) {
      try {
        const parsed = contract.parseError(data);
        if (parsed) return parsed.name;
      } catch { /* Error belongs to another contract ABI. */ }
    }
  }
  return "";
}

export function parseTransactionError(error: any): string {
  if (!error) return "An unknown error occurred.";

  const message = error.message || error.toString();
  const lowerMsg = `${message} ${decodedErrorName(error)}`.toLowerCase();

  // User rejection
  if (
    error.code === 4001 ||
    error.code === "ACTION_REJECTED" ||
    lowerMsg.includes("user rejected") ||
    lowerMsg.includes("user denied")
  ) {
    return "Transaction was cancelled in your wallet.";
  }

  // Network mismatch or RPC unavailable
  if (lowerMsg.includes("network error") || lowerMsg.includes("failed to fetch") || lowerMsg.includes("could not detect network")) {
    return "Unable to connect to blockchain RPC node. Please verify your local node is running (http://127.0.0.1:8545).";
  }

  // Insufficient ETH for gas
  if (lowerMsg.includes("insufficient funds") || lowerMsg.includes("gas required exceeds allowance")) {
    return "Insufficient native ETH balance to pay for transaction gas.";
  }

  // Specific SavingCore / VaultManager custom errors
  if (lowerMsg.includes("notdepositowner")) {
    return "Action rejected: Only the current owner of this deposit NFT certificate can perform this action.";
  }
  if (lowerMsg.includes("depositnotfound")) {
    return "Deposit record was not found on-chain.";
  }
  if (lowerMsg.includes("depositnotactive")) {
    return "This deposit is no longer active (it has already been withdrawn or renewed).";
  }
  if (lowerMsg.includes("depositnotmatured")) {
    return "Deposit has not reached maturity yet. Maturity withdrawal and manual renewal require t >= maturityAt.";
  }
  if (lowerMsg.includes("earlywithdrawalclosed")) {
    return "Early withdrawal is closed because the deposit has already reached or passed maturity.";
  }
  if (lowerMsg.includes("graceperiodnotended")) {
    return "Auto-renewal grace period has not ended yet. Auto-renewal is only available after the grace period expires.";
  }
  if (lowerMsg.includes("depositamountoutofrange")) {
    return "Deposit principal is outside the allowed minimum and maximum deposit limits for this plan.";
  }
  if (lowerMsg.includes("plandisabled")) {
    return "This saving plan is currently disabled by Bank Admin and cannot accept new deposits.";
  }
  if (lowerMsg.includes("plannotfound")) {
    return "The selected saving plan does not exist on-chain.";
  }
  if (lowerMsg.includes("amountzero")) {
    return "Deposit amount must be greater than zero.";
  }
  if (lowerMsg.includes("enforcedpause")) {
    return "The banking vault is currently paused by Bank Admin.";
  }
  if (lowerMsg.includes("corenotbound")) {
    return "Protocol integrity error: SavingCore is not bound to VaultManager.";
  }
  if (lowerMsg.includes("insufficientvaultbalance") || lowerMsg.includes("payinterest")) {
    return "Banking vault has insufficient liquidity reserves to disburse interest.";
  }
  if (lowerMsg.includes("erc20insufficientallowance") || lowerMsg.includes("insufficient allowance")) {
    return "Insufficient MockUSDC allowance. Please approve MockUSDC before depositing.";
  }
  if (lowerMsg.includes("erc20insufficientbalance") || lowerMsg.includes("transfer amount exceeds balance")) {
    return "Insufficient MockUSDC balance in your wallet.";
  }

  if (lowerMsg.includes("invalidtenorseconds") || lowerMsg.includes("invalidtenor")) {
    return "Plan duration must be a positive whole number of seconds within the supported maximum.";
  }

  // Admin custom errors
  if (lowerMsg.includes("notbankadmin") || lowerMsg.includes("onlybankadmin") || lowerMsg.includes("ownableunauthorizedaccount")) {
    return "Action rejected: Connected wallet is not the authorized Bank Admin.";
  }
  if (lowerMsg.includes("planpenaltytoohigh")) {
    return "Penalty rate cannot exceed 100% (10,000 basis points).";
  }
  if (lowerMsg.includes("plandurationzero")) {
    return "Plan duration must be at least 1 day.";
  }
  if (lowerMsg.includes("planaprzero")) {
    return "Plan APR must be greater than zero.";
  }
  if (lowerMsg.includes("invalidaddress")) {
    return "The provided address is invalid or the zero address.";
  }

  // Clean fallback
  if (error.reason) return error.reason;
  if (error.shortMessage) return error.shortMessage;

  return message.length > 120 ? `${message.slice(0, 120)}...` : message;
}

