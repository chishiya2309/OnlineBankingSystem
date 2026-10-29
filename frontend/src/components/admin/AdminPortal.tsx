import React from "react";
import type { SavingPlan } from "../../types";
import { useAdmin } from "../../hooks/useAdmin";
import { shortenAddress } from "../../lib/format";
import { AdminRestrictedState } from "./AdminRestrictedState";
import { AdminSystemCard } from "./AdminSystemCard";
import { AdminVaultCard } from "./AdminVaultCard";
import { AdminPlansManager } from "./AdminPlansManager";

interface AdminPortalProps {
  admin: ReturnType<typeof useAdmin>;
  plans: SavingPlan[];
  connectedAccount: string | null;
  chainId: number | null;
  networkDisplayName?: string;
  blockExplorerUrl?: string;
  savingCoreAddress?: string | null;
  vaultManagerAddress?: string | null;
}

export const AdminPortal: React.FC<AdminPortalProps> = ({
  admin,
  plans,
  connectedAccount,
  networkDisplayName = "Connected Network",
  blockExplorerUrl,
  savingCoreAddress,
  vaultManagerAddress,
}) => {
  const { summary } = admin;

  // Non-admin guard
  if (!summary.isBankAdmin) {
    return (
      <AdminRestrictedState
        connectedAccount={connectedAccount}
        expectedAdmin={summary.vaultOwner}
        currentNetworkName={networkDisplayName}
      />
    );
  }

  return (
    <div className="admin-portal-root">
      {/* Admin Hero Status Bar */}
      <div className="admin-hero-card">
        <div className="admin-hero-left">
          <h3 className="section-title" style={{ margin: "0 0 6px", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <span>Protocol Governance Portal</span>
            <span className="badge-pill active text-nowrap" style={{ fontSize: "12px", padding: "2px 8px", whiteSpace: "nowrap" }}>
              Bank Administrator Authenticated
            </span>
          </h3>

          <p className="body-sm" style={{ color: "var(--color-muted)", margin: 0, maxWidth: "680px" }}>
            Active on {networkDisplayName}. You have full cryptographic authority to configure saving plans, manage reserve liquidity, and trigger emergency protocol pauses.
          </p>
        </div>

        <div className="admin-hero-meta">
          <div className="meta-pill">
            <span className="meta-pill-label">VaultManager</span>
            <span className="meta-pill-val tabular-num">
              {vaultManagerAddress ? (
                blockExplorerUrl ? (
                  <a
                    href={`${blockExplorerUrl}/address/${vaultManagerAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "inherit", textDecoration: "underline" }}
                  >
                    {shortenAddress(vaultManagerAddress)}
                  </a>
                ) : (
                  shortenAddress(vaultManagerAddress)
                )
              ) : (
                "Unbound"
              )}
            </span>
          </div>

          <div className="meta-pill">
            <span className="meta-pill-label">SavingCore</span>
            <span className="meta-pill-val tabular-num">
              {savingCoreAddress ? (
                blockExplorerUrl ? (
                  <a
                    href={`${blockExplorerUrl}/address/${savingCoreAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "inherit", textDecoration: "underline" }}
                  >
                    {shortenAddress(savingCoreAddress)}
                  </a>
                ) : (
                  shortenAddress(savingCoreAddress)
                )
              ) : (
                "Unbound"
              )}
            </span>
          </div>
        </div>
      </div>

      {/* Confirmation & Alert Banners */}
      {admin.latestResult && (
        <div className="alert-banner success" style={{ marginBottom: "24px" }}>
          <div>
            <strong>{admin.latestResult.action}:</strong> {admin.latestResult.details}{" "}
            {admin.latestResult.txHash && (
              <span className="tabular-num" style={{ marginLeft: "8px" }}>
                Tx:{" "}
                {blockExplorerUrl ? (
                  <a
                    href={`${blockExplorerUrl}/tx/${admin.latestResult.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "inherit", textDecoration: "underline" }}
                  >
                    {shortenAddress(admin.latestResult.txHash)}
                  </a>
                ) : (
                  shortenAddress(admin.latestResult.txHash)
                )}
              </span>
            )}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm text-nowrap"
            onClick={admin.resetStatus}
            style={{ marginLeft: "auto", whiteSpace: "nowrap" }}
          >
            Dismiss
          </button>
        </div>
      )}

      {admin.error && (
        <div className="alert-banner error" style={{ marginBottom: "24px" }}>
          <div>{admin.error}</div>
          <button
            type="button"
            className="btn btn-ghost btn-sm text-nowrap"
            onClick={admin.resetStatus}
            style={{ marginLeft: "auto", whiteSpace: "nowrap" }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main Admin Grid */}
      <div className="admin-grid" style={{ display: "grid", gap: "24px" }}>
        {/* Row 1: System Controls & Vault Liquidity */}
        <div className="admin-two-col" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "24px" }}>
          <AdminSystemCard
            summary={summary}
            status={admin.status}
            onTogglePause={admin.togglePause}
            onSetFeeReceiver={admin.setFeeReceiver}
          />

          <AdminVaultCard
            summary={summary}
            status={admin.status}
            onFundVault={admin.fundVault}
            onWithdrawLiquidity={admin.withdrawLiquidity}
            onMintDemoTokens={admin.mintAdminDemoTokens}
          />
        </div>

        {/* Row 2: Saving Plans Management */}
        <AdminPlansManager
          plans={plans}
          status={admin.status}
          onCreatePlan={admin.createPlan}
          onUpdatePlanApr={admin.updatePlanApr}
          onTogglePlanStatus={admin.togglePlanStatus}
        />
      </div>
    </div>
  );
};
