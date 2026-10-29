import React, { useState } from "react";
import type { DepositRecord } from "../../types";
import { DepositCard } from "./DepositCard";

interface DepositListProps {
  activeDeposits: DepositRecord[];
  historicalDeposits: DepositRecord[];
  onInspect: (deposit: DepositRecord) => void;
  onWithdraw: (deposit: DepositRecord) => void;
  onManualRenew: (deposit: DepositRecord) => void;
  onAutoRenew: (deposit: DepositRecord) => void;
  onNavigateToPlans: () => void;
}

export const DepositList: React.FC<DepositListProps> = ({
  activeDeposits,
  historicalDeposits,
  onInspect,
  onWithdraw,
  onManualRenew,
  onAutoRenew,
  onNavigateToPlans,
}) => {
  const [activeTab, setActiveTab] = useState<"active" | "history">("active");

  const depositsToShow = activeTab === "active" ? activeDeposits : historicalDeposits;

  return (
    <div className="deposit-list-wrapper">
      {/* Tab controls */}
      <div className="portfolio-tabs-container">
        <div className="segmented-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "active"}
            className={`tab-btn text-nowrap ${activeTab === "active" ? "active" : ""}`}
            onClick={() => setActiveTab("active")}
            style={{ whiteSpace: "nowrap" }}
          >
            Active Deposits ({activeDeposits.length})
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "history"}
            className={`tab-btn text-nowrap ${activeTab === "history" ? "active" : ""}`}
            onClick={() => setActiveTab("history")}
            style={{ whiteSpace: "nowrap" }}
          >
            Certificate History ({historicalDeposits.length})
          </button>
        </div>
      </div>

      {/* Grid or Empty */}
      {depositsToShow.length > 0 ? (
        <div className="deposit-cards-grid">
          {depositsToShow.map((deposit) => (
            <DepositCard
              key={deposit.depositId}
              deposit={deposit}
              onInspect={onInspect}
              onWithdraw={onWithdraw}
              onManualRenew={onManualRenew}
              onAutoRenew={onAutoRenew}
            />
          ))}
        </div>
      ) : (
        <div className="glass-panel" style={{ padding: "48px 24px", textAlign: "center", marginTop: "16px" }}>
          {activeTab === "active" ? (
            <div>
              <h4 style={{ fontSize: "17px", fontWeight: 600, color: "var(--color-ink)", marginBottom: "8px" }}>
                No Active Term Deposits
              </h4>
              <p style={{ color: "var(--color-muted)", fontSize: "14px", maxWidth: "480px", margin: "0 auto 20px" }}>
                You do not hold any active term deposits currently. Open a new fixed deposit to start accruing guaranteed contractual yields.
              </p>
              <button
                type="button"
                className="btn btn-primary text-nowrap"
                onClick={onNavigateToPlans}
                style={{ whiteSpace: "nowrap" }}
              >
                Browse Saving Plans
              </button>
            </div>
          ) : (
            <div>
              <h4 style={{ fontSize: "17px", fontWeight: 600, color: "var(--color-ink)", marginBottom: "8px" }}>
                No Historical Certificates
              </h4>
              <p style={{ color: "var(--color-muted)", fontSize: "14px", maxWidth: "480px", margin: "0 auto" }}>
                You have not settled or renewed any deposits yet. Once an active deposit is withdrawn or rolled over, its NFT certificate will remain permanently visible here.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
