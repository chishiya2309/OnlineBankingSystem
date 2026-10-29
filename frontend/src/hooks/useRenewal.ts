import { useState, useCallback } from "react";
import { ethers } from "ethers";
import type {
  RenewalFlowStatus,
  ConfirmedRenewalResult,
  DepositRecord,
  SavingPlan,
} from "../types";
import { parseTransactionError } from "../lib/errors";
import { formatUSDC } from "../lib/format";

export interface UseRenewalState {
  status: RenewalFlowStatus;
  statusMessage: string;
  error: string | null;
  confirmedRenewal: ConfirmedRenewalResult | null;
  renewDeposit: (deposit: DepositRecord, targetPlan: SavingPlan) => Promise<boolean>;
  autoRenewDeposit: (deposit: DepositRecord) => Promise<boolean>;
  resetFlow: () => void;
}

export function useRenewal(
  savingCore: ethers.Contract | null,
  account: string | null,
  onSuccess?: () => void
): UseRenewalState {
  const [status, setStatus] = useState<RenewalFlowStatus>("idle");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [confirmedRenewal, setConfirmedRenewal] = useState<ConfirmedRenewalResult | null>(null);

  const resetFlow = useCallback(() => {
    setStatus("idle");
    setStatusMessage("");
    setError(null);
    setConfirmedRenewal(null);
  }, []);

  const renewDeposit = useCallback(
    async (deposit: DepositRecord, targetPlan: SavingPlan): Promise<boolean> => {
      if (!savingCore || !account) {
        setError("Wallet is not connected.");
        return false;
      }

      setError(null);
      setConfirmedRenewal(null);
      setStatus("validating");
      setStatusMessage("Validating manual renewal preflight conditions...");

      try {
        const currentOwner = await savingCore.ownerOf(deposit.depositId);
        if (currentOwner.toLowerCase() !== account.toLowerCase()) {
          throw new Error("Action rejected: Only the current owner of this deposit NFT certificate can perform manual renewal.");
        }

        if (!targetPlan.enabled) {
          throw new Error("The target saving plan is disabled by Bank Admin.");
        }

        const compoundedPrincipal = deposit.principal + deposit.accruedInterest;
        if (targetPlan.minDeposit > 0n && compoundedPrincipal < targetPlan.minDeposit) {
          throw new Error(
            `Compounded principal (${formatUSDC(compoundedPrincipal)} MockUSDC) is below target plan minimum (${targetPlan.minDepositFormatted} MockUSDC).`
          );
        }
        if (targetPlan.maxDeposit > 0n && compoundedPrincipal > targetPlan.maxDeposit) {
          throw new Error(
            `Compounded principal (${formatUSDC(compoundedPrincipal)} MockUSDC) exceeds target plan maximum (${targetPlan.maxDepositFormatted} MockUSDC).`
          );
        }

        setStatus("awaiting-signature");
        setStatusMessage("Please confirm the renewal transaction in MetaMask (no MockUSDC approval needed)...");

        const tx = await savingCore.renewDeposit(deposit.depositId, targetPlan.planId);

        setStatus("pending");
        setStatusMessage(`Renewal transaction submitted (${tx.hash.slice(0, 10)}...). Compounding interest and issuing new certificate...`);

        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error("Transaction execution failed or reverted on-chain.");
        }

        let newDepositId = 0;
        let newPrincipal = compoundedPrincipal;

        for (const log of receipt.logs) {
          try {
            const parsed = savingCore.interface.parseLog(log);
            if (parsed && parsed.name === "Renewed") {
              newDepositId = Number(parsed.args.newDepositId);
              newPrincipal = BigInt(parsed.args.newPrincipal);
            }
          } catch {
            // Non-SavingCore event
          }
        }

        setConfirmedRenewal({
          txHash: receipt.hash,
          oldDepositId: deposit.depositId,
          newDepositId,
          newPrincipal: formatUSDC(newPrincipal, deposit.tenorSeconds < 86400 ? 6 : 2),
          newPlanId: targetPlan.planId,
          isAuto: false,
          owner: account,
          blockNumber: receipt.blockNumber,
        });

        setStatus("success");
        setStatusMessage(`Successfully renewed into Certificate #${newDepositId}! Interest has been compounded.`);

        if (onSuccess) {
          onSuccess();
        }

        return true;
      } catch (err: any) {
        console.error("Manual renewal failed:", err);
        const readable = parseTransactionError(err);
        setError(readable);
        setStatus("error");
        setStatusMessage(readable);
        return false;
      }
    },
    [savingCore, account, onSuccess]
  );

  const autoRenewDeposit = useCallback(
    async (deposit: DepositRecord): Promise<boolean> => {
      if (!savingCore || !account) {
        setError("Wallet is not connected.");
        return false;
      }

      setError(null);
      setConfirmedRenewal(null);
      setStatus("validating");
      setStatusMessage("Validating auto-renewal eligibility...");

      try {
        setStatus("awaiting-signature");
        setStatusMessage("Please confirm auto-renewal trigger transaction in MetaMask...");

        const tx = await savingCore.autoRenewDeposit(deposit.depositId);

        setStatus("pending");
        setStatusMessage(`Auto-renewal transaction submitted (${tx.hash.slice(0, 10)}...). Waiting for confirmation...`);

        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error("Transaction execution failed or reverted on-chain.");
        }

        let newDepositId = 0;
        let newPrincipal = deposit.principal + deposit.accruedInterest;

        for (const log of receipt.logs) {
          try {
            const parsed = savingCore.interface.parseLog(log);
            if (parsed && parsed.name === "Renewed") {
              newDepositId = Number(parsed.args.newDepositId);
              newPrincipal = BigInt(parsed.args.newPrincipal);
            }
          } catch {
            // Non-SavingCore event
          }
        }

        const newOwner = await savingCore.ownerOf(newDepositId);

        setConfirmedRenewal({
          txHash: receipt.hash,
          oldDepositId: deposit.depositId,
          newDepositId,
          newPrincipal: formatUSDC(newPrincipal, deposit.tenorSeconds < 86400 ? 6 : 2),
          newPlanId: deposit.planId,
          isAuto: true,
          owner: newOwner,
          blockNumber: receipt.blockNumber,
        });

        setStatus("success");
        setStatusMessage(`Auto-renewal complete! Fresh Certificate #${newDepositId} minted to ${newOwner.slice(0, 6)}...${newOwner.slice(-4)}.`);

        if (onSuccess) {
          onSuccess();
        }

        return true;
      } catch (err: any) {
        console.error("Auto renewal failed:", err);
        const readable = parseTransactionError(err);
        setError(readable);
        setStatus("error");
        setStatusMessage(readable);
        return false;
      }
    },
    [savingCore, account, onSuccess]
  );

  return {
    status,
    statusMessage,
    error,
    confirmedRenewal,
    renewDeposit,
    autoRenewDeposit,
    resetFlow,
  };
}
