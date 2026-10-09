// Engine 10: the exceptions desk.
// The desk agent proposes fixes for failures that waiting for payday cannot solve.
// It may pick only from this catalogue. Rules here decide whether a fix runs at once
// or waits for the merchant, and reject anything outside the list.

import type { FailureLabel } from "./triage";

export const FIX_TYPES = [
  "stop_attempts",
  "send_reregistration_link",
  "hold_attempts",
  "send_resume_request",
  "send_method_change_link",
  "hold_and_represent",
  "cancel_pending_attempt",
] as const;
export type FixType = (typeof FIX_TYPES)[number];

export type FixMode = "automatic" | "needs_approval";

/** What sends a case to the desk: a non-balance triage label, or a payment made outside the plan. */
export type DeskTrigger = Exclude<FailureLabel, "balance" | "unknown"> | "customer_paid";

export interface FixDefinition {
  type: FixType;
  description: string;
  /** A fix that sends anything to the customer starts as needs_approval. */
  contactsCustomer: boolean;
  startingMode: FixMode;
}

export const FIX_CATALOGUE: Record<FixType, FixDefinition> = {
  stop_attempts: {
    type: "stop_attempts",
    description: "Stop further debit attempts on this mandate",
    contactsCustomer: false,
    startingMode: "automatic",
  },
  send_reregistration_link: {
    type: "send_reregistration_link",
    description: "Send the customer a link to register a new mandate",
    contactsCustomer: true,
    startingMode: "needs_approval",
  },
  hold_attempts: {
    type: "hold_attempts",
    description: "Hold debit attempts while the mandate is paused",
    contactsCustomer: false,
    startingMode: "automatic",
  },
  send_resume_request: {
    type: "send_resume_request",
    description: "Ask the customer to resume the paused mandate",
    contactsCustomer: true,
    startingMode: "needs_approval",
  },
  send_method_change_link: {
    type: "send_method_change_link",
    description: "Send the customer the page to change the payment method",
    contactsCustomer: true,
    startingMode: "needs_approval",
  },
  hold_and_represent: {
    type: "hold_and_represent",
    description: "Hold, then present the debit again once the bank downtime ends",
    contactsCustomer: false,
    startingMode: "automatic",
  },
  cancel_pending_attempt: {
    type: "cancel_pending_attempt",
    description: "Cancel the pending attempt because the customer has already paid",
    contactsCustomer: false,
    startingMode: "automatic",
  },
};

const FIXES_BY_TRIGGER: Record<DeskTrigger, FixType[]> = {
  mandate_cancelled: ["stop_attempts", "send_reregistration_link"],
  mandate_paused: ["hold_attempts", "send_resume_request"],
  instrument_closed: ["stop_attempts", "send_method_change_link"],
  bank_downtime: ["hold_and_represent"],
  customer_paid: ["cancel_pending_attempt"],
};

export function isDeskTrigger(value: string): value is DeskTrigger {
  return value in FIXES_BY_TRIGGER;
}

export function allowedFixes(trigger: DeskTrigger): FixType[] {
  return FIXES_BY_TRIGGER[trigger];
}

/** A merchant's per-fix settings. A missing entry uses the catalogue's starting mode. */
export type FixSettings = Partial<Record<FixType, FixMode>>;

export function resolveMode(fix: FixType, settings: FixSettings = {}): FixMode {
  return settings[fix] ?? FIX_CATALOGUE[fix].startingMode;
}

export interface DeskProposal {
  fix: FixType;
  reason: string;
  mode: FixMode;
}

export interface DeskValidation {
  accepted: DeskProposal[];
  rejected: { fix: string; why: "not_in_catalogue" | "not_allowed_for_trigger" | "no_reason" | "duplicate" }[];
}

/**
 * Validates the desk agent's raw output. Each item must name a fix that is allowed for the trigger
 * and give a reason. The mode always comes from the merchant's settings, never from the agent.
 */
export function validateDeskOutput(trigger: DeskTrigger, raw: unknown, settings: FixSettings = {}): DeskValidation {
  const result: DeskValidation = { accepted: [], rejected: [] };
  if (!Array.isArray(raw)) return result;
  const allowed = allowedFixes(trigger);
  const seen = new Set<string>();
  for (const item of raw) {
    const fix = typeof item === "object" && item !== null ? String((item as Record<string, unknown>).fix ?? "") : "";
    const reason = typeof item === "object" && item !== null ? (item as Record<string, unknown>).reason : undefined;
    if (!(FIX_TYPES as readonly string[]).includes(fix)) {
      result.rejected.push({ fix, why: "not_in_catalogue" });
    } else if (!allowed.includes(fix as FixType)) {
      result.rejected.push({ fix, why: "not_allowed_for_trigger" });
    } else if (typeof reason !== "string" || !reason.trim()) {
      result.rejected.push({ fix, why: "no_reason" });
    } else if (seen.has(fix)) {
      result.rejected.push({ fix, why: "duplicate" });
    } else {
      seen.add(fix);
      result.accepted.push({ fix: fix as FixType, reason: reason.trim(), mode: resolveMode(fix as FixType, settings) });
    }
  }
  return result;
}

/**
 * The rule-based proposal used when the agent is unavailable or returns nothing usable:
 * every allowed fix for the trigger, with a plain reason.
 */
export function fallbackProposals(trigger: DeskTrigger, settings: FixSettings = {}): DeskProposal[] {
  return allowedFixes(trigger).map((fix) => ({
    fix,
    reason: FIX_CATALOGUE[fix].description,
    mode: resolveMode(fix, settings),
  }));
}
