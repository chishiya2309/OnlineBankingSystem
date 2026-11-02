import React, { useState, useEffect, useMemo } from "react";
import { Icon } from "../layout/Icon";
import type { DepositRecord, SavingPlan } from "../../types";
import type { UseRenewalState } from "../../hooks/useRenewal";
import { formatDurationSeconds, formatTimestamp, formatUSDC, shortenAddress } from "../../lib/format";

interface ManualRenewDialogProps {
  deposit: DepositRecord | null;
  savingPlans: SavingPlan[];
  renewalState: UseRenewalState;
  onClose: () => void;
  isPaused?: boolean;
  vaultBalance?: bigint;
}

export const ManualRenewDialog: React.FC<ManualRenewDialogProps> = ({
  deposit,
  savingPlans,
  renewalState,
  onClose,
  isPaused = false,
  vaultBalance,
}) => {
  if (!deposit) return null;

  const {
    status,
    statusMessage,
    error,
    confirmedRenewal,
    renewDeposit,
    resetFlow,
  } = renewalState;

  const compoundedPrincipal = deposit.principal + deposit.accruedInterest;
  const compoundedFormatted = formatUSDC(compoundedPrincipal, deposit.tenorSeconds < 86400 ? 6 : 2);

  // Filter plans to enabled ones
  const availablePlans = useMemo(() => savingPlans.filter((p) => p.enabled), [savingPlans]);

  const [selectedPlanId, setSelectedPlanId] = useState<number>(
    availablePlans[0]?.planId || 1
  );

  const selectedPlan = availablePlans.find((p) => p.planId === selectedPlanId);

  // Pre-select first eligible plan
  useEffect(() => {
    if (availablePlans.length > 0) {
      const eligible = availablePlans.find((p) => {
        const meetsMin = p.minDeposit === 0n || compoundedPrincipal >= p.minDeposit;
        const meetsMax = p.maxDeposit === 0n || compoundedPrincipal <= p.maxDeposit;
        return meetsMin && meetsMax;
      });
      setSelectedPlanId((current) => {
        const selected = availablePlans.find((p) => p.planId === current);
        if (selected && (selected.minDeposit === 0n || compoundedPrincipal >= selected.minDeposit)
          && (selected.maxDeposit === 0n || compoundedPrincipal <= selected.maxDeposit)) return current;
        return eligible?.planId ?? 0;
      });
    } else {
      setSelectedPlanId(0);
    }
  }, [compoundedPrincipal, availablePlans]);

  const isEligible = (plan: SavingPlan) => {
    const meetsMin = plan.minDeposit === 0n || compoundedPrincipal >= plan.minDeposit;
    const meetsMax = plan.maxDeposit === 0n || compoundedPrincipal <= plan.maxDeposit;
    return meetsMin && meetsMax;
  };

  const isInsufficientLiquidity =
    deposit.accruedInterest > 0n &&
    vaultBalance !== undefined &&
    vaultBalance < deposit.accruedInterest;

  const isExecuting = status === "validating" || status === "awaiting-signature" || status === "pending";

  const handleConfirm = async () => {
    if (!selectedPlan) return;
    await renewDeposit(deposit, selectedPlan);
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
        style={{ maxWidth: "620px", width: "90%", padding: "32px", maxHeight: "90vh", overflowY: "auto" }}
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
                  border: "1px solid var(--color-accent)",
                  color: "var(--color-accent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 12px",
                  fontSize: "20px",
                }}
              >
                <Icon name="check" size={22} />
              </div>
              <h3 style={{ fontSize: "20px", fontWeight: 600, color: "var(--color-ink)", margin: 0 }}>
                Manual Renewal Completed!
              </h3>
              <p style={{ fontSize: "14px", color: "var(--color-muted)", margin: "8px 0 0" }}>
                Old deposit transitioned to ManualRenewed and fresh certificate issued.
              </p>
            </div>

            <div className="detail-section glass-panel" style={{ padding: "16px", marginBottom: "20px" }}>
              <div className="detail-row">
                <span className="detail-label">Predecessor Certificate</span>
                <span className="detail-value tabular-num">#{confirmedRenewal.oldDepositId} (ManualRenewed)</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Fresh SDC Certificate</span>
                <span className="detail-value tabular-num" style={{ fontWeight: 600, color: "var(--color-accent)" }}>
                  #{confirmedRenewal.newDepositId} (Active)
                </span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Compounded Principal</span>
                <span className="detail-value tabular-num">{confirmedRenewal.newPrincipal} USDC</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Target Saving Plan</span>
                <span className="detail-value tabular-num">Plan #{confirmedRenewal.newPlanId}</span>
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
          /* Renewal Configuration View */
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "20px" }}>
              <div>
                <h3 style={{ fontSize: "20px", fontWeight: 600, color: "var(--color-ink)", margin: "0 0 4px" }}>
                  Manual Renewal for Certificate #{deposit.depositId}
                </h3>
                <span style={{ fontSize: "13px", color: "var(--color-muted)" }}>
                  Roll over principal plus full interest into an active saving plan with zero additional deposit.
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

            {/* Emergency Pause Warning */}
            {isPaused && (
              <div className="alert-banner warning" style={{ marginBottom: "20px" }}>
                <div>
                  <strong>Vault Emergency Paused:</strong> Renewals cannot be processed while the banking vault is paused by Bank Admin.
                </div>
              </div>
            )}

            {/* Insufficient Vault Liquidity Warning */}
            {isInsufficientLiquidity && (
              <div className="alert-banner warning" style={{ marginBottom: "20px" }}>
                <div>
                  <strong>Insufficient Bank Vault Liquidity:</strong> The bank vault currently holds {formatUSDC(vaultBalance, "auto")} USDC, which is insufficient to compound this certificate's accrued interest ({deposit.accruedInterestFormatted} USDC). Please contact bank administration to replenish the vault before renewing.
                </div>
              </div>
            )}

            {/* Compounding breakdown */}
            <div className="detail-section glass-panel" style={{ padding: "16px", marginBottom: "20px" }}>
              <div className="detail-row">
                <span className="detail-label">Old Principal</span>
                <span className="detail-value tabular-num">{deposit.principalFormatted} USDC</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Old Contractual Interest</span>
                <span className="detail-value tabular-num" style={{ color: "var(--color-accent)" }}>
                  +{deposit.accruedInterestFormatted} USDC
                </span>
              </div>
              <div className="detail-row" style={{ borderTop: "1px solid var(--color-rule)", paddingTop: "8px", marginTop: "8px" }}>
                <span className="detail-label" style={{ fontWeight: 600, color: "var(--color-ink)" }}>
                  New Compounded Principal (P + I)
                </span>
                <span className="detail-value tabular-num" style={{ fontSize: "16px", fontWeight: 600, color: "var(--color-accent)" }}>
                  {compoundedFormatted} USDC
                </span>
              </div>
            </div>

            {/* Target Plan Selector */}
            <div style={{ marginBottom: "20px" }}>
              <label style={{ display: "block", fontSize: "13px", color: "var(--color-muted)", marginBottom: "8px" }}>
                Select Target Saving Plan:
              </label>

              <div style={{ display: "grid", gap: "10px" }}>
                {availablePlans.map((plan) => {
                  const eligible = isEligible(plan);
                  const isSelected = plan.planId === selectedPlanId;

                  return (
                    <div
                      key={plan.planId}
                      className={`glass-panel renewal-plan-option ${isSelected ? "selected-plan-border" : ""}`}
                      style={{
                        padding: "14px 16px",
                        cursor: eligible ? "pointer" : "not-allowed",
                        opacity: eligible ? 1 : 0.5,
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        border: isSelected ? "1px solid var(--color-accent)" : "1px solid var(--color-rule)",
                      }}
                      onClick={() => eligible && setSelectedPlanId(plan.planId)}
                    >
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <span style={{ fontWeight: 600, color: "var(--color-ink)", fontSize: "14px" }}>
                            Plan #{plan.planId}
                          </span>
                          <span className="apr-pill tabular-num" style={{ fontSize: "12px", padding: "2px 8px" }}>
                            {plan.aprPercent} APR
                          </span>
                          <span style={{ fontSize: "13px", color: "var(--color-muted)" }}>
                            ({formatDurationSeconds(plan.tenorSeconds)})
                          </span>
                        </div>
                        <div style={{ fontSize: "12px", color: "var(--color-muted)", marginTop: "4px" }}>
                          Range: {plan.minDepositFormatted} to {plan.maxDepositFormatted} USDC · Penalty: {plan.penaltyPercent}
                        </div>
                      </div>

                      <div style={{ textAlign: "right" }}>
                        {eligible ? (
                          <input
                            type="radio"
                            name="targetPlan"
                            aria-label={`Select Plan #${plan.planId}`}
                            checked={isSelected}
                            onChange={() => setSelectedPlanId(plan.planId)}
                            style={{ accentColor: "var(--color-accent)" }}
                          />
                        ) : (
                          <span style={{ fontSize: "12px", color: "var(--color-dusk)" }}>Amount out of bounds</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Protocol & On-Chain Lineage Difference Note */}
            <div style={{ fontSize: "12px", color: "var(--color-muted)", marginBottom: "20px", lineHeight: 1.6, padding: "12px", background: "var(--color-paper-2)", borderRadius: "8px", border: "1px solid var(--color-rule)" }}>
              <div style={{ marginBottom: "6px", fontWeight: 600, color: "var(--color-ink)" }}>
                💡 Manual Renewal vs Auto Renewal On-Chain Guarantee:
              </div>
              <ul style={{ margin: "0 0 6px 18px", padding: 0 }}>
                <li><strong>Manual Renew:</strong> Allows choosing any active plan at prevailing market APR. Requires the plan to be enabled and the compounded amount to be within deposit bounds.</li>
                <li><strong>Auto Renew (Contract Guarantee):</strong> Bypasses plan enabled checks and deposit bounds. Once the grace period ends ({formatTimestamp(deposit.graceEnd)}), auto-renewal safely executes with your <strong>original locked snapshot APR ({deposit.aprBpsAtOpen / 100}%)</strong> and tenor preserved.</li>
              </ul>
            </div>

            {/* Error banner */}
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
            <div className="dialog-actions">
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
                disabled={
                  isExecuting ||
                  isPaused ||
                  isInsufficientLiquidity ||
                  !selectedPlan ||
                  !isEligible(selectedPlan)
                }
                style={{ whiteSpace: "nowrap" }}
              >
                {isExecuting ? "Executing Renewal…" : "Confirm Renewal"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
