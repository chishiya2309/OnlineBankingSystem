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
import { getDeployedBlock } from "./contracts";
import { getDefaultChainId } from "../config/networks";

export interface PortfolioFetchResult {
  activeDeposits: DepositRecord[];
  historicalDeposits: DepositRecord[];
  summary: PortfolioSummary;
  blockTimestamp: number;
}

const BATCH_SIZE = 10;

interface CachedRenewedEvent {
  oldId: number;
  newId: number;
  blockNumber: number;
}

function getStoredRenewedEvents(chainId: number): CachedRenewedEvent[] {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(`sdc_renewed_${chainId}`) : null;
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveStoredRenewedEvents(chainId: number, events: CachedRenewedEvent[]) {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(`sdc_renewed_${chainId}`, JSON.stringify(events));
    }
  } catch {
    // Ignore quota or private-mode storage errors
  }
}

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
    let chainId = getDefaultChainId();
    let fromBlock = 0;
    let toBlock: number | "latest" = "latest";

    if (provider && typeof provider.getNetwork === "function") {
      try {
        const net = await provider.getNetwork();
        chainId = Number(net.chainId);
      } catch {
        // Fallback to default
      }
    }

    const deployedBlock = getDeployedBlock(chainId);
    const cachedEvents = getStoredRenewedEvents(chainId);

    for (const ev of cachedEvents) {
      renewedToMap.set(ev.oldId, ev.newId);
      renewedFromMap.set(ev.newId, ev.oldId);
    }

    const maxCachedBlock = cachedEvents.reduce(
      (max, ev) => Math.max(max, ev.blockNumber || 0),
      deployedBlock
    );
    fromBlock = maxCachedBlock > deployedBlock ? maxCachedBlock + 1 : deployedBlock;

    if (provider && typeof provider.getBlockNumber === "function") {
      try {
        // The provider's block-number cache can lag a transaction that just settled.
        toBlock = Math.max(latestBlock?.number ?? 0, await provider.getBlockNumber());
      } catch {
        toBlock = "latest";
      }
    }

    const renewedFilter = savingCore.filters.Renewed();
    let newEvents: any[] = [];

    if (typeof toBlock === "number" && toBlock >= fromBlock) {
      const CHUNK_SIZE = 5000;
      const chunks: { from: number; to: number }[] = [];
      for (let b = fromBlock; b <= toBlock; b += CHUNK_SIZE) {
        chunks.push({ from: b, to: Math.min(b + CHUNK_SIZE - 1, toBlock) });
      }

      const chunkResults = await Promise.all(
        chunks.map(async ({ from, to }) => {
          try {
            return await savingCore.queryFilter(renewedFilter, from, to);
          } catch (chunkErr) {
            console.warn(`Querying chunk [${from}, ${to}] failed:`, chunkErr);
            return [];
          }
        })
      );
      newEvents = chunkResults.flat();
    } else if (fromBlock <= (typeof toBlock === "number" ? toBlock : Number.MAX_SAFE_INTEGER)) {
      try {
        newEvents = (await savingCore.queryFilter(renewedFilter, fromBlock, toBlock)) as any[];
      } catch {
        try {
          newEvents = (await savingCore.queryFilter(renewedFilter)) as any[];
        } catch {
          newEvents = [];
        }
      }
    }

    const updatedCachedEvents = [...cachedEvents];
    for (const ev of newEvents) {
      if ("args" in ev && ev.args) {
        const oldId = Number(ev.args[0] ?? ev.args.oldDepositId);
        const newId = Number(ev.args[1] ?? ev.args.newDepositId);
        const blockNumber = ev.blockNumber ?? fromBlock;
        if (oldId && newId) {
          renewedToMap.set(oldId, newId);
          renewedFromMap.set(newId, oldId);
          if (!updatedCachedEvents.some((c) => c.oldId === oldId && c.newId === newId)) {
            updatedCachedEvents.push({ oldId, newId, blockNumber });
          }
        }
      }
    }
    saveStoredRenewedEvents(chainId, updatedCachedEvents);
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

  // 4. Retrieve getDeposit data for all owned deposits (with per-item fault tolerance)
  const depositResults = await Promise.all(
    ownedIds.map(async (depositId): Promise<DepositRecord | null> => {
      try {
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
          principalFormatted: formatUSDC(principal, "auto"),
          startAt,
          maturityAt,
          aprBpsAtOpen,
          penaltyBpsAtOpen,
          status,
          owner: account,
          accruedInterest,
          accruedInterestFormatted: formatUSDC(accruedInterest, "auto"),
          earlyPenalty,
          earlyPenaltyFormatted: formatUSDC(earlyPenalty, "auto"),
          maturityPayout,
          maturityPayoutFormatted: formatUSDC(maturityPayout, "auto"),
          earlyPayout,
          earlyPayoutFormatted: formatUSDC(earlyPayout, "auto"),
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
      } catch (depositErr) {
        console.warn(`Failed to fetch deposit #${depositId} on-chain (RPC glitch/timeout):`, depositErr);
        return null;
      }
    })
  );

  const deposits: DepositRecord[] = depositResults.filter((d): d is DepositRecord => d !== null);

  // 4b. Resolve renewalType ("manual" | "auto") and predecessor/successor summaries
  const depositMap = new Map<number, DepositRecord>();
  for (const d of deposits) {
    depositMap.set(d.depositId, d);
  }

  await Promise.all(
    deposits.map(async (d) => {
      // 1. Predecessor resolution
      if (d.renewedFromDepositId) {
        const predecessor = depositMap.get(d.renewedFromDepositId);
        if (predecessor) {
          d.predecessorSummary = {
            depositId: predecessor.depositId,
            planId: predecessor.planId,
            principalFormatted: predecessor.principalFormatted,
            accruedInterestFormatted: predecessor.accruedInterestFormatted,
            status: predecessor.status,
          };
          if (predecessor.status === DepositStatus.ManualRenewed) {
            d.renewalType = "manual";
          } else if (predecessor.status === DepositStatus.AutoRenewed) {
            d.renewalType = "auto";
          }
        } else if (savingCore) {
          try {
            const oldRaw = await savingCore.getDeposit(d.renewedFromDepositId);
            const oldPlanId = Number(oldRaw.planId);
            const oldPrincipal = BigInt(oldRaw.principal);
            const oldApr = Number(oldRaw.aprBpsAtOpen);
            const oldStatus = Number(oldRaw.status) as DepositStatus;

            let oldTenor = 0;
            try {
              oldTenor = Number(await savingCore.planDurationSeconds(oldPlanId));
            } catch {
              oldTenor = 0;
            }
            const oldInterest = calculateInterestFromSeconds(oldPrincipal, oldApr, oldTenor);

            d.predecessorSummary = {
              depositId: d.renewedFromDepositId,
              planId: oldPlanId,
              principalFormatted: formatUSDC(oldPrincipal, "auto"),
              accruedInterestFormatted: formatUSDC(oldInterest, "auto"),
              status: oldStatus,
            };

            if (oldStatus === DepositStatus.ManualRenewed) {
              d.renewalType = "manual";
            } else if (oldStatus === DepositStatus.AutoRenewed) {
              d.renewalType = "auto";
            }
          } catch {
            // Predecessor fetch ignored
          }
        }
      }

      // 2. Successor resolution
      if (d.renewedToDepositId) {
        const successor = depositMap.get(d.renewedToDepositId);
        if (successor) {
          d.successorSummary = {
            depositId: successor.depositId,
            planId: successor.planId,
            principalFormatted: successor.principalFormatted,
            status: successor.status,
          };
        } else if (savingCore) {
          try {
            const newRaw = await savingCore.getDeposit(d.renewedToDepositId);
            d.successorSummary = {
              depositId: d.renewedToDepositId,
              planId: Number(newRaw.planId),
              principalFormatted: formatUSDC(BigInt(newRaw.principal), "auto"),
              status: Number(newRaw.status) as DepositStatus,
            };
          } catch {
            // Successor fetch ignored
          }
        }
      }
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
    totalActivePrincipalFormatted: formatUSDC(totalActivePrincipal, "auto"),
    activeCount: activeDeposits.length,
    historicalCount: historicalDeposits.length,
    upcomingMaturity,
    totalEstimatedInterest,
    totalEstimatedInterestFormatted: formatUSDC(totalEstimatedInterest, "auto"),
  };

  return {
    activeDeposits,
    historicalDeposits,
    summary,
    blockTimestamp,
  };
}
