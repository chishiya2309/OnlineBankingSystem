import React, { useState } from "react";
import { ethers } from "ethers";
import type { AdminActionStatus } from "../../types";
import { formatUSDC, formatTimestamp } from "../../lib/format";

interface AdminMaturityManagerProps {
  savingCore: ethers.Contract | null;
  status: AdminActionStatus;
  onSetDepositTimeline: (
    depositId: number,
    newStartAt: number,
    newMaturityAt: number
  ) => Promise<boolean>;
}

interface InspectedDeposit {
  depositId: number;
  planId: number;
  principal: bigint;
  startAt: number;
  maturityAt: number;
  status: number;
  aprBps: number;
  calculatedInterest: bigint;
  gracePeriodSeconds: number;
}

export const AdminMaturityManager: React.FC<AdminMaturityManagerProps> = ({
  savingCore,
  status,
  onSetDepositTimeline,
}) => {
  const [depositIdInput, setDepositIdInput] = useState<string>("1");
  const [inspected, setInspected] = useState<InspectedDeposit | null>(null);
  const [isFetching, setIsFetching] = useState<boolean>(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Proposed timeline mode
  const [mode, setMode] = useState<"mature" | "grace" | "custom">("mature");
  const [customStart, setCustomStart] = useState<string>("");
  const [customMaturity, setCustomMaturity] = useState<string>("");

  const isBusy = status === "awaiting-signature" || status === "pending" || isFetching;

  // Lookup deposit
  const handleLookup = async (idToFetch?: number) => {
    const id = idToFetch ?? parseInt(depositIdInput, 10);
    if (!id || id <= 0 || !savingCore) return;

    try {
      setIsFetching(true);
      setFetchError(null);

      const [dep, interest, grace] = await Promise.all([
        savingCore.getDeposit(id),
        savingCore.calculateInterest(id).catch(() => 0n),
        savingCore.gracePeriodSeconds().catch(() => 172800n),
      ]);

      const data: InspectedDeposit = {
        depositId: id,
        planId: Number(dep.planId),
        principal: BigInt(dep.principal),
        startAt: Number(dep.startAt),
        maturityAt: Number(dep.maturityAt),
        status: Number(dep.status),
        aprBps: Number(dep.aprBpsAtOpen),
        calculatedInterest: BigInt(interest),
        gracePeriodSeconds: Number(grace),
      };

      setInspected(data);
      setCustomStart(data.startAt.toString());
      setCustomMaturity(data.maturityAt.toString());
    } catch (err: any) {
      console.error("Failed to inspect deposit:", err);
      setFetchError(err?.message || `Deposit #${id} not found on contract.`);
      setInspected(null);
    } finally {
      setIsFetching(false);
    }
  };

  const handleApply = async () => {
    if (!inspected) return;

    const now = Math.floor(Date.now() / 1000);
    const originalTenor = inspected.maturityAt - inspected.startAt;

    let targetStart: number;
    let targetMaturity: number;

    if (mode === "mature") {
      targetMaturity = now - 5;
      targetStart = targetMaturity - originalTenor;
    } else if (mode === "grace") {
      targetMaturity = now - inspected.gracePeriodSeconds - 60;
      targetStart = targetMaturity - originalTenor;
    } else {
      targetStart = parseInt(customStart, 10);
      targetMaturity = parseInt(customMaturity, 10);
    }

    const ok = await onSetDepositTimeline(inspected.depositId, targetStart, targetMaturity);
    if (ok) {
      // Refresh inspected deposit
      await handleLookup(inspected.depositId);
    }
  };

  const statusLabels = ["Active", "Withdrawn", "ManualRenewed", "AutoRenewed"];
  const now = Math.floor(Date.now() / 1000);
  const isMaturedCurrently = inspected ? now >= inspected.maturityAt : false;
  const isGraceEndedCurrently = inspected
    ? now >= inspected.maturityAt + inspected.gracePeriodSeconds
    : false;

  return (
    <div className="admin-card" style={{ gridColumn: "1 / -1" }}>
      <div className="admin-card-header">
        <div>
          <h3 className="admin-card-title">
            Deposit Maturity &amp; Timeline Controller (Sepolia Testing Tool)
          </h3>
          <p className="admin-card-desc" style={{ margin: "4px 0 0" }}>
            Fast-forward deposit maturity on Ethereum Sepolia to verify full-interest maturity settlement, manual rollovers, and automated renewals without waiting real-world months.
          </p>
        </div>
        <span className="badge-pill active text-nowrap" style={{ fontSize: "12px", padding: "2px 8px" }}>
          Bank Admin Tool
        </span>
      </div>

      {/* Lookup Bar */}
      <div style={{ display: "flex", gap: "12px", alignItems: "flex-end", margin: "20px 0", flexWrap: "wrap" }}>
        <div style={{ minWidth: "220px", flex: "1" }}>
          <label className="admin-label" htmlFor="depositIdInput">
            Target Deposit / Certificate ID
          </label>
          <input
            id="depositIdInput"
            type="number"
            min="1"
            className="input-field"
            value={depositIdInput}
            onChange={(e) => setDepositIdInput(e.target.value)}
            placeholder="e.g. 1"
            disabled={isBusy}
          />
        </div>

        <button
          type="button"
          className="btn btn-secondary text-nowrap"
          onClick={() => handleLookup()}
          disabled={isBusy || !depositIdInput.trim()}
          style={{ height: "42px" }}
        >
          {isFetching ? "Inspecting..." : "Inspect Deposit State"}
        </button>
      </div>

      {fetchError && (
        <div className="alert-banner error" style={{ marginBottom: "16px" }}>
          <div>{fetchError}</div>
        </div>
      )}

      {/* Inspected Deposit State & Controls */}
      {inspected && (
        <div style={{ marginTop: "16px", padding: "20px", background: "var(--color-surface-sunken)", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
            <h4 style={{ margin: 0, fontSize: "16px", fontWeight: "600" }}>
              Certificate #{inspected.depositId} Details
            </h4>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <span className={`badge-pill ${inspected.status === 0 ? "active" : "muted"}`}>
                Status: {statusLabels[inspected.status] ?? inspected.status}
              </span>
              <span className={`badge-pill ${isMaturedCurrently ? "active" : "warning"}`}>
                {isMaturedCurrently ? "Matured" : "Active (Term in Progress)"}
              </span>
            </div>
          </div>

          {/* Quick Specs Grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "14px", marginBottom: "20px" }}>
            <div className="spec-item">
              <span className="spec-label">Locked Principal</span>
              <span className="spec-value tabular-num">
                {formatUSDC(inspected.principal)} USDC
              </span>
            </div>

            <div className="spec-item">
              <span className="spec-label">Contractual Yield (Full Term)</span>
              <span className="spec-value tabular-num" style={{ color: "var(--color-accent)" }}>
                +{formatUSDC(inspected.calculatedInterest)} USDC
              </span>
            </div>

            <div className="spec-item">
              <span className="spec-label">Plan Tenor</span>
              <span className="spec-value tabular-num">
                {((inspected.maturityAt - inspected.startAt) / 86400).toFixed(1)} days
              </span>
            </div>

            <div className="spec-item">
              <span className="spec-label">Current Start Date</span>
              <span className="spec-value tabular-num">
                {formatTimestamp(inspected.startAt)}
              </span>
            </div>

            <div className="spec-item">
              <span className="spec-label">Current Maturity Date</span>
              <span className="spec-value tabular-num" style={{ color: isMaturedCurrently ? "var(--color-accent-2)" : "inherit" }}>
                {formatTimestamp(inspected.maturityAt)}
              </span>
            </div>

            <div className="spec-item">
              <span className="spec-label">Grace Period Boundary</span>
              <span className="spec-value tabular-num">
                {formatTimestamp(inspected.maturityAt + inspected.gracePeriodSeconds)}
                {isGraceEndedCurrently ? " (Expired - Eligible for Auto-Renew)" : " (Pending)"}
              </span>
            </div>
          </div>

          {inspected.status !== 0 ? (
            <div className="alert-banner warning" style={{ margin: 0 }}>
              <div>
                This deposit is already <strong>{statusLabels[inspected.status]}</strong> and cannot be modified. Only <strong>Active</strong> deposits can be fast-forwarded.
              </div>
            </div>
          ) : (
            <div>
              <div style={{ marginBottom: "16px" }}>
                <span className="admin-action-label" style={{ display: "block", marginBottom: "8px" }}>
                  Select Time-Shift Preset:
                </span>
                <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className={`btn btn-sm ${mode === "mature" ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => setMode("mature")}
                    disabled={isBusy}
                  >
                    ⚡ Mature Immediately (Preserve Full Yield)
                  </button>

                  <button
                    type="button"
                    className={`btn btn-sm ${mode === "grace" ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => setMode("grace")}
                    disabled={isBusy}
                  >
                    ⏳ Pass Grace Period (Test Auto-Renew)
                  </button>

                  <button
                    type="button"
                    className={`btn btn-sm ${mode === "custom" ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => setMode("custom")}
                    disabled={isBusy}
                  >
                    ⚙️ Custom Timestamps
                  </button>
                </div>
              </div>

              {/* Mode Explanations & Custom Inputs */}
              {mode === "mature" && (
                <p className="body-sm" style={{ color: "var(--color-muted)", margin: "0 0 16px" }}>
                  Sets maturity timestamp to 5 seconds ago and shifts start time backward by {((inspected.maturityAt - inspected.startAt) / 86400).toFixed(0)} days. The user can immediately test <strong>Withdraw at Maturity</strong> or <strong>Manual Renew</strong> with 100% full contractual interest.
                </p>
              )}

              {mode === "grace" && (
                <p className="body-sm" style={{ color: "var(--color-muted)", margin: "0 0 16px" }}>
                  Sets maturity timestamp past the {inspected.gracePeriodSeconds / 86400}-day grace period. Any account can then immediately test <strong>Auto-Renew</strong> on-chain.
                </p>
              )}

              {mode === "custom" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "16px" }}>
                  <div>
                    <label className="admin-label">New Start Timestamp (Unix seconds)</label>
                    <input
                      type="number"
                      className="input-field"
                      value={customStart}
                      onChange={(e) => setCustomStart(e.target.value)}
                      disabled={isBusy}
                    />
                  </div>
                  <div>
                    <label className="admin-label">New Maturity Timestamp (Unix seconds)</label>
                    <input
                      type="number"
                      className="input-field"
                      value={customMaturity}
                      onChange={(e) => setCustomMaturity(e.target.value)}
                      disabled={isBusy}
                    />
                  </div>
                </div>
              )}

              <button
                type="button"
                className="btn btn-primary"
                onClick={handleApply}
                disabled={isBusy}
                style={{ width: "100%", justifyContent: "center" }}
              >
                {status === "awaiting-signature"
                  ? "Confirm in MetaMask..."
                  : status === "pending"
                  ? "Broadcasting Update to Sepolia..."
                  : `Apply Timeline Adjustment to Certificate #${inspected.depositId}`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
