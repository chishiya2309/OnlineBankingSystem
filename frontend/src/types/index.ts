export interface SavingPlan {
  planId: number;
  tenorDays: number;
  tenorSeconds: number;
  aprBps: number;
  aprPercent: string;
  minDeposit: bigint;
  maxDeposit: bigint;
  minDepositFormatted: string;
  maxDepositFormatted: string;
  earlyWithdrawPenaltyBps: number;
  penaltyPercent: string;
  enabled: boolean;
}

export enum DepositStatus {
  Active = 0,
  Withdrawn = 1,
  ManualRenewed = 2,
  AutoRenewed = 3,
}

export interface DepositRecord {
  depositId: number;
  planId: number;
  principal: bigint;
  principalFormatted: string;
  startAt: number;
  maturityAt: number;
  aprBpsAtOpen: number;
  penaltyBpsAtOpen: number;
  status: DepositStatus;
  owner: string;
  // Computed financial snapshots
  accruedInterest: bigint;
  accruedInterestFormatted: string;
  earlyPenalty: bigint;
  earlyPenaltyFormatted: string;
  maturityPayout: bigint;
  maturityPayoutFormatted: string;
  earlyPayout: bigint;
  earlyPayoutFormatted: string;
  // Time & eligibility helpers
  tenorSeconds: number;
  gracePeriodSeconds: number;
  graceEnd: number;
  isMatured: boolean;
  isGraceEnded: boolean;
  canEarlyWithdraw: boolean;
  canMaturityWithdraw: boolean;
  canManualRenew: boolean;
  canAutoRenew: boolean;
  // Renewal lineage
  renewedFromDepositId?: number;
  renewedToDepositId?: number;
}

export interface PortfolioSummary {
  totalActivePrincipal: bigint;
  totalActivePrincipalFormatted: string;
  activeCount: number;
  historicalCount: number;
  upcomingMaturity: number | null;
  totalEstimatedInterest: bigint;
  totalEstimatedInterestFormatted: string;
}

export type DepositFlowStatus =
  | "idle"
  | "validating"
  | "approval-required"
  | "awaiting-approval-signature"
  | "approval-pending"
  | "approval-confirmed"
  | "awaiting-open-signature"
  | "open-pending"
  | "success"
  | "error";

export type WithdrawFlowStatus =
  | "idle"
  | "validating"
  | "awaiting-signature"
  | "pending"
  | "success"
  | "error";

export type RenewalFlowStatus =
  | "idle"
  | "validating"
  | "awaiting-signature"
  | "pending"
  | "success"
  | "error";

export interface ConfirmedDepositResult {
  txHash: string;
  depositId: number;
  principal: string;
  maturityAt: number;
  maturityFormatted: string;
  aprBps: number;
  aprFormatted: string;
  nftOwner: string;
  status: string;
  blockNumber?: number;
}

export interface ConfirmedWithdrawResult {
  txHash: string;
  depositId: number;
  principal: string;
  payoutAmount: string;
  penaltyAmount: string;
  isEarly: boolean;
  owner: string;
  blockNumber?: number;
}

export interface ConfirmedRenewalResult {
  txHash: string;
  oldDepositId: number;
  newDepositId: number;
  newPrincipal: string;
  newPlanId: number;
  isAuto: boolean;
  owner: string;
  blockNumber?: number;
}

export interface NetworkConfig {
  chainId: number;
  name: string;
  displayName: string;
  rpcUrl: string;
  currencySymbol: string;
  blockExplorerUrl?: string;
  isTestnet: boolean;
}

export interface ContractAddresses {
  MockUSDC: string;
  VaultManager: string;
  SavingCore: string;
}

export interface AdminSummary {
  supportsSecondPlans: boolean;
  isBankAdmin: boolean;
  vaultOwner: string | null;
  isPaused: boolean;
  feeReceiver: string | null;
  vaultBalance: bigint;
  vaultBalanceFormatted: string;
  adminUSDCBalance: bigint;
  adminUSDCBalanceFormatted: string;
  adminAllowance: bigint;
}

export interface CreatePlanInput {
  tenorSeconds: number;
  aprBps: number;
  minDeposit: string;
  maxDeposit: string;
  earlyWithdrawPenaltyBps: number;
  enabled: boolean;
}

export type AdminActionStatus =
  | "idle"
  | "validating"
  | "awaiting-signature"
  | "pending"
  | "success"
  | "error";

export interface ConfirmedAdminResult {
  action: string;
  txHash: string;
  details?: string;
  blockNumber?: number;
}

