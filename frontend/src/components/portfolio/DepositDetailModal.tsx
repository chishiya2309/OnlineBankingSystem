import React from "react";
import { DepositStatus, type DepositRecord } from "../../types";
import { formatBps, formatTimestamp, shortenAddress } from "../../lib/format";

interface DepositDetailModalProps {
  deposit: DepositRecord | null;
  coreAddress?: string;
  blockTimestamp: number;
  onClose: () => void;
  onWithdraw: (deposit: DepositRecord) => void;
  onManualRenew: (deposit: DepositRecord) => void;
  onAutoRenew: (deposit: DepositRecord) => void;
}

export const DepositDetailModal: React.FC<DepositDetailModalProps> = ({
  deposit,
  coreAddress,
  blockTimestamp,
  onClose,
  onWithdraw,
  onManualRenew,
  onAutoRenew,
}) => {
  if (!deposit) return null;

  const isActive = deposit.status === DepositStatus.Active;

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="modal-panel glass-panel"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "680px", width: "90%", padding: "32px", maxHeight: "90vh", overflowY: "auto" }}
      >
        {/* Modal Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "20px" }}>
          <div>
            <h3 style={{ fontSize: "20px", fontWeight: 600, color: "var(--color-ink)", margin: "0 0 4px" }}>
              Details for Certificate #{deposit.depositId}
            </h3>
            <span style={{ fontSize: "13px", color: "var(--color-muted)" }}>
              Immutable on-chain snapshot captured at deposit opening
            </span>
          </div>

          <button
            type="button"
            className="btn btn-ghost btn-sm text-nowrap"
            onClick={onClose}
            aria-label="Close modal"
            style={{ whiteSpace: "nowrap" }}
          >
            Close
          </button>
        </div>

        {/* Ownership & Contract Identity */}
        <div className="detail-section glass-panel" style={{ padding: "16px", marginBottom: "20px" }}>
          <div className="detail-row">
            <span className="detail-label">SDC NFT Certificate</span>
            <span className="detail-value tabular-num">#{deposit.depositId}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Current Certificate Owner</span>
            <span className="detail-value tabular-num" title={deposit.owner}>
              {shortenAddress(deposit.owner, 6)}
            </span>
          </div>
          {coreAddress && (
            <div className="detail-row">
              <span className="detail-label">SavingCore Contract</span>
              <span className="detail-value tabular-num" title={coreAddress}>
                {shortenAddress(coreAddress, 6)}
              </span>
            </div>
          )}
          <div className="detail-row">
            <span className="detail-label">Saving Plan Origin</span>
            <span className="detail-value tabular-num">Plan #{deposit.planId}</span>
          </div>
          {deposit.renewedFromDepositId && (
            <div className="detail-row">
              <span className="detail-label">Renewal Predecessor</span>
              <span className="detail-value tabular-num">Rolled over from Certificate #{deposit.renewedFromDepositId}</span>
            </div>
          )}
          {deposit.renewedToDepositId && (
            <div className="detail-row">
              <span className="detail-label">Renewal Successor</span>
              <span className="detail-value tabular-num">Rolled over into Certificate #{deposit.renewedToDepositId}</span>
            </div>
          )}
        </div>

        {/* Financial Specifications */}
        <div className="detail-section glass-panel" style={{ padding: "16px", marginBottom: "20px" }}>
          <h4 style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-ink)", marginBottom: "12px", letterSpacing: "0.02em" }}>
            Financial Yield & Settlement Snapshot
          </h4>

          <div className="detail-row">
            <span className="detail-label">Principal Deposit</span>
            <span className="detail-value tabular-num" style={{ fontWeight: 600 }}>
              {deposit.principalFormatted} USDC
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Locked APR Snapshot</span>
            <span className="detail-value tabular-num" style={{ color: "var(--color-accent)" }}>
              {formatBps(deposit.aprBpsAtOpen)}
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Contractual Yield at Maturity</span>
            <span className="detail-value tabular-num" style={{ color: "var(--color-accent)" }}>
              +{deposit.accruedInterestFormatted} USDC
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Total Maturity Settlement</span>
            <span className="detail-value tabular-num" style={{ fontWeight: 600 }}>
              {deposit.maturityPayoutFormatted} USDC
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Early Penalty Snapshot</span>
            <span className="detail-value tabular-num">
              {formatBps(deposit.penaltyBpsAtOpen)} ({deposit.earlyPenaltyFormatted} USDC)
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Net Early Withdrawal Payout</span>
            <span className="detail-value tabular-num" style={{ color: "var(--color-dusk)" }}>
              {deposit.earlyPayoutFormatted} USDC
            </span>
          </div>
        </div>

        {/* Time and Eligibility Status */}
        <div className="detail-section glass-panel" style={{ padding: "16px", marginBottom: "24px" }}>
          <h4 style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-ink)", marginBottom: "12px", letterSpacing: "0.02em" }}>
            Time Boundaries & On-Chain Status
          </h4>

          <div className="detail-row">
            <span className="detail-label">Deposit Start Time</span>
            <span className="detail-value tabular-num">{formatTimestamp(deposit.startAt)}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Maturity Date (M)</span>
            <span className="detail-value tabular-num">{formatTimestamp(deposit.maturityAt)}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Grace Period Expiry (G)</span>
            <span className="detail-value tabular-num">{formatTimestamp(deposit.graceEnd)}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Current Blockchain Time (t)</span>
            <span className="detail-value tabular-num">{formatTimestamp(blockTimestamp)}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Maturity Status</span>
            <span className="detail-value tabular-num" style={{ color: deposit.isMatured ? "var(--color-accent-2)" : "var(--color-muted)" }}>
              {deposit.isMatured ? "Matured (t >= M)" : "Active Pre-Maturity (t < M)"}
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Grace Period Status</span>
            <span className="detail-value tabular-num" style={{ color: deposit.isGraceEnded ? "var(--color-accent-2)" : "var(--color-muted)" }}>
              {deposit.isGraceEnded ? "Grace Ended (t >= G)" : "Within Grace Period (t < G)"}
            </span>
          </div>
        </div>

        {/* Modal Action Buttons */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-secondary text-nowrap"
            onClick={onClose}
            style={{ whiteSpace: "nowrap" }}
          >
            Dismiss
          </button>

          {isActive && (
            <>
              {deposit.canEarlyWithdraw && (
                <button
                  type="button"
                  className="btn btn-secondary text-nowrap"
                  onClick={() => {
                    onClose();
                    onWithdraw(deposit);
                  }}
                  style={{ whiteSpace: "nowrap" }}
                >
                  Withdraw Early
                </button>
              )}

              {deposit.canMaturityWithdraw && (
                <button
                  type="button"
                  className="btn btn-primary text-nowrap"
                  onClick={() => {
                    onClose();
                    onWithdraw(deposit);
                  }}
                  style={{ whiteSpace: "nowrap" }}
                >
                  Withdraw at Maturity
                </button>
              )}

              {deposit.canManualRenew && (
                <button
                  type="button"
                  className="btn btn-secondary text-nowrap"
                  onClick={() => {
                    onClose();
                    onManualRenew(deposit);
                  }}
                  style={{ whiteSpace: "nowrap" }}
                >
                  Manual Renew
                </button>
              )}

              {deposit.canAutoRenew && (
                <button
                  type="button"
                  className="btn btn-ghost text-nowrap"
                  onClick={() => {
                    onClose();
                    onAutoRenew(deposit);
                  }}
                  style={{ whiteSpace: "nowrap", borderColor: "var(--color-accent-2)", color: "var(--color-accent-2)" }}
                >
                  Trigger Auto Renew
                </button>
              )}
            </>
          )}
        </div>

        {isActive && !deposit.isMatured && (
          <div style={{ marginTop: "14px", padding: "10px 14px", background: "rgba(100, 150, 255, 0.08)", borderRadius: "8px", fontSize: "12px", color: "var(--color-muted)", border: "1px dashed var(--color-border)" }}>
            💡 <strong>Sepolia Testing Tip:</strong> Bank Administrators can fast-forward this deposit to maturity immediately in the <strong>Admin Portal</strong> tab.
          </div>
        )}
      </div>
    </div>
  );
};
