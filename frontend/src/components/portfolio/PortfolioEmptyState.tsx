import React from "react";

interface PortfolioEmptyStateProps {
  isConnected: boolean;
  isCorrectNetwork: boolean;
  isStaleDeployment: boolean;
  error: string | null;
  onConnect: () => void;
  onSwitchNetwork: () => void;
  onNavigateToPlans: () => void;
  onRetry: () => void;
}

export const PortfolioEmptyState: React.FC<PortfolioEmptyStateProps> = ({
  isConnected,
  isCorrectNetwork,
  isStaleDeployment,
  error,
  onConnect,
  onSwitchNetwork,
  onNavigateToPlans,
  onRetry,
}) => {
  if (!isConnected) {
    return (
      <div className="glass-panel" style={{ padding: "48px 24px", textAlign: "center", margin: "24px 0" }}>
        <h3 style={{ fontSize: "18px", fontWeight: 600, color: "var(--color-ink)", marginBottom: "8px" }}>
          Connect Wallet to View Portfolio
        </h3>
        <p style={{ color: "var(--color-muted)", fontSize: "14px", maxWidth: "480px", margin: "0 auto 20px" }}>
          Please connect your MetaMask wallet to view your active term deposits, inspect certificates, and manage settlements.
        </p>
        <button
          type="button"
          className="btn btn-primary text-nowrap"
          onClick={onConnect}
          style={{ whiteSpace: "nowrap" }}
        >
          Connect MetaMask
        </button>
      </div>
    );
  }

  if (!isCorrectNetwork) {
    return (
      <div className="glass-panel" style={{ padding: "48px 24px", textAlign: "center", margin: "24px 0" }}>
        <h3 style={{ fontSize: "18px", fontWeight: 600, color: "var(--color-ink)", marginBottom: "8px" }}>
          Unsupported Network
        </h3>
        <p style={{ color: "var(--color-muted)", fontSize: "14px", maxWidth: "480px", margin: "0 auto 20px" }}>
          Your wallet is connected to an unsupported network. Please switch to Hardhat Localhost (Chain ID 31337) to access term deposits.
        </p>
        <button
          type="button"
          className="btn btn-secondary text-nowrap"
          onClick={onSwitchNetwork}
          style={{ whiteSpace: "nowrap" }}
        >
          Switch to Localhost
        </button>
      </div>
    );
  }

  if (isStaleDeployment) {
    return (
      <div className="glass-panel" style={{ padding: "48px 24px", textAlign: "center", margin: "24px 0" }}>
        <h3 style={{ fontSize: "18px", fontWeight: 600, color: "var(--color-dusk)", marginBottom: "8px" }}>
          Stale Contract Deployment
        </h3>
        <p style={{ color: "var(--color-muted)", fontSize: "14px", maxWidth: "520px", margin: "0 auto 20px" }}>
          No runtime bytecode found at the configured contract addresses on the connected node. The local Hardhat node may have been restarted.
        </p>
        <div style={{ fontFamily: "monospace", fontSize: "13px", background: "var(--color-paper-2)", padding: "12px", borderRadius: "8px", maxWidth: "480px", margin: "0 auto 20px" }}>
          npm run deploy:localhost<br />
          npm run seed:localhost<br />
          npm run export-contracts
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass-panel" style={{ padding: "48px 24px", textAlign: "center", margin: "24px 0" }}>
        <h3 style={{ fontSize: "18px", fontWeight: 600, color: "var(--color-dusk)", marginBottom: "8px" }}>
          Unable to Load Portfolio
        </h3>
        <p style={{ color: "var(--color-muted)", fontSize: "14px", maxWidth: "520px", margin: "0 auto 20px" }}>
          {error}
        </p>
        <button
          type="button"
          className="btn btn-secondary text-nowrap"
          onClick={onRetry}
          style={{ whiteSpace: "nowrap" }}
        >
          Retry Connection
        </button>
      </div>
    );
  }

  return (
    <div className="glass-panel" style={{ padding: "48px 24px", textAlign: "center", margin: "24px 0" }}>
      <h3 style={{ fontSize: "18px", fontWeight: 600, color: "var(--color-ink)", marginBottom: "8px" }}>
        No Term Deposits Found
      </h3>
      <p style={{ color: "var(--color-muted)", fontSize: "14px", maxWidth: "480px", margin: "0 auto 20px" }}>
        This wallet does not currently own any term deposit certificates. Open a term deposit from our saving plans to start earning yields.
      </p>
      <button
        type="button"
        className="btn btn-primary text-nowrap"
        onClick={onNavigateToPlans}
        style={{ whiteSpace: "nowrap" }}
      >
        Explore Saving Plans
      </button>
    </div>
  );
};
