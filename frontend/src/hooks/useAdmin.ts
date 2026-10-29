import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import type { AdminSummary, CreatePlanInput, AdminActionStatus, ConfirmedAdminResult } from "../types";
import { formatUSDC, formatDurationSeconds } from "../lib/format";
import { parseTransactionError } from "../lib/errors";

const INITIAL_SUMMARY: AdminSummary = {
  isBankAdmin: false,
  supportsSecondPlans: false,
  vaultOwner: null,
  isPaused: false,
  feeReceiver: null,
  vaultBalance: 0n,
  vaultBalanceFormatted: "0.00",
  adminUSDCBalance: 0n,
  adminUSDCBalanceFormatted: "0.00",
  adminAllowance: 0n,
};

export function useAdmin(
  vaultManager: ethers.Contract | null,
  savingCore: ethers.Contract | null,
  mockUSDC: ethers.Contract | null,
  account: string | null,
  onSuccessCallback?: () => void
) {
  const [summary, setSummary] = useState<AdminSummary>(INITIAL_SUMMARY);
  const [status, setStatus] = useState<AdminActionStatus>("idle");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [latestResult, setLatestResult] = useState<ConfirmedAdminResult | null>(null);

  // Fetch live state from contracts
  const fetchAdminData = useCallback(async () => {
    if (!vaultManager || !savingCore || !mockUSDC) {
      setSummary(INITIAL_SUMMARY);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const vaultAddress = vaultManager.target ? await vaultManager.getAddress() : "";

      const [vaultOwner, isPaused, feeReceiver, rawVaultBal, rawAdminBal, rawAllowance, supportsSecondPlans] =
        await Promise.all([
          vaultManager.owner().catch(() => null),
          vaultManager.paused().catch(() => false),
          vaultManager.feeReceiver().catch(() => null),
          vaultAddress ? mockUSDC.balanceOf(vaultAddress).catch(() => 0n) : 0n,
          account ? mockUSDC.balanceOf(account).catch(() => 0n) : 0n,
          account && vaultAddress ? mockUSDC.allowance(account, vaultAddress).catch(() => 0n) : 0n,
          savingCore.planDurationSeconds(0).then(() => true).catch(() => false),
        ]);

      const isBankAdmin = Boolean(
        account &&
          vaultOwner &&
          account.toLowerCase() === (vaultOwner as string).toLowerCase()
      );

      setSummary({
        isBankAdmin,
        supportsSecondPlans,
        vaultOwner,
        isPaused: Boolean(isPaused),
        feeReceiver,
        vaultBalance: BigInt(rawVaultBal || 0),
        vaultBalanceFormatted: formatUSDC(BigInt(rawVaultBal || 0)),
        adminUSDCBalance: BigInt(rawAdminBal || 0),
        adminUSDCBalanceFormatted: formatUSDC(BigInt(rawAdminBal || 0)),
        adminAllowance: BigInt(rawAllowance || 0),
      });
    } catch (err) {
      console.error("Error fetching admin state:", err);
      setError(parseTransactionError(err));
    } finally {
      setIsLoading(false);
    }
  }, [vaultManager, savingCore, mockUSDC, account]);

  useEffect(() => {
    fetchAdminData();
  }, [fetchAdminData]);

  // 1. Create Plan
  const createPlan = useCallback(
    async (input: CreatePlanInput): Promise<boolean> => {
      if (!savingCore || !account) {
        setError("SavingCore contract or wallet not connected.");
        return false;
      }

      if (!Number.isSafeInteger(input.tenorSeconds) || input.tenorSeconds < 1 || input.tenorSeconds > 4294967295 * 86400) {
        setError("Tenor must be a positive whole number of seconds within the supported maximum.");
        return false;
      }
      if (input.aprBps < 0 || input.aprBps > 10000) {
        setError("APR must be between 0 and 10,000 basis points (0.00% - 100.00%).");
        return false;
      }
      if (input.earlyWithdrawPenaltyBps < 0 || input.earlyWithdrawPenaltyBps > 10000) {
        setError("Penalty must be between 0 and 10,000 basis points (0.00% - 100.00%).");
        return false;
      }

      try {
        setStatus("awaiting-signature");
        setError(null);

        const minDeposit = input.minDeposit ? ethers.parseUnits(input.minDeposit, 6) : 0n;
        const maxDeposit = input.maxDeposit ? ethers.parseUnits(input.maxDeposit, 6) : 0n;

        const wholeDays = input.tenorSeconds % 86400 === 0;
        if (!wholeDays && !summary.supportsSecondPlans) throw new Error("This legacy SavingCore must be redeployed to support short plans.");
        const tx = await savingCore[wholeDays ? "createPlan" : "createPlanSeconds"](
          BigInt(wholeDays ? input.tenorSeconds / 86400 : input.tenorSeconds),
          BigInt(input.aprBps),
          minDeposit,
          maxDeposit,
          BigInt(input.earlyWithdrawPenaltyBps),
          input.enabled
        );

        setStatus("pending");
        const receipt = await tx.wait();

        setStatus("success");
        setLatestResult({
          action: "Plan Created",
          txHash: receipt.hash,
          details: `Created ${formatDurationSeconds(input.tenorSeconds)} plan with ${(input.aprBps / 100).toFixed(2)}% APR.`,
          blockNumber: receipt.blockNumber,
        });

        await fetchAdminData();
        onSuccessCallback?.();
        return true;
      } catch (err) {
        console.error("Failed to create plan:", err);
        setError(parseTransactionError(err));
        setStatus("error");
        return false;
      }
    },
    [savingCore, account, fetchAdminData, onSuccessCallback, summary.supportsSecondPlans]
  );

  // 2. Update Plan APR
  const updatePlanApr = useCallback(
    async (planId: number, newAprBps: number): Promise<boolean> => {
      if (!savingCore || !account) {
        setError("SavingCore contract or wallet not connected.");
        return false;
      }

      if (newAprBps < 0 || newAprBps > 10000) {
        setError("APR must be between 0 and 10,000 basis points.");
        return false;
      }

      try {
        setStatus("awaiting-signature");
        setError(null);

        const tx = await savingCore.updatePlan(BigInt(planId), BigInt(newAprBps));
        setStatus("pending");
        const receipt = await tx.wait();

        setStatus("success");
        setLatestResult({
          action: "Plan APR Updated",
          txHash: receipt.hash,
          details: `Plan #${planId} APR updated to ${(newAprBps / 100).toFixed(2)}%.`,
          blockNumber: receipt.blockNumber,
        });

        await fetchAdminData();
        onSuccessCallback?.();
        return true;
      } catch (err) {
        console.error("Failed to update plan APR:", err);
        setError(parseTransactionError(err));
        setStatus("error");
        return false;
      }
    },
    [savingCore, account, fetchAdminData, onSuccessCallback, summary.supportsSecondPlans]
  );

  // 3. Toggle Plan Status (Enable / Disable)
  const togglePlanStatus = useCallback(
    async (planId: number, enable: boolean): Promise<boolean> => {
      if (!savingCore || !account) {
        setError("SavingCore contract or wallet not connected.");
        return false;
      }

      try {
        setStatus("awaiting-signature");
        setError(null);

        const tx = enable
          ? await savingCore.enablePlan(BigInt(planId))
          : await savingCore.disablePlan(BigInt(planId));

        setStatus("pending");
        const receipt = await tx.wait();

        setStatus("success");
        setLatestResult({
          action: enable ? "Plan Enabled" : "Plan Disabled",
          txHash: receipt.hash,
          details: `Plan #${planId} is now ${enable ? "active" : "disabled"}.`,
          blockNumber: receipt.blockNumber,
        });

        await fetchAdminData();
        onSuccessCallback?.();
        return true;
      } catch (err) {
        console.error("Failed to toggle plan status:", err);
        setError(parseTransactionError(err));
        setStatus("error");
        return false;
      }
    },
    [savingCore, account, fetchAdminData, onSuccessCallback, summary.supportsSecondPlans]
  );

  // 4. Fund Vault
  const fundVault = useCallback(
    async (amountStr: string): Promise<boolean> => {
      if (!vaultManager || !mockUSDC || !account) {
        setError("VaultManager, MockUSDC, or wallet not connected.");
        return false;
      }

      const num = parseFloat(amountStr);
      if (isNaN(num) || num <= 0) {
        setError("Please enter a valid funding amount greater than zero.");
        return false;
      }

      try {
        setStatus("validating");
        setError(null);

        const amount = ethers.parseUnits(amountStr, 6);
        const vaultAddress = await vaultManager.getAddress();

        // Check allowance
        const currentAllowance: bigint = BigInt(await mockUSDC.allowance(account, vaultAddress));
        if (currentAllowance < amount) {
          setStatus("awaiting-signature");
          const appTx = await mockUSDC.approve(vaultAddress, amount);
          setStatus("pending");
          await appTx.wait();
        }

        setStatus("awaiting-signature");
        const fundTx = await vaultManager.fundVault(amount);
        setStatus("pending");
        const receipt = await fundTx.wait();

        setStatus("success");
        setLatestResult({
          action: "Vault Funded",
          txHash: receipt.hash,
          details: `Successfully funded vault with ${amountStr} MockUSDC.`,
          blockNumber: receipt.blockNumber,
        });

        await fetchAdminData();
        onSuccessCallback?.();
        return true;
      } catch (err) {
        console.error("Failed to fund vault:", err);
        setError(parseTransactionError(err));
        setStatus("error");
        return false;
      }
    },
    [vaultManager, mockUSDC, account, fetchAdminData, onSuccessCallback]
  );

  // 5. Withdraw Liquidity
  const withdrawLiquidity = useCallback(
    async (amountStr: string): Promise<boolean> => {
      if (!vaultManager || !account) {
        setError("VaultManager or wallet not connected.");
        return false;
      }

      const num = parseFloat(amountStr);
      if (isNaN(num) || num <= 0) {
        setError("Please enter a valid withdrawal amount greater than zero.");
        return false;
      }

      try {
        setStatus("awaiting-signature");
        setError(null);

        const amount = ethers.parseUnits(amountStr, 6);
        const tx = await vaultManager.withdrawVault(amount);
        setStatus("pending");
        const receipt = await tx.wait();

        setStatus("success");
        setLatestResult({
          action: "Liquidity Withdrawn",
          txHash: receipt.hash,
          details: `Withdrew ${amountStr} MockUSDC to the bank admin wallet (${account}).`,
          blockNumber: receipt.blockNumber,
        });

        await fetchAdminData();
        onSuccessCallback?.();
        return true;
      } catch (err) {
        console.error("Failed to withdraw liquidity:", err);
        setError(parseTransactionError(err));
        setStatus("error");
        return false;
      }
    },
    [vaultManager, account, fetchAdminData, onSuccessCallback]
  );

  // 6. Emergency Toggle Pause
  const togglePause = useCallback(async (): Promise<boolean> => {
    if (!vaultManager || !account) {
      setError("VaultManager or wallet not connected.");
      return false;
    }

    try {
      setStatus("awaiting-signature");
      setError(null);

      const tx = summary.isPaused
        ? await vaultManager.unpause()
        : await vaultManager.pause();

      setStatus("pending");
      const receipt = await tx.wait();

      setStatus("success");
      setLatestResult({
        action: summary.isPaused ? "System Unpaused" : "System Emergency Paused",
        txHash: receipt.hash,
        details: `Banking vault emergency pause status changed to: ${!summary.isPaused ? "PAUSED" : "ACTIVE"}.`,
        blockNumber: receipt.blockNumber,
      });

      await fetchAdminData();
      onSuccessCallback?.();
      return true;
    } catch (err) {
      console.error("Failed to toggle pause:", err);
      setError(parseTransactionError(err));
      setStatus("error");
      return false;
    }
  }, [vaultManager, account, summary.isPaused, fetchAdminData, onSuccessCallback]);

  // 7. Set Fee Receiver
  const setFeeReceiver = useCallback(
    async (newReceiver: string): Promise<boolean> => {
      if (!vaultManager || !account) {
        setError("VaultManager or wallet not connected.");
        return false;
      }

      if (!ethers.isAddress(newReceiver) || newReceiver === ethers.ZeroAddress) {
        setError("Please enter a valid non-zero Ethereum address for fee receiver.");
        return false;
      }

      try {
        setStatus("awaiting-signature");
        setError(null);

        const tx = await vaultManager.setFeeReceiver(newReceiver);
        setStatus("pending");
        const receipt = await tx.wait();

        setStatus("success");
        setLatestResult({
          action: "Fee Receiver Updated",
          txHash: receipt.hash,
          details: `Early withdrawal penalty recipient updated to ${newReceiver}.`,
          blockNumber: receipt.blockNumber,
        });

        await fetchAdminData();
        onSuccessCallback?.();
        return true;
      } catch (err) {
        console.error("Failed to update fee receiver:", err);
        setError(parseTransactionError(err));
        setStatus("error");
        return false;
      }
    },
    [vaultManager, account, fetchAdminData, onSuccessCallback]
  );

  // 8. Mint Admin Demo Tokens (Utility for localhost & testnet)
  const mintAdminDemoTokens = useCallback(
    async (amountStr: string = "5000"): Promise<boolean> => {
      if (!mockUSDC || !account) {
        setError("MockUSDC or wallet not connected.");
        return false;
      }

      try {
        setStatus("awaiting-signature");
        setError(null);

        const amount = ethers.parseUnits(amountStr, 6);
        const tx = await mockUSDC.mint(account, amount);
        setStatus("pending");
        const receipt = await tx.wait();

        setStatus("success");
        setLatestResult({
          action: "MockUSDC Minted",
          txHash: receipt.hash,
          details: `Minted ${amountStr} MockUSDC to ${account}.`,
          blockNumber: receipt.blockNumber,
        });

        await fetchAdminData();
        onSuccessCallback?.();
        return true;
      } catch (err) {
        console.error("Failed to mint admin tokens:", err);
        setError(parseTransactionError(err));
        setStatus("error");
        return false;
      }
    },
    [mockUSDC, account, fetchAdminData, onSuccessCallback]
  );

  const resetStatus = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  return {
    summary,
    status,
    isLoading,
    error,
    latestResult,
    createPlan,
    updatePlanApr,
    togglePlanStatus,
    fundVault,
    withdrawLiquidity,
    togglePause,
    setFeeReceiver,
    mintAdminDemoTokens,
    refetch: fetchAdminData,
    resetStatus,
  };
}
