// run-exceptions-desk (specs/03, specs/07 section 2). The desk agent proposes fixes for a failure that
// waiting cannot solve; validateDeskOutput keeps only allowed, explained, unrepeated fixes; with no
// usable answer, fallbackProposals proposes every allowed fix by rule. The merchant's per-fix setting
// gives the mode: automatic fixes run at once, the rest wait for approval on the desk.
//
// Running a fix in the prototype marks its desk item done and writes an audit row. Nothing is sent to
// a customer: real delivery is a later phase, and specs/06 section 9 has no template for these links.
//
// deskProposals is called by process-debit-event for a new desk case, and by the ops-only route
// for an existing desk case that has no desk items (for example after an outage).

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FIX_CATALOGUE, fallbackProposals, isDeskTrigger, validateDeskOutput, type DeskProposal } from "@/lib/engine";
import { agentRunSummary, askDeskAgent } from "../agents";
import type { DeskCaseFacts } from "../agents/tools";
import { HttpError } from "../http-error";
import type { FlowContext, FlowResult } from "../route";
import { limitsFrom } from "../rows";
import { auditRow, errorText, loadCaseTriage, loadFixSettings, readToday, saveBundle, type AuditRow } from "../store";
import { text } from "../validate";
import { loadCaseFor } from "./common";

/** How automatic fixes are named in audit_log: the system ran them, under the merchant's setting. */
export const DESK_ACTOR = "system:exceptions-desk";

export function fixRunAudit(today: string, actor: string, caseId: string, p: Pick<DeskProposal, "fix" | "mode">, how: string): AuditRow {
  return auditRow(today, actor, `fix_run:${p.fix}`, {
    caseId,
    internal: `${how}: ${FIX_CATALOGUE[p.fix].description}. Prototype: recorded only, nothing is sent to the customer.`,
    inputs: { fix: p.fix, mode: p.mode, contactsCustomer: FIX_CATALOGUE[p.fix].contactsCustomer },
  });
}

export interface DeskOutcome {
  deskItems: Record<string, unknown>[];
  audit: AuditRow[];
  source: "agent" | "rules";
}

export async function deskProposals(db: SupabaseClient, userId: string, actor: string, facts: DeskCaseFacts): Promise<DeskOutcome> {
  const settings = await loadFixSettings(db, facts.ob.merchant_id);
  let summary: Record<string, unknown>;
  let proposals: DeskProposal[] = [];
  try {
    const run = await askDeskAgent(db, userId, facts, settings);
    const validation = run.answer ? validateDeskOutput(facts.trigger, run.answer.fixes, settings) : null;
    proposals = validation?.accepted ?? [];
    summary = {
      agentRun: agentRunSummary(run),
      accepted: validation?.accepted.map((p) => p.fix) ?? [],
      rejected: validation?.rejected ?? [],
      replacedReasons: validation?.replacedReasons ?? [],
    };
  } catch (error) {
    summary = { agentError: errorText(error) };
  }
  const source = proposals.length > 0 ? "agent" : "rules";
  if (source === "rules") proposals = fallbackProposals(facts.trigger, settings);

  const deskItems = proposals.map((p) => ({
    merchant_id: facts.ob.merchant_id,
    trigger: facts.trigger,
    fix_type: p.fix,
    reason: p.reason,
    mode: p.mode,
    status: p.mode === "automatic" ? "done" : "proposed",
  }));
  const waiting = proposals.filter((p) => p.mode === "needs_approval").map((p) => p.fix);
  const audit = [
    auditRow(facts.today, actor, "desk_proposed", {
      caseId: facts.caseId,
      internal:
        `Exceptions desk (${facts.trigger}), fixes proposed by ${source === "agent" ? "the desk agent" : "rule (no usable agent answer)"}: ` +
        `${proposals.map((p) => `${p.fix} (${p.mode})`).join(", ")}.` +
        (waiting.length ? ` Waiting for the merchant's approval: ${waiting.join(", ")}.` : ""),
      inputs: { trigger: facts.trigger, source, ...summary },
    }),
    ...proposals
      .filter((p) => p.mode === "automatic")
      .map((p) => fixRunAudit(facts.today, DESK_ACTOR, facts.caseId, p, "Run at once (set to automatic)")),
  ];
  return { deskItems, audit, source };
}

/** POST /api/run-exceptions-desk. Ops only: runs the desk for a desk case that has no desk items yet. */
export async function runExceptionsDesk({ db, caller, body }: FlowContext): Promise<FlowResult> {
  const rec = await loadCaseFor(db, text(body, "caseId", 200), caller);
  if (rec.route !== "exceptions_desk") {
    throw new HttpError(409, "not_a_desk_case", "This case did not go to the exceptions desk.", { caseId: rec.id, caller });
  }
  const { count, error } = await db.from("desk_items").select("id", { count: "exact", head: true }).eq("case_id", rec.id);
  if (error) throw error;
  if ((count ?? 0) > 0) {
    throw new HttpError(409, "desk_already_run", "This case already has fixes on the desk.", { caseId: rec.id, caller });
  }
  const triage = await loadCaseTriage(db, rec.obligation_id, rec.cycle_due_date);
  if (!triage || !isDeskTrigger(triage.label)) {
    throw new HttpError(409, "no_desk_trigger", "This case has no failure label the desk can act on.", { caseId: rec.id, caller });
  }

  const today = await readToday(db);
  const outcome = await deskProposals(db, caller.userId!, caller.actor, {
    caseId: rec.id,
    ob: rec.obligations,
    dueDate: rec.cycle_due_date,
    limits: rec.limits_snapshot ?? limitsFrom(rec.obligations),
    trigger: triage.label,
    state: rec.state ?? "needs_action",
    attemptsUsed: 0,
    today,
  });
  await saveBundle(db, {
    case: { id: rec.id, route: rec.route, state: rec.state, fail_open_reason: rec.fail_open_reason, sim_snapshot: rec.sim_snapshot },
    expected_updated_at: rec.updated_at,
    desk_items: outcome.deskItems,
    audit: outcome.audit,
  });
  return {
    body: { caseId: rec.id, source: outcome.source, fixes: outcome.deskItems.map((d) => ({ fix: d.fix_type, mode: d.mode, status: d.status })) },
  };
}
