import React, { useState } from "react";
import { formatDurationSeconds } from "../../lib/format";
import type { SavingPlan, CreatePlanInput, AdminActionStatus } from "../../types";

interface AdminPlansManagerProps {
  plans: SavingPlan[];
  supportsSecondPlans: boolean;
  status: AdminActionStatus;
  onCreatePlan: (input: CreatePlanInput) => Promise<boolean>;
  onUpdatePlanApr: (planId: number, newAprBps: number) => Promise<boolean>;
  onTogglePlanStatus: (planId: number, enable: boolean) => Promise<boolean>;
}

export const AdminPlansManager: React.FC<AdminPlansManagerProps> = ({
  plans,
  supportsSecondPlans,
  status,
  onCreatePlan,
  onUpdatePlanApr,
  onTogglePlanStatus,
}) => {
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingPlanId, setEditingPlanId] = useState<number | null>(null);
  const [newAprPercent, setNewAprPercent] = useState("");

  // Create plan state
  const [durationValue, setDurationValue] = useState("90");
  const [durationUnit, setDurationUnit] = useState<"days" | "minutes" | "seconds">("days");
  const [aprPercent, setAprPercent] = useState("4.50");
  const [penaltyPercent, setPenaltyPercent] = useState("5.00");
  const [minDeposit, setMinDeposit] = useState("");
  const [maxDeposit, setMaxDeposit] = useState("");
  const [enabled, setEnabled] = useState(true);

  const isBusy = status === "awaiting-signature" || status === "pending";

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const duration = Number(durationValue);
    const seconds = duration * ({ days: 86400, minutes: 60, seconds: 1 }[durationUnit]);
    const aprBps = Math.round(parseFloat(aprPercent) * 100);
    const penaltyBps = Math.round(parseFloat(penaltyPercent) * 100);

    if (!Number.isSafeInteger(duration) || duration <= 0 || !Number.isSafeInteger(seconds) || seconds > 4294967295 * 86400) return;
    if (isNaN(aprBps) || aprBps < 0) return;
    if (isNaN(penaltyBps) || penaltyBps < 0) return;

    const ok = await onCreatePlan({
      tenorSeconds: seconds,
      aprBps,
      earlyWithdrawPenaltyBps: penaltyBps,
      minDeposit: minDeposit.trim(),
      maxDeposit: maxDeposit.trim(),
      enabled,
    });

    if (ok) {
      setShowCreateForm(false);
      setMinDeposit("");
      setMaxDeposit("");
    }
  };

  const handleUpdateAprSubmit = async (planId: number) => {
    const bps = Math.round(parseFloat(newAprPercent) * 100);
    if (isNaN(bps) || bps < 0) return;

    const ok = await onUpdatePlanApr(planId, bps);
    if (ok) {
      setEditingPlanId(null);
      setNewAprPercent("");
    }
  };

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div>
          <h3 className="admin-card-title">Saving plans management</h3>
          <p className="admin-card-desc" style={{ margin: "4px 0 0" }}>
            Configure contractual term deposit offerings. Lenders lock yield snapshots at deposit opening; plan updates affect new deposits only.
          </p>
        </div>

        <button
          type="button"
          className="btn btn-secondary btn-sm text-nowrap"
          onClick={() => setShowCreateForm(!showCreateForm)}
          disabled={isBusy}
          style={{ whiteSpace: "nowrap" }}
        >
          {showCreateForm ? "Close plan creator" : "+ New saving plan"}
        </button>
      </div>

      {/* Expandable Create Plan Form */}
      {showCreateForm && (
        <form onSubmit={handleCreateSubmit} className="admin-create-form" style={{ marginTop: "20px" }}>
          <h4 className="body-md" style={{ color: "var(--color-ink)", marginBottom: "16px" }}>
            Create new saving plan
          </h4>

          {!supportsSecondPlans && <p role="status">This deployment supports whole days only. Deploy the latest SavingCore to enable short plans.</p>}
          <p className="body-sm">The term is fixed when a deposit opens. APR remains annualized, including short terms. Auto-renew still requires the configured grace period.</p>
          <div className="admin-form-grid">
            <div className="form-group">
              <label className="form-label" htmlFor="plan-duration-unit">Duration unit</label>
              <select id="plan-duration-unit" className="input-field" value={durationUnit} disabled={isBusy}
                onChange={e => setDurationUnit(e.target.value as typeof durationUnit)}>
                <option value="days">Days</option>
                <option value="minutes" disabled={!supportsSecondPlans}>Minutes</option>
                <option value="seconds" disabled={!supportsSecondPlans}>Seconds</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="plan-tenor">Tenor ({durationUnit})</label>
              <input
                id="plan-tenor"
                type="number"
                min="1"
                className="input-field tabular-num"
                value={durationValue}
                onChange={(e) => setDurationValue(e.target.value)}
                required
                disabled={isBusy}
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="plan-apr">Contractual APR (%)</label>
              <input
                id="plan-apr"
                type="number"
                step="0.01"
                min="0"
                max="100"
                className="input-field tabular-num"
                value={aprPercent}
                onChange={(e) => setAprPercent(e.target.value)}
                required
                disabled={isBusy}
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="plan-penalty">Early penalty (%)</label>
              <input
                id="plan-penalty"
                type="number"
                step="0.01"
                min="0"
                max="100"
                className="input-field tabular-num"
                value={penaltyPercent}
                onChange={(e) => setPenaltyPercent(e.target.value)}
                required
                disabled={isBusy}
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="plan-min">Min deposit (USDC)</label>
              <input
                id="plan-min"
                type="number"
                step="any"
                min="0"
                placeholder="0 = no minimum"
                className="input-field tabular-num"
                value={minDeposit}
                onChange={(e) => setMinDeposit(e.target.value)}
                disabled={isBusy}
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="plan-max">Max deposit (USDC)</label>
              <input
                id="plan-max"
                type="number"
                step="any"
                min="0"
                placeholder="0 = no maximum"
                className="input-field tabular-num"
                value={maxDeposit}
                onChange={(e) => setMaxDeposit(e.target.value)}
                disabled={isBusy}
              />
            </div>

            <div className="form-group" style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", height: "42px" }}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  disabled={isBusy}
                />
                <span className="body-sm" style={{ color: "var(--color-ink)" }}>Enabled immediately</span>
              </label>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "16px" }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm text-nowrap"
              onClick={() => setShowCreateForm(false)}
              disabled={isBusy}
              style={{ whiteSpace: "nowrap" }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary btn-sm text-nowrap"
              disabled={isBusy}
              style={{ whiteSpace: "nowrap" }}
            >
              {isBusy ? "Creating on-chain…" : "Create saving plan"}
            </button>
          </div>
        </form>
      )}

      {/* Saving Plans Table */}
      <div className="admin-table-container" style={{ marginTop: "20px" }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Tenor</th>
              <th>APR</th>
              <th>Penalty</th>
              <th>Deposit limits</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {plans.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: "32px", color: "var(--color-muted)" }}>
                  No saving plans found on this network.
                </td>
              </tr>
            ) : (
              plans.map((p) => {
                const isEditing = editingPlanId === p.planId;
                return (
                  <tr key={p.planId}>
                    <td className="tabular-num">#{p.planId}</td>
                    <td className="tabular-num">{formatDurationSeconds(p.tenorSeconds)}</td>
                    <td className="tabular-num" style={{ color: "var(--color-accent-hi)" }}>
                      {isEditing ? (
                        <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            className="input-field tabular-num"
                            style={{ width: "80px", padding: "2px 6px" }}
                            value={newAprPercent}
                            onChange={(e) => setNewAprPercent(e.target.value)}
                            disabled={isBusy}
                            placeholder={p.aprPercent}
                          />
                          <span>%</span>
                        </div>
                      ) : (
                        p.aprPercent
                      )}
                    </td>
                    <td className="tabular-num">{p.penaltyPercent}</td>
                    <td className="tabular-num">
                      {p.minDeposit > 0n || p.maxDeposit > 0n
                        ? `${p.minDepositFormatted} to ${p.maxDepositFormatted} USDC`
                        : "No limits"}
                    </td>
                    <td>
                      <span className={`status-badge-pill ${p.enabled ? "normal" : "paused"}`}>
                        {p.enabled ? "Active" : "Disabled"}
                      </span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <div style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                        {isEditing ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm text-nowrap"
                              onClick={() => handleUpdateAprSubmit(p.planId)}
                              disabled={isBusy || !newAprPercent.trim()}
                              style={{ whiteSpace: "nowrap" }}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm text-nowrap"
                              onClick={() => {
                                setEditingPlanId(null);
                                setNewAprPercent("");
                              }}
                              disabled={isBusy}
                              style={{ whiteSpace: "nowrap" }}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm text-nowrap"
                              onClick={() => {
                                setEditingPlanId(p.planId);
                                setNewAprPercent((p.aprBps / 100).toFixed(2));
                              }}
                              disabled={isBusy}
                              style={{ whiteSpace: "nowrap" }}
                            >
                              Edit APR
                            </button>
                            <button
                              type="button"
                              className={`btn ${p.enabled ? "btn-danger" : "btn-secondary"} btn-sm text-nowrap`}
                              onClick={() => onTogglePlanStatus(p.planId, !p.enabled)}
                              disabled={isBusy}
                              style={{ whiteSpace: "nowrap" }}
                            >
                              {p.enabled ? "Disable" : "Enable"}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
