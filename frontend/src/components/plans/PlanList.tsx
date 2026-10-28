import React from "react";
import type { SavingPlan } from "../../types";
import { PlanCard } from "./PlanCard";

interface PlanListProps {
  plans: SavingPlan[];
  selectedPlan: SavingPlan | null;
  onSelectPlan: (plan: SavingPlan) => void;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export const PlanList: React.FC<PlanListProps> = ({
  plans,
  selectedPlan,
  onSelectPlan,
  isLoading,
  error,
  onRefresh,
}) => {
  return (
    <section style={{ marginBottom: "48px" }}>
      <div className="section-header">
        <div>
          <h2 className="section-title">Verified Saving Plans</h2>
          <p className="section-caption">
            Term deposit rates and early withdrawal penalties queried directly from SavingCore
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm text-nowrap"
          onClick={onRefresh}
          disabled={isLoading}
        >
          {isLoading ? "Refreshing…" : "↻ Refresh Plans"}
        </button>
      </div>

      {error && (
        <div className="alert-banner error" role="alert">
          <div>{error}</div>
        </div>
      )}

      {isLoading && plans.length === 0 ? (
        <div className="glass-panel" style={{ padding: "40px", textAlign: "center", color: "var(--color-muted)" }}>
          Loading saving plans from blockchain ledger…
        </div>
      ) : plans.length === 0 ? (
        <div className="glass-panel" style={{ padding: "40px", textAlign: "center", color: "var(--color-muted)" }}>
          No saving plans found on-chain. Please seed the saving plans (`npx hardhat run scripts/seed.ts --network localhost`).
        </div>
      ) : (
        <div className="plans-grid">
          {plans.map((plan) => (
            <PlanCard
              key={plan.planId}
              plan={plan}
              isSelected={selectedPlan?.planId === plan.planId}
              onSelect={onSelectPlan}
            />
          ))}
        </div>
      )}
    </section>
  );
};
