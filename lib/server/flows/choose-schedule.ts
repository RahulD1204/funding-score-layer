// choose-schedule (specs/03, specs/06 section 7). Lenders only, own cases only.
// Calls pickSchedule. A refused pick changes nothing and is answered with the engine's reason.

import "server-only";
import { SCHEDULE_ORDER, pickSchedule, type PickError } from "@/lib/engine";
import { failOpenExistingCase } from "../fail-open";
import { HttpError } from "../http-error";
import type { FlowContext, FlowResult } from "../route";
import { bundleFromSim } from "../rows";
import { auditRow, readToday, saveBundle } from "../store";
import { oneOf, text } from "../validate";
import { loadCaseFor, planOf } from "./common";

const PICK_REFUSED: Record<PickError, string> = {
  not_a_lender: "Only a lender picks a schedule.",
  no_such_schedule: "That schedule is not offered for this case.",
  locked: "Too late to pick: the first date is a day away or an action has locked.",
  case_closed: "This case is no longer waiting for a schedule.",
};

export async function chooseSchedule({ db, caller, body }: FlowContext): Promise<FlowResult> {
  const caseId = text(body, "caseId", 200);
  const label = oneOf(body, "label", SCHEDULE_ORDER);
  const rec = await loadCaseFor(db, caseId, caller);
  const sim = planOf(rec, caller);
  const today = await readToday(db);

  const picked = pickSchedule(sim, label);
  if (!picked.ok) throw new HttpError(409, picked.error, PICK_REFUSED[picked.error], { caseId, caller });

  try {
    const audit = auditRow(today, caller.actor, "schedule_picked", {
      caseId,
      internal: `The lender picked ${label}${picked.case.chosen !== label ? ` (merged into ${picked.case.chosen})` : ""}.`,
      inputs: { label, previous: sim.chosen },
    });
    await saveBundle(db, bundleFromSim(rec, picked.case, [audit], rec.updated_at));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    await failOpenExistingCase(db, rec, caller.actor, today, error);
    return { status: 500, body: { error: "server_error", failedOpen: true, caseId } };
  }
  return { body: { caseId, state: picked.case.state, chosen: picked.case.chosen } };
}
