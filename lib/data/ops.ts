// What the ops console reads. Ops reads every table through row-level security ("ops only"
// policies), with its own login. sim_truth has no grant, so not even ops reads ground truth here.

import "server-only";
import type { SimCase } from "@/lib/engine";
import { createClient } from "@/lib/supabase/server";
import type { MerchantCaseRow, ScheduleOptionRow } from "./rows";

function must<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}

export async function opsToday(): Promise<string> {
  const supabase = await createClient();
  return (must(await supabase.from("sim_clock").select("today").single()) as { today: string }).today;
}

export interface ObligationChoice {
  id: string;
  kind: "EMI" | "premium";
  amount_paise: number;
  due_day: number;
  mandate_status: string;
  customers: { label: string };
  merchants: { name: string; type: "lender" | "insurer" };
  products: { rail: string; result_delay_days: number };
}

/** Every obligation, for the event injector. */
export async function listObligations(): Promise<ObligationChoice[]> {
  const supabase = await createClient();
  return must(
    await supabase
      .from("obligations")
      .select(
        "id, kind, amount_paise, due_day, mandate_status, customers!obligations_customer_id_fkey(label), merchants!obligations_merchant_id_fkey(name, type), products!obligations_product_id_fkey(rail, result_delay_days)",
      )
      .order("id"),
  ) as unknown as ObligationChoice[];
}

export interface OpsCaseRow {
  id: string;
  obligation_id: string;
  cycle_due_date: string;
  route: string;
  state: string | null;
  fail_open_reason: string | null;
  updated_at: string;
  obligations: { kind: string; amount_paise: number; customers: { label: string }; merchants: { name: string; type: string } };
}

const CASE_LIST_SELECT =
  "id, obligation_id, cycle_due_date, route, state, fail_open_reason, updated_at, obligations!cases_obligation_id_fkey(kind, amount_paise, customers!obligations_customer_id_fkey(label), merchants!obligations_merchant_id_fkey(name, type))";

export async function listCases(): Promise<OpsCaseRow[]> {
  const supabase = await createClient();
  return must(await supabase.from("cases").select(CASE_LIST_SELECT).order("id")) as unknown as OpsCaseRow[];
}

export interface PlanActionRow {
  action_number: number;
  kind: string;
  day: number;
  status: string;
  result_due_day: number | null;
  executed_date: string | null;
}

export interface TriageRow {
  event_id: string;
  label: string;
  decided_by: string;
  evidence: string[] | null;
  agent_strength: string | null;
}

export interface EventRow {
  event_id: string;
  reason_code: string | null;
  bank_text: string | null;
  clock_date: string;
  received_at: string;
}

export interface AuditRow {
  id: number;
  at: string;
  clock_date: string;
  actor: string;
  case_id: string | null;
  decision: string;
  internal_reason: string | null;
  public_reason: string | null;
  inputs: Record<string, unknown> | null;
  policy_version: string;
  model_version: string | null;
}

export interface OpsCaseDetail {
  rec: OpsCaseRow & { policy_version: string; standing_default: string | null; limits_snapshot: Record<string, unknown> | null; sim_snapshot: SimCase | null; prediction_id: number | null };
  actions: PlanActionRow[];
  events: EventRow[];
  triage: TriageRow[];
  audit: AuditRow[];
  merchantRow: MerchantCaseRow | null;
  options: ScheduleOptionRow[];
  prediction: { source: string; model_version: string } | null;
}

export async function getCase(caseId: string): Promise<OpsCaseDetail | null> {
  const supabase = await createClient();
  const rec = must(
    await supabase
      .from("cases")
      .select(`${CASE_LIST_SELECT}, policy_version, standing_default, limits_snapshot, sim_snapshot, prediction_id`)
      .eq("id", caseId)
      .maybeSingle(),
  ) as unknown as OpsCaseDetail["rec"] | null;
  if (!rec) return null;
  const [actions, events, audit, merchantRow, options, prediction] = await Promise.all([
    supabase.from("plan_actions").select("action_number, kind, day, status, result_due_day, executed_date").eq("case_id", caseId).order("action_number").then(must),
    supabase
      .from("debit_events")
      .select("event_id, reason_code, bank_text, clock_date, received_at")
      .eq("obligation_id", rec.obligation_id)
      .eq("cycle_due_date", rec.cycle_due_date)
      .order("received_at")
      .then(must),
    supabase.from("audit_log").select("*").eq("case_id", caseId).order("id").then(must),
    supabase.from("merchant_cases").select("*").eq("case_id", caseId).maybeSingle().then(must),
    supabase.from("schedule_options").select("*").eq("case_id", caseId).order("main_day").then(must),
    rec.prediction_id === null
      ? Promise.resolve(null)
      : supabase.from("predictions").select("source, model_version").eq("id", rec.prediction_id).maybeSingle().then(must),
  ]);
  const eventIds = (events as EventRow[]).map((e) => e.event_id);
  const triage =
    eventIds.length === 0 ? [] : (must(await supabase.from("triage_results").select("*").in("event_id", eventIds)) as TriageRow[]);
  return {
    rec,
    actions: actions as PlanActionRow[],
    events: events as EventRow[],
    triage,
    audit: audit as AuditRow[],
    merchantRow: merchantRow as MerchantCaseRow | null,
    options: options as ScheduleOptionRow[],
    prediction: prediction as OpsCaseDetail["prediction"],
  };
}

/** The audit log, newest first, optionally for one case or every case of one obligation. */
export async function listAudit(filter: string | null, limit = 300): Promise<AuditRow[]> {
  const supabase = await createClient();
  let query = supabase.from("audit_log").select("*").order("id", { ascending: false }).limit(limit);
  if (filter) query = filter.includes(":") ? query.eq("case_id", filter) : query.like("case_id", `${filter}:%`);
  return must(await query) as AuditRow[];
}

export type ModelCardRow = Record<string, unknown> & { model_version: string };

export async function getModelCards(): Promise<ModelCardRow[]> {
  const supabase = await createClient();
  return must(await supabase.from("model_card").select("*")) as ModelCardRow[];
}
