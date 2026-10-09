// Shared steps for the flows that act on one existing case.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SimCase } from "@/lib/engine";
import type { Caller } from "../auth";
import { HttpError } from "../http-error";
import { loadCase, type CaseRecord } from "../store";

/** Whether the caller may reach this case: ops any, a merchant its own, a customer only its link's case. */
function mayReach(rec: CaseRecord, caller: Caller): boolean {
  if (caller.role === "ops") return true;
  if (caller.role === "customer") return rec.id === caller.caseId;
  return rec.obligations.merchant_id === caller.merchantId;
}

/**
 * Loads a case the caller may act on. Anyone else's case answers "not found", so its existence
 * is not revealed.
 */
export async function loadCaseFor(db: SupabaseClient, caseId: string, caller: Caller): Promise<CaseRecord> {
  const rec = await loadCase(db, caseId);
  if (!rec || !mayReach(rec, caller)) {
    throw new HttpError(404, "case_not_found", "There is no such case.");
  }
  return rec;
}

/** The case's plan. Cases the layer is not running (fail open, desk) have none. */
export function planOf(rec: CaseRecord, caller: Caller): SimCase {
  if (!rec.sim_snapshot) {
    throw new HttpError(409, "no_plan", "The layer is not running a plan for this case.", { caseId: rec.id, caller });
  }
  return rec.sim_snapshot;
}
