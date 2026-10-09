// Engines 4 and 5: the evidence gate, salary recognition and the funded-day estimate.
// Pure functions. No database, no clock, no model call.

import { POLICY, type Segment } from "./policy";
import { addDays, addMonths, diffDays, monthKey, type ISODate } from "./dates";
import {
  bestAnchor,
  circularDistance,
  fitAnchor,
  median,
  nextOccurrence,
  type Anchor,
  type AnchorFit,
} from "./circular";

/** A successful payment the customer made through Razorpay, of any size, at any merchant. */
export interface Observation {
  date: ISODate;
  amountPaise: number;
  /** True when the payment was a collection by the merchant now asking. These count twice. */
  ownMerchant?: boolean;
}

/** An inbound credit, such as a RazorpayX Payroll payout. */
export interface Credit {
  date: ISODate;
  amountPaise: number;
  source: string;
}

// ---------------------------------------------------------------------------
// Evidence summary and gate
// ---------------------------------------------------------------------------

export interface EvidenceSummary {
  timingObservations: number;
  monthsCovered: number;
  affordabilityObservations: number;
  inWindow: Observation[];
}

/** Keeps observations dated before `asOf` and inside the lookback window, then counts them. */
export function summarizeEvidence(
  observations: Observation[],
  asOf: ISODate,
  debitAmountPaise: number,
): EvidenceSummary {
  const from = addMonths(asOf, -POLICY.gate.lookbackMonths);
  const inWindow = observations.filter((o) => o.date < asOf && o.date >= from);
  const months = new Set(inWindow.map((o) => monthKey(o.date)));
  const minAmount = debitAmountPaise * POLICY.affordability.minShareOfDebit;
  return {
    timingObservations: inWindow.length,
    monthsCovered: months.size,
    affordabilityObservations: inWindow.filter((o) => o.amountPaise >= minAmount).length,
    inWindow,
  };
}

export type GateFailure = "too_few_observations" | "too_few_months" | "no_failure_evidence" | "identity_not_linked";

export interface GateInput {
  timingObservations: number;
  monthsCovered: number;
  /** At least one insufficient-funds failure or late rescue has been seen for this customer. */
  hasFailureEvidence: boolean;
  /** The same customer id is linked across merchants. */
  identityLinked: boolean;
}

export interface GateResult {
  tier: "A" | "C";
  passed: boolean;
  failed: GateFailure[];
}

export function evaluateGate(input: GateInput): GateResult {
  const failed: GateFailure[] = [];
  if (input.timingObservations < POLICY.gate.minTimingObservations) failed.push("too_few_observations");
  if (input.monthsCovered < POLICY.gate.minMonthsCovered) failed.push("too_few_months");
  if (!input.hasFailureEvidence) failed.push("no_failure_evidence");
  if (!input.identityLinked) failed.push("identity_not_linked");
  return { tier: failed.length === 0 ? "A" : "C", passed: failed.length === 0, failed };
}

/** Thin affordability evidence lowers confidence instead of blocking the customer. */
export function affordabilityDeduction(affordabilityObservations: number): number {
  return affordabilityObservations < POLICY.affordability.minCount ? POLICY.affordability.confidenceDeduction : 0;
}

// ---------------------------------------------------------------------------
// Salary recognition
// ---------------------------------------------------------------------------

export interface SalarySignal {
  source: string;
  fit: AnchorFit;
  dates: ISODate[];
  months: number;
  medianAmountPaise: number;
}

function monthIndex(key: string): number {
  const [y, m] = key.split("-").map(Number);
  return y * 12 + (m - 1);
}

/**
 * Looks for a recurring monthly credit from one source: at least three consecutive months,
 * ending this month or last, with every amount within 10% of the median and every date
 * within 3 days of the circular median. A wrong payday is worse than none, so every credit
 * in the run must pass.
 */
