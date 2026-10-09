// process-debit-event (specs/03 "Event path", specs/06 section 1). Ops only.
// Stores the event (a repeated id stops here), runs evaluateFailedDebit, and saves the case,
// its plan, the merchant row, the cards or desk items, the triage row and one audit row.

import "server-only";
import {
  POLICY_VERSION,
  diffDays,
  evaluateFailedDebit,
  fallbackProposals,
  formatDate,
  openCase,
  addDays,
  type Decision,
} from "@/lib/engine";
import { FAILURE_WORDS } from "@/lib/demo/words";
import { failOpenNewCase } from "../fail-open";
import { HttpError } from "../http-error";
import type { FlowContext, FlowResult } from "../route";
import {
  caseIdFor,
  limitsFrom,
  merchantRowFromSim,
  merchantRowWithoutPlan,
  planActionRows,
  scheduleOptionRows,
} from "../rows";
import {
  appendAudit,
  auditRow,
  loadDebitInput,
  loadFixSettings,
  loadObligation,
  readToday,
  saveBundle,
  type CaseBundle,
} from "../store";
import { isoDate, oneOf, optionalText, text } from "../validate";

/** Why the Triage agent's answer is missing, until build step 8 connects it. */
const AGENT_NOT_CONNECTED =
  "Triage agent not connected yet (build step 8): with no answer the label is unknown and the case fails open.";

