// Turns the engine's output into table rows. Merchant rows come only from merchantView (the case)
// and buildCards (the schedule cards), so they never carry h, u, a likelihood number or confidence.
// Day numbers become dates with the engine's addDays.

import "server-only";
import {
  POLICY,
  addDays,
  buildCards,
  merchantView,
  type ISODate,
  type SimCase,
} from "@/lib/engine";
import type { AuditRow, CaseBundle, CaseRecord, LimitsSnapshot, ObligationRow } from "./store";

/** What a merchant reads once the layer is not acting. The same words as the engine's fail-open reason. */
export const ORIGINAL_RETRIES_REASON = "Razorpay's original retries apply.";

/** One case per failed cycle, so the id is fixed by the obligation and the due date. */
export function caseIdFor(obligationId: string, dueDate: ISODate): string {
  return `${obligationId}:${dueDate}`;
}

export function limitsFrom(ob: ObligationRow): LimitsSnapshot {
  const p = ob.products;
  return {
    merchantType: ob.merchants.type,
    segment: p.segment,
    rail: p.rail,
    lastAllowedDay: p.last_allowed_day ?? 0,
    maxRepresentations: p.max_representations ?? 0,
    // The same delay the pipeline builds schedules with.
    resultDelayDays: POLICY.resultDelayDays[p.rail],
    baselineRetryDays: p.baseline_retry_days,
    penalChargePerDayPaise: p.penal_charge_per_day_paise,
    bounceChargePaise: p.bounce_charge_paise,
  };
}

const dateOf = (dueDate: ISODate, day: number | null | undefined): ISODate | null =>
  day === null || day === undefined ? null : addDays(dueDate, day);

/** The merchant_cases row for a case the layer is not running (fail open, or waiting on the desk). */
export function merchantRowWithoutPlan(
  ob: ObligationRow,
  caseId: string,
  dueDate: ISODate,
  limits: LimitsSnapshot,
  state: "normal_retries" | "needs_action",
  failureWords: string | null,
  publicReason: string | null,
): Record<string, unknown> {
  return {
    case_id: caseId,
    merchant_id: ob.merchant_id,
    customer_label: ob.customers.label,
    kind: ob.kind,
    amount_paise: ob.amount_paise,
    due_date: dueDate,
    failure_words: failureWords,
    state,
    retries_used: 0,
    retries_allowed: limits.maxRepresentations,
    chosen_schedule: null,
    chosen_by: null,
    next_date: null,
    next_action_kind: null,
    result_due_date: null,
    paid_date: null,
    paid_via: null,
    public_reason: publicReason,
  };
}

/** The merchant_cases row from merchantView. An insurer's next date appears only once it locks. */
export function merchantRowFromSim(
  ob: ObligationRow,
  caseId: string,
  dueDate: ISODate,
  limits: LimitsSnapshot,
  sim: SimCase,
  failureWords: string | null,
  publicReason: string | null,
): Record<string, unknown> {
  const view = merchantView(sim);
  return {
    case_id: caseId,
    merchant_id: ob.merchant_id,
    customer_label: ob.customers.label,
    kind: ob.kind,
    amount_paise: ob.amount_paise,
    due_date: dueDate,
    failure_words: failureWords,
    state: view.state,
    retries_used: view.attemptsUsed,
    retries_allowed: limits.maxRepresentations,
    chosen_schedule: view.chosen,
    chosen_by: view.chosen === null ? null : sim.chosenBy,
    next_date: dateOf(dueDate, view.nextActionDay),
    next_action_kind: view.nextActionKind,
    result_due_date: dateOf(dueDate, view.resultDueDay),
    paid_date: dateOf(dueDate, sim.paidDay),
    paid_via: sim.paidVia,
    public_reason: sim.stopReason !== null ? ORIGINAL_RETRIES_REASON : publicReason,
  };
}

/** The schedule cards from buildCards, for lenders only. Insurers never get cards. */
export function scheduleOptionRows(
  ob: ObligationRow,
  caseId: string,
  limits: LimitsSnapshot,
  sim: SimCase,
): Record<string, unknown>[] | undefined {
  if (limits.merchantType !== "lender") return undefined;
  const { cards } = buildCards(sim.options, {
    penalChargePerDayPaise: limits.penalChargePerDayPaise,
    bounceChargePaise: limits.bounceChargePaise,
    baselineRetryDays: limits.baselineRetryDays,
  });
  return cards.map((card) => ({
    case_id: caseId,
    merchant_id: ob.merchant_id,
    label: card.label,
    merged_labels: card.labels,
    attempt_days: card.attemptDays,
    main_day: card.mainDay,
    band: card.band,
    attempts: card.attempts,
    days_overdue: card.daysOverdue,
    waiting_charge_paise: card.waitingChargePaise,
    days_later_than_original: card.versusOriginal?.daysLater ?? null,
    extra_charge_paise: card.versusOriginal?.extraChargePaise ?? null,
    chosen: sim.chosen !== null && card.labels.includes(sim.chosen),
  }));
}

export function planActionRows(caseId: string, dueDate: ISODate, sim: SimCase): Record<string, unknown>[] {
  return sim.actions.map((a) => ({
    case_id: caseId,
    action_number: a.id,
    kind: a.kind,
    day: a.day,
    status: a.status,
    result_due_day: a.resultDueDay ?? null,
    // The day it ran: a debit once presented, a link once sent.
    executed_date: a.resultDueDay !== undefined || a.status === "sent" ? addDays(dueDate, a.day) : null,
  }));
}

/**
 * Everything to store after the engine moved an existing case: the snapshot, its actions, the
 * merchant row and the cards. `expectedUpdatedAt` null saves regardless (used only to fail open).
 */
export function bundleFromSim(
  rec: CaseRecord,
  sim: SimCase,
  audit: AuditRow[],
  expectedUpdatedAt: string | null,
): CaseBundle {
  const ob = rec.obligations;
  const limits = rec.limits_snapshot ?? limitsFrom(ob);
  return {
    case: {
      id: rec.id,
      route: rec.route,
      state: sim.state,
      fail_open_reason: sim.stopReason ?? rec.fail_open_reason,
      sim_snapshot: sim,
    },
    expected_updated_at: expectedUpdatedAt,
    merchant_case: merchantRowFromSim(ob, rec.id, rec.cycle_due_date, limits, sim, null, null),
    schedule_options: scheduleOptionRows(ob, rec.id, limits, sim),
    plan_actions: planActionRows(rec.id, rec.cycle_due_date, sim),
    audit,
  };
}

/** One line per engine log entry, for the audit row. */
export function describeLog(entries: SimCase["log"], dueDate: ISODate): string {
  return entries
    .map((e) => `${addDays(dueDate, e.day)}: ${e.event}${e.detail ? ` (${e.detail})` : ""}`)
    .join("; ");
}
