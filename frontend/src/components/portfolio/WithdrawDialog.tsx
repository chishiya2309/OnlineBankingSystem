import React, { useState } from "react";
import { Icon } from "../layout/Icon";
import type { DepositRecord } from "../../types";
import type { UseWithdrawState } from "../../hooks/useWithdraw";
import { formatUSDC, shortenAddress } from "../../lib/format";

interface WithdrawDialogProps {
  deposit: DepositRecord | null;
  withdrawState: UseWithdrawState;
  onClose: () => void;
  isPaused?: boolean;
  vaultBalance?: bigint;
}

export const WithdrawDialog: React.FC<WithdrawDialogProps> = ({
  deposit,
  withdrawState,
  onClose,
  isPaused = false,
  vaultBalance,
}) => {
  if (!deposit) return null;

  const [hasConfirmedTotalLoss, setHasConfirmedTotalLoss] = useState(false);

  const {
    status,
    statusMessage,
    error,
    confirmedWithdraw,
    earlyWithdraw,
    withdrawAtMaturity,
    resetFlow,
  } = withdrawState;

  const isEarly = deposit.canEarlyWithdraw;
  const isTotalLoss = isEarly && (deposit.penaltyBpsAtOpen >= 10000 || deposit.earlyPayout === 0n);
  const isInsufficientLiquidity =
    !isEarly &&
    deposit.accruedInterest > 0n &&
    vaultBalance !== undefined &&
    vaultBalance < deposit.accruedInterest;
  const isExecuting = status === "validating" || status === "awaiting-signature" || status === "pending";

  const handleConfirm = async () => {
    if (isEarly) {
      await earlyWithdraw(deposit);
    } else {
      await withdrawAtMaturity(deposit);
    }
  };

  const handleDismiss = () => {
    setHasConfirmedTotalLoss(false);
    resetFlow();
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={isExecuting ? undefined : handleDismiss} role="dialog" aria-modal="true">
      <div
        className="modal-panel glass-panel"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "560px", width: "90%", padding: "32px" }}
      >
        {/* Success View */}
        {status === "success" && confirmedWithdraw ? (
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
                {confirmedWithdraw.isEarly ? "Early Withdrawal Settled" : "Maturity Settlement Successful"}
              </h3>
              <p style={{ fontSize: "14px", color: "var(--color-muted)", margin: "8px 0 0" }}>
                Funds have been transferred to your wallet on-chain.
              </p>
            </div>

            <div className="detail-section glass-panel" style={{ padding: "16px", marginBottom: "20px" }}>
              <div className="detail-row">
                <span className="detail-label">Settled Certificate</span>
                <span className="detail-value tabular-num">#{confirmedWithdraw.depositId}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Original Principal</span>
                <span className="detail-value tabular-num">{confirmedWithdraw.principal} USDC</span>
              </div>
              {confirmedWithdraw.isEarly ? (
                <>
                  <div className="detail-row">
                    <span className="detail-label">Penalty Deducted</span>
                    <span className="detail-value tabular-num" style={{ color: "var(--color-dusk)" }}>
                      -{confirmedWithdraw.penaltyAmount} USDC
                    </span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">Net Payout Received</span>
                    <span className="detail-value tabular-num" style={{ fontWeight: 600, color: "var(--color-ink)" }}>
                      {confirmedWithdraw.payoutAmount} USDC
                    </span>
                  </div>
                </>
              ) : (
                <div className="detail-row">
                  <span className="detail-label">Total Payout Received</span>
                  <span className="detail-value tabular-num" style={{ fontWeight: 600, color: "var(--color-accent)" }}>
                    {confirmedWithdraw.payoutAmount} USDC
                  </span>
                </div>
              )}
              <div className="detail-row">
                <span className="detail-label">Transaction Hash</span>
                <span className="detail-value tabular-num text-nowrap" title={confirmedWithdraw.txHash}>
                  {shortenAddress(confirmedWithdraw.txHash, 8)}
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
          /* Confirmation View */
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "20px" }}>
              <div>
                <h3 style={{ fontSize: "20px", fontWeight: 600, color: "var(--color-ink)", margin: "0 0 4px" }}>
                  {isEarly ? "Confirm Early Withdrawal" : "Confirm Maturity Settlement"} for Certificate #{deposit.depositId}
                </h3>
                <span style={{ fontSize: "13px", color: "var(--color-muted)" }}>
                  {isEarly
                    ? "Settling before maturity closes the deposit early subject to penalty terms"
                    : "Matured deposit is eligible for full principal and interest payout"}
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
                  <strong>Vault Emergency Paused:</strong> Withdrawals cannot be processed while the banking vault is paused by Bank Admin.
                </div>
              </div>
            )}

            {/* Insufficient Vault Liquidity Warning for Maturity Settlement */}
            {isInsufficientLiquidity && (
              <div className="alert-banner warning" style={{ marginBottom: "20px" }}>
                <div>
                  <strong>Insufficient Bank Vault Liquidity:</strong> The bank vault currently holds {formatUSDC(vaultBalance, "auto")} USDC, which is insufficient to pay this certificate's contractual interest of {deposit.accruedInterestFormatted} USDC. Please contact bank administration to replenish the vault before withdrawing.
                </div>
              </div>
            )}

            {/* 100% Capital Loss Danger Warning */}
            {isTotalLoss ? (
              <div className="alert-banner error" style={{ marginBottom: "20px", borderLeft: "4px solid var(--color-paused-text)" }}>
                <div>
                  <strong>🚨 DANGER - 100% CAPITAL LOSS:</strong> This term deposit plan carries a 100% early withdrawal penalty. If you proceed, your entire principal balance of {deposit.principalFormatted} USDC will be forfeited and transferred to the bank fee receiver. You will receive 0.00 USDC payout.
                </div>
              </div>
            ) : isEarly ? (
              /* Standard early withdrawal warning */
              <div className="alert-banner warning" style={{ marginBottom: "20px" }}>
                <div>
                  <strong>Permanent Action:</strong> Early withdrawal forfeits 100% of accrued interest and incurs a contractual penalty. This certificate will be permanently closed.
                </div>
              </div>
            ) : null}

            {/* Financial figures */}
            <div className="detail-section glass-panel" style={{ padding: "16px", marginBottom: "20px" }}>
              <div className="detail-row">
                <span className="detail-label">Principal Balance</span>
                <span className="detail-value tabular-num">{deposit.principalFormatted} USDC</span>
              </div>

              {isEarly ? (
                <>
                  <div className="detail-row">
                    <span className="detail-label">Early Penalty Rate</span>
                    <span className="detail-value tabular-num">{deposit.penaltyBpsAtOpen / 100}%</span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">Penalty Deducted (to Fee Receiver)</span>
                    <span className="detail-value tabular-num" style={{ color: "var(--color-dusk)" }}>
                      -{deposit.earlyPenaltyFormatted} USDC
                    </span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">Contractual Interest</span>
                    <span className="detail-value tabular-num">0.00 USDC (Forfeited)</span>
                  </div>
                  <div className="detail-row" style={{ borderTop: "1px solid var(--color-rule)", paddingTop: "8px", marginTop: "8px" }}>
                    <span className="detail-label" style={{ fontWeight: 600, color: "var(--color-ink)" }}>
                      Net Payout to Wallet
                    </span>
                    <span className="detail-value tabular-num" style={{ fontSize: "16px", fontWeight: 600, color: "var(--color-ink)" }}>
                      {deposit.earlyPayoutFormatted} USDC
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div className="detail-row">
                    <span className="detail-label">Guaranteed Contractual Interest</span>
                    <span className="detail-value tabular-num" style={{ color: "var(--color-accent)" }}>
                      +{deposit.accruedInterestFormatted} USDC
                    </span>
                  </div>
                  <div className="detail-row" style={{ borderTop: "1px solid var(--color-rule)", paddingTop: "8px", marginTop: "8px" }}>
                    <span className="detail-label" style={{ fontWeight: 600, color: "var(--color-ink)" }}>
                      Total Settlement Payout
                    </span>
                    <span className="detail-value tabular-num" style={{ fontSize: "16px", fontWeight: 600, color: "var(--color-accent)" }}>
                      {deposit.maturityPayoutFormatted} USDC
                    </span>
                  </div>
                </>
              )}
            </div>

            {/* Error Message */}
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

            {/* 100% Capital Loss Explicit Confirmation Checkbox */}
            {isTotalLoss && (
              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "10px",
                  margin: "16px 0 20px",
                  padding: "12px",
                  background: "var(--color-paused-bg)",
                  border: "1px solid var(--color-paused-text)",
                  borderRadius: "8px",
                  cursor: "pointer",
                  color: "var(--color-paused-text)",
                  fontSize: "13px",
                  lineHeight: 1.5,
                }}
              >
                <input
                  type="checkbox"
                  checked={hasConfirmedTotalLoss}
                  onChange={(e) => setHasConfirmedTotalLoss(e.target.checked)}
                  disabled={isExecuting || isPaused}
                  style={{ width: "18px", height: "18px", marginTop: "2px", accentColor: "var(--color-paused-text)" }}
                />
                <span>
                  <strong>Required Acknowledgment:</strong> I understand and accept that this early withdrawal penalty is 100%. I will permanently forfeit my entire principal and receive <strong>0.00 USDC</strong> payout.
                </span>
              </label>
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
                className={`btn text-nowrap ${
                  isTotalLoss
                    ? "btn-danger"
                    : isEarly
                    ? "btn-secondary"
                    : "btn-primary"
                }`}
                onClick={handleConfirm}
                disabled={
                  isExecuting ||
                  isPaused ||
                  isInsufficientLiquidity ||
                  (isTotalLoss && !hasConfirmedTotalLoss)
                }
                style={{
                  whiteSpace: "nowrap",
                  ...(isEarly && !isTotalLoss ? { borderColor: "var(--color-dusk)", color: "var(--color-dusk)" } : {}),
                }}
              >
                {isExecuting
                  ? "Executing…"
                  : isTotalLoss
                  ? "Forfeit Principal & Withdraw (0.00 USDC)"
                  : isEarly
                  ? "Confirm Early Withdrawal"
                  : "Confirm Settlement"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
