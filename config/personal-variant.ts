// Personal Variant used by deployment, seed scripts and business-contract fixtures.
export const personalVariant = {
  studentIdSuffix: "10",
  A: 0,
  B: 1,
  gracePeriodDays: 2,
  defaultAprBps: 200,
  earlyWithdrawPenaltyBps: 350,
  defaultTenorDays: 180,
} as const;
