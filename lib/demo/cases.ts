// Demo cases for the engine preview on the home page.
// Every customer, merchant and payment here is invented. Nothing is read from a database:
// each case is a fixed input that the real engine evaluates when the page is built.
// The full build replaces this file with the seeded Supabase tables (specs/05-data-and-model.md).

import type { FailedDebitInput } from "@/lib/engine/pipeline";
import type { Credit, Observation } from "@/lib/engine/estimate";
import type { MerchantType, ScheduleLabel } from "@/lib/engine/policy";

export const DEMO_DUE_DATE = "2026-04-02";

/** The preview opens on 4 April: the day lenders learn that the 2 April debits failed. */
export const DEMO_START_DAY = 2;

const SIX_MONTHS = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"];

function payments(
  months: string[],
  days: number[],
  amountPaise: number | ((dayOfMonth: number, index: number) => number),
  ownMerchant = false,
): Observation[] {
  const out: Observation[] = [];
  for (const month of months) {
    days.forEach((d, i) => {
      out.push({
        date: `${month}-${String(d).padStart(2, "0")}`,
        amountPaise: typeof amountPaise === "function" ? amountPaise(d, i) : amountPaise,
        ownMerchant,
      });
    });
  }
  return out;
}

function credits(months: string[], days: number[], amountPaise: number, source: string): Credit[] {
  return months.map((month, i) => ({
    date: `${month}-${String(days[i % days.length]).padStart(2, "0")}`,
    amountPaise,
    source,
  }));
}

const CONTROLS_ON = {
  layerEnabled: true,
  killSwitch: false,
  productConfigured: true,
  merchantConsent: true,
  customerConsent: true,
  inHoldout: false,
  forcedNormalRetries: false,
};

export const LENDER = {
  name: "Northfield Finance",
  type: "lender" as MerchantType,
  product: "Personal loan",
  kind: "EMI" as const,
  amountPaise: 12_000_00,
  limits: { lastAllowedDay: 10, maxRepresentations: 2 },
  // Illustrative rates a lender would have disclosed in its Key Facts Statement.
  cost: { penalChargePerDayPaise: 8_00, bounceChargePaise: 500_00, baselineRetryDays: [3, 6, 9] },
  standingDefault: "Balanced" as ScheduleLabel,
};

export const INSURER = {
  name: "Harbour Life",
  type: "insurer" as MerchantType,
  product: "Term plan, monthly premium",
  kind: "premium" as const,
  amountPaise: 2_500_00,
  limits: { lastAllowedDay: 12, maxRepresentations: 3 },
  /** Cover continues to this day after the due date. */
  graceEndDay: 15,
  standingDefault: "Balanced" as ScheduleLabel,
};

export interface DemoCaseSeed {
  id: string;
  customer: string;
  merchant: typeof LENDER | typeof INSURER;
  /** The bank's free-text reason, as an ops analyst would see it. */
  bankText: string;
  /** One line on what this case shows. */
  teaches: string;
  input: FailedDebitInput;
  /** Ground truth for the simulated bank. The engine never reads it. */
  truth: { fundedOnDay: number | null };
}

function lending(over: Partial<FailedDebitInput> & Pick<FailedDebitInput, "observations">): FailedDebitInput {
  return {
    dueDate: DEMO_DUE_DATE,
    segment: "lending",
    rail: "bank_mandate",
    amountPaise: LENDER.amountPaise,
    errorReason: "insufficient_funds",
    mandateStatus: "active",
    downtimeActive: false,
    controls: CONTROLS_ON,
    hasFailureEvidence: true,
    identityLinked: true,
    limits: LENDER.limits,
    cost: LENDER.cost,
    ...over,
  };
}

function insurance(over: Partial<FailedDebitInput> & Pick<FailedDebitInput, "observations">): FailedDebitInput {
  return {
    dueDate: DEMO_DUE_DATE,
    segment: "insurance",
    rail: "upi_autopay",
    amountPaise: INSURER.amountPaise,
    errorReason: "insufficient_funds",
    mandateStatus: "active",
    downtimeActive: false,
    controls: CONTROLS_ON,
    hasFailureEvidence: true,
    identityLinked: true,
    limits: INSURER.limits,
    ...over,
  };
}

