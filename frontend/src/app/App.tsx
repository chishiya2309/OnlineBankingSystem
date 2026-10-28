import React, { useState } from "react";
import { useWallet } from "../hooks/useWallet";
import { useContracts } from "../hooks/useContracts";
import { useSavingPlans } from "../hooks/useSavingPlans";
import { useDepositFlow } from "../hooks/useDepositFlow";
import type { SavingPlan } from "../types";

import { Header } from "../components/layout/Header";
import { Footer } from "../components/layout/Footer";
import { AccountOverview } from "../components/overview/AccountOverview";
import { PlanList } from "../components/plans/PlanList";
import { DepositForm } from "../components/deposit/DepositForm";
import { TransactionReceiptCard } from "../components/deposit/TransactionReceiptCard";

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

  const [selectedPlan, setSelectedPlan] = useState<SavingPlan | null>(null);

  // If plans load and no plan is selected yet, pre-select Plan 1 if enabled
  React.useEffect(() => {
    if (!selectedPlan && savingPlans.plans.length > 0) {
      const defaultPlan = savingPlans.plans.find((p) => p.enabled) || savingPlans.plans[0];
      setSelectedPlan(defaultPlan);
    }
  }, [savingPlans.plans, selectedPlan]);

  return (
    <div className="app-root">
      <Header wallet={wallet} />

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

          {/* Global Alert Notification */}
          {(wallet.error || depositFlow.error) && (
            <div className="alert-banner error" role="alert" style={{ marginBottom: "32px" }}>
              <div>{wallet.error || depositFlow.error}</div>
            </div>
          )}

          {/* Saving Plans Selection */}
          <PlanList
            plans={savingPlans.plans}
            selectedPlan={selectedPlan}
            onSelectPlan={(plan) => setSelectedPlan(plan)}
            isLoading={savingPlans.isLoading}
            error={savingPlans.error}
            onRefresh={savingPlans.refetch}
          />

          {/* Deposit Configuration & Receipt Workspace */}
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
                onOpenDeposit={depositFlow.openDeposit}
              />
            </div>

            <div>
              {depositFlow.confirmedDeposit ? (
                <TransactionReceiptCard
                  confirmedDeposit={depositFlow.confirmedDeposit}
                  chainId={wallet.chainId}
                  onReset={depositFlow.resetFlow}
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
      </main>

      <Footer addresses={contracts.addresses} chainId={wallet.chainId} />
    </div>
  );
};
