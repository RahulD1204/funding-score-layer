// Engine 2: failure triage, and Engine 3: control and consent checks.
// Triage runs in three stages. Rules and lookups decide most failures.
// The Triage agent is called only for catch-all codes that the first two stages cannot label,
// and its answer is accepted only when it is strong and passes the checks below.

import { POLICY, type Rail, type Segment } from "./policy";

export const FAILURE_LABELS = [
  "balance",
  "mandate_cancelled",
  "mandate_paused",
  "instrument_closed",
  "bank_downtime",
  "unknown",
] as const;
export type FailureLabel = (typeof FAILURE_LABELS)[number];

export type MandateStatus = "active" | "cancelled" | "paused" | "expired" | "unknown";

/**
 * Failure reason to label. These reason strings are the ones the prototype's mocked events use.
 * `insufficient_funds`, `payment_failed`, `bank_technical_error` and `gateway_technical_error`
 * appear in Razorpay's public error lists. The mandate and account reasons are illustrative
 * and must be replaced with Razorpay's real reasons for recurring debits before a pilot.
 */
export const CLEAR_REASONS: Record<string, FailureLabel> = {
  insufficient_funds: "balance",
  mandate_cancelled: "mandate_cancelled",
  mandate_revoked: "mandate_cancelled",
  mandate_expired: "mandate_cancelled",
  mandate_paused: "mandate_paused",
  account_closed: "instrument_closed",
  instrument_closed: "instrument_closed",
  bank_technical_error: "bank_downtime",
  gateway_technical_error: "bank_downtime",
};

/** Reasons that say nothing specific. Anything not listed anywhere is also treated as a catch-all. */
export const CATCH_ALL_REASONS = ["payment_failed", "bank_declined", "transaction_declined"];

export interface TriageInput {
  errorReason: string;
  mandateStatus: MandateStatus;
  /** A downtime was active at the customer's bank when the debit was attempted. */
  downtimeActive: boolean;
}

export interface TriageResult {
  label: FailureLabel;
  decidedBy: "rule" | "lookup" | "agent";
  evidence: string[];
  /** True when rules and lookups could not decide and the Triage agent should be asked. */
  needsAgent: boolean;
}

/** Stages 1 and 2. Never calls a model. */
export function triageByRules(input: TriageInput): TriageResult {
  const clear = CLEAR_REASONS[input.errorReason];
  if (clear) {
    return { label: clear, decidedBy: "rule", evidence: [`reason code ${input.errorReason}`], needsAgent: false };
  }
  if (input.mandateStatus === "cancelled" || input.mandateStatus === "expired") {
    return {
      label: "mandate_cancelled",
      decidedBy: "lookup",
      evidence: [`catch-all reason ${input.errorReason}`, `mandate status ${input.mandateStatus}`],
      needsAgent: false,
    };
  }
  if (input.mandateStatus === "paused") {
    return {
      label: "mandate_paused",
      decidedBy: "lookup",
      evidence: [`catch-all reason ${input.errorReason}`, "mandate status paused"],
      needsAgent: false,
    };
  }
  if (input.downtimeActive) {
    return {
      label: "bank_downtime",
      decidedBy: "lookup",
      evidence: [`catch-all reason ${input.errorReason}`, "bank downtime active at the time of the debit"],
      needsAgent: false,
    };
  }
  return {
    label: "unknown",
    decidedBy: "lookup",
    evidence: [`catch-all reason ${input.errorReason}`, "mandate active", "no bank downtime"],
    needsAgent: true,
  };
}

export interface AgentTriageContext {
  mandateStatus: MandateStatus;
  downtimeActive: boolean;
  /**
   * Reason codes of past failed debits on this obligation before the due date: the history the
   * agent's get_failure_history tool reads. Missing means none, so a closed-account label is refused.
   */
  pastFailureCodes?: string[];
}

export interface AgentTriageDecision {
  label: FailureLabel;
  accepted: boolean;
  rejection?: "malformed" | "label_not_allowed" | "weak" | "no_evidence" | "contradicts_lookup" | "closed_not_in_history";
  evidence: string[];
}

/**
 * Stage 3. Validates the Triage agent's raw answer. Anything that is not a well-formed,
 * strong answer inside the label list becomes `unknown`, and the case fails open.
 * Code, not the agent, confirms the facts a `balance` label depends on.
 */
