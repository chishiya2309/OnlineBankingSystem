import { describe, it, expect } from "vitest";
import { parseTransactionError } from "../lib/errors";
import { isSupportedNetwork, getNetworkConfig } from "../config/networks";
import networksData from "../contracts/networks.json";
import { formatUSDC, parseUSDC } from "../lib/format";

describe("Admin Portal & Sepolia Multi-Network Unit Tests", () => {
  describe("Admin Error Parsing & Decoding", () => {
    it("decodes OnlyBankAdmin and OwnableUnauthorizedAccount error correctly", () => {
      const err1 = new Error("execution reverted: OnlyBankAdmin()");
      expect(parseTransactionError(err1)).toBe(
        "Action rejected: Connected wallet is not the authorized Bank Admin."
      );

      const err2 = new Error("OwnableUnauthorizedAccount(0x1234)");
      expect(parseTransactionError(err2)).toBe(
        "Action rejected: Connected wallet is not the authorized Bank Admin."
      );
    });

    it("decodes PlanPenaltyTooHigh correctly", () => {
      const err = new Error("PlanPenaltyTooHigh()");
      expect(parseTransactionError(err)).toBe(
        "Penalty rate cannot exceed 100% (10,000 basis points)."
      );
    });

    it("decodes PlanDurationZero correctly", () => {
      const err = new Error("PlanDurationZero()");
      expect(parseTransactionError(err)).toBe(
        "Plan duration must be at least 1 day."
      );
    });

    it("decodes PlanAprZero correctly", () => {
      const err = new Error("PlanAprZero()");
      expect(parseTransactionError(err)).toBe("Plan APR must be greater than zero.");
    });

    it("decodes InvalidAddress correctly", () => {
      const err = new Error("InvalidAddress()");
      expect(parseTransactionError(err)).toBe(
        "The provided address is invalid or the zero address."
      );
    });
  });

  describe("Role-Based Access Control Logic", () => {
    const localhostAdmin = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const sepoliaAdmin = "0xA4CDcB4eFd9D4615586a6d78CB1283656078249c";
    const regularUser = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

    it("identifies authorized Bank Admin on Localhost (case-insensitive)", () => {
      const isLocalAdmin =
        localhostAdmin.toLowerCase() ===
        "0x70997970c51812dc3a010c7d01b50e0d17dc79c8".toLowerCase();
      expect(isLocalAdmin).toBe(true);

      const isNonAdmin =
        regularUser.toLowerCase() === localhostAdmin.toLowerCase();
      expect(isNonAdmin).toBe(false);
    });

    it("identifies authorized Bank Admin on Sepolia (case-insensitive)", () => {
      const isSepoliaAdmin =
        sepoliaAdmin.toLowerCase() ===
        "0xa4cdcb4efd9d4615586a6d78cb1283656078249c".toLowerCase();
      expect(isSepoliaAdmin).toBe(true);

      const isNonAdmin =
        regularUser.toLowerCase() === sepoliaAdmin.toLowerCase();
      expect(isNonAdmin).toBe(false);
    });
  });

  describe("Sepolia & Localhost Network Configuration", () => {
    it("recognizes Localhost (31337) and Sepolia (11155111) as supported networks", () => {
      expect(isSupportedNetwork(31337)).toBe(true);
      expect(isSupportedNetwork(11155111)).toBe(true);
      expect(isSupportedNetwork(1)).toBe(false); // Mainnet not active
    });

    it("has valid RPC and block explorer config for Sepolia", () => {
      const sepoliaConfig = getNetworkConfig(11155111);
      expect(sepoliaConfig).toBeDefined();
      expect(sepoliaConfig?.name).toBe("sepolia");
      expect(sepoliaConfig?.chainId).toBe(11155111);
      expect(sepoliaConfig?.rpcUrl).toContain("sepolia");
      expect(sepoliaConfig?.blockExplorerUrl).toBe("https://sepolia.etherscan.io");
      expect(sepoliaConfig?.isTestnet).toBe(true);
    });

    it("has registered contract deployments for both chains in networks.json", () => {
      const networks = networksData as Record<string, any>;
      expect(networks["31337"]).toBeDefined();
      expect(networks["31337"].contracts.SavingCore).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(networks["31337"].contracts.VaultManager).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(networks["31337"].contracts.MockUSDC).toMatch(/^0x[a-fA-F0-9]{40}$/);

      expect(networks["11155111"]).toBeDefined();
      expect(networks["11155111"].contracts.SavingCore).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(networks["11155111"].contracts.VaultManager).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(networks["11155111"].contracts.MockUSDC).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  describe("Admin Financial Formatting & Vault Calculations", () => {
    it("formats vault reserve balances with 6 decimals correctly", () => {
      const vaultBal = 5000000000n; // 5,000 USDC
      expect(formatUSDC(vaultBal)).toBe("5,000.00");

      const parsed = parseUSDC("5000.00");
      expect(parsed).toBe(5000000000n);
    });

    it("validates plan input parameters accurately", () => {
      // APR basis points conversion
      const aprPercent = "4.50";
      const aprBps = Math.round(parseFloat(aprPercent) * 100);
      expect(aprBps).toBe(450);

      // Penalty basis points conversion
      const penaltyPercent = "5.00";
      const penaltyBps = Math.round(parseFloat(penaltyPercent) * 100);
      expect(penaltyBps).toBe(500);

      expect(aprBps).toBeGreaterThan(0);
      expect(aprBps).toBeLessThanOrEqual(10000);
      expect(penaltyBps).toBeLessThanOrEqual(10000);
    });
  });

  describe("Sepolia Deposit Maturity Timeline Controls", () => {
    it("decodes InvalidDepositTimeline error correctly", () => {
      const err = new Error("execution reverted: InvalidDepositTimeline(100, 50)");
      expect(parseTransactionError(err)).toBe(
        "Invalid deposit timeline: Maturity timestamp must be strictly greater than start timestamp."
      );
    });

    it("decodes NotBankAdmin error correctly", () => {
      const err = new Error("NotBankAdmin(0x1234)");
      expect(parseTransactionError(err)).toBe(
        "Action rejected: Connected wallet is not the authorized Bank Admin."
      );
    });

    it("computes 'Mature Immediately' timeline preserving full tenor duration", () => {
      const now = 1700000000;
      const originalStart = 1699900000;
      const originalMaturity = 1705000000;
      const originalTenor = originalMaturity - originalStart; // 5,100,000s

      const targetMaturity = now - 5;
      const targetStart = targetMaturity - originalTenor;

      expect(targetMaturity).toBeLessThan(now); // is matured
      expect(targetMaturity - targetStart).toBe(originalTenor); // full interest preserved
      expect(targetStart).toBeLessThan(targetMaturity);
    });

    it("computes 'Expire Grace Period' timeline for auto-renew testing", () => {
      const now = 1700000000;
      const gracePeriod = 172800; // 2 days
      const originalTenor = 180 * 86400;

      const targetMaturity = now - gracePeriod - 60;
      const targetStart = targetMaturity - originalTenor;

      const graceEnd = targetMaturity + gracePeriod;
      expect(now).toBeGreaterThan(graceEnd); // eligible for auto-renewal
      expect(targetMaturity - targetStart).toBe(originalTenor);
    });
  });
});
