import { ethers } from "ethers";
import {
  DepositStatus,
  type DepositRecord,
  type PortfolioSummary,
} from "../types";
import {
  calculateInterestFromSeconds,
  calculatePenalty,
  calculateEarlyWithdrawal,
  calculateMaturityPayout,
} from "./financials";
import { formatUSDC } from "./format";

export interface PortfolioFetchResult {
  activeDeposits: DepositRecord[];
  historicalDeposits: DepositRecord[];
  summary: PortfolioSummary;
  blockTimestamp: number;
}

const BATCH_SIZE = 10;

/**
 * Discovers and parses all deposits currently owned by the target account.
 * Uses bounded batching over depositCount() and ownerOf(id) checks to respect
 * ERC721 ownership transferability without assuming ERC721Enumerable.
 */
export async function fetchUserPortfolio(
  savingCore: ethers.Contract | null,
  account: string | null,
  provider: ethers.Provider
): Promise<PortfolioFetchResult> {
  const emptySummary: PortfolioSummary = {
    totalActivePrincipal: 0n,
    totalActivePrincipalFormatted: "0.00",
    activeCount: 0,
    historicalCount: 0,
    upcomingMaturity: null,
    totalEstimatedInterest: 0n,
    totalEstimatedInterestFormatted: "0.00",
  };

  if (!savingCore || !account) {
    return {
      activeDeposits: [],
      historicalDeposits: [],
      summary: emptySummary,
      blockTimestamp: Math.floor(Date.now() / 1000),
    };
  }

  // 1. Fetch deposit count, grace period and latest on-chain block timestamp
  const [rawDepositCount, rawGracePeriod, latestBlock] = await Promise.all([
    savingCore.depositCount(),
    savingCore.gracePeriodSeconds(),
    provider.getBlock("latest"),
  ]);

  const depositCount = Number(rawDepositCount);
  const gracePeriodSeconds = Number(rawGracePeriod);
  const blockTimestamp = latestBlock ? latestBlock.timestamp : Math.floor(Date.now() / 1000);

  if (depositCount === 0) {
    return {
      activeDeposits: [],
      historicalDeposits: [],
      summary: emptySummary,
      blockTimestamp,
    };
  }

  // 2. Discover renewal lineage by querying past Renewed events
  const renewedToMap = new Map<number, number>();
  const renewedFromMap = new Map<number, number>();
  try {
    const renewedFilter = savingCore.filters.Renewed();
    const renewedEvents = await savingCore.queryFilter(renewedFilter, 0, "latest");
    for (const ev of renewedEvents) {
      if ("args" in ev && ev.args) {
        const oldId = Number(ev.args[0] ?? ev.args.oldDepositId);
        const newId = Number(ev.args[1] ?? ev.args.newDepositId);
        if (oldId && newId) {
          renewedToMap.set(oldId, newId);
          renewedFromMap.set(newId, oldId);
        }
      }
    }
  } catch (err) {
    console.warn("Could not query Renewed events for lineage mapping:", err);
  }

  // 3. Scan deposit IDs [1..depositCount] in bounded batches to find tokens owned by account
  const targetAccountLower = account.toLowerCase();
  const ownedIds: number[] = [];

  for (let i = 1; i <= depositCount; i += BATCH_SIZE) {
    const batchIds: number[] = [];
    for (let j = i; j < i + BATCH_SIZE && j <= depositCount; j++) {
      batchIds.push(j);
    }

    const batchOwners = await Promise.all(
      batchIds.map(async (id) => {
        try {
          const owner: string = await savingCore.ownerOf(id);
          return { id, owner };
        } catch {
          // Token could be burned or invalid
          return { id, owner: "" };
        }
      })
    );

    for (const { id, owner } of batchOwners) {
      if (owner && owner.toLowerCase() === targetAccountLower) {
        ownedIds.push(id);
      }
    }
  }

  if (ownedIds.length === 0) {
    return {
      activeDeposits: [],
      historicalDeposits: [],
      summary: emptySummary,
      blockTimestamp,
    };
  }

  // 4. Retrieve getDeposit data for all owned deposits
  const deposits: DepositRecord[] = await Promise.all(
    ownedIds.map(async (depositId) => {
      const raw = await savingCore.getDeposit(depositId);
      const planId = Number(raw.planId);
      const principal = BigInt(raw.principal);
      const startAt = Number(raw.startAt);
      const maturityAt = Number(raw.maturityAt);
      const aprBpsAtOpen = Number(raw.aprBpsAtOpen);
      const penaltyBpsAtOpen = Number(raw.penaltyBpsAtOpen);
      const status = Number(raw.status) as DepositStatus;

      const tenorSeconds = maturityAt - startAt;
      const graceEnd = maturityAt + gracePeriodSeconds;

      // Contractual interest & penalty
      const accruedInterest = calculateInterestFromSeconds(principal, aprBpsAtOpen, tenorSeconds);
      const earlyPenalty = calculatePenalty(principal, penaltyBpsAtOpen);
      const maturityPayout = calculateMaturityPayout(principal, accruedInterest);
      const { netPayout: earlyPayout } = calculateEarlyWithdrawal(principal, penaltyBpsAtOpen);

      // Eligibility using on-chain block timestamp
      const isMatured = blockTimestamp >= maturityAt;
      const isGraceEnded = blockTimestamp >= graceEnd;
      const isActive = status === DepositStatus.Active;

      const canEarlyWithdraw = isActive && !isMatured;
      const canMaturityWithdraw = isActive && isMatured;
      const canManualRenew = isActive && isMatured;
      const canAutoRenew = isActive && isGraceEnded;

      return {
        depositId,
        planId,
        principal,
        principalFormatted: formatUSDC(principal),
        startAt,
        maturityAt,
        aprBpsAtOpen,
        penaltyBpsAtOpen,
        status,
        owner: account,
        accruedInterest,
        accruedInterestFormatted: formatUSDC(accruedInterest, tenorSeconds < 86400 ? 6 : 2),
        earlyPenalty,
        earlyPenaltyFormatted: formatUSDC(earlyPenalty),
        maturityPayout,
        maturityPayoutFormatted: formatUSDC(maturityPayout, tenorSeconds < 86400 ? 6 : 2),
        earlyPayout,
        earlyPayoutFormatted: formatUSDC(earlyPayout),
        tenorSeconds,
        gracePeriodSeconds,
        graceEnd,
        isMatured,
        isGraceEnded,
        canEarlyWithdraw,
        canMaturityWithdraw,
        canManualRenew,
        canAutoRenew,
        renewedFromDepositId: renewedFromMap.get(depositId),
        renewedToDepositId: renewedToMap.get(depositId),
      };
    })
  );

  // 5. Partition into Active and Historical certificates
  const activeDeposits = deposits
    .filter((d) => d.status === DepositStatus.Active)
    .sort((a, b) => b.depositId - a.depositId);

  const historicalDeposits = deposits
    .filter((d) => d.status !== DepositStatus.Active)
    .sort((a, b) => b.depositId - a.depositId);

  // 6. Compute overall portfolio summary
  const totalActivePrincipal = activeDeposits.reduce((acc, d) => acc + d.principal, 0n);
  const totalEstimatedInterest = activeDeposits.reduce((acc, d) => acc + d.accruedInterest, 0n);

  // Find earliest upcoming maturity among active deposits
  let upcomingMaturity: number | null = null;
  const unmatured = activeDeposits.filter((d) => d.maturityAt > blockTimestamp);
  if (unmatured.length > 0) {
    unmatured.sort((a, b) => a.maturityAt - b.maturityAt);
    upcomingMaturity = unmatured[0].maturityAt;
  }

  const summary: PortfolioSummary = {
    totalActivePrincipal,
    totalActivePrincipalFormatted: formatUSDC(totalActivePrincipal),
    activeCount: activeDeposits.length,
    historicalCount: historicalDeposits.length,
    upcomingMaturity,
    totalEstimatedInterest,
    totalEstimatedInterestFormatted: formatUSDC(totalEstimatedInterest),
  };

  return {
    activeDeposits,
    historicalDeposits,
    summary,
    blockTimestamp,
  };
}
