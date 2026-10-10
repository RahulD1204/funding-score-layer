// advance-day (specs/03 "Clock path"). Ops only.
// Moves sim_clock.today forward one day, then brings every open case to the new day with the
// engine's advanceTo. The control checks re-run from live data before every action, and ground
// truth comes from sim_truth. A case that fell behind (an earlier error) catches up.
// Once a case is saved, the customer messages its change calls for are composed (compose-message.ts):
// a retry notice for each debit that locked, the link text for a link that was sent.

import "server-only";
import { addDays, advanceTo, diffDays, messagesDue, type SimCase } from "@/lib/engine";
import { failOpenExistingCase } from "../fail-open";
import { HttpError } from "../http-error";
import type { FlowContext, FlowResult } from "../route";
import { composeCaseMessages } from "./compose-message";
import { bundleFromSim, describeLog } from "../rows";
import {
  CASE_SELECT,
  appendAudit,
  auditRow,
  controlFailureFor,
  loadConsents,
  loadFundedDays,
  readToday,
  saveBundle,
  type CaseRecord,
} from "../store";

const ACTOR = "system:advance-day";
const RUNNING = new Set(["awaiting_choice", "scheduled", "result_pending", "link_sent"]);

/** A running plan moves with the clock. A stopped one still receives results for debits already presented. */
function needsClock(rec: CaseRecord): boolean {
  if (rec.state !== null && RUNNING.has(rec.state)) return true;
  const actions = (rec.sim_snapshot as SimCase | null)?.actions;
  return Array.isArray(actions) && actions.some((a) => a.status === "in_flight");
}

export async function advanceDay({ db, caller }: FlowContext): Promise<FlowResult> {
  const today = await readToday(db);
  const next = addDays(today, 1);

  // Only one Next day at a time: the update matches only if nobody moved the clock since it was read.
  const { data: moved, error: moveError } = await db
    .from("sim_clock")
    .update({ today: next })
    .eq("today", today)
    .select("today");
  if (moveError) throw moveError;
  if (!moved || moved.length === 0) throw new HttpError(409, "clock_moved", "The clock moved while you clicked. Reload and try again.", { caller });

  const { data, error } = await db.from("cases").select(CASE_SELECT).not("sim_snapshot", "is", null).neq("state", "paid").order("id");
  if (error) throw error;
  const open = (data as CaseRecord[]).filter(needsClock);

  const [consents, fundedDays] = await Promise.all([
    loadConsents(db, open.map((r) => r.obligations.merchant_id), open.map((r) => r.obligations.customer_id)),
    loadFundedDays(db, open.map((r) => ({ obligationId: r.obligation_id, dueDate: r.cycle_due_date }))),
  ]);

  const results: { caseId: string; state: string; messages?: number; failedOpen?: boolean; skipped?: string }[] = [];
  for (const rec of open) {
    // Set once the day's change is saved, so a later error fails open from the saved state.
    let saved: SimCase | null = null;
    try {
      const sim = rec.sim_snapshot!;
      const day = diffDays(rec.cycle_due_date, next);
      if (sim.today >= day) continue;
      const after = advanceTo(sim, day, {
        fundedOnDay: fundedDays.get(`${rec.obligation_id}|${rec.cycle_due_date}`) ?? null,
        controlFailure: controlFailureFor(rec.obligations, consents),
      });
      const happened = after.log.slice(sim.log.length);
      const audit = happened.length
        ? [auditRow(next, ACTOR, "case_advanced", { caseId: rec.id, internal: describeLog(happened, rec.cycle_due_date), inputs: { log: happened } })]
        : [];
      await saveBundle(db, bundleFromSim(rec, after, audit, rec.updated_at));
      saved = after;
      const composed = await composeCaseMessages(
        db,
        { caseId: rec.id, ob: rec.obligations, dueDate: rec.cycle_due_date },
        messagesDue(sim, after),
        { userId: caller.userId, today: next },
      );
      results.push({ caseId: rec.id, state: after.state, ...(composed.length > 0 ? { messages: composed.length } : {}) });
    } catch (caught) {
      if (caught instanceof HttpError && caught.code === "case_changed") {
        // Someone acted on the case meanwhile. It catches up on the next day.
        results.push({ caseId: rec.id, state: rec.state ?? "", skipped: "case_changed" });
        continue;
      }
      await failOpenExistingCase(db, saved ? { ...rec, sim_snapshot: saved } : rec, ACTOR, next, caught);
      results.push({ caseId: rec.id, state: "normal_retries", failedOpen: true });
    }
  }

  await appendAudit(
    db,
    auditRow(next, caller.actor, "clock_advanced", {
      internal: `Clock moved from ${today} to ${next}. ${results.length} case(s) moved.`,
      inputs: { from: today, to: next, cases: results },
    }),
  );
  return { body: { today: next, cases: results } };
}
