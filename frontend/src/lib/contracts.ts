import { ethers } from "ethers";
import type { ContractAddresses } from "../types";

import MockUSDCExport from "../contracts/MockUSDC.json";
import SavingCoreExport from "../contracts/SavingCore.json";
import VaultManagerExport from "../contracts/VaultManager.json";
import networksData from "../contracts/networks.json";

export const MOCK_USDC_ABI = MockUSDCExport.abi;
export const SAVING_CORE_ABI = SavingCoreExport.abi;
export const VAULT_MANAGER_ABI = VaultManagerExport.abi;

interface NetworkEntry {
  name: string;
  chainId: number;
  contracts: ContractAddresses;
}

const networksMap = networksData as Record<string, NetworkEntry>;

/**
 * Returns contract addresses registered for the given chainId.
 */
export function getContractAddresses(chainId: number): ContractAddresses | null {
  const entry = networksMap[chainId.toString()];
  if (!entry || !entry.contracts) {
    return null;
  }
  return entry.contracts;
}

/**
 * Verifies that runtime bytecode actually exists on-chain at the specified address.
 * Prevents interacting with stale deployments after local node restart.
 */
export async function verifyContractBytecode(
  provider: ethers.Provider,
  address: string
): Promise<boolean> {
  if (!address || address === ethers.ZeroAddress) return false;
  try {
    const code = await provider.getCode(address);
    return Boolean(code && code !== "0x" && code !== "0x0");
  } catch (err) {
    console.warn(`Failed to query bytecode for ${address}:`, err);
    return false;
  }
}

/**
 * Returns contract instances connected to a provider or signer.
 */
export function getContractInstances(
  chainId: number,
  runner: ethers.ContractRunner
) {
  const addresses = getContractAddresses(chainId);
  if (!addresses) return null;

  const mockUSDC = new ethers.Contract(addresses.MockUSDC, MOCK_USDC_ABI, runner);
  const savingCore = new ethers.Contract(addresses.SavingCore, SAVING_CORE_ABI, runner);
  const vaultManager = new ethers.Contract(addresses.VaultManager, VAULT_MANAGER_ABI, runner);

  return {
    mockUSDC,
    savingCore,
    vaultManager,
    addresses,
  };
}
