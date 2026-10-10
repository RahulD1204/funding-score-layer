// compose-message (specs/03, specs/06 section 9). The customer's message for a case.
//
// The engine's messagesDue says which messages a change to a case calls for: a retry notice when a
// debit locks (the day before it runs), or the link text when a payment link is sent. For each one:
//
//   1. Fill the template (buildRetryMessage or buildLinkMessage). Every fact comes from code.
//   2. If the merchant's polish switch is on, ask Claude to reword a retry notice (lib/server/polish.ts).
//      The rewrite is used only if validatePolish passes. A link's text is never polished, because
//      validatePolish does not check the link.
//   3. Store the message, the merchant's copy and an audit row together (store_customer_message).
//
// composeCaseMessages is called by advance-day and process-debit-event (an insurer's standing
// default can lock its first debit the day the case opens) after the case is saved. choose-schedule
// does not call it: a pick is allowed only before anything locks. An error there fails the case open.
// The ops-only route composes any message a running case is missing, for example after an outage.
// The prototype sends nothing: the customer phone mock shows the stored message.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  TEMPLATE_VERSION,
  addDays,
  buildLinkMessage,
  buildRetryMessage,
  formatDate,
  messagesDue,
  type BuiltMessage,
  type ISODate,
  type MessageDue,
} from "@/lib/engine";
import { failOpenExistingCase } from "../fail-open";
import { HttpError } from "../http-error";
import { polishMessage, type PolishOutcome } from "../polish";
import type { FlowContext, FlowResult } from "../route";
import { auditRow, loadCase, readToday, type ObligationRow } from "../store";
import { text } from "../validate";

/** The prototype has no real payment link; the phone mock's Pay button stands in for it. */
export const PAYMENT_LINK_TEXT = "[payment link]";
/** Nothing is sent: the message is shown on the customer phone mock. */
export const MESSAGE_CHANNEL = "phone_mock";

const ACTOR = "system:compose-message";

export interface MessageCase {
  caseId: string;
  ob: ObligationRow;
  dueDate: ISODate;
}

export interface ComposedMessage {
  messageId: number;
  type: MessageDue["type"];
  source: "template" | "polished";
  polish: PolishOutcome["status"] | null;
  body: string;
}

function fillTemplate(c: MessageCase, due: MessageDue): BuiltMessage {
  const { ob } = c;
  if (due.type === "link") {
    return buildLinkMessage({ kind: ob.kind, merchantName: ob.merchants.name, amountPaise: ob.amount_paise, link: PAYMENT_LINK_TEXT });
  }
  const graceDays = ob.products.grace_days;
  return buildRetryMessage({
    segment: ob.products.segment,
    merchantName: ob.merchants.name,
    amountPaise: ob.amount_paise,
    dueDate: c.dueDate,
    plannedDate: addDays(c.dueDate, due.day),
    graceEnd: graceDays !== null ? addDays(c.dueDate, graceDays) : undefined,
  });
}

/** One line for the audit log on which text was stored, and why. */
function auditNote(c: MessageCase, due: MessageDue, polish: PolishOutcome | null): string {
  const what = due.type === "link" ? "Payment link text" : `Retry notice for ${formatDate(addDays(c.dueDate, due.day))}`;
  if (due.type === "link") return `${what}: template (a link's text is never polished).`;
  if (!polish) return `${what}: template (polish is off).`;
  switch (polish.status) {
    case "accepted":
      return `${what}: polished wording, accepted by validatePolish.`;
    case "rejected":
      return `${what}: template kept, the rewrite was rejected (${polish.problems.join("; ")}).`;
    default:
      return `${what}: template kept, polish gave no usable answer (${polish.status}).`;
  }
}

/** Fills, optionally polishes and stores each message. The caller handles errors by failing the case open. */
export async function composeCaseMessages(
  db: SupabaseClient,
  c: MessageCase,
  dues: MessageDue[],
  ctx: { userId: string | null; today: ISODate },
): Promise<ComposedMessage[]> {
  const composed: ComposedMessage[] = [];
  for (const due of dues) {
    const built = fillTemplate(c, due);
    const polish =
      due.type === "retry" && c.ob.merchants.polish_on
        ? await polishMessage(db, { userId: ctx.userId, caseId: c.caseId, messageType: due.type, message: built })
        : null;
    const body = polish?.text ?? built.text;
    const source = polish?.source ?? "template";

    const message = {
      case_id: c.caseId,
      audience: "customer",
      channel: MESSAGE_CHANNEL,
      body,
      source,
      template_version: TEMPLATE_VERSION,
      facts: {
        type: due.type,
        action_id: due.actionId,
        planned_date: due.type === "retry" ? addDays(c.dueDate, due.day) : null,
        ...built.facts,
        polish: polish && { status: polish.status, problems: polish.problems },
      },
      clock_date: ctx.today,
    };
    const audit = auditRow(ctx.today, ACTOR, `message_composed:${due.type}`, {
      caseId: c.caseId,
      internal: auditNote(c, due, polish),
      inputs: { type: due.type, actionId: due.actionId, source, polish: polish?.status ?? null, templateVersion: TEMPLATE_VERSION },
    });
    const { data, error } = await db.rpc("store_customer_message", { p_message: message, p_audit: audit });
    if (error) throw error;
    composed.push({ messageId: Number(data), type: due.type, source, polish: polish?.status ?? null, body });
  }
  return composed;
}

/** Messages already stored for a case, keyed the way messagesDue names them. */
async function storedKeys(db: SupabaseClient, caseId: string): Promise<Set<string>> {
  const { data, error } = await db.from("messages").select("facts").eq("case_id", caseId);
  if (error) throw error;
  return new Set(
    (data as { facts: { type?: string; action_id?: number; planned_date?: string | null } | null }[]).map(
      (r) => `${r.facts?.type}|${r.facts?.action_id}|${r.facts?.planned_date ?? ""}`,
    ),
  );
}

/** The route (ops only): composes any message a running case is missing. */
export async function composeMessage({ db, caller, body }: FlowContext): Promise<FlowResult> {
  const caseId = text(body, "caseId", 200);
  const rec = await loadCase(db, caseId);
  if (!rec) throw new HttpError(404, "case_not_found", "There is no such case.", { caller });
  const sim = rec.sim_snapshot;
  if (!sim || sim.stopReason !== null || sim.paidDay !== null) {
    throw new HttpError(409, "no_plan", "The layer is not running a plan for this case.", { caseId, caller });
  }
  const today = await readToday(db);

  try {
    const stored = await storedKeys(db, caseId);
    // A debit that already ran needs no notice any more; one that is locked and waiting does.
    const waiting = (d: MessageDue) => d.type === "link" || sim.actions.find((a) => a.id === d.actionId)?.status === "locked";
    const missing = messagesDue(null, sim).filter(
      (d) => waiting(d) && !stored.has(`${d.type}|${d.actionId}|${d.type === "retry" ? addDays(rec.cycle_due_date, d.day) : ""}`),
    );
    const composed = await composeCaseMessages(
      db,
      { caseId, ob: rec.obligations, dueDate: rec.cycle_due_date },
      missing,
      { userId: caller.userId, today },
    );
    return { body: { caseId, composed } };
  } catch (error) {
    await failOpenExistingCase(db, rec, caller.actor, today, error);
    return { status: 500, body: { error: "server_error", failedOpen: true, caseId, message: "Something went wrong. Razorpay's original retries apply." } };
  }
}
