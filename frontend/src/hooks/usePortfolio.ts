import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import type { DepositRecord, PortfolioSummary } from "../types";
import { fetchUserPortfolio } from "../lib/portfolio";

export interface UsePortfolioState {
  activeDeposits: DepositRecord[];
  historicalDeposits: DepositRecord[];
  summary: PortfolioSummary;
  blockTimestamp: number;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function usePortfolio(
  savingCore: ethers.Contract | null,
  account: string | null,
  provider: ethers.Provider,
  isStaleDeployment: boolean
): UsePortfolioState {
  const [activeDeposits, setActiveDeposits] = useState<DepositRecord[]>([]);
  const [historicalDeposits, setHistoricalDeposits] = useState<DepositRecord[]>([]);
  const [summary, setSummary] = useState<PortfolioSummary>({
    totalActivePrincipal: 0n,
    totalActivePrincipalFormatted: "0.00",
    activeCount: 0,
    historicalCount: 0,
    upcomingMaturity: null,
    totalEstimatedInterest: 0n,
    totalEstimatedInterestFormatted: "0.00",
  });
  const [blockTimestamp, setBlockTimestamp] = useState<number>(Math.floor(Date.now() / 1000));
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const loadPortfolio = useCallback(async () => {
    if (!savingCore || !account || isStaleDeployment) {
      setActiveDeposits([]);
      setHistoricalDeposits([]);
      setSummary({
        totalActivePrincipal: 0n,
        totalActivePrincipalFormatted: "0.00",
        activeCount: 0,
        historicalCount: 0,
        upcomingMaturity: null,
        totalEstimatedInterest: 0n,
        totalEstimatedInterestFormatted: "0.00",
      });
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await fetchUserPortfolio(savingCore, account, provider);
      setActiveDeposits(result.activeDeposits);
      setHistoricalDeposits(result.historicalDeposits);
      setSummary(result.summary);
      setBlockTimestamp(result.blockTimestamp);
    } catch (err: any) {
      console.error("Failed to load user deposit portfolio:", err);
      setError(err?.message || "Failed to load deposit portfolio from blockchain.");
    } finally {
      setIsLoading(false);
    }
  }, [savingCore, account, provider, isStaleDeployment]);

  useEffect(() => {
    loadPortfolio();
  }, [loadPortfolio]);

  return {
    activeDeposits,
    historicalDeposits,
    summary,
    blockTimestamp,
    isLoading,
    error,
    refetch: loadPortfolio,
  };
}
