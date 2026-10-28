import { ethers } from "ethers";

/**
 * Formats 6-decimal token units to human-readable locale string with 2 decimal places.
 * Example: 1000000000n -> "1,000.00"
 */
export function formatUSDC(rawUnits: bigint | string | number | undefined | null): string {
  if (rawUnits === undefined || rawUnits === null) return "0.00";
  try {
    const rawBigInt = typeof rawUnits === "bigint" ? rawUnits : BigInt(rawUnits.toString());
    const formatted = ethers.formatUnits(rawBigInt, 6);
    const parts = formatted.split(".");
    const whole = Number(parts[0]).toLocaleString("en-US");
    const decimal = parts[1] ? parts[1].padEnd(2, "0").slice(0, 2) : "00";
    return `${whole}.${decimal}`;
  } catch {
    return "0.00";
  }
}

/**
 * Parses user input amount string into exact 6-decimal bigint.
 * Prevents floating point inaccuracies.
 */
export function parseUSDC(amountString: string): bigint {
  const trimmed = amountString.trim().replace(/,/g, "");
  if (!trimmed || isNaN(Number(trimmed)) || Number(trimmed) < 0) {
    return 0n;
  }
  // Max 6 decimal places check
  const parts = trimmed.split(".");
  if (parts.length > 1 && parts[1].length > 6) {
    throw new Error("Maximum 6 decimal places allowed for USDC");
  }
  return ethers.parseUnits(trimmed, 6);
}

/**
 * Formats basis points to percentage.
 * Example: 200 -> "2.00%"
 */
export function formatBps(bps: number | bigint | undefined | null): string {
  if (bps === undefined || bps === null) return "0.00%";
  const num = Number(bps);
  return `${(num / 100).toFixed(2)}%`;
}

/**
 * Formats tenor in days.
 */
export function formatDurationDays(days: number): string {
  if (days === 365) return "1 year (365 days)";
  if (days === 180) return "6 months (180 days)";
  if (days === 90) return "3 months (90 days)";
  return `${days} days`;
}

/**
 * Formats UNIX epoch timestamp (seconds) into standard readable date.
 */
export function formatTimestamp(timestampSec: number | bigint): string {
  if (!timestampSec) return "N/A";
  const ms = Number(timestampSec) * 1000;
  const d = new Date(ms);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Shortens an Ethereum address for UI display.
 * Example: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" -> "0xf39F...2266"
 */
export function shortenAddress(address: string, chars = 4): string {
  if (!address || address.length < chars * 2 + 2) return address || "";
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}
