import React, { useState } from "react";
import { shortenAddress } from "../../lib/format";
import type { AdminSummary, AdminActionStatus } from "../../types";

interface AdminSystemCardProps {
  summary: AdminSummary;
  status: AdminActionStatus;
  onTogglePause: () => Promise<boolean>;
  onSetFeeReceiver: (newReceiver: string) => Promise<boolean>;
}

export const AdminSystemCard: React.FC<AdminSystemCardProps> = ({
  summary,
  status,
  onTogglePause,
  onSetFeeReceiver,
}) => {
  const [feeReceiverInput, setFeeReceiverInput] = useState("");
  const isBusy = status === "awaiting-signature" || status === "pending";

  const handleUpdateReceiver = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feeReceiverInput.trim()) return;
    const ok = await onSetFeeReceiver(feeReceiverInput.trim());
    if (ok) {
      setFeeReceiverInput("");
    }
  };

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <h3 className="admin-card-title">System governance and emergency controls</h3>
        <span className={`status-badge-pill ${summary.isPaused ? "paused" : "normal"}`}>
          {summary.isPaused ? "Vault paused" : "Vault operational"}
        </span>
      </div>

      <p className="admin-card-desc">
        Manage protocol pause safeguards and update the destination address for early-withdrawal penalties.
      </p>

      {/* Emergency Pause Switch */}
      <div className="admin-action-box" style={{ marginBottom: "20px" }}>
        <div className="admin-action-info">
          <span className="admin-action-label">Emergency pause switch</span>
          <span className="admin-action-sub">
            {summary.isPaused
              ? "When paused, all deposit withdrawals and renewals are halted for user safety."
              : "Pausing the vault immediately prevents all user withdrawals and renewals in an emergency."}
          </span>
        </div>

        <button
          type="button"
          className={`btn ${summary.isPaused ? "btn-primary" : "btn-danger"} btn-sm text-nowrap`}
          onClick={onTogglePause}
          disabled={isBusy}
          style={{ whiteSpace: "nowrap" }}
        >
          {isBusy
            ? "Processing…"
            : summary.isPaused
            ? "Unpause system"
            : "Emergency pause"}
        </button>
      </div>

      {/* Fee Receiver Configuration */}
      <div className="admin-action-box">
        <div className="admin-action-info" style={{ marginBottom: "12px" }}>
          <span className="admin-action-label">Early withdrawal fee receiver</span>
          <span className="admin-action-sub">
            Current penalty receiver:{" "}
            <span className="tabular-num" style={{ color: "var(--color-accent-hi)" }}>
              {summary.feeReceiver ? (
                <span title={summary.feeReceiver}>{shortenAddress(summary.feeReceiver)}</span>
              ) : (
                "Not set"
              )}
            </span>
          </span>
        </div>

        <form onSubmit={handleUpdateReceiver} className="admin-inline-form">
          <input
            type="text"
            className="input-field tabular-num"
            placeholder="0x… New recipient address"
            value={feeReceiverInput}
            onChange={(e) => setFeeReceiverInput(e.target.value)}
            disabled={isBusy}
          />
          <button
            type="submit"
            className="btn btn-secondary btn-sm text-nowrap"
            disabled={isBusy || !feeReceiverInput.trim()}
            style={{ whiteSpace: "nowrap" }}
          >
            Update receiver
          </button>
        </form>
      </div>
    </div>
  );
};
