import React from "react";
import type { ConfirmedDepositResult } from "../../types";
import { shortenAddress } from "../../lib/format";

interface TransactionReceiptCardProps {
  confirmedDeposit: ConfirmedDepositResult;
  chainId: number | null;
  onReset: () => void;
  onViewInPortfolio?: () => void;
}

export const TransactionReceiptCard: React.FC<TransactionReceiptCardProps> = ({
  confirmedDeposit,
  chainId,
  onReset,
  onViewInPortfolio,
}) => {
  const explorerTx =
    chainId === 11155111
      ? `https://sepolia.etherscan.io/tx/${confirmedDeposit.txHash}`
      : null;

  return (
    <div className="tx-state-card success">
      <div className="tx-state-head">
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "32px",
            height: "32px",
            borderRadius: "50%",
            background: "var(--color-accent)",
            color: "var(--color-accent-ink)",
            fontWeight: "bold",
            fontSize: "18px",
          }}
        >
          ✓
        </span>
        <div>
          <h4 className="tx-state-title">Deposit Confirmed on Blockchain</h4>
          <div style={{ fontSize: "13px", color: "var(--color-muted)" }}>
            ERC721 Certificate NFT minted to your wallet
          </div>
        </div>
      </div>

      <div className="tx-evidence-list">
        <div className="tx-evidence-item">
          <span className="meta-label">Certificate Token ID</span>
          <strong className="tabular-num" style={{ color: "var(--color-accent)" }}>
            #{confirmedDeposit.depositId} (SDC NFT)
          </strong>
        </div>

        <div className="tx-evidence-item">
          <span className="meta-label">Principal Deposited</span>
          <span className="meta-value tabular-num">{confirmedDeposit.principal} USDC</span>
        </div>

        <div className="tx-evidence-item">
          <span className="meta-label">Contractual APR</span>
          <span className="meta-value tabular-num">{confirmedDeposit.aprFormatted}</span>
        </div>

        <div className="tx-evidence-item">
          <span className="meta-label">Maturity Date</span>
          <span className="meta-value tabular-num">{confirmedDeposit.maturityFormatted}</span>
        </div>

        <div className="tx-evidence-item">
          <span className="meta-label">Certificate Owner (NFT)</span>
          <span className="meta-value tabular-num" title={confirmedDeposit.nftOwner}>
            {shortenAddress(confirmedDeposit.nftOwner, 6)}
          </span>
        </div>

        <div className="tx-evidence-item">
          <span className="meta-label">Deposit Status</span>
          <span className="plan-badge active">{confirmedDeposit.status}</span>
        </div>

        <div className="tx-evidence-item">
          <span className="meta-label">Transaction Hash</span>
          {explorerTx ? (
            <a
              href={explorerTx}
              target="_blank"
              rel="noreferrer"
              className="tx-hash-link tabular-num"
            >
              {shortenAddress(confirmedDeposit.txHash, 8)} ↗
            </a>
          ) : (
            <span className="tabular-num" style={{ color: "var(--color-accent)" }}>
              {shortenAddress(confirmedDeposit.txHash, 8)}
            </span>
          )}
        </div>
      </div>

      <div style={{ marginTop: "20px", display: "flex", gap: "10px", flexDirection: "column" }}>
        {onViewInPortfolio && (
          <button
            type="button"
            className="btn btn-primary btn-sm text-nowrap"
            onClick={onViewInPortfolio}
            style={{ width: "100%", whiteSpace: "nowrap" }}
          >
            <span style={{ whiteSpace: "nowrap" }}>View Certificate in Portfolio</span>
          </button>
        )}
        <button
          type="button"
          className="btn btn-secondary btn-sm text-nowrap"
          onClick={onReset}
          style={{ width: "100%", whiteSpace: "nowrap" }}
        >
          <span style={{ whiteSpace: "nowrap" }}>Open Another Term Deposit</span>
        </button>
      </div>
    </div>
  );
};
