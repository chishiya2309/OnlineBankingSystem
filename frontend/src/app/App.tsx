import React, { useState, useCallback } from "react";
import { useWallet } from "../hooks/useWallet";
import { useContracts } from "../hooks/useContracts";
import { useSavingPlans } from "../hooks/useSavingPlans";
import { useDepositFlow } from "../hooks/useDepositFlow";
import { usePortfolio } from "../hooks/usePortfolio";
import { useWithdraw } from "../hooks/useWithdraw";
import { useRenewal } from "../hooks/useRenewal";
import type { SavingPlan, DepositRecord } from "../types";

import { Header } from "../components/layout/Header";
import { Footer } from "../components/layout/Footer";
import { AccountOverview } from "../components/overview/AccountOverview";
import { PlanList } from "../components/plans/PlanList";
import { DepositForm } from "../components/deposit/DepositForm";
import { TransactionReceiptCard } from "../components/deposit/TransactionReceiptCard";

import { PortfolioOverview } from "../components/portfolio/PortfolioOverview";
import { DepositList } from "../components/portfolio/DepositList";
import { DepositDetailModal } from "../components/portfolio/DepositDetailModal";
import { WithdrawDialog } from "../components/portfolio/WithdrawDialog";
import { ManualRenewDialog } from "../components/portfolio/ManualRenewDialog";
import { AutoRenewDialog } from "../components/portfolio/AutoRenewDialog";
import { PortfolioEmptyState } from "../components/portfolio/PortfolioEmptyState";
import { useAdmin } from "../hooks/useAdmin";
import { AdminPortal } from "../components/admin/AdminPortal";
import { getNetworkConfig } from "../config/networks";

