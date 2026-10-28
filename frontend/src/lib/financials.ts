/**
 * Financial calculation formulas matching SavingCore.sol exactly.
 */

const BPS_DENOMINATOR = 10000n;
const SECONDS_PER_DAY = 86400n;
const SECONDS_PER_YEAR = 365n * SECONDS_PER_DAY; // 31,536,000s

/**
 * Calculates full-term contractual interest.
 * Matches: mulDiv(principal, aprBps * tenorSeconds, 10000 * 365 days)
 */
export function calculateContractualInterest(
  principalUnits: bigint,
  aprBps: number,
  tenorDays: number
): bigint {
  if (principalUnits === 0n || aprBps === 0 || tenorDays === 0) {
    return 0n;
  }
  const tenorSeconds = BigInt(tenorDays) * SECONDS_PER_DAY;
  const numerator = principalUnits * BigInt(aprBps) * tenorSeconds;
  const denominator = BPS_DENOMINATOR * SECONDS_PER_YEAR;
  return numerator / denominator;
}

/**
 * Calculates early withdrawal penalty.
 * Matches: mulDiv(principal, penaltyBps, 10000)
 */
export function calculatePenalty(principalUnits: bigint, penaltyBps: number): bigint {
  if (principalUnits === 0n || penaltyBps === 0) {
    return 0n;
  }
  return (principalUnits * BigInt(penaltyBps)) / BPS_DENOMINATOR;
}
