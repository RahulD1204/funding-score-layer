// update-controls (specs/03). The merchant's settings, and the actions that end or pause a plan.
//
//   set_limits, set_standing_default, set_fix_mode, set_kill_switch   lender or insurer, own merchant
//   mark_paid, force_original_retries                                 lender or insurer, own cases
//   withdraw_consent, pay_by_link                                     the customer only, through the signed
//                                                                     case link of the phone mock (build step 7;
//                                                                     ops stood in until then)
//
// Settings changes apply to cases opened afterwards; an open case keeps the limits it opened with.
// The kill switch, consent withdrawal and forced retries call stopLayer; the payments call
// recordOutsidePayment. The engine decides; this file stores.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FIX_TYPES,
  SCHEDULE_ORDER,
  recordOutsidePayment,
  stopLayer,
  type PaymentError,
  type SimCase,
} from "@/lib/engine";
import type { Caller } from "../auth";
import { failOpenExistingCase } from "../fail-open";
import { HttpError } from "../http-error";
import type { FlowContext, FlowResult } from "../route";
import { bundleFromSim, limitsFrom } from "../rows";
import { CASE_SELECT, appendAudit, auditRow, readToday, saveBundle, type CaseRecord, type AuditRow } from "../store";
import { oneOf, text, wholeNumber, yesNo, type Body } from "../validate";
import { loadCaseFor, planOf } from "./common";

const ACTIONS = [
  "set_limits",
  "set_standing_default",
  "set_fix_mode",
  "set_kill_switch",
  "mark_paid",
  "force_original_retries",
  "withdraw_consent",
  "pay_by_link",
] as const;
type Action = (typeof ACTIONS)[number];

const CUSTOMER_ACTIONS: Action[] = ["withdraw_consent", "pay_by_link"];

const PAYMENT_REFUSED: Record<PaymentError, string> = {
  attempt_in_flight: "A debit is waiting for the bank's result. Marking it paid now could collect twice.",
  already_paid: "This cycle is already paid.",
};

/** Furthest day a limit may reach: the likelihood curve runs to day 30. */
const MAX_DAY = 30;

function merchantOnly(caller: Caller): string {
  if (caller.role === "ops" || !caller.merchantId) throw new HttpError(403, "role_not_allowed", "Only the merchant can change its settings.", { caller });
  return caller.merchantId;
}

async function ownProduct(db: SupabaseClient, caller: Caller, body: Body): Promise<string> {
  const merchantId = merchantOnly(caller);
  const productId = text(body, "productId", 100);
  const { data, error } = await db.from("products").select("id").eq("id", productId).eq("merchant_id", merchantId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "product_not_found", "There is no such product.", { caller });
  return productId;
}

/** Stops a running plan through the engine. Paid or already-stopped plans are left alone. */
function stopped(sim: SimCase, reason: string, rec: CaseRecord): SimCase | null {
  if (sim.paidDay !== null || sim.stopReason !== null) return null;
  return stopLayer(sim, reason, (rec.limits_snapshot ?? limitsFrom(rec.obligations)).baselineRetryDays);
}

/** Saves an engine result for one case. An unexpected error fails that case open and returns false. */
async function saveCase(db: SupabaseClient, rec: CaseRecord, sim: SimCase, audit: AuditRow, caller: Caller, today: string): Promise<boolean> {
  try {
    await saveBundle(db, bundleFromSim(rec, sim, [audit], rec.updated_at));
    return true;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    await failOpenExistingCase(db, rec, caller.actor, today, error);
    return false;
  }
}

const failedOpen = (caseId: string): FlowResult => ({
  status: 500,
  body: { error: "server_error", failedOpen: true, caseId, message: "Something went wrong. Razorpay's original retries apply." },
});

