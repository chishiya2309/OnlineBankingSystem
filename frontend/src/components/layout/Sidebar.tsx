import React from "react";
import { Icon, type IconName } from "./Icon";

export type AppView = "plans" | "portfolio" | "admin";

interface SidebarProps {
  activeTab: AppView;
  onTabChange: (tab: AppView) => void;
  activeDepositCount: number;
  isBankAdmin: boolean;
  isMenuOpen: boolean;
}

const destinations: { id: AppView; label: string; icon: IconName }[] = [
  { id: "plans", label: "Saving Plans & Open", icon: "plans" },
  { id: "portfolio", label: "My Portfolio", icon: "portfolio" },
  { id: "admin", label: "Admin Portal", icon: "admin" },
];

export const Sidebar: React.FC<SidebarProps> = ({ activeTab, onTabChange, activeDepositCount, isBankAdmin, isMenuOpen }) => (
  <aside id="app-navigation" className={`app-sidebar${isMenuOpen ? " is-open" : ""}`}>
    <div className="sidebar-brand wordmark">
      <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="LEDGER Logo" width="34" height="34" />
      <span className="wordmark-title">LEDGER</span>
    </div>
    <nav aria-label="Main navigation">
      <div className="sidebar-tabs" role="tablist" aria-label="Workspace" aria-orientation="vertical">
        {destinations.map(({ id, label, icon }) => (
          <button key={id} id={`tab-${id}`} type="button" role="tab" aria-controls="workspace-panel" aria-selected={activeTab === id} className={`sidebar-tab${activeTab === id ? " active" : ""}`} onClick={() => onTabChange(id)}>
            <Icon name={icon} size={22} />
            <span>{label}</span>
            {id === "portfolio" && activeDepositCount > 0 && <span className="badge-count tabular-num">{activeDepositCount}</span>}
            {id === "admin" && isBankAdmin && <span className="sidebar-admin-badge">Admin</span>}
          </button>
        ))}
      </div>
    </nav>
    <div className="sidebar-caption">Digital Savings<br />and Term Deposit</div>
  </aside>
);
