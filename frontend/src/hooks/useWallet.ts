import { useState, useEffect, useCallback, useMemo } from "react";
import { ethers } from "ethers";
import { isSupportedNetwork, getAddChainParams } from "../config/networks";
import { parseTransactionError } from "../lib/errors";

export interface WalletState {
  account: string | null;
  chainId: number | null;
  isConnecting: boolean;
  isConnected: boolean;
  isCorrectNetwork: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchNetwork: (targetChainId: number) => Promise<boolean>;
  browserProvider: ethers.BrowserProvider | null;
  signer: ethers.Signer | null;
}

export function useWallet(): WalletState {
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [signer, setSigner] = useState<ethers.Signer | null>(null);

  const browserProvider = useMemo(() => {
    if (typeof window !== "undefined" && window.ethereum) {
      return new ethers.BrowserProvider(window.ethereum);
    }
    return null;
  }, []);

  const updateWalletState = useCallback(async (provider: ethers.BrowserProvider) => {
    try {
      const network = await provider.getNetwork();
      const currentChainId = Number(network.chainId);
      setChainId(currentChainId);

      const accounts = await provider.listAccounts();
      if (accounts.length > 0) {
        const activeSigner = await provider.getSigner();
        setAccount(accounts[0].address);
        setSigner(activeSigner);
      } else {
        setAccount(null);
        setSigner(null);
      }
      setError(null);
    } catch (err) {
      console.error("Failed to update wallet state:", err);
      setError(parseTransactionError(err));
    }
  }, []);

  // Initialize and attach listeners
  useEffect(() => {
    if (!window.ethereum || !browserProvider) return;

    updateWalletState(browserProvider);

    const handleAccountsChanged = (accounts: string[]) => {
      if (accounts.length === 0) {
        setAccount(null);
        setSigner(null);
      } else {
        updateWalletState(browserProvider);
      }
    };

    const handleChainChanged = () => {
      // Refresh provider on chain change
      window.location.reload();
    };

    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);

    return () => {
      if (window.ethereum?.removeListener) {
        window.ethereum.removeListener("accountsChanged", handleAccountsChanged);
        window.ethereum.removeListener("chainChanged", handleChainChanged);
      }
    };
  }, [browserProvider, updateWalletState]);

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setError("MetaMask or compatible Web3 wallet not detected. Please install MetaMask to use this application.");
      return;
    }

    try {
      setIsConnecting(true);
      setError(null);

      const accounts = await window.ethereum.request({
        method: "eth_requestAccounts",
      });

      if (accounts && accounts.length > 0 && browserProvider) {
        await updateWalletState(browserProvider);
      }
    } catch (err: any) {
      console.error("User rejected wallet connection:", err);
      setError(parseTransactionError(err));
    } finally {
      setIsConnecting(false);
    }
  }, [browserProvider, updateWalletState]);

  const disconnect = useCallback(() => {
    setAccount(null);
    setSigner(null);
    setError(null);
  }, []);

  const switchNetwork = useCallback(async (targetChainId: number): Promise<boolean> => {
    if (!window.ethereum) {
      setError("MetaMask not detected.");
      return false;
    }

    try {
      setError(null);
      const hexChainId = `0x${targetChainId.toString(16)}`;

      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: hexChainId }],
        });
        return true;
      } catch (switchError: any) {
        // Error code 4902 indicates chain has not been added to MetaMask
        if (switchError.code === 4902 || switchError.code === -32603) {
          const addParams = getAddChainParams(targetChainId);
          if (addParams) {
            await window.ethereum.request({
              method: "wallet_addEthereumChain",
              params: [addParams],
            });
            return true;
          }
        }
        throw switchError;
      }
    } catch (err: any) {
      console.error("Failed to switch network:", err);
      setError(parseTransactionError(err));
      return false;
    }
  }, []);

  const isConnected = Boolean(account && signer);
  const isCorrectNetwork = Boolean(chainId && isSupportedNetwork(chainId));

  return {
    account,
    chainId,
    isConnecting,
    isConnected,
    isCorrectNetwork,
    error,
    connect,
    disconnect,
    switchNetwork,
    browserProvider,
    signer,
  };
}
