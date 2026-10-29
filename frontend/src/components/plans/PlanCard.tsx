import React from "react";
import type { SavingPlan } from "../../types";
import { formatDurationSeconds } from "../../lib/format";

interface PlanCardProps {
  plan: SavingPlan;
  isSelected: boolean;
  onSelect: (plan: SavingPlan) => void;
}

export const PlanCard: React.FC<PlanCardProps> = ({
  plan,
  isSelected,
  onSelect,
}) => {
  return (
    <div
      className={`plan-card ${isSelected ? "selected" : ""} ${!plan.enabled ? "disabled" : ""}`}
    >
      <div>
        <div className="plan-head">
          <div>
            <h3 className="plan-title">Plan #{plan.planId}</h3>
            <div style={{ fontSize: "14px", color: "var(--color-muted)" }}>
              {formatDurationSeconds(plan.tenorSeconds)}
            </div>
          </div>
          <span className={`plan-badge ${plan.enabled ? "active" : "inactive"}`}>
            {plan.enabled ? "Open" : "Disabled"}
          </span>
        </div>

        <div className="plan-apr tabular-num">
          {plan.aprPercent}
          <span className="plan-apr-label">Fixed APR</span>
        </div>

        <div className="plan-meta-list">
          <div className="plan-meta-item">
            <span className="meta-label">Tenor Period</span>
            <span className="meta-value tabular-num">{formatDurationSeconds(plan.tenorSeconds)}</span>
          </div>
          <div className="plan-meta-item">
            <span className="meta-label">Early Penalty</span>
            <span className="meta-value tabular-num">{plan.penaltyPercent}</span>
          </div>
          <div className="plan-meta-item">
            <span className="meta-label">Min Deposit</span>
            <span className="meta-value tabular-num">{plan.minDepositFormatted}</span>
          </div>
          <div className="plan-meta-item">
            <span className="meta-label">Max Deposit</span>
            <span className="meta-value tabular-num">{plan.maxDepositFormatted}</span>
          </div>
        </div>
      </div>

      <button
        type="button"
        className={`btn ${isSelected ? "btn-primary" : "btn-secondary"}`}
        onClick={() => onSelect(plan)}
        disabled={!plan.enabled}
        style={{ width: "100%" }}
      >
        {!plan.enabled ? "Plan Disabled" : isSelected ? "Plan Selected" : "Select Plan"}
      </button>
    </div>
  );
};
