import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import type {
  SavingPlan,
  DepositFlowStatus,
  ConfirmedDepositResult,
} from "../types";
import { parseUSDC, formatUSDC, formatBps, formatTimestamp } from "../lib/format";
import { parseTransactionError } from "../lib/errors";

export interface DepositFlowState {
  balance: bigint;
  allowance: bigint;
  status: DepositFlowStatus;
  statusMessage: string;
  txHash: string | null;
  confirmedDeposit: ConfirmedDepositResult | null;
  error: string | null;
  isMinting: boolean;
  approve: (savingPlan: SavingPlan, amountStr: string) => Promise<boolean>;
  openDeposit: (savingPlan: SavingPlan, amountStr: string) => Promise<boolean>;
  mintDemoTokens: () => Promise<boolean>;
  resetFlow: () => void;
  refreshBalances: () => Promise<void>;
}

export function useDepositFlow(
  account: string | null,
  mockUSDC: ethers.Contract | null,
  savingCore: ethers.Contract | null,
  savingCoreAddress: string | null
): DepositFlowState {
  const [balance, setBalance] = useState<bigint>(0n);
  const [allowance, setAllowance] = useState<bigint>(0n);
  const [status, setStatus] = useState<DepositFlowStatus>("idle");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [confirmedDeposit, setConfirmedDeposit] = useState<ConfirmedDepositResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isMinting, setIsMinting] = useState<boolean>(false);

  const refreshBalances = useCallback(async () => {
    if (!account || !mockUSDC || !savingCoreAddress) {
      setBalance(0n);
      setAllowance(0n);
      return;
    }

    try {
      const [rawBal, rawAllow] = await Promise.all([
        mockUSDC.balanceOf(account),
        mockUSDC.allowance(account, savingCoreAddress),
      ]);
      setBalance(BigInt(rawBal));
      setAllowance(BigInt(rawAllow));
    } catch (err) {
      console.error("Error reading balance/allowance:", err);
    }
  }, [account, mockUSDC, savingCoreAddress]);

  useEffect(() => {
    refreshBalances();
  }, [refreshBalances]);

  const resetFlow = useCallback(() => {
    setStatus("idle");
    setStatusMessage("");
    setTxHash(null);
    setConfirmedDeposit(null);
    setError(null);
  }, []);

  const approve = useCallback(
    async (_plan: SavingPlan, amountStr: string): Promise<boolean> => {
      if (!account || !mockUSDC || !savingCoreAddress) {
        setError("Wallet or contract not connected.");
        return false;
      }

      try {
        setError(null);
        setStatus("validating");
        setStatusMessage("Validating allowance requirements...");

        const parsedAmount = parseUSDC(amountStr);
        if (parsedAmount <= 0n) {
          throw new Error("Amount must be greater than zero.");
        }

        if (balance < parsedAmount) {
          throw new Error(
            `Insufficient MockUSDC balance. You have ${formatUSDC(balance)} USDC but tried to approve ${formatUSDC(parsedAmount)} USDC.`
          );
        }

        setStatus("awaiting-approval-signature");
        setStatusMessage("Please sign the ERC20 approve transaction in MetaMask...");

        const tx = await mockUSDC.approve(savingCoreAddress, parsedAmount);
        setTxHash(tx.hash);
        setStatus("approval-pending");
        setStatusMessage(`Approval transaction submitted. Waiting for blockchain confirmation...`);

        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error("Approve transaction failed on-chain.");
        }

        await refreshBalances();
        setStatus("approval-confirmed");
        setStatusMessage("MockUSDC approval confirmed! You can now proceed to open your deposit.");
        return true;
      } catch (err: any) {
        console.error("Approval error:", err);
        setStatus("error");
        setError(parseTransactionError(err));
        return false;
      }
    },
    [account, mockUSDC, savingCoreAddress, balance, refreshBalances]
  );

  const openDeposit = useCallback(
    async (plan: SavingPlan, amountStr: string): Promise<boolean> => {
      if (!account || !savingCore || !mockUSDC) {
        setError("Wallet or SavingCore contract not connected.");
        return false;
      }

      try {
        setError(null);
        setStatus("validating");
        setStatusMessage("Validating deposit requirements...");

        if (!plan.enabled) {
          throw new Error("This plan is disabled and cannot accept new deposits.");
        }

        const parsedAmount = parseUSDC(amountStr);
        if (parsedAmount <= 0n) {
          throw new Error("Amount must be greater than zero.");
        }

        if (plan.minDeposit > 0n && parsedAmount < plan.minDeposit) {
          throw new Error(`Deposit amount is below minimum requirement of ${plan.minDepositFormatted}.`);
        }

        if (plan.maxDeposit > 0n && parsedAmount > plan.maxDeposit) {
          throw new Error(`Deposit amount exceeds maximum allowed limit of ${plan.maxDepositFormatted}.`);
        }

        if (balance < parsedAmount) {
          throw new Error(`Insufficient MockUSDC balance (${formatUSDC(balance)} USDC available).`);
        }

        // Recheck allowance directly
        const currentAllowance = await mockUSDC.allowance(account, savingCoreAddress);
        if (BigInt(currentAllowance) < parsedAmount) {
          setStatus("approval-required");
          setError("Additional MockUSDC approval is required before opening deposit.");
          return false;
        }

        setStatus("awaiting-open-signature");
        setStatusMessage("Please confirm the Open Deposit transaction in MetaMask...");

        const tx = await savingCore.openDeposit(plan.planId, parsedAmount);
        setTxHash(tx.hash);
        setStatus("open-pending");
        setStatusMessage(`Open deposit transaction submitted. Waiting for block confirmation...`);

        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error("Open deposit transaction failed on-chain.");
        }

        // Parse DepositOpened event from receipt
        let parsedDepositId = 0;
        let parsedMaturityAt = 0;
        let parsedAprBps = plan.aprBps;

        for (const log of receipt.logs) {
          try {
            const parsed = savingCore.interface.parseLog({
              topics: [...log.topics],
              data: log.data,
            });
            if (parsed && parsed.name === "DepositOpened") {
              parsedDepositId = Number(parsed.args.depositId ?? parsed.args[0]);
              parsedMaturityAt = Number(parsed.args.maturityAt ?? parsed.args[4]);
              parsedAprBps = Number(parsed.args.aprBpsAtOpen ?? parsed.args[5]);
              break;
            }
          } catch {
            // Log from another contract (e.g. ERC20 Transfer)
          }
        }

        if (parsedDepositId === 0) {
          const count = await savingCore.depositCount();
          parsedDepositId = Number(count);
        }

        // On-chain verification of ownership & deposit record
        const onChainOwner = await savingCore.ownerOf(parsedDepositId);
        const onChainDeposit = await savingCore.getDeposit(parsedDepositId);

        const result: ConfirmedDepositResult = {
          txHash: tx.hash,
          depositId: parsedDepositId,
          principal: formatUSDC(parsedAmount),
          maturityAt: parsedMaturityAt || Number(onChainDeposit.maturityAt),
          maturityFormatted: formatTimestamp(parsedMaturityAt || Number(onChainDeposit.maturityAt)),
          aprBps: parsedAprBps,
          aprFormatted: formatBps(parsedAprBps),
          nftOwner: onChainOwner,
          status: "Active",
          blockNumber: receipt.blockNumber,
        };

        setConfirmedDeposit(result);
        setStatus("success");
        setStatusMessage("Deposit opened successfully! Your ERC721 Deposit Certificate is active.");

        await refreshBalances();
        return true;
      } catch (err: any) {
        console.error("Open deposit error:", err);
        setStatus("error");
        setError(parseTransactionError(err));
        return false;
      }
    },
    [account, savingCore, mockUSDC, savingCoreAddress, balance, refreshBalances]
  );

  const mintDemoTokens = useCallback(async (): Promise<boolean> => {
    if (!account || !mockUSDC) {
      setError("Please connect your wallet first.");
      return false;
    }

    try {
      setIsMinting(true);
      setError(null);
      const mintAmount = ethers.parseUnits("1000", 6);
      const tx = await mockUSDC.mint(account, mintAmount);
      await tx.wait();
      await refreshBalances();
      return true;
    } catch (err: any) {
      console.error("Mint demo tokens error:", err);
      setError(parseTransactionError(err));
      return false;
    } finally {
      setIsMinting(false);
    }
  }, [account, mockUSDC, refreshBalances]);

  return {
    balance,
    allowance,
    status,
    statusMessage,
    txHash,
    confirmedDeposit,
    error,
    isMinting,
    approve,
    openDeposit,
    mintDemoTokens,
    resetFlow,
    refreshBalances,
  };
}
