/**
 * Error decoding and human-readable formatting for Web3 & Solidity contract reverts.
 */

export function parseTransactionError(error: any): string {
  if (!error) return "An unknown error occurred.";

  const message = error.message || error.toString();
  const lowerMsg = message.toLowerCase();

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
  if (lowerMsg.includes("depositamountoutofrange")) {
    return "Deposit principal is outside the allowed minimum and maximum deposit limits for this plan.";
  }
  if (lowerMsg.includes("plandisabled")) {
    return "This saving plan is currently disabled by Bank Admin and cannot accept new deposits.";
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
  if (lowerMsg.includes("erc20insufficientallowance") || lowerMsg.includes("insufficient allowance")) {
    return "Insufficient MockUSDC allowance. Please approve MockUSDC before depositing.";
  }
  if (lowerMsg.includes("erc20insufficientbalance") || lowerMsg.includes("transfer amount exceeds balance")) {
    return "Insufficient MockUSDC balance in your wallet.";
  }

  // Clean fallback
  if (error.reason) return error.reason;
  if (error.shortMessage) return error.shortMessage;

  return message.length > 120 ? `${message.slice(0, 120)}...` : message;
}
