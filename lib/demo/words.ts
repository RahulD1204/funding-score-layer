// Plain words for states, actions and log events. Every state is shown as a word plus a colour.

import { formatDay } from "@/lib/engine/dates";
import type { ActionKind, ActionStatus, CaseState, SimLogEntry } from "@/lib/engine/simulate";

export type Tone = "paid" | "waiting" | "info" | "idle" | "failed";

export const STATE_WORDS: Record<CaseState, { label: string; tone: Tone }> = {
  awaiting_choice: { label: "Awaiting choice", tone: "waiting" },
  scheduled: { label: "Scheduled", tone: "info" },
  result_pending: { label: "Result pending", tone: "waiting" },
  link_sent: { label: "Link sent", tone: "info" },
  paid: { label: "Paid", tone: "paid" },
  failed: { label: "Failed", tone: "failed" },
  normal_retries: { label: "Original retries", tone: "idle" },
  needs_action: { label: "Needs action", tone: "waiting" },
};

export const ACTION_KIND_WORDS: Record<ActionKind, string> = {
  probe: "Early attempt",
  attempt: "Attempt",
  backup: "Backup attempt",
  link: "Payment link",
};

export const ACTION_STATUS_WORDS: Record<ActionStatus, { label: string; tone: Tone }> = {
  planned: { label: "Planned", tone: "idle" },
  locked: { label: "Locked", tone: "info" },
  in_flight: { label: "Result awaited", tone: "waiting" },
  succeeded: { label: "Collected", tone: "paid" },
  failed: { label: "Failed", tone: "failed" },
  sent: { label: "Sent", tone: "info" },
  cancelled: { label: "Cancelled", tone: "idle" },
  dropped: { label: "Dropped", tone: "idle" },
};

/** The failure reason a merchant sees, from the triage label. Stored in merchant_cases.failure_words. */
export const FAILURE_WORDS: Record<string, string> = {
  balance: "Insufficient funds",
  mandate_cancelled: "Mandate cancelled",
  mandate_paused: "Mandate paused",
  instrument_closed: "Account closed",
  bank_downtime: "Bank downtime",
  unknown: "Reason unclear",
};

const STOP_WORDS: Record<string, string> = {
  server_error: "a server check failed",
  kill_switch: "the kill switch is on",
  forced_normal_retries: "the merchant chose Razorpay's original retries for this case",
  no_customer_consent: "the customer withdrew consent",
  no_merchant_consent: "merchant consent is missing",
  mandate_not_active: "the mandate is no longer active",
  holdout: "the customer is in the holdout group",
  layer_off: "the layer is switched off",
};

const FAIL_OPEN_WORDS: Record<string, string> = {
  tier_c: "Too little payment history to say anything about timing (tier C).",
  low_confidence: "The payment pattern is too scattered to trust.",
  no_observations: "No payment history.",
  triage_unknown: "The failure could not be labelled.",
  holdout: "The customer is in the holdout group, which stays on the original retries for comparison.",
  kill_switch: "The kill switch is on.",
  no_customer_consent: "The customer has not consented.",
  no_merchant_consent: "Merchant consent is missing.",
  mandate_not_active: "The mandate is not active.",
  amount_above_afa_limit: "The amount is above the limit for debits without extra authentication.",
  forced_normal_retries: "The merchant forced the original retries for this customer.",
  layer_off: "The layer is switched off for this merchant.",
  product_not_configured: "The product's limits are not set.",
  paid_outside: "The cycle was already paid outside the plan.",
  server_error: "A server check failed, so the case was handed back to the original retries.",
};

export function failOpenWords(reason: string | null): string {
  if (!reason) return "";
  return FAIL_OPEN_WORDS[reason] ?? reason;
}

function dayIn(detail: string | undefined): number | null {
  const m = detail?.match(/day (\d+)/);
  return m ? Number(m[1]) : null;
}

/** One log line in plain words, with real dates instead of day numbers. */
export function eventText(entry: SimLogEntry, dueDate: string): string {
  const d = dayIn(entry.detail);
  const on = d === null ? "" : ` on ${formatDay(dueDate, d)}`;
  switch (entry.event) {
    case "case_opened":
      return entry.detail === "out_of_reach"
        ? "The bank confirmed the due-date failure. No debit can reach the funded day inside the limits, so a payment link is planned."
        : "The bank confirmed the due-date failure. Schedules are ready.";
    case "standing_default_applied":
      return `The standing default (${entry.detail}) was applied.`;
    case "schedule_picked":
      return `The lender picked ${entry.detail}.`;
    case "debit_presented":
      return `${ACTION_KIND_WORDS[(entry.detail as ActionKind) ?? "attempt"] ?? "Attempt"} presented to the bank.`;
    case "debit_succeeded":
      return `The bank confirmed that the debit presented${on} was collected.`;
    case "debit_failed":
      return `The bank confirmed that the debit presented${on} failed.`;
    case "link_sent":
      return "The payment link was sent to the customer.";
    case "link_paid":
      return "The customer paid through the link.";
    case "debit_held":
      return `The backup was held${d === null ? "" : ` until ${formatDay(dueDate, d)}`}, so that two debits are never unresolved at once.`;
    case "debit_dropped":
      return "The backup was dropped, because the earlier result would arrive after the last allowed day.";
    case "plan_stopped":
      return `The plan stopped because ${STOP_WORDS[entry.detail ?? ""] ?? entry.detail}. Razorpay's original retries apply.`;
    case "paid_outside_plan":
      return "The cycle was marked as paid outside the plan. Pending attempts were cancelled.";
    default:
      return entry.event;
  }
}
