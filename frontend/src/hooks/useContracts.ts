import { useState, useEffect, useMemo } from "react";
import { ethers } from "ethers";
import {
  getContractInstances,
  verifyContractBytecode,
} from "../lib/contracts";
import { SUPPORTED_NETWORKS, DEFAULT_CHAIN_ID } from "../config/networks";
import type { ContractAddresses } from "../types";

export interface ContractsState {
  mockUSDC: ethers.Contract | null;
  savingCore: ethers.Contract | null;
  vaultManager: ethers.Contract | null;
  addresses: ContractAddresses | null;
  isStaleDeployment: boolean;
  isValidating: boolean;
  provider: ethers.Provider;
}

export function useContracts(
  chainId: number | null,
  signer: ethers.Signer | null,
  browserProvider: ethers.BrowserProvider | null
): ContractsState {
  const activeChainId = chainId && chainId in SUPPORTED_NETWORKS ? chainId : DEFAULT_CHAIN_ID;
  const [isStaleDeployment, setIsStaleDeployment] = useState<boolean>(false);
  const [isValidating, setIsValidating] = useState<boolean>(false);

  // Fallback JSON-RPC provider for read-only operations when wallet is not connected
  const provider = useMemo(() => {
    if (browserProvider && chainId && chainId in SUPPORTED_NETWORKS) {
      return browserProvider;
    }
    const rpcUrl = SUPPORTED_NETWORKS[activeChainId]?.rpcUrl || "http://127.0.0.1:8545";
    return new ethers.JsonRpcProvider(rpcUrl);
  }, [browserProvider, chainId, activeChainId]);

  const contractInstances = useMemo(() => {
    const runner = signer || provider;
    return getContractInstances(activeChainId, runner);
  }, [activeChainId, signer, provider]);

  // Bytecode verification guard against stale manifests
  useEffect(() => {
    let cancelled = false;

    async function checkBytecode() {
      if (!contractInstances?.addresses) {
        setIsStaleDeployment(true);
        return;
      }

      setIsValidating(true);
      try {
        const { MockUSDC, SavingCore, VaultManager } = contractInstances.addresses;
        const [hasTokenCode, hasCoreCode, hasVaultCode] = await Promise.all([
          verifyContractBytecode(provider, MockUSDC),
          verifyContractBytecode(provider, SavingCore),
          verifyContractBytecode(provider, VaultManager),
        ]);

        if (!cancelled) {
          const isStale = !hasTokenCode || !hasCoreCode || !hasVaultCode;
          setIsStaleDeployment(isStale);
          if (isStale) {
            console.warn("Bytecode check failed: One or more contracts are missing from the connected chain.");
          }
        }
      } catch (err) {
        console.error("Error verifying contract bytecode:", err);
        if (!cancelled) setIsStaleDeployment(true);
      } finally {
        if (!cancelled) setIsValidating(false);
      }
    }

    checkBytecode();

    return () => {
      cancelled = true;
    };
  }, [provider, contractInstances]);

  return {
    mockUSDC: contractInstances?.mockUSDC ?? null,
    savingCore: contractInstances?.savingCore ?? null,
    vaultManager: contractInstances?.vaultManager ?? null,
    addresses: contractInstances?.addresses ?? null,
    isStaleDeployment,
    isValidating,
    provider,
  };
}
