import React, { useState, useMemo } from "react";
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
  onSelectDeposit?: (depositId: number) => void;
}

export const DepositList: React.FC<DepositListProps> = ({
  activeDeposits,
  historicalDeposits,
  onInspect,
  onWithdraw,
  onManualRenew,
  onAutoRenew,
  onNavigateToPlans,
  onSelectDeposit,
}) => {
  const [activeTab, setActiveTab] = useState<"active" | "history">("active");
  const [searchQuery, setSearchQuery] = useState("");
  const [filterMode, setFilterMode] = useState<"all" | "renewed">("all");

  const baseDeposits = activeTab === "active" ? activeDeposits : historicalDeposits;

  // Filter deposits by search query and lineage filter
  const filteredDeposits = useMemo(() => {
    return baseDeposits.filter((d) => {
      // 1. Lineage filter
      if (filterMode === "renewed" && !d.renewedFromDepositId && !d.renewedToDepositId) {
        return false;
      }
      // 2. Search query (matches ID, plan, or principal)
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase().replace("#", "");
        const matchId = d.depositId.toString().includes(q);
        const matchPredecessor = d.renewedFromDepositId?.toString().includes(q);
        const matchSuccessor = d.renewedToDepositId?.toString().includes(q);
        const matchPlan = `plan ${d.planId}`.includes(q) || d.planId.toString() === q;
        return matchId || matchPredecessor || matchSuccessor || matchPlan;
      }
      return true;
    });
  }, [baseDeposits, filterMode, searchQuery]);

  const handleSelectDeposit = (depositId: number) => {
    // Automatically switch tabs if target deposit lives in the other tab
    const inActive = activeDeposits.some((d) => d.depositId === depositId);
    const inHistory = historicalDeposits.some((d) => d.depositId === depositId);
    if (inActive && activeTab !== "active") {
      setActiveTab("active");
    } else if (inHistory && activeTab !== "history") {
      setActiveTab("history");
    }

    if (onSelectDeposit) {
      onSelectDeposit(depositId);
    }
  };

  const renewedCount = baseDeposits.filter((d) => d.renewedFromDepositId || d.renewedToDepositId).length;

  return (
    <div className="deposit-list-wrapper">
      {/* Tab controls & Search Filter Bar */}
      <div className="portfolio-tabs-container" style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
        <div className="segmented-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "active"}
            className={`tab-btn text-nowrap ${activeTab === "active" ? "active" : ""}`}
            onClick={() => {
              setActiveTab("active");
              setFilterMode("all");
            }}
            style={{ whiteSpace: "nowrap" }}
          >
            Active Deposits ({activeDeposits.length})
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "history"}
            className={`tab-btn text-nowrap ${activeTab === "history" ? "active" : ""}`}
            onClick={() => {
              setActiveTab("history");
              setFilterMode("all");
            }}
            style={{ whiteSpace: "nowrap" }}
          >
            Certificate History ({historicalDeposits.length})
          </button>
        </div>

        {/* Quick Filter & Search Bar */}
        {(activeDeposits.length > 0 || historicalDeposits.length > 0) && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            {renewedCount > 0 && (
              <button
                type="button"
                className={`filter-pill-btn ${filterMode === "renewed" ? "active" : ""}`}
                onClick={() => setFilterMode(filterMode === "renewed" ? "all" : "renewed")}
                title="Filter to certificates with renewal lineage"
              >
                🧬 Renewed Only ({renewedCount})
              </button>
            )}

            <div className="deposit-search-box">
              <input
                type="text"
                placeholder="Search ID (e.g. 3, 4)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="deposit-search-input"
              />
              {searchQuery && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={() => setSearchQuery("")}
                  title="Clear search"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Grid or Empty */}
      {filteredDeposits.length > 0 ? (
        <div className="deposit-cards-grid">
          {filteredDeposits.map((deposit) => (
            <DepositCard
              key={deposit.depositId}
              deposit={deposit}
              onInspect={onInspect}
              onWithdraw={onWithdraw}
              onManualRenew={onManualRenew}
              onAutoRenew={onAutoRenew}
              onSelectDeposit={handleSelectDeposit}
            />
          ))}
        </div>
      ) : (
        <div className="glass-panel" style={{ padding: "48px 24px", textAlign: "center", marginTop: "16px" }}>
          {searchQuery || filterMode === "renewed" ? (
            <div>
              <h4 style={{ fontSize: "17px", fontWeight: 600, color: "var(--color-ink)", marginBottom: "8px" }}>
                No Certificates Match Your Filter
              </h4>
              <p style={{ color: "var(--color-muted)", fontSize: "14px", maxWidth: "480px", margin: "0 auto 16px" }}>
                No deposits found matching "{searchQuery}". Try clearing your search query or reset filter.
              </p>
              <button
                type="button"
                className="btn btn-secondary btn-sm text-nowrap"
                onClick={() => {
                  setSearchQuery("");
                  setFilterMode("all");
                }}
              >
                Reset Filters
              </button>
            </div>
          ) : activeTab === "active" ? (
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
