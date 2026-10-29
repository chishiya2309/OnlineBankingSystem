import { describe, it, expect, vi } from "vitest";
import { getContractAddresses, verifyContractBytecode } from "../lib/contracts";
// Stable fixtures verify chain selection independently of redeployed addresses.
vi.mock("../contracts/networks.json", () => ({ default: {
  "31337": { contracts: {
    MockUSDC: "0x1111111111111111111111111111111111111111",
    VaultManager: "0x2222222222222222222222222222222222222222",
    SavingCore: "0x3333333333333333333333333333333333333333",
  } },
  "11155111": { contracts: {
    MockUSDC: "0x4444444444444444444444444444444444444444",
    VaultManager: "0x5555555555555555555555555555555555555555",
    SavingCore: "0x6666666666666666666666666666666666666666",
  } },
} }));
import {
  isSupportedNetwork,
  getNetworkConfig,
  getAddChainParams,
  SUPPORTED_NETWORKS,
} from "../config/networks";

describe("Contracts & Network Registry (FE-001, FE-002, FE-016)", () => {
  it("FE-001: contract configuration selects correct contracts for Localhost 31337", () => {
    const contracts = getContractAddresses(31337);
    expect(contracts).not.toBeNull();
    expect(contracts?.MockUSDC).toBe("0x1111111111111111111111111111111111111111");
    expect(contracts?.VaultManager).toBe("0x2222222222222222222222222222222222222222");
    expect(contracts?.SavingCore).toBe("0x3333333333333333333333333333333333333333");
  });

  it("FE-001: contract configuration selects correct contracts for Sepolia 11155111", () => {
    const contracts = getContractAddresses(11155111);
    expect(contracts).not.toBeNull();
    expect(contracts?.MockUSDC).toBe("0x4444444444444444444444444444444444444444");
    expect(contracts?.VaultManager).toBe("0x5555555555555555555555555555555555555555");
    expect(contracts?.SavingCore).toBe("0x6666666666666666666666666666666666666666");
  });

  it("FE-001: returns null for unsupported chain ID", () => {
    expect(getContractAddresses(1)).toBeNull();
    expect(getContractAddresses(137)).toBeNull();
  });

  it("FE-002: verifies supported vs unsupported chain IDs", () => {
    expect(isSupportedNetwork(31337)).toBe(true);
    expect(isSupportedNetwork(11155111)).toBe(true);
    expect(isSupportedNetwork(1)).toBe(false);
    expect(isSupportedNetwork(56)).toBe(false);

    const localConfig = getNetworkConfig(31337);
    expect(localConfig?.displayName).toBe("Hardhat Localhost");
    const sepoliaConfig = getNetworkConfig(11155111);
    expect(sepoliaConfig?.displayName).toBe("Ethereum Sepolia");
  });

  it("FE-002: generates valid EIP-3085 add chain parameters for MetaMask", () => {
    const params = getAddChainParams(31337);
    expect(params).not.toBeNull();
    expect(params?.chainId).toBe("0x7a69"); // 31337 in hex
    expect(params?.chainName).toBe(SUPPORTED_NETWORKS[31337].displayName);
    expect(params?.rpcUrls).toContain("http://127.0.0.1:8545");
  });

  it("FE-016: detects stale deployment when getCode returns 0x", async () => {
    const mockProvider = {
      getCode: vi.fn().mockResolvedValue("0x"),
    } as any;

    const hasBytecode = await verifyContractBytecode(
      mockProvider,
      "0x5FbDB2315678afecb367f032d93F642f64180aa3"
    );
    expect(hasBytecode).toBe(false);
  });

  it("FE-016: verifies deployed contracts when runtime bytecode exists", async () => {
    const mockProvider = {
      getCode: vi.fn().mockResolvedValue("0x608060405234801561001057600080fd5b50"),
    } as any;

    const hasBytecode = await verifyContractBytecode(
      mockProvider,
      "0x5FbDB2315678afecb367f032d93F642f64180aa3"
    );
    expect(hasBytecode).toBe(true);
  });
});
