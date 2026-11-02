import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";

export interface VaultStatusState {
  isPaused: boolean;
  vaultBalance: bigint;
  isLoading: boolean;
  error: string | null;
  refreshVaultStatus: () => Promise<void>;
}

/**
 * Hook to monitor VaultManager emergency pause state and MockUSDC liquidity reserve.
 * Used for pre-flight transaction guards across deposits, withdrawals, and renewals.
 */
export function useVaultStatus(
  vaultManager: ethers.Contract | null,
  mockUSDC: ethers.Contract | null,
  vaultManagerAddress?: string | null
): VaultStatusState {
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [vaultBalance, setVaultBalance] = useState<bigint>(0n);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const refreshVaultStatus = useCallback(async () => {
    if (!vaultManager || !mockUSDC || !vaultManagerAddress) {
      setIsPaused(false);
      setVaultBalance(0n);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const [pausedState, balance] = await Promise.all([
        vaultManager.paused().catch((err: unknown) => {
          console.warn("Failed to query vaultManager.paused():", err);
          return false;
        }),
        mockUSDC.balanceOf(vaultManagerAddress).catch((err: unknown) => {
          console.warn("Failed to query vault MockUSDC balance:", err);
          return 0n;
        }),
      ]);

      setIsPaused(Boolean(pausedState));
      setVaultBalance(BigInt(balance || 0n));
    } catch (err: unknown) {
      console.error("Error updating vault status:", err);
      setError("Unable to query vault status");
    } finally {
      setIsLoading(false);
    }
  }, [vaultManager, mockUSDC, vaultManagerAddress]);

  useEffect(() => {
    refreshVaultStatus();
  }, [refreshVaultStatus]);

  // Set up listeners for Paused, Unpaused events on VaultManager
  useEffect(() => {
    if (!vaultManager) return;

    const handlePaused = () => {
      setIsPaused(true);
    };

    const handleUnpaused = () => {
      setIsPaused(false);
    };

    try {
      vaultManager.on("Paused", handlePaused);
      vaultManager.on("Unpaused", handleUnpaused);
    } catch (err) {
      console.warn("Could not attach VaultManager event listeners:", err);
    }

    return () => {
      try {
        vaultManager.off("Paused", handlePaused);
        vaultManager.off("Unpaused", handleUnpaused);
      } catch {
        // Ignore detach errors
      }
    };
  }, [vaultManager]);

  return {
    isPaused,
    vaultBalance,
    isLoading,
    error,
    refreshVaultStatus,
  };
}
