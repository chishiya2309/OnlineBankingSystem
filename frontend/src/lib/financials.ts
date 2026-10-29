/**
 * Financial calculation formulas matching SavingCore.sol exactly.
 * All computations use native BigInt and floor division to match Solidity Math.mulDiv.
 */

export const BPS_DENOMINATOR = 10000n;
export const SECONDS_PER_DAY = 86400n;
export const SECONDS_PER_YEAR = 365n * SECONDS_PER_DAY; // 31,536,000s

/**
 * Calculates full-term contractual interest from tenor in days.
 * Matches: mulDiv(principal, aprBps * tenorSeconds, 10000 * 365 days)
 */
export function calculateContractualInterest(
  principalUnits: bigint,
  aprBps: number,
  tenorDays: number
): bigint {
  if (principalUnits <= 0n || aprBps <= 0 || tenorDays <= 0) {
    return 0n;
  }
  const tenorSeconds = BigInt(tenorDays) * SECONDS_PER_DAY;
  return calculateInterestFromSeconds(principalUnits, aprBps, tenorSeconds);
}

/**
 * Calculates contractual interest directly from tenor in seconds.
 * Matches SavingCore._calculateInterest exactly.
 */
export function calculateInterestFromSeconds(
  principalUnits: bigint,
  aprBps: number,
  tenorSeconds: bigint | number
): bigint {
  if (principalUnits <= 0n || aprBps <= 0 || BigInt(tenorSeconds) <= 0n) {
    return 0n;
  }
  const tenorSec = BigInt(tenorSeconds);
  const numerator = principalUnits * BigInt(aprBps) * tenorSec;
  const denominator = BPS_DENOMINATOR * SECONDS_PER_YEAR;
  return numerator / denominator;
}

/**
 * Calculates early withdrawal penalty.
 * Matches SavingCore._calculatePenalty: mulDiv(principal, penaltyBps, 10000)
 */
export function calculatePenalty(principalUnits: bigint, penaltyBps: number): bigint {
  if (principalUnits <= 0n || penaltyBps <= 0) {
    return 0n;
  }
  return (principalUnits * BigInt(penaltyBps)) / BPS_DENOMINATOR;
}

/**
 * Calculates net early withdrawal payout and fee.
 * User receives = P - F; Fee receiver receives = F; Interest = 0.
 */
export function calculateEarlyWithdrawal(
  principalUnits: bigint,
  penaltyBps: number
): { netPayout: bigint; penalty: bigint } {
  const penalty = calculatePenalty(principalUnits, penaltyBps);
  const netPayout = principalUnits > penalty ? principalUnits - penalty : 0n;
  return { netPayout, penalty };
}

/**
 * Calculates maturity total payout.
 * User receives = P + I.
 */
export function calculateMaturityPayout(principalUnits: bigint, interestUnits: bigint): bigint {
  return principalUnits + interestUnits;
}

/**
 * Calculates compounded renewal principal.
 * New Principal = P + I.
 */
export function calculateRenewalPrincipal(principalUnits: bigint, interestUnits: bigint): bigint {
  return principalUnits + interestUnits;
}
