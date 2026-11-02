import React from "react";
import type { WalletState } from "../../hooks/useWallet";
import { getNetworkConfig, setPreferredChainId } from "../../config/networks";
import { shortenAddress } from "../../lib/format";
import { Icon } from "./Icon";

interface HeaderProps {
  wallet: WalletState;
  isBankAdmin?: boolean;
  title: string;
  isMenuOpen: boolean;
  onToggleMenu: () => void;
}

export const Header: React.FC<HeaderProps> = ({ wallet, isBankAdmin = false, title, isMenuOpen, onToggleMenu }) => {
  const { account, chainId, isConnecting, isConnected, isCorrectNetwork, connect, disconnect, switchNetwork } = wallet;
  const currentNetwork = chainId ? getNetworkConfig(chainId) : undefined;

  const targetSwitchChainId = chainId === 11155111 ? 31337 : 11155111;
  const targetSwitchName = chainId === 11155111 ? "Localhost" : "Sepolia";

  return (
    <header className="app-header">
      <div className="app-container header-inner">
        <div className="header-heading">
          <button id="navigation-toggle" type="button" className="btn btn-ghost menu-toggle" aria-label={isMenuOpen ? "Close navigation" : "Open navigation"} aria-expanded={isMenuOpen} aria-controls="app-navigation" onClick={onToggleMenu}>
            <Icon name={isMenuOpen ? "close" : "menu"} />
          </button>
          <div className="header-title-group">
            <div className="mobile-brand">
              <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="LEDGER Logo" width="24" height="24" />
              <span>LEDGER</span>
            </div>
            <h1 className="page-title">{title}</h1>
          </div>
        </div>

        <div className="header-actions">
          {isConnected && (
            <>
              {isCorrectNetwork && currentNetwork ? (
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <div className={`network-badge ${currentNetwork.name === "localhost" ? "local" : "sepolia"}`}>
                    <span>{currentNetwork.displayName}</span>
                  </div>

                  <button
                    type="button"
                    className="btn btn-ghost btn-sm text-nowrap"
                    onClick={() => {
                      setPreferredChainId(targetSwitchChainId);
                      switchNetwork(targetSwitchChainId);
                    }}
                    title={`Switch network to ${targetSwitchName}`}
                    style={{ whiteSpace: "nowrap" }}
                  >
                    To {targetSwitchName}
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                  <span className="network-badge wrong text-nowrap" style={{ whiteSpace: "nowrap" }}>
                    Wrong Network
                  </span>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm text-nowrap"
                    onClick={() => {
                      setPreferredChainId(11155111);
                      switchNetwork(11155111);
                    }}
                    style={{ whiteSpace: "nowrap" }}
                    title="Switch to Ethereum Sepolia"
                  >
                    To Sepolia
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm text-nowrap"
                    onClick={() => {
                      setPreferredChainId(31337);
                      switchNetwork(31337);
                    }}
                    style={{ whiteSpace: "nowrap" }}
                    title="Switch to Hardhat Localhost"
                  >
                    To Localhost
                  </button>
                </div>
              )}

              {isBankAdmin && (
                <span className="badge-pill active text-nowrap" style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>
                  Bank Admin
                </span>
              )}
            </>
          )}

          {isConnected && account ? (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div className="btn btn-secondary btn-sm tabular-num text-nowrap" title={account} style={{ whiteSpace: "nowrap" }}>
                {shortenAddress(account)}
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm text-nowrap"
                onClick={disconnect}
                title="Disconnect Wallet"
                style={{ whiteSpace: "nowrap" }}
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
              style={{ whiteSpace: "nowrap" }}
            >
              {isConnecting ? "Connecting…" : "Connect MetaMask"}
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
