import type { NetworkConfig } from "../types";

export const SUPPORTED_NETWORKS: Record<number, NetworkConfig> = {
  31337: {
    chainId: 31337,
    name: "localhost",
    displayName: "Hardhat Localhost",
    rpcUrl: "http://127.0.0.1:8545",
    currencySymbol: "ETH",
    isTestnet: true,
  },
  11155111: {
    chainId: 11155111,
    name: "sepolia",
    displayName: "Ethereum Sepolia",
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    currencySymbol: "ETH",
    blockExplorerUrl: "https://sepolia.etherscan.io",
    isTestnet: true,
  },
};

export const DEFAULT_CHAIN_ID = 31337;

export function getNetworkConfig(chainId: number): NetworkConfig | undefined {
  return SUPPORTED_NETWORKS[chainId];
}

export function isSupportedNetwork(chainId: number): boolean {
  return chainId in SUPPORTED_NETWORKS;
}

export function getAddChainParams(chainId: number) {
  const config = SUPPORTED_NETWORKS[chainId];
  if (!config) return null;

  return {
    chainId: `0x${chainId.toString(16)}`,
    chainName: config.displayName,
    nativeCurrency: {
      name: config.currencySymbol,
      symbol: config.currencySymbol,
      decimals: 18,
    },
    rpcUrls: [config.rpcUrl],
    blockExplorerUrls: config.blockExplorerUrl ? [config.blockExplorerUrl] : undefined,
  };
}
