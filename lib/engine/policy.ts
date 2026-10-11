// Policy constants for version 1.
// Every number here is a placeholder to tune on data unless specs/00-decision-record.md says it is decided.
// Change POLICY_VERSION whenever a rule or a number changes, then rerun all golden cases.

export const POLICY_VERSION = "v1.3";

export type Segment = "lending" | "insurance";
export type Rail = "bank_mandate" | "upi_autopay";
export type MerchantType = "lender" | "insurer";
export type ScheduleLabel = "Earliest" | "Balanced" | "Safest";
export type Band = "High" | "Medium" | "Lower";

export const POLICY = {
  /** Days on the day-of-month circle, so that day 31 sits next to day 1. */
  circle: 31,

  gate: {
    minTimingObservations: 25,
    minMonthsCovered: 3,
    lookbackMonths: 12,
  },

  affordability: {
    /** A past debit counts as affordability evidence at this share of the debit or more. */
    minShareOfDebit: 0.5,
    minCount: 3,
    confidenceDeduction: 10,
  },

  drift: {
    recentMonths: 3,
    minRecentObservations: 6,
    maxDistanceDays: 3,
    confidenceDeduction: 10,
  },

  confidence: {
    withinDays: 2,
    floor: { lending: 80, insurance: 70 } as Record<Segment, number>,
  },

  /** The upper day is the day by which this share of observations is funded. */
  upperShare: 0.85,

  bands: { high: 0.8, medium: 0.6 },

  /** Result delay in calendar days. Bank mandates confirm late; UPI Autopay is treated as instant. */
  resultDelayDays: { bank_mandate: 2, upi_autopay: 0 } as Record<Rail, number>,

  /** Razorpay's original retries, used when the layer does not act. Loan days are an assumption to confirm. */
  baselineRetryDays: {
    lending: [3, 6, 9],
    insurance: [1, 2, 3],
  } as Record<Segment, number[]>,

  /** Starting limits a merchant can edit per product. */
  defaultLimits: {
    lending: { lastAllowedDay: 10, maxRepresentations: 2 },
    insurance: { lastAllowedDay: 12, maxRepresentations: 3 },
  } as Record<Segment, { lastAllowedDay: number; maxRepresentations: number }>,

  /** Debits above these amounts need extra customer authentication on UPI Autopay. Bank mandates are not checked. */
  afaLimitPaise: {
    upiDefault: 15_000_00,
    upiInsurance: 1_00_000_00,
  },

  salary: {
    minConsecutiveMonths: 3,
    amountTolerance: 0.1,
    dateToleranceDays: 3,
  },

  agent: { maxSteps: 4, dailyRunsPerUser: 50 },
} as const;

export const SCHEDULE_ORDER: ScheduleLabel[] = ["Earliest", "Balanced", "Safest"];
