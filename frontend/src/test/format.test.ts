import { describe, it, expect } from "vitest";
import {
  formatUSDC,
  parseUSDC,
  formatBps,
  formatDurationDays,
  shortenAddress,
} from "../lib/format";
import {
  calculateContractualInterest,
  calculatePenalty,
} from "../lib/financials";

describe("Token & Financial Formatters (FE-005, FE-006)", () => {
  it("FE-005: formats 6-decimal units accurately into locale string", () => {
    expect(formatUSDC(1000000000n)).toBe("1,000.00");
    expect(formatUSDC(500000000n)).toBe("500.00");
    expect(formatUSDC(1234567n)).toBe("1.23");
    expect(formatUSDC(0n)).toBe("0.00");
  });

  it("FE-005: parses input string with exact 6 decimals precision without float loss", () => {
    expect(parseUSDC("1000")).toBe(1000000000n);
    expect(parseUSDC("500.5")).toBe(500500000n);
    expect(parseUSDC("0.000001")).toBe(1n);
    expect(parseUSDC("1,000.00")).toBe(1000000000n);
  });

  it("FE-005: rejects precision exceeding 6 decimals", () => {
    expect(() => parseUSDC("100.1234567")).toThrowError(
      "Maximum 6 decimal places allowed for USDC"
    );
  });

  it("FE-006: returns 0n for zero, empty, or negative input", () => {
    expect(parseUSDC("0")).toBe(0n);
    expect(parseUSDC("")).toBe(0n);
    expect(parseUSDC("-50")).toBe(0n);
  });

  it("formats APR and penalty basis points into human-readable percentages", () => {
    expect(formatBps(200)).toBe("2.00%");
    expect(formatBps(500)).toBe("5.00%");
    expect(formatBps(350)).toBe("3.50%");
    expect(formatBps(0)).toBe("0.00%");
  });

  it("formats tenor durations correctly", () => {
    expect(formatDurationDays(180)).toBe("6 months (180 days)");
    expect(formatDurationDays(360)).toBe("360 days");
    expect(formatDurationDays(90)).toBe("3 months (90 days)");
  });

  it("shortens Ethereum addresses properly", () => {
    expect(
      shortenAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
    ).toBe("0xf39F...2266");
  });

  it("calculates contractual interest matching SavingCore MulDiv exactly", () => {
    // 1,000 USDC principal, 200 bps (2.00%), 180 days
    // Expected: 1000 * 200 * (180 * 86400) / (10000 * 365 * 86400)
    // = 200000 * 180 / (10000 * 365) = 36000000 / 3650000 = 9.863013 USDC -> 9,863,013 units
    const principal = parseUSDC("1000");
    const interest = calculateContractualInterest(principal, 200, 180);
    expect(interest).toBe(9863013n);
    expect(formatUSDC(interest)).toBe("9.86");
  });

  it("calculates early withdrawal penalty matching SavingCore MulDiv exactly", () => {
    // 1,000 USDC principal, 350 bps (3.50%) penalty
    // Expected: 1000 * 350 / 10000 = 35 USDC -> 35,000,000 units
    const principal = parseUSDC("1000");
    const penalty = calculatePenalty(principal, 350);
    expect(penalty).toBe(35000000n);
    expect(formatUSDC(penalty)).toBe("35.00");
  });
});
