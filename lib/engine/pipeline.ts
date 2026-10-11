// The decision pipeline for one failed debit: triage, checks, gate, estimate, schedules.
// Any failed step ends in "fail open", which means Razorpay's original retries run and the reason is logged.
// The process-debit-event server function calls this and stores the result.

import { POLICY_VERSION, POLICY, type Rail, type Segment } from "./policy";
import type { ISODate } from "./dates";
import {
  acceptAgentTriage,
  runControlChecks,
  triageByRules,
  type ControlFailure,
  type ControlInput,
  type FailureLabel,
  type MandateStatus,
  type TriageResult,
} from "./triage";
import {
  describeAnchor,
  estimateFunding,
  evaluateGate,
  summarizeEvidence,
  type Credit,
  type Estimate,
  type GateResult,
  type ModelScore,
  type Observation,
} from "./estimate";
import {
  buildCards,
  buildSchedules,
  type BaselineRow,
  type CostSettings,
  type ScheduleBuild,
  type ScheduleCard,
} from "./schedule";
import { isDeskTrigger, type DeskTrigger } from "./desk";
import { fillTemplate, TEMPLATES } from "./messages";

export interface FailedDebitInput {
  dueDate: ISODate;
  /** Only data dated before this day is used. Defaults to the due date. */
  asOf?: ISODate;
  segment: Segment;
  rail: Rail;
  amountPaise: number;

  errorReason: string;
  mandateStatus: MandateStatus;
  downtimeActive: boolean;
  /** The Triage agent's raw answer, once the caller has asked it. Leave out on the first pass. */
  agentTriage?: unknown;
  /** Reason codes of past failed debits on this obligation, which confirm a closed-account answer. */
  pastFailureCodes?: string[];

  controls: Pick<
    ControlInput,
    | "layerEnabled"
    | "killSwitch"
    | "productConfigured"
    | "merchantConsent"
    | "customerConsent"
    | "inHoldout"
    | "forcedNormalRetries"
  >;

  hasFailureEvidence: boolean;
  identityLinked: boolean;
  observations: Observation[];
  credits?: Credit[];
  modelScore?: ModelScore;

  limits: { lastAllowedDay: number; maxRepresentations: number };
  cost?: Partial<CostSettings>;
}

export type DecisionRoute = "schedules" | "out_of_reach" | "exceptions_desk" | "fail_open" | "needs_agent";

export type FailOpenReason =
  | "triage_unknown"
  | ControlFailure
  | "tier_c"
  | "no_observations"
  | "low_confidence";

export interface Decision {
  route: DecisionRoute;
  policyVersion: string;
  triage: TriageResult;
  failOpenReason?: FailOpenReason;
  deskTrigger?: DeskTrigger;
  gate?: GateResult;
  estimate?: Estimate;
  build?: ScheduleBuild;
  cards?: ScheduleCard[];
  baseline?: BaselineRow;
  /** Safe to show a merchant. Never names a score, a tier or income. */
  publicReason: string;
  /** For the audit log and the ops console only. */
  internalReason: string;
}

function failOpen(triage: TriageResult, reason: FailOpenReason, extra: Partial<Decision> = {}): Decision {
  return {
    route: "fail_open",
    policyVersion: POLICY_VERSION,
    triage,
    failOpenReason: reason,
    publicReason: "Razorpay's original retries apply.",
    internalReason: `Fail open: ${reason}`,
    ...extra,
  };
}

