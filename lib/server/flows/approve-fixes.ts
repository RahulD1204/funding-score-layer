// approve-fixes (specs/03). Lender or insurer, own desk items only. The desk's "Approve selected" and
// "Approve all" buttons. Runs each approved fix and audits it; all or nothing (run_desk_items in
// migration 20261010000005). Only items still waiting (proposed) can be approved.
//
// Running a fix in the prototype marks it done and writes an audit row. Nothing is sent to a
// customer: real delivery is a later phase, and message text comes with build step 9.

import "server-only";
import { FIX_TYPES, type FixMode, type FixType } from "@/lib/engine";
import { HttpError } from "../http-error";
import type { FlowContext, FlowResult } from "../route";
import { readToday } from "../store";
import { fixRunAudit } from "./run-exceptions-desk";

/** At most this many fixes in one approval. */
const MAX_ITEMS = 100;

function itemIds(body: Record<string, unknown>): number[] | "all" {
  if (body.all === true) return "all";
  const ids = body.itemIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ITEMS || !ids.every((id) => Number.isInteger(id) && id > 0)) {
    throw new HttpError(400, "bad_input", `Send itemIds (1 to ${MAX_ITEMS} desk item ids) or all: true.`);
  }
  return [...new Set(ids as number[])];
}

export async function approveFixes({ db, caller, body }: FlowContext): Promise<FlowResult> {
  const merchantId = caller.merchantId;
  if (!merchantId) throw new HttpError(403, "role_not_allowed", "Only the merchant can approve its fixes.", { caller });
  const wanted = itemIds(body);

  let query = db.from("desk_items").select("id, case_id, fix_type, mode").eq("merchant_id", merchantId).eq("status", "proposed");
  if (wanted !== "all") query = query.in("id", wanted);
  const { data, error } = await query.order("id");
  if (error) throw error;
  const items = data as { id: number; case_id: string; fix_type: FixType; mode: FixMode }[];

  if (wanted !== "all" && items.length !== wanted.length) {
    throw new HttpError(409, "desk_changed", "Some of these fixes are no longer waiting. Reload the desk and try again.", { caller });
  }
  if (items.length === 0) throw new HttpError(409, "nothing_to_approve", "No fixes are waiting for approval.", { caller });
  if (!items.every((i) => (FIX_TYPES as readonly string[]).includes(i.fix_type))) throw new Error("A desk item has an unknown fix type.");

  const today = await readToday(db);
  const audit = items.map((i) => fixRunAudit(today, caller.actor, i.case_id, { fix: i.fix_type, mode: i.mode }, "Approved by the merchant and run"));
  const { error: runError } = await db.rpc("run_desk_items", {
    p_merchant: merchantId,
    p_ids: items.map((i) => i.id),
    p_user: caller.userId,
    p_audit: audit,
  });
  if (runError) {
    if (runError.code === "40001") {
      throw new HttpError(409, "desk_changed", "Some of these fixes changed while you were looking. Reload the desk and try again.", { caller });
    }
    throw runError;
  }
  return { body: { ran: items.map((i) => ({ id: i.id, caseId: i.case_id, fix: i.fix_type })) } };
}
