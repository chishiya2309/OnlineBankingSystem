import React, { useState, useEffect } from "react";
import type { DepositRecord, SavingPlan } from "../../types";
import type { UseRenewalState } from "../../hooks/useRenewal";
import { formatUSDC, shortenAddress } from "../../lib/format";

interface ManualRenewDialogProps {
  deposit: DepositRecord | null;
  savingPlans: SavingPlan[];
  renewalState: UseRenewalState;
  onClose: () => void;
}

export const ManualRenewDialog: React.FC<ManualRenewDialogProps> = ({
  deposit,
  savingPlans,
  renewalState,
  onClose,
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
  const compoundedFormatted = formatUSDC(compoundedPrincipal);

  // Filter plans to enabled ones
  const availablePlans = savingPlans.filter((p) => p.enabled);

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
      if (eligible) {
        setSelectedPlanId(eligible.planId);
      }
    }
  }, [compoundedPrincipal, availablePlans]);

  const isEligible = (plan: SavingPlan) => {
    const meetsMin = plan.minDeposit === 0n || compoundedPrincipal >= plan.minDeposit;
    const meetsMax = plan.maxDeposit === 0n || compoundedPrincipal <= plan.maxDeposit;
    return meetsMin && meetsMax;
  };

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
                ✓
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
                      className={`glass-panel ${isSelected ? "selected-plan-border" : ""}`}
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
                            ({plan.tenorDays} days)
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

            {/* Explanatory note */}
            <div style={{ fontSize: "12px", color: "var(--color-muted)", marginBottom: "20px", lineHeight: 1.6 }}>
              <strong>Protocol Note:</strong> Manual renewal transitions the old deposit to status 2 (<code>ManualRenewed</code>). VaultManager transfers interest to SavingCore to fund the backing of your compounded principal, and a new transferable ERC721 NFT is minted to your wallet. No ERC20 approval is required.
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
                disabled={isExecuting || !selectedPlan || !isEligible(selectedPlan)}
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