export async function updateControls({ db, caller, body }: FlowContext): Promise<FlowResult> {
  const action = oneOf(body, "action", ACTIONS);
  if (CUSTOMER_ACTIONS.includes(action) !== (caller.role === "customer")) {
    throw new HttpError(403, "role_not_allowed", "Your role cannot do this.", { caller });
  }
  const today = await readToday(db);
  const settingAudit = (internal: string, inputs: unknown) =>
    appendAudit(db, auditRow(today, caller.actor, `controls_updated:${action}`, { internal, inputs }));

  switch (action) {
    case "set_limits": {
      const productId = await ownProduct(db, caller, body);
      const lastAllowedDay = wholeNumber(body, "lastAllowedDay", 0, MAX_DAY);
      const maxRepresentations = wholeNumber(body, "maxRepresentations", 0, MAX_DAY);
      await db.from("products").update({ last_allowed_day: lastAllowedDay, max_representations: maxRepresentations }).eq("id", productId).throwOnError();
      await settingAudit(`Limits for ${productId}: overdue cap day ${lastAllowedDay}, ${maxRepresentations} re-presentations.`, { productId, lastAllowedDay, maxRepresentations });
      return { body: { productId, lastAllowedDay, maxRepresentations } };
    }

    case "set_standing_default": {
      const productId = await ownProduct(db, caller, body);
      const label = oneOf(body, "label", SCHEDULE_ORDER);
      await db.from("products").update({ standing_default: label }).eq("id", productId).throwOnError();
      await settingAudit(`Standing default for ${productId}: ${label}.`, { productId, label });
      return { body: { productId, standingDefault: label } };
    }

    case "set_fix_mode": {
      const merchantId = merchantOnly(caller);
      const fixType = oneOf(body, "fixType", FIX_TYPES);
      const mode = oneOf(body, "mode", ["automatic", "needs_approval"] as const);
      await db.from("fix_settings").upsert({ merchant_id: merchantId, fix_type: fixType, mode }).throwOnError();
      await settingAudit(`Fix ${fixType}: ${mode}.`, { fixType, mode });
      return { body: { fixType, mode } };
    }

    case "set_kill_switch": {
      const merchantId = merchantOnly(caller);
      const on = yesNo(body, "on");
      await db.from("merchants").update({ kill_switch: on }).eq("id", merchantId).throwOnError();
      await settingAudit(`Kill switch ${on ? "on" : "off"}.`, { on });
      const cases: { caseId: string; state: string; failedOpen?: boolean }[] = [];
      if (on) {
        // Every running plan of this merchant steps back to Razorpay's original retries.
        const { data, error } = await db.from("cases").select(CASE_SELECT).not("sim_snapshot", "is", null).neq("state", "paid");
        if (error) throw error;
        for (const rec of (data as CaseRecord[]).filter((r) => r.obligations.merchant_id === merchantId)) {
          const after = stopped(rec.sim_snapshot!, "kill_switch", rec);
          if (!after) continue;
          const audit = auditRow(today, caller.actor, "plan_stopped", { caseId: rec.id, internal: "Kill switch on." });
          const saved = await saveCase(db, rec, after, audit, caller, today);
          cases.push(saved ? { caseId: rec.id, state: after.state } : { caseId: rec.id, state: "normal_retries", failedOpen: true });
        }
      }
      return { body: { killSwitch: on, cases } };
    }

    case "mark_paid":
    case "pay_by_link": {
      const rec = await loadCaseFor(db, text(body, "caseId", 200), caller);
      const sim = planOf(rec, caller);
      const via = action === "pay_by_link" ? "link" : "outside";
      const paid = recordOutsidePayment(sim, via);
      if (!paid.ok) throw new HttpError(409, paid.error, PAYMENT_REFUSED[paid.error], { caseId: rec.id, caller });
      const audit = auditRow(today, caller.actor, "paid_outside_plan", {
        caseId: rec.id,
        internal: via === "link" ? "The customer paid by link." : "The merchant marked the cycle as paid outside the plan.",
        inputs: { via },
      });
      if (!(await saveCase(db, rec, paid.case, audit, caller, today))) return failedOpen(rec.id);
      return { body: { caseId: rec.id, state: paid.case.state } };
    }

    case "force_original_retries":
    case "withdraw_consent": {
      const rec = await loadCaseFor(db, text(body, "caseId", 200), caller);
      if (action === "withdraw_consent") {
        await db
          .from("consents")
          .update({ status: "withdrawn", withdrawn_date: today })
          .eq("party", "customer")
          .eq("customer_id", rec.obligations.customer_id)
          .eq("merchant_id", rec.obligations.merchant_id)
          .throwOnError();
      }
      const reason = action === "withdraw_consent" ? "no_customer_consent" : "forced_normal_retries";
      const after = rec.sim_snapshot ? stopped(rec.sim_snapshot, reason, rec) : null;
      if (after) {
        const audit = auditRow(today, caller.actor, "plan_stopped", {
          caseId: rec.id,
          internal: action === "withdraw_consent" ? "The customer withdrew consent." : "The merchant forced Razorpay's original retries.",
        });
        if (!(await saveCase(db, rec, after, audit, caller, today))) return failedOpen(rec.id);
        return { body: { caseId: rec.id, state: after.state } };
      }
      if (action === "force_original_retries") {
        throw new HttpError(409, "no_plan", "The layer is not running a plan for this case.", { caseId: rec.id, caller });
      }
      // Consent is recorded as withdrawn even when no plan is running.
      await appendAudit(db, auditRow(today, caller.actor, "consent_withdrawn", { caseId: rec.id, internal: "The customer withdrew consent; no plan was running." }));
      return { body: { caseId: rec.id, state: rec.state } };
    }
  }
}
