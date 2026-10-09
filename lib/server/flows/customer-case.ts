// customer-case: what the customer phone mock shows (specs/02 screen 7). Customer link only.
// Returns the listed fields and nothing else: no score, no estimate, nothing about income.
// The message is the filled template (buildRetryMessage); build step 9 adds the stored, polished text.

import "server-only";
import { addDays, buildRetryMessage, fillTemplate, formatRupees, type ISODate } from "@/lib/engine";
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
    const link = sim.actions.find((a) => a.kind === "link" && a.status === "sent");
    // A dated message exists once the action has locked, the day before it runs.
    const next = sim.actions
      .filter((a) => a.kind !== "link" && (a.status === "locked" || a.status === "in_flight"))
      .sort((a, b) => b.day - a.day)[0];
    if (link) {
      status = "link";
      message = fillTemplate("payment_link", {
        kind: ob.kind,
        amount: formatRupees(ob.amount_paise),
        merchant: ob.merchants.name,
        link: "[payment link]",
      });
    } else if (next) {
      status = "planned";
      const graceDays = ob.products.grace_days;
      message = buildRetryMessage({
        segment: ob.products.segment,
        merchantName: ob.merchants.name,
        amountPaise: ob.amount_paise,
        dueDate: rec.cycle_due_date,
        plannedDate: addDays(rec.cycle_due_date, next.day),
        graceEnd: graceDays !== null ? addDays(rec.cycle_due_date, graceDays) : undefined,
      }).text;
    }
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
