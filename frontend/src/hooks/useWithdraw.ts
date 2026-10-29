import { useState, useCallback } from "react";
import { ethers } from "ethers";
import type {
  WithdrawFlowStatus,
  ConfirmedWithdrawResult,
  DepositRecord,
} from "../types";
import { parseTransactionError } from "../lib/errors";
import { formatUSDC } from "../lib/format";

export interface UseWithdrawState {
  status: WithdrawFlowStatus;
  statusMessage: string;
  error: string | null;
  confirmedWithdraw: ConfirmedWithdrawResult | null;
  earlyWithdraw: (deposit: DepositRecord) => Promise<boolean>;
  withdrawAtMaturity: (deposit: DepositRecord) => Promise<boolean>;
  resetFlow: () => void;
}

export function useWithdraw(
  savingCore: ethers.Contract | null,
  account: string | null,
  onSuccess?: () => void
): UseWithdrawState {
  const [status, setStatus] = useState<WithdrawFlowStatus>("idle");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [confirmedWithdraw, setConfirmedWithdraw] = useState<ConfirmedWithdrawResult | null>(null);

  const resetFlow = useCallback(() => {
    setStatus("idle");
    setStatusMessage("");
    setError(null);
    setConfirmedWithdraw(null);
  }, []);

  const earlyWithdraw = useCallback(
    async (deposit: DepositRecord): Promise<boolean> => {
      if (!savingCore || !account) {
        setError("Wallet is not connected.");
        return false;
      }

      setError(null);
      setConfirmedWithdraw(null);
      setStatus("validating");
      setStatusMessage("Validating early withdrawal preflight conditions...");

      try {
        // Preflight validations
        const currentOwner = await savingCore.ownerOf(deposit.depositId);
        if (currentOwner.toLowerCase() !== account.toLowerCase()) {
          throw new Error("Action rejected: Only the current owner of this deposit NFT certificate can perform early withdrawal.");
        }

        setStatus("awaiting-signature");
        setStatusMessage("Please confirm the early withdrawal transaction in MetaMask...");

        const tx = await savingCore.earlyWithdraw(deposit.depositId);

        setStatus("pending");
        setStatusMessage(`Early withdrawal transaction submitted (${tx.hash.slice(0, 10)}...). Waiting for block confirmation...`);

        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error("Transaction execution failed or reverted on-chain.");
        }

        // Parse Withdrawn event
        let parsedPrincipal = deposit.principal;
        let isEarly = true;

        for (const log of receipt.logs) {
          try {
            const parsed = savingCore.interface.parseLog(log);
            if (parsed && parsed.name === "Withdrawn") {
              parsedPrincipal = BigInt(parsed.args.principal);
              isEarly = Boolean(parsed.args.isEarly);
            }
          } catch {
            // Non-SavingCore event
          }
        }

        setConfirmedWithdraw({
          txHash: receipt.hash,
          depositId: deposit.depositId,
          principal: formatUSDC(parsedPrincipal),
          payoutAmount: deposit.earlyPayoutFormatted,
          penaltyAmount: deposit.earlyPenaltyFormatted,
          isEarly,
          owner: account,
          blockNumber: receipt.blockNumber,
        });

        setStatus("success");
        setStatusMessage("Early withdrawal successfully settled! Net payout transferred to your wallet.");

        if (onSuccess) {
          onSuccess();
        }

        return true;
      } catch (err: any) {
        console.error("Early withdrawal failed:", err);
        const readable = parseTransactionError(err);
        setError(readable);
        setStatus("error");
        setStatusMessage(readable);
        return false;
      }
    },
    [savingCore, account, onSuccess]
  );

  const withdrawAtMaturity = useCallback(
    async (deposit: DepositRecord): Promise<boolean> => {
      if (!savingCore || !account) {
        setError("Wallet is not connected.");
        return false;
      }

      setError(null);
      setConfirmedWithdraw(null);
      setStatus("validating");
      setStatusMessage("Validating maturity withdrawal preflight conditions...");

      try {
        const currentOwner = await savingCore.ownerOf(deposit.depositId);
        if (currentOwner.toLowerCase() !== account.toLowerCase()) {
          throw new Error("Action rejected: Only the current owner of this deposit NFT certificate can perform maturity withdrawal.");
        }

        setStatus("awaiting-signature");
        setStatusMessage("Please confirm the maturity settlement transaction in MetaMask...");

        const tx = await savingCore.withdrawAtMaturity(deposit.depositId);

        setStatus("pending");
        setStatusMessage(`Maturity settlement transaction submitted (${tx.hash.slice(0, 10)}...). Waiting for block confirmation...`);

        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error("Transaction execution failed or reverted on-chain.");
        }

        let parsedPrincipal = deposit.principal;

        for (const log of receipt.logs) {
          try {
            const parsed = savingCore.interface.parseLog(log);
            if (parsed && parsed.name === "Withdrawn") {
              parsedPrincipal = BigInt(parsed.args.principal);
            }
          } catch {
            // Non-SavingCore event
          }
        }

        setConfirmedWithdraw({
          txHash: receipt.hash,
          depositId: deposit.depositId,
          principal: formatUSDC(parsedPrincipal),
          payoutAmount: deposit.maturityPayoutFormatted,
          penaltyAmount: "0.00",
          isEarly: false,
          owner: account,
          blockNumber: receipt.blockNumber,
        });

        setStatus("success");
        setStatusMessage("Deposit principal plus full contractual interest successfully paid out to your wallet!");

        if (onSuccess) {
          onSuccess();
        }

        return true;
      } catch (err: any) {
        console.error("Maturity withdrawal failed:", err);
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
    confirmedWithdraw,
    earlyWithdraw,
    withdrawAtMaturity,
    resetFlow,
  };
}
