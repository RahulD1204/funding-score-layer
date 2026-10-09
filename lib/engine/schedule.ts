// Engine 6: the schedule builder, and the card arithmetic the lender sees.
// Version 1 retimes retries only. The debit on the due date (day 0) always runs as usual.
// Days are counted from the due date: day 0 is the due date, day 5 is five days later.

import { POLICY, SCHEDULE_ORDER, type Band, type ScheduleLabel, type Segment } from "./policy";

export type AttemptKind = "probe" | "attempt" | "backup";

export interface PlannedAttempt {
  day: number;
  kind: AttemptKind;
}

export interface ScheduleOption {
  /** The label shown. When schedules merge, this is the first of the merged labels. */
  label: ScheduleLabel;
  /** Every label that produced this exact schedule. */
  labels: ScheduleLabel[];
  attempts: PlannedAttempt[];
  /** The main attempt day. The band and the days overdue are read at this day. */
  mainDay: number;
  /** The earliest action day, including a probe. */
  firstActionDay: number;
  band: Band;
}

export interface ScheduleInput {
  /** Days from the due date to the predicted funded day. */
  h: number;
  /** Upper day from the estimate. */
  u: number;
  /** Share funded on or before each day. An array indexed by day, or a sparse map. */
  likelihoodByDay: number[] | Record<number, number>;
  segment: Segment;
  /** The merchant's cap on how late an attempt may run. Shown to lenders as the overdue cap. */
  lastAllowedDay: number;
  /** The merchant's cap on re-presentations after the due-date debit. */
  maxRepresentations: number;
  /** Days until a debit's result is known. 2 for bank mandates, 0 for UPI Autopay. */
  resultDelayDays: number;
  /** True when a salary was recognized. Insurance then gets a second backup instead of a probe. */
  salaryRecognized: boolean;
}

export interface ScheduleBuild {
  route: "schedules" | "out_of_reach";
  options: ScheduleOption[];
  /** Set on the out-of-reach route: the day a payment link is sent. */
  linkDay: number | null;
  /** The day the due-date failure is known. */
  failureKnownDay: number;
  /** The earliest day any re-presentation may run. */
  minDay: number;
}

export function likelihoodAt(likelihoodByDay: number[] | Record<number, number>, day: number): number {
  if (Array.isArray(likelihoodByDay)) {
    if (likelihoodByDay.length === 0) return 0;
    return likelihoodByDay[Math.min(Math.max(day, 0), likelihoodByDay.length - 1)] ?? 0;
  }
  // Sparse map: use the value at the greatest listed day on or before the one asked for.
  let best = 0;
  let bestDay = -Infinity;
  for (const [k, v] of Object.entries(likelihoodByDay)) {
    const d = Number(k);
    if (d <= day && d > bestDay) {
      bestDay = d;
      best = v;
    }
  }
  return best;
}

export function bandFor(share: number): Band {
  if (share >= POLICY.bands.high) return "High";
  if (share >= POLICY.bands.medium) return "Medium";
  return "Lower";
}

