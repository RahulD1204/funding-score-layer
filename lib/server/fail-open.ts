// When something unexpected breaks while handling a case, the case is handed back to Razorpay's
// original retries and an audit row says why (CLAUDE.md: any error fails open). Each step falls
// back to a simpler one, down to an audit row on its own.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { POLICY_VERSION, stopLayer, type ISODate } from "@/lib/engine";
import { HttpError } from "./http-error";
import {
  ORIGINAL_RETRIES_REASON,
  bundleFromSim,
  caseIdFor,
  limitsFrom,
  merchantRowWithoutPlan,
} from "./rows";
import { appendAudit, auditRow, errorText, saveBundle, type CaseRecord, type ObligationRow } from "./store";
import type { FlowResult } from "./route";

export const SERVER_ERROR = "server_error";

/** An open case hit an error: stop the plan through the engine and store that. */
export async function failOpenExistingCase(
  db: SupabaseClient,
  rec: CaseRecord,
  actor: string,
  today: ISODate,
  error: unknown,
): Promise<void> {
  const message = errorText(error);
  const audit = [
    auditRow(today, actor, "fail_open", {
      caseId: rec.id,
      internal: `Fail open: ${SERVER_ERROR}. ${message}`,
      public: ORIGINAL_RETRIES_REASON,
      inputs: { error: message },
    }),
  ];
  const limits = rec.limits_snapshot ?? limitsFrom(rec.obligations);

  // 1. The engine steps back: pending actions cancelled, the original retry days listed.
  try {
    const stopped = stopLayer(rec.sim_snapshot!, SERVER_ERROR, limits.baselineRetryDays);
    await saveBundle(db, bundleFromSim(rec, stopped, audit, null));
    return;
  } catch {
    // The snapshot itself may be what broke. Store the state without it.
  }
  // 2. Mark the case and the merchant row, keeping the snapshot as it was for ops to inspect.
  try {
    await saveBundle(db, {
      case: { id: rec.id, route: rec.route, state: "normal_retries", fail_open_reason: SERVER_ERROR, sim_snapshot: rec.sim_snapshot },
      expected_updated_at: null,
      merchant_case: merchantRowWithoutPlan(
        rec.obligations, rec.id, rec.cycle_due_date, limits, "normal_retries", null, ORIGINAL_RETRIES_REASON,
      ),
      audit,
    });
    return;
  } catch {
    // Fall through to the audit row alone.
  }
  // 3. At least the audit row.
  try {
    await appendAudit(db, audit[0]);
  } catch {
    // The database is unreachable.
  }
}

/** A new failed debit hit an error before its case was saved: open it as a fail-open case. */
export async function failOpenNewCase(
  db: SupabaseClient,
  ob: ObligationRow,
  eventId: string,
  dueDate: ISODate,
  actor: string,
  today: ISODate,
  error: unknown,
): Promise<FlowResult> {
  if (error instanceof HttpError) throw error;
  const message = errorText(error);
  const caseId = caseIdFor(ob.id, dueDate);
  const limits = limitsFrom(ob);
  const audit = auditRow(today, actor, "fail_open", {
    caseId,
    internal: `Fail open: ${SERVER_ERROR}. ${message}`,
    public: ORIGINAL_RETRIES_REASON,
    inputs: { eventId, error: message },
  });
  let saved = false;
  try {
    await saveBundle(db, {
      case: {
        id: caseId,
        obligation_id: ob.id,
        cycle_due_date: dueDate,
        route: "fail_open",
        state: "normal_retries",
        fail_open_reason: SERVER_ERROR,
        policy_version: POLICY_VERSION,
        limits_snapshot: limits,
        standing_default: ob.products.standing_default,
      },
      merchant_case: merchantRowWithoutPlan(ob, caseId, dueDate, limits, "normal_retries", null, ORIGINAL_RETRIES_REASON),
      event_id: eventId,
      audit: [audit],
    });
    saved = true;
  } catch {
    try {
      await appendAudit(db, { ...audit, case_id: null });
    } catch {
      // The database is unreachable.
    }
  }
  return {
    status: 500,
    body: { error: SERVER_ERROR, failedOpen: true, caseId: saved ? caseId : null, message: "Something went wrong. Razorpay's original retries apply." },
  };
}