// Payment histories. One payment a month is large enough to count as affordability evidence.
const bigOnFirst = (_d: number, i: number) => (i === 0 ? 10_000_00 : 500_00);
const AROUND_THE_7TH = payments(SIX_MONTHS, [6, 7, 7, 7, 8, 9], bigOnFirst);
const AROUND_THE_9TH = payments(SIX_MONTHS, [8, 9, 9, 10, 11], bigOnFirst);
const AROUND_THE_11TH = payments(SIX_MONTHS, [10, 11, 11, 11, 12, 13], bigOnFirst);
const AROUND_THE_22ND = payments(SIX_MONTHS, [21, 22, 22, 22, 23, 22], bigOnFirst);
const TWO_MONTHS_ONLY = payments(["2026-02", "2026-03"], [5, 9, 14, 20], 800_00);

export const DEMO_CASES: DemoCaseSeed[] = [
  {
    id: "L-1041",
    customer: "Asha Verma",
    merchant: LENDER,
    bankText: "INSUFFICIENT FUNDS",
    teaches: "The core flow. The retries wait for the day this borrower is usually funded, instead of bouncing before it.",
    input: lending({ observations: AROUND_THE_7TH }),
    truth: { fundedOnDay: 5 },
  },
  {
    id: "L-1042",
    customer: "Rohan Mehta",
    merchant: LENDER,
    bankText: "INSUFFICIENT FUNDS",
    teaches:
      "This month the money lands a day later than usual. Pick Earliest to watch the first attempt miss and the backup attempt rescue it.",
    input: lending({
      observations: AROUND_THE_9TH,
      credits: credits(SIX_MONTHS, [8, 7, 8, 9, 9, 8], 62_000_00, "payroll-source-17"),
    }),
    truth: { fundedOnDay: 7 },
  },
  {
    id: "L-1043",
    customer: "Karan Joshi",
    merchant: LENDER,
    bankText: "INSUFFICIENT FUNDS",
    teaches: "The usual funded day is close to the lender's 10-day cap, so two of the three schedules merge into one.",
    input: lending({ observations: AROUND_THE_11TH }),
    truth: { fundedOnDay: 9 },
  },
  {
    id: "L-1044",
    customer: "Imran Sheikh",
    merchant: LENDER,
    bankText: "INSUFFICIENT FUNDS",
    teaches: "The usual funded day is past the lender's cap. No debit can reach it, so a payment link goes out instead.",
    input: lending({ observations: AROUND_THE_22ND }),
    truth: { fundedOnDay: 20 },
  },
  {
    id: "L-1045",
    customer: "Neha Kulkarni",
    merchant: LENDER,
    bankText: "INSUFFICIENT FUNDS",
    teaches: "A new customer with two months of history. There is too little evidence, so the layer stays out of the way.",
    input: lending({ observations: TWO_MONTHS_ONLY }),
    truth: { fundedOnDay: 4 },
  },
  {
    id: "L-1046",
    customer: "Vikram Nair",
    merchant: LENDER,
    bankText: "MANDATE CANCELLED BY CUSTOMER",
    teaches: "Not a balance problem. Waiting for a funded day cannot fix a cancelled mandate, so the case goes to the exceptions desk.",
    input: lending({ observations: AROUND_THE_7TH, errorReason: "mandate_cancelled", mandateStatus: "cancelled" }),
    truth: { fundedOnDay: 5 },
  },
  {
    id: "L-1047",
    customer: "Sunita Rao",
    merchant: LENDER,
    bankText: "TXN DECLINED - REFER TO BANK",
    teaches: "A catch-all reason code that rules and lookups cannot label. The Triage agent would read the bank's text here.",
    input: lending({ observations: AROUND_THE_7TH, errorReason: "payment_failed" }),
    truth: { fundedOnDay: 5 },
  },
  {
    id: "I-2011",
    customer: "Priya Raman",
    merchant: INSURER,
    bankText: "INSUFFICIENT FUNDS",
    teaches: "An insurer sees no schedule cards. One cheap early attempt runs first, then the retries wait for the funded day.",
    input: insurance({ observations: AROUND_THE_11TH }),
    truth: { fundedOnDay: 9 },
  },
  {
    id: "I-2012",
    customer: "Dev Malhotra",
    merchant: INSURER,
    bankText: "INSUFFICIENT FUNDS",
    teaches: "The timing evidence is strong here, so there is no early attempt and nothing fails. Compare with Priya Raman.",
    input: insurance({
      observations: AROUND_THE_11TH,
      credits: credits(SIX_MONTHS, [11, 10, 11, 11, 12, 11], 48_000_00, "payroll-source-08"),
    }),
    truth: { fundedOnDay: 9 },
  },
];
