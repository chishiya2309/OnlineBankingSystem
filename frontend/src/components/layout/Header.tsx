import React from "react";
import type { WalletState } from "../../hooks/useWallet";
import { getNetworkConfig } from "../../config/networks";
import { shortenAddress } from "../../lib/format";

interface HeaderProps {
  wallet: WalletState;
}

export const Header: React.FC<HeaderProps> = ({ wallet }) => {
  const { account, chainId, isConnecting, isConnected, isCorrectNetwork, connect, disconnect, switchNetwork } = wallet;
  const currentNetwork = chainId ? getNetworkConfig(chainId) : undefined;

  return (
    <header className="app-header">
      <div className="app-container header-inner">
        <div className="wordmark">
          <img
            src="/favicon.svg"
            alt="LEDGER Logo"
            width="28"
            height="28"
            style={{ borderRadius: "7px", flexShrink: 0 }}
          />
          <h1 className="wordmark-title">LEDGER</h1>
          <span className="wordmark-sub">Digital Savings and Term Deposit</span>
        </div>

        <div className="header-actions">
          {isConnected && (
            <>
              {isCorrectNetwork && currentNetwork ? (
                <div className={`network-badge ${currentNetwork.name === "localhost" ? "local" : "sepolia"}`}>
                  <span className="status-dot"></span>
                  <span>{currentNetwork.displayName}</span>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm text-nowrap"
                  onClick={() => switchNetwork(31337)}
                  style={{ whiteSpace: "nowrap" }}
                  title="Switch to Hardhat Localhost"
                >
                  <span className="network-badge wrong text-nowrap" style={{ whiteSpace: "nowrap" }}>Wrong Network: Switch to Localhost</span>
                </button>
              )}
            </>
          )}

          {isConnected && account ? (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div className="btn btn-secondary btn-sm tabular-num text-nowrap" title={account}>
                {shortenAddress(account)}
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm text-nowrap"
                onClick={disconnect}
                title="Disconnect Wallet"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-primary text-nowrap"
              onClick={connect}
              disabled={isConnecting}
            >
              {isConnecting ? "Connecting…" : "Connect MetaMask"}
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