export function acceptAgentTriage(raw: unknown, context: AgentTriageContext): AgentTriageDecision {
  const reject = (rejection: AgentTriageDecision["rejection"]): AgentTriageDecision => ({
    label: "unknown",
    accepted: false,
    rejection,
    evidence: [],
  });

  if (typeof raw !== "object" || raw === null) return reject("malformed");
  const r = raw as Record<string, unknown>;
  if (typeof r.label !== "string" || typeof r.strength !== "string") return reject("malformed");
  if (!(FAILURE_LABELS as readonly string[]).includes(r.label) || r.label === "unknown") {
    return reject("label_not_allowed");
  }
  if (r.strength !== "strong") return reject("weak");
  if (!Array.isArray(r.evidence) || r.evidence.length === 0 || !r.evidence.every((e) => typeof e === "string" && e.trim())) {
    return reject("no_evidence");
  }
  const label = r.label as FailureLabel;
  // Waiting for payday cannot fix a mandate or bank problem, so a balance label needs both to be clean.
  if (label === "balance" && (context.mandateStatus !== "active" || context.downtimeActive)) {
    return reject("contradicts_lookup");
  }
  // The lookups decide mandate and downtime labels; the agent may not overrule them (policy v1.3).
  if ((label === "mandate_cancelled" || label === "mandate_paused") && context.mandateStatus === "active") {
    return reject("contradicts_lookup");
  }
  if (label === "bank_downtime" && !context.downtimeActive) return reject("contradicts_lookup");
  // Bank text alone cannot close an account: a past failure code must confirm it (policy v1.3).
  if (label === "instrument_closed" && !(context.pastFailureCodes ?? []).some((c) => CLEAR_REASONS[c] === "instrument_closed")) {
    return reject("closed_not_in_history");
  }
  return { label, accepted: true, evidence: r.evidence as string[] };
}

// ---------------------------------------------------------------------------
// Engine 3: control and consent checks
// ---------------------------------------------------------------------------

export type ControlFailure =
  | "layer_off"
  | "kill_switch"
  | "product_not_configured"
  | "no_merchant_consent"
  | "no_customer_consent"
  | "holdout"
  | "mandate_not_active"
  | "amount_above_afa_limit"
  | "forced_normal_retries"
  | "paid_outside";

export interface ControlInput {
  layerEnabled: boolean;
  killSwitch: boolean;
  productConfigured: boolean;
  merchantConsent: boolean;
  customerConsent: boolean;
  inHoldout: boolean;
  mandateStatus: MandateStatus;
  rail: Rail;
  segment: Segment;
  amountPaise: number;
  forcedNormalRetries: boolean;
  /** The merchant marked this cycle as paid outside the layer. */
  paidOutside?: boolean;
}

export interface ControlResult {
  ok: boolean;
  failed?: ControlFailure;
}

/** The limit for debits without extra customer authentication. Null means the rail is not checked. */
export function afaLimitPaise(rail: Rail, segment: Segment): number | null {
  if (rail === "bank_mandate") return null;
  return segment === "insurance" ? POLICY.afaLimitPaise.upiInsurance : POLICY.afaLimitPaise.upiDefault;
}

/**
 * Runs the checks in a fixed order and stops at the first failure, which is logged as the fail-open reason.
 * The same function runs again before every attempt, because a mandate can be cancelled or
 * consent withdrawn after the schedule was set.
 */
export function runControlChecks(input: ControlInput): ControlResult {
  if (!input.layerEnabled) return { ok: false, failed: "layer_off" };
  if (input.killSwitch) return { ok: false, failed: "kill_switch" };
  if (!input.productConfigured) return { ok: false, failed: "product_not_configured" };
  if (!input.merchantConsent) return { ok: false, failed: "no_merchant_consent" };
  if (!input.customerConsent) return { ok: false, failed: "no_customer_consent" };
  if (input.inHoldout) return { ok: false, failed: "holdout" };
  if (input.mandateStatus !== "active") return { ok: false, failed: "mandate_not_active" };
  const limit = afaLimitPaise(input.rail, input.segment);
  if (limit !== null && input.amountPaise > limit) return { ok: false, failed: "amount_above_afa_limit" };
  if (input.forcedNormalRetries) return { ok: false, failed: "forced_normal_retries" };
  if (input.paidOutside) return { ok: false, failed: "paid_outside" };
  return { ok: true };
}
