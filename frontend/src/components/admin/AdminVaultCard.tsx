import React, { useState } from "react";
import type { AdminSummary, AdminActionStatus } from "../../types";

interface AdminVaultCardProps {
  summary: AdminSummary;
  status: AdminActionStatus;
  onFundVault: (amount: string) => Promise<boolean>;
  onWithdrawLiquidity: (amount: string) => Promise<boolean>;
  onMintDemoTokens: (amount: string) => Promise<boolean>;
}

export const AdminVaultCard: React.FC<AdminVaultCardProps> = ({
  summary,
  status,
  onFundVault,
  onWithdrawLiquidity,
  onMintDemoTokens,
}) => {
  const [fundAmount, setFundAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [isMinting, setIsMinting] = useState(false);

  const isBusy = status === "awaiting-signature" || status === "pending" || isMinting;

  const handleFundSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fundAmount.trim()) return;
    const ok = await onFundVault(fundAmount.trim());
    if (ok) {
      setFundAmount("");
    }
  };

  const handleWithdrawSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!withdrawAmount.trim()) return;
    const ok = await onWithdrawLiquidity(withdrawAmount.trim());
    if (ok) {
      setWithdrawAmount("");
    }
  };

  const handleQuickMint = async () => {
    try {
      setIsMinting(true);
      await onMintDemoTokens("5000");
    } finally {
      setIsMinting(false);
    }
  };

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <h3 className="admin-card-title">Vault liquidity reserves</h3>
        <button
          type="button"
          className="btn btn-ghost btn-sm text-nowrap"
          onClick={handleQuickMint}
          disabled={isBusy}
          title="Mint 5,000 MockUSDC to Admin wallet for liquidity operations"
          style={{ whiteSpace: "nowrap" }}
        >
          {isMinting ? "Minting…" : "+ Mint 5,000 test USDC"}
        </button>
      </div>

      <p className="admin-card-desc">
        The bank vault holds liquidity dedicated to paying accrued interest upon deposit maturity. User principal is strictly segregated in SavingCore.
      </p>

      {/* Reserves Stat Grid */}
      <div className="admin-stat-grid" style={{ marginBottom: "20px" }}>
        <div className="admin-stat-item">
          <span className="admin-stat-label">Vault interest pool</span>
          <span className="admin-stat-val tabular-num">
            {summary.vaultBalanceFormatted}{" "}
            <span className="body-sm" style={{ color: "var(--color-muted)" }}>USDC</span>
          </span>
        </div>
        <div className="admin-stat-item">
          <span className="admin-stat-label">Bank admin wallet balance</span>
          <span className="admin-stat-val tabular-num">
            {summary.adminUSDCBalanceFormatted}{" "}
            <span className="body-sm" style={{ color: "var(--color-muted)" }}>USDC</span>
          </span>
        </div>
      </div>

      {/* Fund Vault Form */}
      <div className="admin-action-box" style={{ marginBottom: "20px" }}>
        <div className="admin-action-info" style={{ marginBottom: "12px" }}>
          <span className="admin-action-label">Fund vault liquidity</span>
          <span className="admin-action-sub">
            Deposit MockUSDC into the vault pool. The contract will automatically request approval if needed.
          </span>
        </div>

        <form onSubmit={handleFundSubmit} className="admin-inline-form">
          <input
            type="number"
            step="any"
            min="1"
            className="input-field tabular-num"
            placeholder="Amount (e.g. 1000)"
            value={fundAmount}
            onChange={(e) => setFundAmount(e.target.value)}
            disabled={isBusy}
          />
          <button
            type="submit"
            className="btn btn-primary btn-sm text-nowrap"
            disabled={isBusy || !fundAmount.trim()}
            style={{ whiteSpace: "nowrap" }}
          >
            {isBusy ? "Processing…" : "Fund vault"}
          </button>
        </form>
      </div>

      {/* Withdraw Liquidity Form */}
      <div className="admin-action-box">
        <div className="admin-action-info" style={{ marginBottom: "12px" }}>
          <span className="admin-action-label">Withdraw surplus liquidity</span>
          <span className="admin-action-sub">
            Withdraw liquidity from the vault to the connected bank admin wallet. This operation does not reserve future interest.
          </span>
        </div>

        <form onSubmit={handleWithdrawSubmit} className="admin-stacked-form">
          <div className="admin-input-row">
            <input
              type="number"
              step="any"
              min="1"
              className="input-field tabular-num"
              placeholder="Amount (e.g. 500)"
              value={withdrawAmount}
              onChange={(e) => setWithdrawAmount(e.target.value)}
              disabled={isBusy}
            />
          </div>
          <button
            type="submit"
            className="btn btn-secondary btn-sm text-nowrap"
            disabled={isBusy || !withdrawAmount.trim()}
            style={{ alignSelf: "flex-end", whiteSpace: "nowrap" }}
          >
            {isBusy ? "Processing…" : "Withdraw liquidity"}
          </button>
        </form>
      </div>
    </div>
  );
};
