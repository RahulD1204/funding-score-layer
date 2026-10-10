// Turning merchant rows into what a screen shows. Display only: every rule comes from lib/engine
// (lockDay, lastPickDay, buildRetryMessage), so a screen never decides anything for itself.

import {
  addDays,
  buildRetryMessage,
  diffDays,
  fillTemplate,
  formatRupees,
  lastPickDay,
  lockDay,
  type ScheduleCard,
} from "@/lib/engine";
import { STATE_WORDS, type Tone } from "@/lib/demo/words";
import type { MerchantCaseRow, ProductRow, ScheduleOptionRow } from "@/lib/data/rows";

/** A schedule_options row in the engine's card shape, so the preview's card view can draw it. */
export function cardFromRow(row: ScheduleOptionRow): ScheduleCard {
  return {
    label: row.label,
    labels: row.merged_labels,
    attemptDays: row.attempt_days,
    mainDay: row.main_day,
    band: row.band,
    attempts: row.attempts,
    daysOverdue: row.days_overdue,
    waitingChargePaise: row.waiting_charge_paise,
    versusOriginal:
      row.days_later_than_original === null
        ? null
        : { daysLater: row.days_later_than_original, extraChargePaise: row.extra_charge_paise },
  };
}

export function stateChip(state: MerchantCaseRow["state"]): { label: string; tone: Tone } {
  return STATE_WORDS[state];
}

/** Days after the due date, the unit the engine counts in. */
export function dayOf(dueDate: string, date: string): number {
  return diffDays(dueDate, date);
}

/** Whether a dated action has locked by `today`: the day before its date (lib/engine lockDay). */
export function hasLocked(dueDate: string, actionDate: string, today: string): boolean {
  return lockDay(dayOf(dueDate, actionDate)) <= dayOf(dueDate, today);
}

/**
 * Whether the lender may still pick `card`, and until when. The server function decides for real
 * (pickSchedule); this is the same rule (lastPickDay) so the screen shows it before the click.
 * Nothing may have locked yet: the earliest planned date is the chosen card's first attempt.
 */
export function pickWindow(
  row: MerchantCaseRow,
  card: ScheduleCard,
  chosen: ScheduleCard | null,
  today: string,
): { open: boolean; lastDay: string } {
  const lastDay = addDays(row.due_date, lastPickDay(card.attemptDays[0]));
  const running = row.state === "awaiting_choice" || row.state === "scheduled";
  const nothingLocked = row.retries_used === 0 && (chosen === null || !hasLocked(row.due_date, addDays(row.due_date, chosen.attemptDays[0]), today));
  return { open: running && nothingLocked && today <= lastDay, lastDay };
}

/** The day the standing default applies to a lender case nobody picked: its first action's lock day. */
export function defaultAppliesOn(row: MerchantCaseRow, defaultCard: ScheduleCard): string {
  return addDays(row.due_date, lockDay(defaultCard.attemptDays[0]));
}

/** The last day of cover for a premium: the due date plus the product's grace days. */
export function endOfCover(dueDate: string, product: Pick<ProductRow, "grace_days"> | null): string | null {
  return product?.grace_days == null ? null : addDays(dueDate, product.grace_days);
}

/**
 * The customer message for the row, once it exists: a payment link once sent, or a retry
 * message once the next date has locked. Filled from the template by the engine.
 * Build step 9 stores and shows the composed message instead.
 */
export function customerMessage(
  row: MerchantCaseRow,
  merchantName: string,
  product: ProductRow | null,
  today: string,
): string | null {
  if (row.state === "link_sent") {
    return fillTemplate("payment_link", {
      kind: row.kind,
      amount: formatRupees(row.amount_paise),
      merchant: merchantName,
      link: "[payment link]",
    });
  }
  if (!row.next_date || row.next_action_kind === "link" || !hasLocked(row.due_date, row.next_date, today)) return null;
  if (row.state === "paid" || row.state === "failed" || row.state === "normal_retries" || row.state === "needs_action") return null;
  const graceEnd = endOfCover(row.due_date, product);
  return buildRetryMessage({
    segment: row.kind === "EMI" ? "lending" : "insurance",
    merchantName,
    amountPaise: row.amount_paise,
    dueDate: row.due_date,
    plannedDate: row.next_date,
    graceEnd: graceEnd ?? undefined,
  }).text;
}

/** Failed retries so far: every presented debit failed except a debit that collected. */
export function failedRetries(row: MerchantCaseRow): number {
  return Math.max(0, row.retries_used - (row.paid_via === "debit" ? 1 : 0) - (row.state === "result_pending" ? 1 : 0));
}

/** The summary strip on the collections queue (specs/02 screen 2). */
export function queueSummary(rows: MerchantCaseRow[]) {
  const count = (states: MerchantCaseRow["state"][]) => rows.filter((r) => states.includes(r.state)).length;
  return [
    { label: "Awaiting choice", value: count(["awaiting_choice"]) },
    { label: "In progress", value: count(["scheduled", "result_pending", "link_sent", "needs_action"]) },
    { label: "Paid", value: count(["paid"]) },
    { label: "On original retries", value: count(["normal_retries"]) },
    { label: "Failed retries", value: rows.reduce((n, r) => n + failedRetries(r), 0) },
  ];
}
