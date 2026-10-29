import React from "react";
import type { PortfolioSummary } from "../../types";
import { formatTimestamp } from "../../lib/format";

interface PortfolioOverviewProps {
  summary: PortfolioSummary;
  blockTimestamp: number;
  isLoading: boolean;
  onRefresh: () => void;
}

export const PortfolioOverview: React.FC<PortfolioOverviewProps> = ({
  summary,
  blockTimestamp,
  isLoading,
  onRefresh,
}) => {
  return (
    <section className="portfolio-overview-section" aria-label="Portfolio Summary">
      <div className="section-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <div>
          <h3 className="section-title">Deposit Portfolio Overview</h3>
          <p className="section-desc">
            Aggregated metrics for on-chain term deposit certificates held by your connected wallet.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm text-nowrap"
          onClick={onRefresh}
          disabled={isLoading}
          style={{ whiteSpace: "nowrap" }}
          title="Query latest blockchain state"
        >
          {isLoading ? "Refreshing…" : "Refresh Portfolio"}
        </button>
      </div>

      <div className="overview-grid">
        {/* Metric 1: Total Active Principal */}
        <div className="metric-card glass-panel">
          <span className="metric-label">Total Active Principal</span>
          <div className="metric-value-container">
            <span className="metric-value tabular-num">{summary.totalActivePrincipalFormatted}</span>
            <span className="metric-unit">USDC</span>
          </div>
          <span className="metric-subtext">Excludes withdrawn & renewed deposits</span>
        </div>

        {/* Metric 2: Active Certificates */}
        <div className="metric-card glass-panel">
          <span className="metric-label">Active Certificates</span>
          <div className="metric-value-container">
            <span className="metric-value tabular-num">{summary.activeCount}</span>
            <span className="metric-unit">SDC NFTs</span>
          </div>
          <span className="metric-subtext">Transferable ERC721 certificates</span>
        </div>

        {/* Metric 3: Upcoming Maturity */}
        <div className="metric-card glass-panel">
          <span className="metric-label">Next Maturity</span>
          <div className="metric-value-container" style={{ fontSize: "16px", minHeight: "36px", display: "flex", alignItems: "center" }}>
            {summary.upcomingMaturity ? (
              <span className="tabular-num" style={{ fontWeight: 600, color: "var(--color-ink)" }}>
                {formatTimestamp(summary.upcomingMaturity)}
              </span>
            ) : (
              <span style={{ color: "var(--color-muted)", fontSize: "14px" }}>No upcoming active maturity</span>
            )}
          </div>
          <span className="metric-subtext">
            Chain time: {formatTimestamp(blockTimestamp)}
          </span>
        </div>

        {/* Metric 4: Projected Contractual Yield */}
        <div className="metric-card glass-panel">
          <span className="metric-label">Contractual Yield Snapshot</span>
          <div className="metric-value-container">
            <span className="metric-value tabular-num" style={{ color: "var(--color-accent)" }}>
              +{summary.totalEstimatedInterestFormatted}
            </span>
            <span className="metric-unit">USDC</span>
          </div>
          <span className="metric-subtext">Full-term contractual yield upon maturity</span>
        </div>
      </div>
    </section>
  );
};
