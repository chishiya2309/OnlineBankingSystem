import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { DepositForm } from "../components/deposit/DepositForm";
import type { SavingPlan } from "../types";

const plan: SavingPlan = {
  planId: 1, tenorDays: 180, tenorSeconds: 180 * 86400, aprBps: 200, aprPercent: "2.00%",
  minDeposit: 0n, maxDeposit: 0n, minDepositFormatted: "0.00", maxDepositFormatted: "No limit",
  earlyWithdrawPenaltyBps: 350, penaltyPercent: "3.50%", enabled: true,
};
const props: React.ComponentProps<typeof DepositForm> = {
  selectedPlan: plan, balance: 0n, allowance: 0n, status: "idle", statusMessage: "",
  isConnected: true, isCorrectNetwork: true, onApprove: vi.fn(), onOpenDeposit: vi.fn(),
};

afterEach(cleanup);

describe("Deposit form validation stays in sync with wallet and plan data", () => {
  it("clears a stale insufficient-balance error when the wallet balance arrives", () => {
    const view = render(<DepositForm {...props} />);
    fireEvent.change(view.getByLabelText("Deposit Principal"), { target: { value: "1000" } });
    expect(view.getByRole("alert").textContent).toContain("exceeds available balance");
    view.rerender(<DepositForm {...props} balance={2000_000000n} />);
    expect(view.queryByRole("alert")).toBeNull();
    expect((view.getByRole("button", { name: /^Step 1\/2: Approve/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("revalidates an entered amount when a different plan changes the deposit bounds", () => {
    const view = render(<DepositForm {...props} balance={2000_000000n} selectedPlan={{ ...plan, minDeposit: 1500_000000n, minDepositFormatted: "1,500.00" }} />);
    fireEvent.change(view.getByLabelText("Deposit Principal"), { target: { value: "1000" } });
    expect(view.getByRole("alert").textContent).toContain("Minimum deposit");
    view.rerender(<DepositForm {...props} balance={2000_000000n} />);
    expect(view.queryByRole("alert")).toBeNull();
    view.rerender(<DepositForm {...props} balance={2000_000000n} selectedPlan={{ ...plan, maxDeposit: 500_000000n, maxDepositFormatted: "500.00" }} />);
    expect(view.getByRole("alert").textContent).toContain("Maximum deposit");
    expect((view.getByRole("button", { name: /^Step 1\/2: Approve/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
