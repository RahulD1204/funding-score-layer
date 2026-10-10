// customer-case: what the customer phone mock shows (specs/02 screen 7). Customer link only.
// Returns the listed fields and nothing else: no score, no estimate, nothing about income.
// The message is the latest one compose-message stored for the case, template or polished.

import "server-only";
import { addDays, type ISODate } from "@/lib/engine";
import type { FlowContext, FlowResult } from "../route";
import { loadConsents } from "../store";
import { loadCaseFor } from "./common";

export interface CustomerCaseView {
  caseId: string;
  customer: string;
  merchant: string;
  kind: "EMI" | "premium";
  amountPaise: number;
  dueDate: ISODate;
  /** paid, link (a payment link is open), planned (a dated retry), or none. */
  status: "paid" | "link" | "planned" | "none";
  paidDate: ISODate | null;
  message: string | null;
  consent: "granted" | "withdrawn";
}

/** The latest stored message for the case. */
async function latestMessage(db: FlowContext["db"], caseId: string): Promise<string | null> {
  const { data, error } = await db.from("messages").select("body").eq("case_id", caseId).order("id", { ascending: false }).limit(1);
  if (error) throw error;
  return (data as { body: string }[])[0]?.body ?? null;
}

export async function customerCase({ db, caller }: FlowContext): Promise<FlowResult> {
  const rec = await loadCaseFor(db, caller.caseId ?? "", caller);
  const ob = rec.obligations;
  const sim = rec.sim_snapshot;
  const consents = await loadConsents(db, [ob.merchant_id], [ob.customer_id]);
  const own = consents.filter((c) => c.party === "customer" && c.customer_id === ob.customer_id);
  const consent = own.length > 0 && own.every((c) => c.status === "granted") ? "granted" : "withdrawn";

  let status: CustomerCaseView["status"] = "none";
  let message: string | null = null;
  let paidDate: ISODate | null = null;
  if (sim?.paidDay !== null && sim?.paidDay !== undefined) {
    status = "paid";
    paidDate = addDays(rec.cycle_due_date, sim.paidDay);
  } else if (sim && sim.stopReason === null) {
    const link = sim.actions.some((a) => a.kind === "link" && a.status === "sent");
    // A dated message exists once a debit has locked, the day before it runs.
    const planned = sim.actions.some((a) => a.kind !== "link" && (a.status === "locked" || a.status === "in_flight"));
    if (link) status = "link";
    else if (planned) status = "planned";
    if (link || planned) message = await latestMessage(db, rec.id);
  }

  const view: CustomerCaseView = {
    caseId: rec.id,
    customer: ob.customers.label,
    merchant: ob.merchants.name,
    kind: ob.kind,
    amountPaise: ob.amount_paise,
    dueDate: rec.cycle_due_date,
    status,
    paidDate,
    message,
    consent,
  };
  return { body: view };
}