export async function processDebitEvent({ db, caller, body }: FlowContext): Promise<FlowResult> {
  const eventId = text(body, "eventId", 200);
  const eventType = oneOf(body, "eventType", ["debit.failed"] as const);
  const obligationId = text(body, "obligationId", 100);
  const dueDate = isoDate(body, "cycleDueDate");
  const reasonCode = text(body, "reasonCode", 100);
  const bankText = optionalText(body, "bankText", 500);

  const today = await readToday(db);
  const ob = await loadObligation(db, obligationId);
  if (!ob) throw new HttpError(404, "unknown_obligation", `There is no obligation ${obligationId}.`);
  const limits = limitsFrom(ob);

  // The case opens on the day the due-date failure is known, so the clock must sit between the due
  // date and that day. Anything else would put the plan's first days in the past.
  const sinceDue = diffDays(dueDate, today);
  if (sinceDue < 0) {
    throw new HttpError(422, "cycle_in_future", `The due date ${formatDate(dueDate)} is after the demo clock (${formatDate(today)}).`);
  }
  if (sinceDue > limits.resultDelayDays) {
    throw new HttpError(
      422,
      "event_too_late",
      `This failure was known on ${formatDate(addDays(dueDate, limits.resultDelayDays))} and the demo clock is past it. Reset the demo to replay it.`,
    );
  }

  const { data: inserted, error: insertError } = await db
    .from("debit_events")
    .upsert(
      {
        event_id: eventId,
        event_type: eventType,
        obligation_id: obligationId,
        cycle_due_date: dueDate,
        reason_code: reasonCode,
        bank_text: bankText,
        clock_date: today,
        raw_payload: body,
      },
      { onConflict: "event_id", ignoreDuplicates: true },
    )
    .select("event_id");
  if (insertError) throw insertError;

  const caseId = caseIdFor(obligationId, dueDate);
  const { data: existing, error: existingError } = await db.from("cases").select("id").eq("id", caseId).maybeSingle();
  if (existingError) throw existingError;

  // A repeated event id: one case and one audit entry per event, so nothing more happens.
  if (inserted.length === 0) return { body: { duplicate: true, eventId, caseId: existing ? caseId : null } };

  // A different event for a cycle that already has a case: one case per failed cycle.
  if (existing) {
    await db.from("debit_events").update({ processed: true }).eq("event_id", eventId).throwOnError();
    await appendAudit(
      db,
      auditRow(today, caller.actor, "event_ignored", {
        caseId,
        internal: "This cycle already has a case.",
        inputs: { eventId, reasonCode },
      }),
    );
    return { body: { eventId, caseId, ignored: "case_exists" } };
  }

  try {
    const loaded = await loadDebitInput(db, ob, dueDate, reasonCode, limits);
    let decision: Decision = evaluateFailedDebit(loaded.input);
    let agentNote: string | null = null;
    if (decision.route === "needs_agent") {
      agentNote = AGENT_NOT_CONNECTED;
      decision = evaluateFailedDebit({ ...loaded.input, agentTriage: null });
    }

    const e = decision.estimate;
    const prediction = e?.source === "model" ? loaded.modelPrediction : loaded.rulePrediction;
    const failureWords = FAILURE_WORDS[decision.triage.label] ?? FAILURE_WORDS.unknown;

    const bundle: CaseBundle = {
      case: {
        id: caseId,
        obligation_id: obligationId,
        cycle_due_date: dueDate,
        route: decision.route,
        state: null,
        fail_open_reason: decision.failOpenReason ?? null,
        prediction_id: e ? (prediction?.id ?? null) : null,
        policy_version: POLICY_VERSION,
        limits_snapshot: limits,
        standing_default: ob.products.standing_default,
        sim_snapshot: null,
      },
      triage_result: {
        event_id: eventId,
        label: decision.triage.label,
        decided_by: decision.triage.decidedBy,
        evidence: decision.triage.evidence,
        agent_strength: null,
      },
      event_id: eventId,
    };

    if ((decision.route === "schedules" || decision.route === "out_of_reach") && decision.build) {
      const sim = openCase({
        merchantType: limits.merchantType,
        build: decision.build,
        standingDefault: ob.products.standing_default,
        resultDelayDays: limits.resultDelayDays,
        lastAllowedDay: limits.lastAllowedDay,
      });
      bundle.case.state = sim.state;
      bundle.case.sim_snapshot = sim;
      bundle.merchant_case = merchantRowFromSim(ob, caseId, dueDate, limits, sim, failureWords, decision.publicReason);
      bundle.schedule_options = scheduleOptionRows(ob, caseId, limits, sim);
      bundle.plan_actions = planActionRows(caseId, dueDate, sim);
    } else if (decision.route === "exceptions_desk" && decision.deskTrigger) {
      // Build step 8 adds the desk agent and runs the fixes. Until then the rule-based fallback proposes them.
      const proposals = fallbackProposals(decision.deskTrigger, await loadFixSettings(db, ob.merchant_id));
      bundle.case.state = "needs_action";
      bundle.merchant_case = merchantRowWithoutPlan(ob, caseId, dueDate, limits, "needs_action", failureWords, decision.publicReason);
      bundle.desk_items = proposals.map((p) => ({
        merchant_id: ob.merchant_id,
        trigger: decision.deskTrigger,
        fix_type: p.fix,
        reason: p.reason,
        mode: p.mode,
        status: "proposed",
      }));
    } else {
      bundle.case.state = "normal_retries";
      bundle.merchant_case = merchantRowWithoutPlan(ob, caseId, dueDate, limits, "normal_retries", failureWords, decision.publicReason);
    }

    bundle.audit = [
      auditRow(today, caller.actor, `case_opened:${decision.route}`, {
        caseId,
        internal: agentNote ? `${decision.internalReason} ${agentNote}` : decision.internalReason,
        public: decision.publicReason,
        modelVersion: e ? (e.modelVersion ?? prediction?.model_version ?? null) : null,
        inputs: {
          eventId,
          reasonCode,
          bankText,
          triage: decision.triage,
          failOpenReason: decision.failOpenReason ?? null,
          deskTrigger: decision.deskTrigger ?? null,
          gate: decision.gate ?? null,
          estimate: e
            ? { source: e.source, h: e.h, u: e.u, confidence: e.confidence, floor: e.floor, deductions: e.deductions, salaryRecognized: e.salaryRecognized }
            : null,
        },
      }),
    ];

    await saveBundle(db, bundle);
    return { body: { eventId, caseId, route: decision.route, state: bundle.case.state } };
  } catch (error) {
    return failOpenNewCase(db, ob, eventId, dueDate, caller.actor, today, error);
  }
}