export function evaluateFailedDebit(input: FailedDebitInput): Decision {
  // 1. Triage: what kind of failure is this?
  let triage = triageByRules({
    errorReason: input.errorReason,
    mandateStatus: input.mandateStatus,
    downtimeActive: input.downtimeActive,
  });

  if (triage.needsAgent) {
    if (input.agentTriage === undefined) {
      return {
        route: "needs_agent",
        policyVersion: POLICY_VERSION,
        triage,
        publicReason: "Checking the failure reason.",
        internalReason: "Catch-all reason with no lookup hit: ask the Triage agent.",
      };
    }
    const agent = acceptAgentTriage(input.agentTriage, {
      mandateStatus: input.mandateStatus,
      downtimeActive: input.downtimeActive,
      pastFailureCodes: input.pastFailureCodes,
    });
    triage = {
      label: agent.label,
      decidedBy: "agent",
      evidence: agent.accepted ? agent.evidence : [...triage.evidence, `agent answer rejected: ${agent.rejection}`],
      needsAgent: false,
    };
    if (!agent.accepted) return failOpen(triage, "triage_unknown");
  }

  const label: FailureLabel = triage.label;
  if (label === "unknown") return failOpen(triage, "triage_unknown");

  // 2. A failure that waiting for payday cannot fix goes to the exceptions desk.
  if (label !== "balance") {
    if (!isDeskTrigger(label)) return failOpen(triage, "triage_unknown");
    return {
      route: "exceptions_desk",
      policyVersion: POLICY_VERSION,
      triage,
      deskTrigger: label,
      publicReason: "This failure needs a fix before another attempt.",
      internalReason: `Non-balance failure: ${label}`,
    };
  }

  // 3. Control and consent checks.
  const controls = runControlChecks({
    ...input.controls,
    mandateStatus: input.mandateStatus,
    rail: input.rail,
    segment: input.segment,
    amountPaise: input.amountPaise,
  });
  if (!controls.ok) return failOpen(triage, controls.failed!);

  // 4. Gate: is there enough evidence to say anything about timing?
  const asOf = input.asOf ?? input.dueDate;
  const evidence = summarizeEvidence(input.observations, asOf, input.amountPaise);
  const gate = evaluateGate({
    timingObservations: evidence.timingObservations,
    monthsCovered: evidence.monthsCovered,
    hasFailureEvidence: input.hasFailureEvidence,
    identityLinked: input.identityLinked,
  });
  if (!gate.passed) {
    return failOpen(triage, "tier_c", { gate, internalReason: `Fail open: tier C (${gate.failed.join(", ")})` });
  }

  // 5. Estimate the funded day and how sure we are.
  const estimate = estimateFunding({
    dueDate: input.dueDate,
    asOf,
    segment: input.segment,
    debitAmountPaise: input.amountPaise,
    observations: input.observations,
    credits: input.credits,
    modelScore: input.modelScore,
  });
  if (!estimate.ok) {
    return failOpen(triage, estimate.failReason ?? "low_confidence", {
      gate,
      estimate,
      internalReason: `Fail open: ${estimate.failReason} (confidence ${estimate.confidence}%, floor ${estimate.floor}%)`,
    });
  }

  // 6. Build schedules inside the merchant's limits.
  const build = buildSchedules({
    h: estimate.h,
    u: estimate.u,
    likelihoodByDay: estimate.likelihoodByDay,
    segment: input.segment,
    lastAllowedDay: input.limits.lastAllowedDay,
    maxRepresentations: input.limits.maxRepresentations,
    resultDelayDays: POLICY.resultDelayDays[input.rail],
    salaryRecognized: estimate.salaryRecognized,
  });

  const cost: CostSettings = {
    penalChargePerDayPaise: input.cost?.penalChargePerDayPaise ?? null,
    bounceChargePaise: input.cost?.bounceChargePaise ?? null,
    baselineRetryDays: input.cost?.baselineRetryDays ?? POLICY.baselineRetryDays[input.segment],
  };
  const { cards, baseline } = buildCards(build.options, cost);

  const internalReason = estimate.anchor
    ? fillTemplate("ops_reason", {
        anchor: describeAnchor(estimate.anchor),
        observations: String(estimate.observationsUsed),
        confidence: String(estimate.confidence),
      })
    : `Model score ${estimate.modelVersion}, confidence ${estimate.confidence}%.`;

  return {
    route: build.route,
    policyVersion: POLICY_VERSION,
    triage,
    gate,
    estimate,
    build,
    cards,
    baseline,
    publicReason: TEMPLATES.merchant_reason,
    internalReason,
  };
}
