import React from "react";
import { DepositStatus, type DepositRecord } from "../../types";
import { formatBps, formatTimestamp, shortenAddress } from "../../lib/format";

interface DepositCardProps {
  deposit: DepositRecord;
  onInspect: (deposit: DepositRecord) => void;
  onWithdraw: (deposit: DepositRecord) => void;
  onManualRenew: (deposit: DepositRecord) => void;
  onAutoRenew: (deposit: DepositRecord) => void;
}

export const DepositCard: React.FC<DepositCardProps> = ({
  deposit,
  onInspect,
  onWithdraw,
  onManualRenew,
  onAutoRenew,
}) => {
  const getStatusBadge = () => {
    switch (deposit.status) {
      case DepositStatus.Active:
        return (
          <span className="deposit-status-badge badge-active" title="Active on-chain deposit">
            <span className="status-dot"></span> Active
          </span>
        );
      case DepositStatus.Withdrawn:
        return (
          <span className="deposit-status-badge badge-withdrawn" title="Terminal deposit settled">
            Withdrawn
          </span>
        );
      case DepositStatus.ManualRenewed:
        return (
          <span className="deposit-status-badge badge-renewed" title="Renewed into a new saving plan">
            Manual Renewed
          </span>
        );
      case DepositStatus.AutoRenewed:
        return (
          <span className="deposit-status-badge badge-auto" title="Auto-renewed after grace period">
            Auto Renewed
          </span>
        );
      default:
        return null;
    }
  };

  const isActive = deposit.status === DepositStatus.Active;

  return (
    <article className={`deposit-card glass-panel ${!isActive ? "deposit-card-terminal" : ""}`}>
      {/* Header: ID, Badge, Lineage */}
      <div className="deposit-card-header">
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div className="certificate-tag tabular-num">
            Certificate #{deposit.depositId}
          </div>
          {getStatusBadge()}
        </div>

        {deposit.renewedFromDepositId && (
          <span className="lineage-badge text-nowrap" title={`Lineage: Renewed from #${deposit.renewedFromDepositId}`}>
            From #{deposit.renewedFromDepositId}
          </span>
        )}
        {deposit.renewedToDepositId && (
          <span className="lineage-badge text-nowrap" title={`Lineage: Succeeded by #${deposit.renewedToDepositId}`}>
            Succeeded by #{deposit.renewedToDepositId}
          </span>
        )}
      </div>

      {/* Main Figure: Principal & Projected Yield */}
      <div className="deposit-card-body">
        <div className="deposit-principal-row">
          <div>
            <div className="figure-label">Principal Balance</div>
            <div className="figure-value tabular-num">
              {deposit.principalFormatted} <span className="figure-unit">USDC</span>
            </div>
          </div>

          <div style={{ textAlign: "right" }}>
            <div className="figure-label">Fixed APR Snapshot</div>
            <div className="apr-pill tabular-num">
              {formatBps(deposit.aprBpsAtOpen)}
            </div>
          </div>
        </div>

        {/* Financial Details Table */}
        <div className="deposit-specs-grid">
          <div className="spec-item">
            <span className="spec-label">Tenor Term</span>
            <span className="spec-value tabular-num">
              {(deposit.tenorSeconds / 86400).toFixed(0)} days
            </span>
          </div>

          <div className="spec-item">
            <span className="spec-label">Maturity Date</span>
            <span className="spec-value tabular-num" style={{ color: deposit.isMatured ? "var(--color-accent-2)" : "var(--color-ink)" }}>
              {formatTimestamp(deposit.maturityAt)}
            </span>
          </div>

          <div className="spec-item">
            <span className="spec-label">Contractual Yield</span>
            <span className="spec-value tabular-num" style={{ color: "var(--color-accent)" }}>
              +{deposit.accruedInterestFormatted} USDC
            </span>
          </div>

          <div className="spec-item">
            <span className="spec-label">Early Penalty Rate</span>
            <span className="spec-value tabular-num">
              {formatBps(deposit.penaltyBpsAtOpen)}
            </span>
          </div>
        </div>

        {/* Timestamps and Ownership */}
        <div className="deposit-footer-meta">
          <div className="meta-text text-nowrap">
            NFT Owner: <span className="tabular-num">{shortenAddress(deposit.owner)}</span>
          </div>
          <div className="meta-text text-nowrap">
            Started: <span className="tabular-num">{formatTimestamp(deposit.startAt)}</span>
          </div>
        </div>
      </div>

      {/* Action Strip */}
      <div className="deposit-card-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm text-nowrap"
          onClick={() => onInspect(deposit)}
          style={{ whiteSpace: "nowrap" }}
        >
          View Details
        </button>

        {isActive && (
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" }}>
            {deposit.canEarlyWithdraw && (
              <button
                type="button"
                className="btn btn-secondary btn-sm text-nowrap"
                onClick={() => onWithdraw(deposit)}
                style={{ whiteSpace: "nowrap" }}
                title="Settle early before maturity (penalty applies)"
              >
                Withdraw Early
              </button>
            )}

            {deposit.canMaturityWithdraw && (
              <button
                type="button"
                className="btn btn-primary btn-sm text-nowrap"
                onClick={() => onWithdraw(deposit)}
                style={{ whiteSpace: "nowrap" }}
                title="Withdraw full principal and contractual interest"
              >
                Withdraw at Maturity
              </button>
            )}

            {deposit.canManualRenew && (
              <button
                type="button"
                className="btn btn-secondary btn-sm text-nowrap"
                onClick={() => onManualRenew(deposit)}
                style={{ whiteSpace: "nowrap" }}
                title="Roll over principal plus interest into a new saving plan"
              >
                Manual Renew
              </button>
            )}

            {deposit.canAutoRenew && (
              <button
                type="button"
                className="btn btn-ghost btn-sm text-nowrap"
                onClick={() => onAutoRenew(deposit)}
                style={{ whiteSpace: "nowrap", borderColor: "var(--color-accent-2)", color: "var(--color-accent-2)" }}
                title="Grace period ended: execute auto-renewal"
              >
                Auto Renew
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
};
