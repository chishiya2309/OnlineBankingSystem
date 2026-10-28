import React from "react";
import type { ContractAddresses } from "../../types";
import { shortenAddress } from "../../lib/format";

interface FooterProps {
  addresses: ContractAddresses | null;
  chainId: number | null;
}

export const Footer: React.FC<FooterProps> = ({ addresses, chainId }) => {
  const explorerBase = chainId === 11155111 ? "https://sepolia.etherscan.io/address/" : null;

  return (
    <footer className="app-footer">
      <div className="app-container footer-inner">
        <div className="footer-top">
          <div>
            <strong>LEDGER</strong>: Decentralized Term Deposit and Savings Infrastructure
          </div>
          <div>
            Hallmark v2.0.0 Dusk Theme, Wix Madefor Typography, High Contrast
          </div>
        </div>

        {addresses && (
          <div className="footer-contracts">
            <span>
              MockUSDC:{" "}
              {explorerBase ? (
                <a
                  href={`${explorerBase}${addresses.MockUSDC}`}
                  target="_blank"
                  rel="noreferrer"
                  className="contract-link tabular-num"
                >
                  {shortenAddress(addresses.MockUSDC, 6)}
                </a>
              ) : (
                <span className="tabular-num">{shortenAddress(addresses.MockUSDC, 6)}</span>
              )}
            </span>
            <span>
              SavingCore:{" "}
              {explorerBase ? (
                <a
                  href={`${explorerBase}${addresses.SavingCore}`}
                  target="_blank"
                  rel="noreferrer"
                  className="contract-link tabular-num"
                >
                  {shortenAddress(addresses.SavingCore, 6)}
                </a>
              ) : (
                <span className="tabular-num">{shortenAddress(addresses.SavingCore, 6)}</span>
              )}
            </span>
            <span>
              VaultManager:{" "}
              {explorerBase ? (
                <a
                  href={`${explorerBase}${addresses.VaultManager}`}
                  target="_blank"
                  rel="noreferrer"
                  className="contract-link tabular-num"
                >
                  {shortenAddress(addresses.VaultManager, 6)}
                </a>
              ) : (
                <span className="tabular-num">{shortenAddress(addresses.VaultManager, 6)}</span>
              )}
            </span>
          </div>
        )}
      </div>
    </footer>
  );
};
