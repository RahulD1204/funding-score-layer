// Shared set-up for the golden cases.
// Unless a test says otherwise: a Rs 12,000 EMI due on 2 April 2026 that failed for insufficient funds.
// Day 0 is 2 April, so day 5 is 7 April and day 10 is 12 April.

import { addDays, type CostSettings, type Observation, type ScheduleInput } from "@/lib/engine";

export const DUE = "2026-04-02";
export const EMI_PAISE = 12_000_00;
export const PREMIUM_PAISE = 2_500_00;

/** The date n days after the due date. */
export const day = (n: number) => addDays(DUE, n);

/** A lender on bank mandates: results take 2 days, cap of 10 days, 2 re-presentations. */
export const LENDING: Pick<
  ScheduleInput,
  "segment" | "lastAllowedDay" | "maxRepresentations" | "resultDelayDays" | "salaryRecognized"
> = {
  segment: "lending",
  lastAllowedDay: 10,
  maxRepresentations: 2,
  resultDelayDays: 2,
  salaryRecognized: false,
};

/** An insurer on UPI Autopay: instant results, last allowed day 14 April, 3 attempts. */
export const INSURANCE: Pick<
  ScheduleInput,
  "segment" | "lastAllowedDay" | "maxRepresentations" | "resultDelayDays" | "salaryRecognized"
> = {
  segment: "insurance",
  lastAllowedDay: 12,
  maxRepresentations: 3,
  resultDelayDays: 0,
  salaryRecognized: false,
};

/** Illustrative lender rates: Rs 8 a day overdue, Rs 500 a bounce. */
export const LENDER_COST: CostSettings = {
  penalChargePerDayPaise: 8_00,
  bounceChargePaise: 500_00,
  baselineRetryDays: [3, 6, 9],
};

export const MONTHS_5 = ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03"];

/** Builds one successful payment per listed day in each listed month. */
export function observations(
  months: string[],
  days: number[],
  amountPaise: number | ((dayOfMonth: number, index: number) => number) = 500_00,
  ownMerchant = false,
): Observation[] {
  const out: Observation[] = [];
  for (const m of months) {
    days.forEach((d, i) => {
      out.push({
        date: `${m}-${String(d).padStart(2, "0")}`,
        amountPaise: typeof amountPaise === "function" ? amountPaise(d, i) : amountPaise,
        ownMerchant,
      });
    });
  }
  return out;
}

/**
 * Thirty payments over five months, clustered on the 6th to the 9th with most on the 7th.
 * One payment a month is large enough to count as affordability evidence for the EMI.
 * Gives a funded day of the 7th: h = 5 and u = 7 for a 2 April due date.
 */
export const AROUND_THE_7TH: Observation[] = observations(MONTHS_5, [6, 7, 7, 7, 8, 9], (d) =>
  d === 6 ? 10_000_00 : 500_00,
);

export const CONTROLS_OK = {
  layerEnabled: true,
  killSwitch: false,
  productConfigured: true,
  merchantConsent: true,
  customerConsent: true,
  inHoldout: false,
  forcedNormalRetries: false,
};