export const App: React.FC = () => {
  const wallet = useWallet();
  const contracts = useContracts(wallet.chainId, wallet.signer, wallet.browserProvider);
  const savingPlans = useSavingPlans(contracts.savingCore, contracts.isStaleDeployment);
  const depositFlow = useDepositFlow(
    wallet.account,
    contracts.mockUSDC,
    contracts.savingCore,
    contracts.addresses?.SavingCore ?? null
  );

  const portfolio = usePortfolio(
    contracts.savingCore,
    wallet.account,
    contracts.provider,
    contracts.isStaleDeployment
  );

  const handleActionSuccess = useCallback(() => {
    portfolio.refetch();
    depositFlow.refreshBalances();
  }, [portfolio, depositFlow]);

  const handleAdminSuccess = useCallback(() => {
    savingPlans.refetch();
    depositFlow.refreshBalances();
    portfolio.refetch();
  }, [savingPlans, depositFlow, portfolio]);

  const withdraw = useWithdraw(contracts.savingCore, wallet.account, handleActionSuccess);
  const renewal = useRenewal(contracts.savingCore, wallet.account, handleActionSuccess);
  const admin = useAdmin(
    contracts.vaultManager,
    contracts.savingCore,
    contracts.mockUSDC,
    wallet.account,
    handleAdminSuccess
  );

  // Current network config
  const currentNetwork = wallet.chainId ? getNetworkConfig(wallet.chainId) : undefined;

  // Navigation tab: 'plans' | 'portfolio' | 'admin'
  const [activeTab, setActiveTab] = useState<"plans" | "portfolio" | "admin">("plans");

  // Plan selection
  const [selectedPlan, setSelectedPlan] = useState<SavingPlan | null>(null);

  // Modal dialog states
  const [detailDeposit, setDetailDeposit] = useState<DepositRecord | null>(null);
  const [withdrawDeposit, setWithdrawDeposit] = useState<DepositRecord | null>(null);
  const [manualRenewDeposit, setManualRenewDeposit] = useState<DepositRecord | null>(null);
  const [autoRenewDeposit, setAutoRenewDeposit] = useState<DepositRecord | null>(null);

  // Default select first enabled plan
  React.useEffect(() => {
    if (!selectedPlan && savingPlans.plans.length > 0) {
      const defaultPlan = savingPlans.plans.find((p) => p.enabled) || savingPlans.plans[0];
      setSelectedPlan(defaultPlan);
    }
  }, [savingPlans.plans, selectedPlan]);

  // Refresh portfolio whenever an open deposit succeeds
  const handleOpenDeposit = async (plan: SavingPlan, amount: string) => {
    const success = await depositFlow.openDeposit(plan, amount);
    if (success) {
      portfolio.refetch();
    }
    return success;
  };

  return (
    <div className="app-root">
      <Header wallet={wallet} isBankAdmin={admin.summary.isBankAdmin} />

      <main className="main-content">
        <div className="app-container">
          {/* Hero section */}
          <div className="hero-section">
            <h2 className="hero-headline">
              Institutional-grade digital term deposits on Ethereum.
            </h2>
            <p className="hero-subheadline">
              Lock MockUSDC at fixed contractual yields with on-chain interest reserves and transferable ERC721 certificates.
            </p>
          </div>

          {/* Account & Liquidity Overview */}
          <AccountOverview
            isConnected={wallet.isConnected}
            balance={depositFlow.balance}
            allowance={depositFlow.allowance}
            planCount={savingPlans.plans.length}
            isStaleDeployment={contracts.isStaleDeployment}
            isMinting={depositFlow.isMinting}
            onMintDemoTokens={depositFlow.mintDemoTokens}
          />

          {/* Top Application Navigation */}
          <div className="app-nav-bar" style={{ margin: "28px 0 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="segmented-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "plans"}
                className={`tab-btn text-nowrap ${activeTab === "plans" ? "active" : ""}`}
                onClick={() => setActiveTab("plans")}
                style={{ whiteSpace: "nowrap" }}
              >
                <span style={{ whiteSpace: "nowrap" }}>Saving Plans &amp; Open</span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "portfolio"}
                className={`tab-btn text-nowrap ${activeTab === "portfolio" ? "active" : ""}`}
                onClick={() => setActiveTab("portfolio")}
                style={{ whiteSpace: "nowrap" }}
              >
                <span style={{ whiteSpace: "nowrap" }}>My Portfolio</span>
                {wallet.isConnected && portfolio.summary.activeCount > 0 && (
                  <span className="badge-count tabular-num" style={{ marginLeft: "8px", whiteSpace: "nowrap" }}>
                    {portfolio.summary.activeCount}
                  </span>
                )}
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "admin"}
                className={`tab-btn text-nowrap ${activeTab === "admin" ? "active" : ""}`}
                onClick={() => setActiveTab("admin")}
                style={{ whiteSpace: "nowrap" }}
              >
                <span style={{ whiteSpace: "nowrap" }}>Admin Portal</span>
                {admin.summary.isBankAdmin && (
                  <span
                    className="badge-count tabular-num"
                    style={{
                      marginLeft: "8px",
                      background: "var(--color-accent)",
                      color: "var(--color-accent-ink)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Admin
                  </span>
                )}
              </button>
            </div>
          </div>

          {/* Global Alert Notification */}
          {(wallet.error || depositFlow.error || portfolio.error) && (
            <div className="alert-banner error" role="alert" style={{ marginBottom: "28px" }}>
              <div>{wallet.error || depositFlow.error || portfolio.error}</div>
            </div>
          )}

          {/* View A: Saving Plans & Open Deposit */}
          {activeTab === "plans" && (
            <div className="plans-view">
              <PlanList
                plans={savingPlans.plans}
                selectedPlan={selectedPlan}
                onSelectPlan={(plan) => setSelectedPlan(plan)}
                isLoading={savingPlans.isLoading}
                error={savingPlans.error}
                onRefresh={savingPlans.refetch}
              />

              <div className="workspace-grid">
                <div>
                  <DepositForm
                    selectedPlan={selectedPlan}
                    balance={depositFlow.balance}
                    allowance={depositFlow.allowance}
                    status={depositFlow.status}
                    statusMessage={depositFlow.statusMessage}
                    isConnected={wallet.isConnected}
                    isCorrectNetwork={wallet.isCorrectNetwork}
                    onApprove={depositFlow.approve}
                    onOpenDeposit={handleOpenDeposit}
                  />
                </div>

                <div>
                  {depositFlow.confirmedDeposit ? (
                    <TransactionReceiptCard
                      confirmedDeposit={depositFlow.confirmedDeposit}
                      chainId={wallet.chainId}
                      onReset={depositFlow.resetFlow}
                      onViewInPortfolio={() => setActiveTab("portfolio")}
                    />
                  ) : (
                    <div className="glass-panel" style={{ padding: "28px" }}>
                      <h4 style={{ fontSize: "17px", fontWeight: "600", marginBottom: "14px" }}>
                        How It Works
                      </h4>
                      <ul style={{ paddingLeft: "20px", margin: 0, color: "var(--color-muted)", fontSize: "14px", lineHeight: "1.7" }}>
                        <li style={{ marginBottom: "10px" }}>
                          <strong>Select Plan:</strong> Choose a term deposit package with fixed duration and guaranteed APR.
                        </li>
                        <li style={{ marginBottom: "10px" }}>
                          <strong>Approve MockUSDC:</strong> Grant SavingCore allowance to transfer your principal into the liquidity vault.
                        </li>
                        <li style={{ marginBottom: "10px" }}>
                          <strong>Open Deposit:</strong> Execute the on-chain deposit transaction to initiate the term countdown and mint your SDC NFT certificate.
                        </li>
                        <li>
                          <strong>Settlement:</strong> Withdraw principal plus full interest upon maturity, or execute early withdrawal under penalty rules.
                        </li>
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* View B: My Portfolio & Certificates */}
          {activeTab === "portfolio" && (
            <div className="portfolio-view">
              {!wallet.isConnected || !wallet.isCorrectNetwork || contracts.isStaleDeployment ? (
                <PortfolioEmptyState
                  isConnected={wallet.isConnected}
                  isCorrectNetwork={wallet.isCorrectNetwork}
                  isStaleDeployment={contracts.isStaleDeployment}
                  error={portfolio.error}
                  onConnect={wallet.connect}
                  onSwitchNetwork={() => wallet.switchNetwork(31337)}
                  onNavigateToPlans={() => setActiveTab("plans")}
                  onRetry={portfolio.refetch}
                />
              ) : (
                <>
                  <PortfolioOverview
                    summary={portfolio.summary}
                    blockTimestamp={portfolio.blockTimestamp}
                    isLoading={portfolio.isLoading}
                    onRefresh={portfolio.refetch}
                  />

                  <div style={{ marginTop: "32px" }}>
                    <DepositList
                      activeDeposits={portfolio.activeDeposits}
                      historicalDeposits={portfolio.historicalDeposits}
                      onInspect={(d) => setDetailDeposit(d)}
                      onWithdraw={(d) => setWithdrawDeposit(d)}
                      onManualRenew={(d) => setManualRenewDeposit(d)}
                      onAutoRenew={(d) => setAutoRenewDeposit(d)}
                      onNavigateToPlans={() => setActiveTab("plans")}
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {/* View C: Admin Governance Portal */}
          {activeTab === "admin" && (
            <AdminPortal
              admin={admin}
              plans={savingPlans.plans}
              connectedAccount={wallet.account}
              chainId={wallet.chainId}
              networkDisplayName={currentNetwork?.displayName}
              blockExplorerUrl={currentNetwork?.blockExplorerUrl}
              savingCoreAddress={contracts.addresses?.SavingCore}
              vaultManagerAddress={contracts.addresses?.VaultManager}
              savingCore={contracts.savingCore}
            />
          )}
        </div>
      </main>

      {/* Modal Dialogs */}
      {detailDeposit && (
        <DepositDetailModal
          deposit={detailDeposit}
          coreAddress={contracts.addresses?.SavingCore}
          blockTimestamp={portfolio.blockTimestamp}
          onClose={() => setDetailDeposit(null)}
          onWithdraw={(d) => setWithdrawDeposit(d)}
          onManualRenew={(d) => setManualRenewDeposit(d)}
          onAutoRenew={(d) => setAutoRenewDeposit(d)}
        />
      )}

      {withdrawDeposit && (
        <WithdrawDialog
          deposit={withdrawDeposit}
          withdrawState={withdraw}
          onClose={() => setWithdrawDeposit(null)}
        />
      )}

      {manualRenewDeposit && (
        <ManualRenewDialog
          deposit={manualRenewDeposit}
          savingPlans={savingPlans.plans}
          renewalState={renewal}
          onClose={() => setManualRenewDeposit(null)}
        />
      )}

      {autoRenewDeposit && (
        <AutoRenewDialog
          deposit={autoRenewDeposit}
          renewalState={renewal}
          onClose={() => setAutoRenewDeposit(null)}
        />
      )}

      <Footer addresses={contracts.addresses} chainId={wallet.chainId} />
    </div>
  );
};