export function buildSchedules(input: ScheduleInput): ScheduleBuild {
  const { h, segment, lastAllowedDay: L, maxRepresentations: R, resultDelayDays: d } = input;
  const u = Math.max(input.u, h + 1);
  const failureKnownDay = d;
  const minDay = failureKnownDay + 1;

  // Payday itself is past the merchant's cap: no debit can reach it inside the limits.
  if (h > L || R < 1 || minDay > L) {
    return {
      route: "out_of_reach",
      options: [],
      // A loan link is timed to payday. A premium link goes at once, because waiting risks a lapse.
      linkDay: segment === "lending" ? Math.max(h, minDay) : minDay,
      failureKnownDay,
      minDay,
    };
  }

  const base: Record<ScheduleLabel, number> = {
    Earliest: h,
    // One day after the funded day, because money often lands late in the day.
    Balanced: h + 1,
    Safest: u + 1,
  };

  const built: ScheduleOption[] = [];
  for (const label of SCHEDULE_ORDER) {
    const mainDay = Math.min(Math.max(base[label], minDay), L);
    const attempts: PlannedAttempt[] = [{ day: mainDay, kind: "attempt" }];
    let remaining = R - 1;

    // The backup waits for the first result, so two debits never overlap.
    const backupDay = mainDay + d + 1;
    const hasBackup = remaining > 0 && backupDay <= L;
    if (hasBackup) {
      attempts.push({ day: backupDay, kind: "backup" });
      remaining -= 1;
    }

    if (segment === "insurance" && remaining > 0) {
      if (!input.salaryRecognized) {
        // A cheap early check for one-off failures. Lending never gets one: a failed attempt costs a bounce charge.
        if (mainDay > minDay) attempts.push({ day: minDay, kind: "probe" });
      } else if (hasBackup) {
        const secondBackup = backupDay + d + 1;
        if (secondBackup <= L) attempts.push({ day: secondBackup, kind: "backup" });
      }
    }

    attempts.sort((a, b) => a.day - b.day);
    const signature = attempts.map((a) => `${a.kind}:${a.day}`).join("|");
    const existing = built.find((o) => o.attempts.map((a) => `${a.kind}:${a.day}`).join("|") === signature);
    if (existing) {
      existing.labels.push(label);
      continue;
    }
    built.push({
      label,
      labels: [label],
      attempts,
      mainDay,
      firstActionDay: attempts[0].day,
      band: bandFor(likelihoodAt(input.likelihoodByDay, mainDay)),
    });
  }

  return { route: "schedules", options: built, linkDay: null, failureKnownDay, minDay };
}

/** Finds the option a label points to, including a label that was merged into another schedule. */
export function resolveOption(options: ScheduleOption[], label: ScheduleLabel): ScheduleOption | null {
  return options.find((o) => o.labels.includes(label)) ?? null;
}

// ---------------------------------------------------------------------------
// Card arithmetic
// ---------------------------------------------------------------------------

export interface CostSettings {
  /** The lender's disclosed penal charge for each day overdue, in paise. Null hides the charge lines. */
  penalChargePerDayPaise: number | null;
  /** The lender's disclosed charge for each failed presentation, in paise. */
  bounceChargePaise: number | null;
  /** Razorpay's original retry days for this product. */
  baselineRetryDays: number[];
}

export interface ScheduleCard {
  label: ScheduleLabel;
  labels: ScheduleLabel[];
  attemptDays: number[];
  mainDay: number;
  band: Band;
  attempts: number;
  /** Days overdue at the main attempt. */
  daysOverdue: number;
  /** Days overdue times the lender's per-day charge. Never multiplied by a likelihood. */
  waitingChargePaise: number | null;
  /** Against Razorpay's original first retry. */
  versusOriginal: { daysLater: number; extraChargePaise: number | null } | null;
}

export interface BaselineRow {
  days: number[];
  waitingChargePaise: (number | null)[];
  bounceChargePaise: number | null;
}

/**
 * Builds what a lender sees on each schedule card.
 * The charge lines are plain arithmetic on the lender's own disclosed rates, so they reveal
 * nothing about the hidden likelihood. A bounce charge is shown as a fixed fact per failed attempt.
 */
export function buildCards(options: ScheduleOption[], cost: CostSettings): { cards: ScheduleCard[]; baseline: BaselineRow } {
  const perDay = cost.penalChargePerDayPaise;
  const originalFirst = cost.baselineRetryDays[0] ?? null;
  const cards = options.map((o) => ({
    label: o.label,
    labels: o.labels,
    attemptDays: o.attempts.map((a) => a.day),
    mainDay: o.mainDay,
    band: o.band,
    attempts: o.attempts.length,
    daysOverdue: o.mainDay,
    waitingChargePaise: perDay === null ? null : o.mainDay * perDay,
    versusOriginal:
      originalFirst === null
        ? null
        : {
            daysLater: o.mainDay - originalFirst,
            extraChargePaise: perDay === null ? null : (o.mainDay - originalFirst) * perDay,
          },
  }));
  return {
    cards,
    baseline: {
      days: cost.baselineRetryDays,
      waitingChargePaise: cost.baselineRetryDays.map((day) => (perDay === null ? null : day * perDay)),
      bounceChargePaise: cost.bounceChargePaise,
    },
  };
}
