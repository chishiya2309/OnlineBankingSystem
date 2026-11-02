import React from "react";
import { formatUSDC } from "../../lib/format";
import { Icon } from "../layout/Icon";

interface AccountOverviewProps {
  isConnected: boolean;
  balance: bigint;
  allowance: bigint;
  planCount: number;
  isStaleDeployment: boolean;
  isMinting: boolean;
  tokenAddress?: string | null;
  onMintDemoTokens: () => void;
}

export const AccountOverview: React.FC<AccountOverviewProps> = ({
  isConnected,
  balance,
  allowance,
  planCount,
  isStaleDeployment,
  isMinting,
  tokenAddress,
  onMintDemoTokens,
}) => {
  const handleWatchToken = async () => {
    if (!tokenAddress || typeof window === "undefined" || !window.ethereum) return;
    try {
      await window.ethereum.request({
        method: "wallet_watchAsset",
        params: {
          type: "ERC20",
          options: {
            address: tokenAddress,
            symbol: "USDC",
            decimals: 6,
          },
        },
      });
    } catch (err) {
      console.warn("Could not add token to MetaMask:", err);
    }
  };

  return (
    <section className="account-overview" aria-label="Account overview">
      {isStaleDeployment && (
        <div className="alert-banner error" role="alert">
          <div>
            <strong>Deployment Not Found on Connected Node:</strong> No contract runtime bytecode was detected at the configured addresses. Please verify contract addresses or check your network connection.
          </div>
        </div>
      )}

      <div className="overview-grid account-grid">
        <div className="overview-card balance-overview">
          <div className="overview-label">Available MockUSDC Balance</div>
          <div className="overview-value tabular-num">
            {isConnected ? formatUSDC(balance, "auto") : "0.00"} <span style={{ fontSize: "16px", color: "var(--color-muted)" }}>USDC</span>
          </div>
          <div className="overview-detail" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span>Demo ERC20 (6 Decimals)</span>
              {isConnected && tokenAddress && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm text-nowrap"
                  onClick={handleWatchToken}
                  title="Import MockUSDC token into your MetaMask wallet"
                  style={{ padding: "4px 8px", fontSize: "13px", height: "auto" }}
                >
                  <Icon name="wallet" size={16} /> Add to MetaMask
                </button>
              )}
            </div>
            {isConnected && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={onMintDemoTokens}
                disabled={isMinting || isStaleDeployment}
                title="Mint 1,000 MockUSDC for testing"
              >
                {isMinting ? "Minting..." : "+ Mint 1,000 USDC"}
              </button>
            )}
          </div>
        </div>

        <div className="overview-card">
          <div className="overview-label">Approved Allowance (SavingCore)</div>
          <div className="overview-value tabular-num">
            {isConnected ? formatUSDC(allowance, "auto") : "0.00"} <span style={{ fontSize: "16px", color: "var(--color-muted)" }}>USDC</span>
          </div>
          <div className="overview-detail">
            {allowance > 0n ? "Sufficient for approved deposit amount" : "Approval requested upon deposit"}
          </div>
        </div>

        <div className="overview-card">
          <div className="overview-label">Available Term Deposit Plans</div>
          <div className="overview-value tabular-num">
            {planCount > 0 ? planCount : "0"} <span style={{ fontSize: "16px", color: "var(--color-muted)" }}>Plans</span>
          </div>
          <div className="overview-detail">
            Loaded in real-time from SavingCore contract
          </div>
        </div>
      </div>
    </section>
  );
};
