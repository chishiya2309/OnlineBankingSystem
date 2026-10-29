import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import type { SavingPlan } from "../types";
import { formatBps, formatUSDC } from "../lib/format";
import { parseTransactionError } from "../lib/errors";

export interface SavingPlansState {
  plans: SavingPlan[];
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useSavingPlans(
  savingCore: ethers.Contract | null,
  isStaleDeployment: boolean
): SavingPlansState {
  const [plans, setPlans] = useState<SavingPlan[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPlans = useCallback(async () => {
    if (!savingCore || isStaleDeployment) {
      setPlans([]);
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const rawCount = await savingCore.planCount();
      const count = Number(rawCount);

      if (count === 0) {
        setPlans([]);
        return;
      }

      const planPromises: Promise<SavingPlan>[] = [];

      for (let i = 1; i <= count; i++) {
        const planId = i;
        planPromises.push(
          savingCore.getPlan(planId).then(async (planData: any) => {
            const tenorDays = Number(planData.tenorDays ?? planData[0]);
            // Existing deployments only support whole days; new deployments expose exact seconds.
            const tenorSeconds = Number(await savingCore.planDurationSeconds(planId)
              .catch(() => BigInt(tenorDays) * 86400n));
            const aprBps = Number(planData.aprBps ?? planData[1]);
            const minDeposit = BigInt(planData.minDeposit ?? planData[2]);
            const maxDeposit = BigInt(planData.maxDeposit ?? planData[3]);
            const earlyWithdrawPenaltyBps = Number(
              planData.earlyWithdrawPenaltyBps ?? planData[4]
            );
            const enabled = Boolean(planData.enabled ?? planData[5]);

            return {
              planId,
              tenorDays,
              tenorSeconds,
              aprBps,
              aprPercent: formatBps(aprBps),
              minDeposit,
              maxDeposit,
              minDepositFormatted: minDeposit === 0n ? "No minimum" : `${formatUSDC(minDeposit)} USDC`,
              maxDepositFormatted: maxDeposit === 0n ? "No maximum" : `${formatUSDC(maxDeposit)} USDC`,
              earlyWithdrawPenaltyBps,
              penaltyPercent: formatBps(earlyWithdrawPenaltyBps),
              enabled,
            };
          })
        );
      }

      const resolvedPlans = await Promise.all(planPromises);
      setPlans(resolvedPlans);
    } catch (err: any) {
      console.error("Error fetching saving plans from SavingCore:", err);
      setError(parseTransactionError(err));
      setPlans([]);
    } finally {
      setIsLoading(false);
    }
  }, [savingCore, isStaleDeployment]);

  useEffect(() => {
    fetchPlans();
  }, [fetchPlans]);

  return {
    plans,
    isLoading,
    error,
    refetch: fetchPlans,
  };
}
