import React from "react";
import { formatUSDC } from "../../lib/format";

interface AccountOverviewProps {
  isConnected: boolean;
  balance: bigint;
  allowance: bigint;
  planCount: number;
  isStaleDeployment: boolean;
  isMinting: boolean;
  onMintDemoTokens: () => void;
}

export const AccountOverview: React.FC<AccountOverviewProps> = ({
  isConnected,
  balance,
  allowance,
  planCount,
  isStaleDeployment,
  isMinting,
  onMintDemoTokens,
}) => {
  return (
    <div>
      {isStaleDeployment && (
        <div className="alert-banner error" role="alert">
          <div>
            <strong>Deployment Not Found on Connected Node:</strong> No contract runtime bytecode was detected at the configured addresses. Please redeploy and re-export manifests (`npx hardhat run scripts/deploy.ts --network localhost`).
          </div>
        </div>
      )}

      <div className="overview-grid">
        <div className="overview-card">
          <div className="overview-label">Available MockUSDC Balance</div>
          <div className="overview-value tabular-num">
            {isConnected ? formatUSDC(balance) : "0.00"} <span style={{ fontSize: "16px", color: "var(--color-muted)" }}>USDC</span>
          </div>
          <div className="overview-detail" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Demo ERC20 (6 Decimals)</span>
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
            {isConnected ? formatUSDC(allowance) : "0.00"} <span style={{ fontSize: "16px", color: "var(--color-muted)" }}>USDC</span>
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
    </div>
  );
};
