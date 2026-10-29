import React, { useState, useMemo } from "react";
import type { SavingPlan, DepositFlowStatus } from "../../types";
import { formatUSDC, parseUSDC, formatDurationSeconds } from "../../lib/format";
import { calculateInterestFromSeconds } from "../../lib/financials";

interface DepositFormProps {
  selectedPlan: SavingPlan | null;
  balance: bigint;
  allowance: bigint;
  status: DepositFlowStatus;
  statusMessage: string;
  isConnected: boolean;
  isCorrectNetwork: boolean;
  onApprove: (plan: SavingPlan, amountStr: string) => Promise<boolean>;
  onOpenDeposit: (plan: SavingPlan, amountStr: string) => Promise<boolean>;
}

export const DepositForm: React.FC<DepositFormProps> = ({
  selectedPlan,
  balance,
  allowance,
  status,
  statusMessage,
  isConnected,
  isCorrectNetwork,
  onApprove,
  onOpenDeposit,
}) => {
  const [amountStr, setAmountStr] = useState<string>("500.00");
  const [validationError, setValidationError] = useState<string | null>(null);

  const parsedAmount = useMemo(() => {
    try {
      return parseUSDC(amountStr);
    } catch {
      return 0n;
    }
  }, [amountStr]);

  const estimatedInterest = useMemo(() => {
    if (!selectedPlan || parsedAmount <= 0n) return 0n;
    return calculateInterestFromSeconds(
      parsedAmount,
      selectedPlan.aprBps,
      selectedPlan.tenorSeconds
    );
  }, [selectedPlan, parsedAmount]);

  const totalEstimatedPayout = useMemo(() => {
    return parsedAmount + estimatedInterest;
  }, [parsedAmount, estimatedInterest]);

  const hasSufficientAllowance = useMemo(() => {
    return parsedAmount > 0n && allowance >= parsedAmount;
  }, [allowance, parsedAmount]);

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setAmountStr(val);
    setValidationError(null);

    try {
      const parsed = parseUSDC(val);
      if (parsed > balance) {
        setValidationError(`Amount exceeds available balance (${formatUSDC(balance)} USDC).`);
      } else if (selectedPlan) {
        if (selectedPlan.minDeposit > 0n && parsed < selectedPlan.minDeposit) {
          setValidationError(`Minimum deposit for this plan is ${selectedPlan.minDepositFormatted}.`);
        } else if (selectedPlan.maxDeposit > 0n && parsed > selectedPlan.maxDeposit) {
          setValidationError(`Maximum deposit for this plan is ${selectedPlan.maxDepositFormatted}.`);
        }
      }
    } catch (err: any) {
      setValidationError(err.message || "Invalid amount format");
    }
  };

  const handleSetMax = () => {
    if (balance > 0n) {
      setAmountStr(ethersFormatUSDC(balance));
      setValidationError(null);
    }
  };

  function ethersFormatUSDC(val: bigint): string {
    const s = val.toString().padStart(7, "0");
    const whole = s.slice(0, -6);
    const dec = s.slice(-6);
    return `${whole}.${dec}`;
  }

  const isPending =
    status === "validating" ||
    status === "awaiting-approval-signature" ||
    status === "approval-pending" ||
    status === "awaiting-open-signature" ||
    status === "open-pending";

  const handleAction = async () => {
    if (!selectedPlan) return;
    if (parsedAmount <= 0n) {
      setValidationError("Please enter a valid deposit amount.");
      return;
    }

    if (!hasSufficientAllowance) {
      await onApprove(selectedPlan, amountStr);
    } else {
      await onOpenDeposit(selectedPlan, amountStr);
    }
  };

  return (
    <div className="form-card">
      <h3 style={{ fontSize: "20px", fontWeight: "600", marginBottom: "8px" }}>
        Open Term Deposit
      </h3>
      <p style={{ fontSize: "14px", color: "var(--color-muted)", marginBottom: "24px" }}>
        Fund principal in MockUSDC to lock guaranteed fixed-term APR and receive a transferable ERC721 Deposit Certificate.
      </p>

      {selectedPlan ? (
        <div>
          <div
            style={{
              padding: "16px",
              background: "var(--color-paper-2)",
              borderRadius: "var(--radius-inner)",
              border: "var(--rule-hair) solid var(--color-rule)",
              marginBottom: "24px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
              <strong>Selected: Plan #{selectedPlan.planId}</strong>
              <span className="tabular-num" style={{ color: "var(--color-accent)", fontWeight: "600" }}>
                {selectedPlan.aprPercent} APR
              </span>
            </div>
            <div style={{ fontSize: "13px", color: "var(--color-muted)" }}>
              Tenor: {formatDurationSeconds(selectedPlan.tenorSeconds)}, Early Penalty: {selectedPlan.penaltyPercent}
            </div>
          </div>

          <div className="form-group">
            <div className="form-label">
              <span>Deposit Principal</span>
              <span className="tabular-num">
                Balance: {formatUSDC(balance)} USDC
              </span>
            </div>

            <div className="input-wrapper">
              <input
                type="text"
                className="form-input tabular-num"
                value={amountStr}
                onChange={handleAmountChange}
                disabled={isPending || !isConnected}
                placeholder="0.00"
              />
              <div className="input-suffix">
                <button
                  type="button"
                  className="btn-max"
                  onClick={handleSetMax}
                  disabled={isPending || !isConnected || balance === 0n}
                >
                  MAX
                </button>
                <span className="input-asset">USDC</span>
              </div>
            </div>

            {validationError && (
              <div style={{ color: "var(--color-dusk)", fontSize: "12px", marginTop: "6px" }}>
                {validationError}
              </div>
            )}
          </div>

          {/* Financial calculations */}
          <div className="summary-tally">
            <div className="summary-row">
              <span className="meta-label">Principal Amount</span>
              <span className="meta-value tabular-num">{formatUSDC(parsedAmount)} USDC</span>
            </div>
            <div className="summary-row">
              <span className="meta-label">Contractual APR</span>
              <span className="meta-value tabular-num">{selectedPlan.aprPercent}</span>
            </div>
            <div className="summary-row">
              <span className="meta-label">Tenor Duration</span>
              <span className="meta-value tabular-num">{formatDurationSeconds(selectedPlan.tenorSeconds)}</span>
            </div>
            <div className="summary-row">
              <span className="meta-label">Estimated Contractual Interest</span>
              <span className="meta-value tabular-num summary-highlight">
                +{formatUSDC(estimatedInterest, selectedPlan.tenorSeconds < 86400 ? 6 : 2)} USDC
              </span>
            </div>
            <div className="summary-row">
              <span className="meta-label">Total Projected Payout</span>
              <span className="meta-value tabular-num">
                {formatUSDC(totalEstimatedPayout, selectedPlan.tenorSeconds < 86400 ? 6 : 2)} USDC
              </span>
            </div>
          </div>

          {/* Action button */}
          {!isConnected ? (
            <div style={{ color: "var(--color-muted)", fontSize: "14px", textAlign: "center" }}>
              Please connect MetaMask to proceed with opening a deposit.
            </div>
          ) : !isCorrectNetwork ? (
            <div style={{ color: "var(--color-dusk)", fontSize: "14px", textAlign: "center" }}>
              Please switch to Hardhat Localhost network (31337) to transact.
            </div>
          ) : (
            <div>
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={handleAction}
                disabled={
                  isPending ||
                  parsedAmount <= 0n ||
                  parsedAmount > balance ||
                  Boolean(validationError)
                }
              >
                {isPending
                  ? statusMessage || "Processing Transaction..."
                  : !hasSufficientAllowance
                  ? `Step 1/2: Approve ${formatUSDC(parsedAmount)} MockUSDC`
                  : `Step 2/2: Open Deposit (${formatUSDC(parsedAmount)} USDC)`}
              </button>

              {statusMessage && (
                <div
                  style={{
                    marginTop: "12px",
                    fontSize: "13px",
                    color: status === "error" ? "var(--color-dusk)" : "var(--color-accent)",
                    textAlign: "center",
                  }}
                >
                  {statusMessage}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div style={{ padding: "32px 0", textAlign: "center", color: "var(--color-muted)" }}>
          Please select a saving plan above to configure your term deposit.
        </div>
      )}
    </div>
  );
};
