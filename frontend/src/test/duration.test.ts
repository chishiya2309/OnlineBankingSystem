import { describe, expect, it } from "vitest";
import { formatDurationSeconds, formatUSDC } from "../lib/format";
import { calculateInterestFromSeconds } from "../lib/financials";
import { SAVING_CORE_ABI } from "../lib/contracts";
import { Interface } from "ethers";

describe("Exact short plan durations and immutable contract API", () => {
  it.each([[5, "5 seconds"], [60, "1 minute"], [90, "1 minute 30 seconds"], [120, "2 minutes"], [180 * 86400, "180 days"]])(
    "formats %s seconds without rounding to whole days", (seconds, expected) => {
      expect(formatDurationSeconds(Number(seconds))).toBe(expected);
    }
  );
  it("shows the three smallest interest units from a five-second term", () => {
    const interest = calculateInterestFromSeconds(1000_000000n, 200, 5);
    expect(interest).toBe(3n);
    expect(formatUSDC(interest, 6)).toBe("0.000003");
    expect(formatUSDC(1000_000000n + interest, 6)).toBe("1,000.000003");
  });
  it("formats large integer balances without losing integer precision", () => {
    expect(formatUSDC(9007199254740993_000003n, 6)).toBe("9,007,199,254,740,993.000003");
  });
  it("exports short plan creation and removes the deposit editing API", () => {
    const abi = new Interface(SAVING_CORE_ABI);
    expect(abi.hasFunction("createPlanSeconds")).toBe(true);
    expect(abi.hasFunction("planDurationSeconds")).toBe(true);
    expect(abi.hasFunction("setDepositTimeline")).toBe(false);
    expect(abi.hasEvent("DepositTimelineUpdated")).toBe(false);
  });
});