export function recognizeSalary(credits: Credit[], asOf: ISODate): SalarySignal | null {
  const from = addMonths(asOf, -POLICY.gate.lookbackMonths);
  const bySource = new Map<string, Credit[]>();
  for (const c of credits) {
    if (c.date >= asOf || c.date < from) continue;
    const list = bySource.get(c.source) ?? [];
    list.push(c);
    bySource.set(c.source, list);
  }

  let best: SalarySignal | null = null;
  const latestAllowed = monthIndex(monthKey(asOf)) - 1;

  for (const [source, list] of bySource) {
    // Keep the largest credit in each month.
    const perMonth = new Map<number, Credit>();
    for (const c of list) {
      const idx = monthIndex(monthKey(c.date));
      const current = perMonth.get(idx);
      if (!current || c.amountPaise > current.amountPaise) perMonth.set(idx, c);
    }
    const months = [...perMonth.keys()].sort((a, b) => b - a);
    if (months.length === 0 || months[0] < latestAllowed) continue;

    // The most recent unbroken run of months.
    const run: Credit[] = [perMonth.get(months[0])!];
    for (let i = 1; i < months.length && months[i] === months[i - 1] - 1; i++) {
      run.push(perMonth.get(months[i])!);
    }
    if (run.length < POLICY.salary.minConsecutiveMonths) continue;

    const medianAmount = median(run.map((c) => c.amountPaise));
    const amountsOk = run.every(
      (c) => Math.abs(c.amountPaise - medianAmount) <= medianAmount * POLICY.salary.amountTolerance,
    );
    if (!amountsOk) continue;

    const dates = run.map((c) => c.date).sort();
    const fit = bestAnchor(dates);
    const datesOk = fit.positions.every(
      (p) => circularDistance(p, fit.anchor.value) <= POLICY.salary.dateToleranceDays,
    );
    if (!datesOk) continue;

    const signal: SalarySignal = { source, fit, dates, months: run.length, medianAmountPaise: medianAmount };
    if (!best || signal.months > best.months || (signal.months === best.months && medianAmount > best.medianAmountPaise)) {
      best = signal;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Funded-day estimate
// ---------------------------------------------------------------------------

/** A batch score from the offline model. When present it replaces the rule's h, u and likelihood. */
export interface ModelScore {
  h: number;
  u: number;
  /** Chance of being funded by each day after the due date. Index 0 is the due date. */
  likelihoodByDay: number[];
  confidence?: number;
  modelVersion: string;
}

export interface EstimateInput {
  dueDate: ISODate;
  /** Only data dated before this day is used. Defaults to the due date. */
  asOf?: ISODate;
  segment: Segment;
  debitAmountPaise: number;
  observations: Observation[];
  credits?: Credit[];
  modelScore?: ModelScore;
}

export type EstimateFailure = "no_observations" | "low_confidence";

export interface Estimate {
  ok: boolean;
  failReason?: EstimateFailure;
  source: "salary" | "history" | "model";
  salaryRecognized: boolean;
  anchor: Anchor | null;
  mad: number | null;
  /** Confidence after deductions, 0 to 100. */
  confidence: number;
  confidenceBeforeDeductions: number;
  deductions: { affordability: number; drift: number };
  floor: number;
  driftApplied: boolean;
  observationsUsed: number;
  /** Days from the due date to the next funded day. */
  h: number;
  /** The day by which 85% of observations are funded, and at least h + 1. */
  u: number;
  /** Index k holds the share of observations funded on or before day k. Length 31. */
  likelihoodByDay: number[];
  fundedDate: ISODate;
  modelVersion?: string;
}

const HORIZON = 30;

function failed(input: EstimateInput, reason: EstimateFailure): Estimate {
  return {
    ok: false,
    failReason: reason,
    source: "history",
    salaryRecognized: false,
    anchor: null,
    mad: null,
    confidence: 0,
    confidenceBeforeDeductions: 0,
    deductions: { affordability: 0, drift: 0 },
    floor: POLICY.confidence.floor[input.segment],
    driftApplied: false,
    observationsUsed: 0,
    h: 0,
    u: 1,
    likelihoodByDay: new Array(HORIZON + 1).fill(0),
    fundedDate: input.dueDate,
  };
}

export function estimateFunding(input: EstimateInput): Estimate {
  const asOf = input.asOf ?? input.dueDate;
  const floor = POLICY.confidence.floor[input.segment];
  const evidence = summarizeEvidence(input.observations, asOf, input.debitAmountPaise);
  const affordability = affordabilityDeduction(evidence.affordabilityObservations);

  const salary = input.credits ? recognizeSalary(input.credits, asOf) : null;

  let fit: AnchorFit;
  let dates: ISODate[];
  let driftApplied = false;

  if (salary) {
    fit = salary.fit;
    dates = salary.dates;
  } else {
    // The merchant's own collections count twice.
    dates = evidence.inWindow.flatMap((o) => (o.ownMerchant ? [o.date, o.date] : [o.date]));
    if (dates.length === 0) {
      if (!input.modelScore) return failed(input, "no_observations");
      // A model score can still stand on its own.
      return fromModel(input, input.modelScore, floor, affordability);
    }
    fit = bestAnchor(dates);

    // Drift: a recent pattern that has moved wins over the long-run pattern.
    const recentFrom = addMonths(asOf, -POLICY.drift.recentMonths);
    const recent = dates.filter((d) => d >= recentFrom);
    if (recent.length >= POLICY.drift.minRecentObservations) {
      // Both patterns are compared as plain days of the month, so the test does not depend on which anchor fitted best.
      const longRunDay = fitAnchor(dates, "start").anchor.value;
      const recentDay = fitAnchor(recent, "start").anchor.value;
      if (circularDistance(recentDay, longRunDay) > POLICY.drift.maxDistanceDays) {
        fit = bestAnchor(recent);
        dates = recent;
        driftApplied = true;
      }
    }
  }

  const { kind, value } = fit.anchor;
  const within = fit.positions.filter((p) => circularDistance(p, value) <= POLICY.confidence.withinDays).length;
  const confidenceBefore = Math.round((100 * within) / fit.positions.length);
  const drift = driftApplied ? POLICY.drift.confidenceDeduction : 0;
  let confidence = Math.max(0, confidenceBefore - affordability - drift);

  const fundedDate = nextOccurrence(kind, value, input.dueDate);
  let h = diffDays(input.dueDate, fundedDate);

  // Each observation's own next occurrence after the due date gives the likelihood curve.
  const offsets = fit.positions.map((p) => diffDays(input.dueDate, nextOccurrence(kind, p, input.dueDate)));
  let likelihoodByDay: number[] = [];
  for (let k = 0; k <= HORIZON; k++) {
    likelihoodByDay.push(offsets.filter((o) => o <= k).length / offsets.length);
  }
  let u = likelihoodByDay.findIndex((share) => share >= POLICY.upperShare);
  if (u < 0) u = HORIZON;
  u = Math.max(u, h + 1);

  let source: Estimate["source"] = salary ? "salary" : "history";
  let modelVersion: string | undefined;
  let resolvedFundedDate = fundedDate;

  if (input.modelScore) {
    const m = input.modelScore;
    h = m.h;
    u = Math.max(m.u, m.h + 1);
    likelihoodByDay = m.likelihoodByDay;
    if (m.confidence !== undefined) confidence = Math.max(0, m.confidence - affordability - drift);
    source = "model";
    modelVersion = m.modelVersion;
    resolvedFundedDate = addDays(input.dueDate, h);
  }

  const ok = confidence >= floor;
  return {
    ok,
    failReason: ok ? undefined : "low_confidence",
    source,
    salaryRecognized: salary !== null,
    anchor: fit.anchor,
    mad: fit.mad,
    confidence,
    confidenceBeforeDeductions: confidenceBefore,
    deductions: { affordability, drift },
    floor,
    driftApplied,
    observationsUsed: fit.positions.length,
    h,
    u,
    likelihoodByDay,
    fundedDate: resolvedFundedDate,
    modelVersion,
  };
}

function fromModel(input: EstimateInput, m: ModelScore, floor: number, affordability: number): Estimate {
  const confidenceBefore = m.confidence ?? 0;
  const confidence = Math.max(0, confidenceBefore - affordability);
  const ok = confidence >= floor;
  return {
    ok,
    failReason: ok ? undefined : "low_confidence",
    source: "model",
    salaryRecognized: false,
    anchor: null,
    mad: null,
    confidence,
    confidenceBeforeDeductions: confidenceBefore,
    deductions: { affordability, drift: 0 },
    floor,
    driftApplied: false,
    observationsUsed: 0,
    h: m.h,
    u: Math.max(m.u, m.h + 1),
    likelihoodByDay: m.likelihoodByDay,
    fundedDate: addDays(input.dueDate, m.h),
    modelVersion: m.modelVersion,
  };
}

/** "the 7th", "the last day of the month" or "2 days before month-end". Used in the ops reason line. */
export function describeAnchor(anchor: Anchor): string {
  if (anchor.kind === "end") {
    if (anchor.value === 0) return "the last day of the month";
    return `${anchor.value} day${anchor.value === 1 ? "" : "s"} before month-end`;
  }
  const n = anchor.value;
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `the ${n}${suffix}`;
}
