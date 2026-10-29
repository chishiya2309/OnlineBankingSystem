import React from "react";
import type { DepositRecord } from "../../types";
import type { UseRenewalState } from "../../hooks/useRenewal";
import { formatDurationSeconds, formatBps, formatTimestamp, formatUSDC, shortenAddress } from "../../lib/format";

interface AutoRenewDialogProps {
  deposit: DepositRecord | null;
  renewalState: UseRenewalState;
  onClose: () => void;
}

export const AutoRenewDialog: React.FC<AutoRenewDialogProps> = ({
  deposit,
  renewalState,
  onClose,
}) => {
  if (!deposit) return null;

  const {
    status,
    statusMessage,
    error,
    confirmedRenewal,
    autoRenewDeposit,
    resetFlow,
  } = renewalState;

  const compoundedPrincipal = deposit.principal + deposit.accruedInterest;
  const isExecuting = status === "validating" || status === "awaiting-signature" || status === "pending";

  const handleConfirm = async () => {
    await autoRenewDeposit(deposit);
  };

  const handleDismiss = () => {
    resetFlow();
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={isExecuting ? undefined : handleDismiss} role="dialog" aria-modal="true">
      <div
        className="modal-panel glass-panel"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "580px", width: "90%", padding: "32px", maxHeight: "90vh", overflowY: "auto" }}
      >
        {/* Success View */}
        {status === "success" && confirmedRenewal ? (
          <div>
            <div style={{ textAlign: "center", marginBottom: "20px" }}>
              <div
                style={{
                  width: "48px",
                  height: "48px",
                  borderRadius: "50%",
                  background: "var(--color-paper-2)",
                  border: "1px solid var(--color-accent-2)",
                  color: "var(--color-accent-2)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 12px",
                  fontSize: "20px",
                }}
              >
                ✓
              </div>
              <h3 style={{ fontSize: "20px", fontWeight: 600, color: "var(--color-ink)", margin: 0 }}>
                Auto Renewal Executed!
              </h3>
              <p style={{ fontSize: "14px", color: "var(--color-muted)", margin: "8px 0 0" }}>
                Old deposit transitioned to AutoRenewed and new certificate issued to owner.
              </p>
            </div>

            <div className="detail-section glass-panel" style={{ padding: "16px", marginBottom: "20px" }}>
              <div className="detail-row">
                <span className="detail-label">Predecessor Certificate</span>
                <span className="detail-value tabular-num">#{confirmedRenewal.oldDepositId} (AutoRenewed)</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Fresh SDC Certificate</span>
                <span className="detail-value tabular-num" style={{ fontWeight: 600, color: "var(--color-accent-2)" }}>
                  #{confirmedRenewal.newDepositId} (Active)
                </span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Compounded Principal</span>
                <span className="detail-value tabular-num">{confirmedRenewal.newPrincipal} USDC</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Certificate Recipient</span>
                <span className="detail-value tabular-num text-nowrap" title={confirmedRenewal.owner}>
                  {shortenAddress(confirmedRenewal.owner, 6)}
                </span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Transaction Hash</span>
                <span className="detail-value tabular-num text-nowrap" title={confirmedRenewal.txHash}>
                  {shortenAddress(confirmedRenewal.txHash, 8)}
                </span>
              </div>
            </div>

            <button
              type="button"
              className="btn btn-primary text-nowrap"
              style={{ width: "100%", whiteSpace: "nowrap" }}
              onClick={handleDismiss}
            >
              Back to Portfolio
            </button>
          </div>
        ) : (
          /* Trigger Confirmation View */
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "20px" }}>
              <div>
                <h3 style={{ fontSize: "20px", fontWeight: 600, color: "var(--color-ink)", margin: "0 0 4px" }}>
                  Auto Renewal for Certificate #{deposit.depositId}
                </h3>
                <span style={{ fontSize: "13px", color: "var(--color-muted)" }}>
                  Grace period has ended (t &gt;= G). Auto-renewal locks snapshot terms and compounds principal.
                </span>
              </div>

              {!isExecuting && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm text-nowrap"
                  onClick={handleDismiss}
                  style={{ whiteSpace: "nowrap" }}
                >
                  Close
                </button>
              )}
            </div>

            {/* Terms locked display */}
            <div className="detail-section glass-panel" style={{ padding: "16px", marginBottom: "20px" }}>
              <div className="detail-row">
                <span className="detail-label">Old Principal</span>
                <span className="detail-value tabular-num">{deposit.principalFormatted} USDC</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Accrued Interest (Compounded)</span>
                <span className="detail-value tabular-num" style={{ color: "var(--color-accent)" }}>
                  +{deposit.accruedInterestFormatted} USDC
                </span>
              </div>
              <div className="detail-row" style={{ borderTop: "1px solid var(--color-rule)", paddingTop: "8px", marginTop: "8px" }}>
                <span className="detail-label" style={{ fontWeight: 600, color: "var(--color-ink)" }}>
                  New Principal (P + I)
                </span>
                <span className="detail-value tabular-num" style={{ fontSize: "16px", fontWeight: 600, color: "var(--color-accent-2)" }}>
                  {formatUSDC(compoundedPrincipal, deposit.tenorSeconds < 86400 ? 6 : 2)} USDC
                </span>
              </div>
            </div>

            <div className="detail-section glass-panel" style={{ padding: "16px", marginBottom: "20px" }}>
              <h4 style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-ink)", marginBottom: "8px" }}>
                Terms Locked from Previous Snapshot:
              </h4>
              <div className="detail-row">
                <span className="detail-label">Locked APR</span>
                <span className="detail-value tabular-num">{formatBps(deposit.aprBpsAtOpen)}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Locked Tenor</span>
                <span className="detail-value tabular-num">{formatDurationSeconds(deposit.tenorSeconds)}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Locked Early Penalty</span>
                <span className="detail-value tabular-num">{formatBps(deposit.penaltyBpsAtOpen)}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Grace Period Ended</span>
                <span className="detail-value tabular-num">{formatTimestamp(deposit.graceEnd)}</span>
              </div>
            </div>

            {/* Permissionless notice */}
            <div style={{ fontSize: "12px", color: "var(--color-muted)", marginBottom: "20px", lineHeight: 1.6 }}>
              <strong>Permissionless Execution:</strong> Auto renewal can be triggered by any caller once the grace period ends. The fresh certificate will be minted directly to the current NFT owner (<span className="tabular-num">{shortenAddress(deposit.owner)}</span>).
            </div>

            {/* Error message */}
            {error && (
              <div className="alert-banner error" style={{ marginBottom: "20px" }}>
                <div>{error}</div>
              </div>
            )}

            {/* Progress status */}
            {isExecuting && (
              <div style={{ textAlign: "center", padding: "12px", marginBottom: "16px", color: "var(--color-muted)", fontSize: "14px" }}>
                {statusMessage}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px" }}>
              <button
                type="button"
                className="btn btn-secondary text-nowrap"
                onClick={handleDismiss}
                disabled={isExecuting}
                style={{ whiteSpace: "nowrap" }}
              >
                Cancel
              </button>

              <button
                type="button"
                className="btn btn-primary text-nowrap"
                onClick={handleConfirm}
                disabled={isExecuting}
                style={{ whiteSpace: "nowrap" }}
              >
                {isExecuting ? "Executing Auto Renewal…" : "Trigger Auto Renewal"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
