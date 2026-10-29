import React from "react";
import { shortenAddress } from "../../lib/format";

interface AdminRestrictedStateProps {
  connectedAccount: string | null;
  expectedAdmin: string | null;
  currentNetworkName?: string;
}

export const AdminRestrictedState: React.FC<AdminRestrictedStateProps> = ({
  connectedAccount,
  expectedAdmin,
  currentNetworkName = "current network",
}) => {
  return (
    <div className="admin-restricted-card">
      <h3 className="section-title" style={{ marginBottom: "8px", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <span>Bank Administrator authentication required</span>
        <span className="badge-pill error text-nowrap" style={{ fontSize: "12px", padding: "2px 8px", whiteSpace: "nowrap" }}>
          Restricted Access
        </span>
      </h3>

      <p className="section-subtitle" style={{ maxWidth: "600px", marginBottom: "24px" }}>
        This management portal is strictly reserved for the authorized Bank Administrator of the term deposit protocol on {currentNetworkName}.
      </p>

      <div className="meta-box" style={{ maxWidth: "680px", marginBottom: "24px" }}>
        <div className="meta-row">
          <span className="meta-label">Connected account</span>
          <span className="meta-val tabular-num">
            {connectedAccount ? (
              <span title={connectedAccount}>{shortenAddress(connectedAccount)}</span>
            ) : (
              "Wallet not connected"
            )}
          </span>
        </div>
        <div className="meta-row">
          <span className="meta-label">Authorized bank admin</span>
          <span className="meta-val tabular-num" style={{ color: "var(--color-accent-hi)" }}>
            {expectedAdmin ? (
              <span title={expectedAdmin}>{shortenAddress(expectedAdmin)}</span>
            ) : (
              "Querying on-chain registry…"
            )}
          </span>
        </div>
      </div>

      <div className="instructions-box" style={{ maxWidth: "680px" }}>
        <p className="body-sm" style={{ color: "var(--color-muted)", margin: 0 }}>
          To access the Admin Portal, please open MetaMask and switch to the authorized administrator address listed above.
        </p>
      </div>
    </div>
  );
};
