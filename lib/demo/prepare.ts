// Runs each demo case through the real engine and shapes the result for the preview page.
// The merchant-facing part and the internal part are kept in separate objects, the same split
// the database enforces in the full build (merchant tables against internal tables).

import {
  POLICY,
  advanceTo,
  describeAnchor,
  evaluateFailedDebit,
  fallbackProposals,
  openCase,
  type BaselineRow,
  type DeskProposal,
  type DeskTrigger,
  type MerchantType,
  type ScheduleCard,
  type ScheduleLabel,
  type SimCase,
} from "@/lib/engine";
import { DEMO_CASES, DEMO_START_DAY, INSURER, type DemoCaseSeed } from "./cases";

export type PreviewRoute = "schedules" | "out_of_reach" | "exceptions_desk" | "original_retries";

/** What a signed-in merchant could read. No score, percentage, confidence, tier or income. */
export interface MerchantPart {
  customer: string;
  merchantName: string;
  merchantType: MerchantType;
  product: string;
  kind: "EMI" | "premium";
  amountPaise: number;
  dueDate: string;
  failureReason: string;
  publicReason: string;
  route: PreviewRoute;
  cards: ScheduleCard[];
  baseline: BaselineRow | null;
  standingDefault: ScheduleLabel;
  lastAllowedDay: number;
  maxRepresentations: number;
  resultDelayDays: number;
  baselineRetryDays: number[];
  penalChargePerDayPaise: number | null;
  graceEndDay: number | null;
  desk: { trigger: DeskTrigger; proposals: DeskProposal[] } | null;
}

/** What only Razorpay ops could read. */
export interface OpsPart {
  bankText: string;
  errorReason: string;
  triage: { label: string; decidedBy: string; evidence: string[] };
  decision: string;
  failOpenReason: string | null;
  gate: { tier: string; failed: string[] } | null;
  estimate: {
    source: string;
    pattern: string | null;
    observationsUsed: number;
    confidence: number;
    floor: number;
    deductions: { affordability: number; drift: number };
    fundedDate: string;
    h: number;
    u: number;
  } | null;
  internalReason: string;
  policyVersion: string;
  truthFundedOnDay: number | null;
  note: string | null;
}

export interface PreparedCase {
  id: string;
  teaches: string;
  merchant: MerchantPart;
  ops: OpsPart;
  /** The case state machine at the preview's start day. Null when the layer is not acting. */
  sim: SimCase | null;
  world: { fundedOnDay: number | null };
}

const FAILURE_WORDS: Record<string, string> = {
  balance: "Insufficient funds",
  mandate_cancelled: "Mandate cancelled",
  mandate_paused: "Mandate paused",
  instrument_closed: "Account closed",
  bank_downtime: "Bank downtime",
  unknown: "Reason unclear",
};

function prepare(seed: DemoCaseSeed): PreparedCase {
  const decision = evaluateFailedDebit(seed.input);
  const world = { fundedOnDay: seed.truth.fundedOnDay };
  const resultDelayDays = POLICY.resultDelayDays[seed.input.rail];
  const baselineRetryDays = seed.input.cost?.baselineRetryDays ?? POLICY.baselineRetryDays[seed.input.segment];

  let route: PreviewRoute = "original_retries";
  let sim: SimCase | null = null;
  let desk: MerchantPart["desk"] = null;
  let note: string | null = null;

  if ((decision.route === "schedules" || decision.route === "out_of_reach") && decision.build) {
    route = decision.route;
    const opened = openCase({
      merchantType: seed.merchant.type,
      build: decision.build,
      standingDefault: seed.merchant.standingDefault,
      resultDelayDays,
      lastAllowedDay: seed.input.limits.lastAllowedDay,
    });
    sim = advanceTo(opened, DEMO_START_DAY, world);
  } else if (decision.route === "exceptions_desk" && decision.deskTrigger) {
    route = "exceptions_desk";
    // With no agent connected, the desk proposes every fix the rules allow for this trigger.
    desk = { trigger: decision.deskTrigger, proposals: fallbackProposals(decision.deskTrigger) };
    note = "The desk agent is not connected in this preview, so the fixes come from the rule-based fallback.";
  } else if (decision.route === "needs_agent") {
    note =
      "The Triage agent is not connected in this preview. With no answer the label stays unknown and the case fails open, which is what the full build does when the agent is unavailable.";
  }

  const e = decision.estimate;
  return {
    id: seed.id,
    teaches: seed.teaches,
    merchant: {
      customer: seed.customer,
      merchantName: seed.merchant.name,
      merchantType: seed.merchant.type,
      product: seed.merchant.product,
      kind: seed.merchant.kind,
      amountPaise: seed.input.amountPaise,
      dueDate: seed.input.dueDate,
      failureReason: FAILURE_WORDS[decision.triage.label] ?? "Reason unclear",
      publicReason: decision.route === "needs_agent" ? "Razorpay's original retries apply." : decision.publicReason,
      route,
      cards: route === "schedules" ? (decision.cards ?? []) : [],
      baseline: decision.baseline ?? null,
      standingDefault: seed.merchant.standingDefault,
      lastAllowedDay: seed.input.limits.lastAllowedDay,
      maxRepresentations: seed.input.limits.maxRepresentations,
      resultDelayDays,
      baselineRetryDays,
      penalChargePerDayPaise: seed.input.cost?.penalChargePerDayPaise ?? null,
      graceEndDay: seed.merchant === INSURER ? INSURER.graceEndDay : null,
      desk,
    },
    ops: {
      bankText: seed.bankText,
      errorReason: seed.input.errorReason,
      triage: {
        label: decision.triage.label,
        decidedBy: decision.triage.decidedBy,
        evidence: decision.triage.evidence,
      },
      decision: decision.route,
      failOpenReason: decision.failOpenReason ?? (decision.route === "needs_agent" ? "triage_unknown" : null),
      gate: decision.gate ? { tier: decision.gate.tier, failed: decision.gate.failed } : null,
      estimate: e
        ? {
            source: e.source,
            pattern: e.anchor ? describeAnchor(e.anchor) : null,
            observationsUsed: e.observationsUsed,
            confidence: e.confidence,
            floor: e.floor,
            deductions: e.deductions,
            fundedDate: e.fundedDate,
            h: e.h,
            u: e.u,
          }
        : null,
      internalReason: decision.internalReason,
      policyVersion: decision.policyVersion,
      truthFundedOnDay: seed.truth.fundedOnDay,
      note,
    },
    sim,
    world,
  };
}

export function prepareDemoCases(): PreparedCase[] {
  return DEMO_CASES.map(prepare);
}
