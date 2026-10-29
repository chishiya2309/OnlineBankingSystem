import { ethers } from "ethers";

/**
 * Formats 6-decimal token units to human-readable locale string with 2 decimal places.
 * Example: 1000000000n -> "1,000.00"
 */
export function formatUSDC(rawUnits: bigint | string | number | undefined | null, decimals: 2 | 6 = 2): string {
  const zero = `0.${"0".repeat(decimals)}`;
  if (rawUnits === undefined || rawUnits === null) return zero;
  try {
    const rawBigInt = typeof rawUnits === "bigint" ? rawUnits : BigInt(rawUnits.toString());
    const formatted = ethers.formatUnits(rawBigInt, 6);
    const parts = formatted.split(".");
    const whole = BigInt(parts[0]).toLocaleString("en-US");
    const decimal = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
    return `${whole}.${decimal}`;
  } catch {
    return zero;
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

/** Exact duration, including sub-day terms; never rounds a short plan to zero days. */
export function formatDurationSeconds(seconds: number): string {
  let remaining = seconds;
  const parts: string[] = [];
  for (const [size, unit] of [[86400, "day"], [3600, "hour"], [60, "minute"], [1, "second"]] as const) {
    const value = Math.floor(remaining / size);
    if (value > 0) parts.push(`${value} ${unit}${value === 1 ? "" : "s"}`);
    remaining %= size;
  }
  return parts.join(" ") || "0 seconds";
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
    second: "2-digit",
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
