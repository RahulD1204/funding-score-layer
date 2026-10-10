// The agents' read-only tools (specs/07). Each is a server function that returns only the fields its
// spec row lists: no income, no employer, no balance, no score. None of them writes anything.
//
// Triage and desk tools are bound to the one case being handled when they are built, so they take
// no input: the model cannot point them at another customer. The Ops assistant's tools take a case
// id or a search, because ops may read every case.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FIX_CATALOGUE,
  addDays,
  allowedFixes,
  formatRupees,
  type DeskTrigger,
  type ISODate,
} from "@/lib/engine";
import { endOfCover } from "@/lib/view/cases";
import { CASE_SELECT, loadCaseTriage, type CaseRecord, type LimitsSnapshot, type ObligationRow } from "../store";
import type { AgentTool } from "./runner";

const NO_INPUT = { type: "object" as const, properties: {}, additionalProperties: false };

function must<T>(result: { data: T | null; error: unknown }): T {
  if (result.error) throw result.error;
  return result.data as T;
}

function mandateStatusTool(ob: ObligationRow): AgentTool {
  return {
    name: "get_mandate_status",
    description: "The status of the customer's mandate for this debit, and the date it last changed.",
    inputSchema: NO_INPUT,
    // The prototype's data does not record when a mandate status changed, so that field is empty.
    run: async () => ({ status: ob.mandate_status, last_changed: null }),
  };
}

async function downtimesFor(db: SupabaseClient, bank: string | null, on: ISODate) {
  if (!bank) return [] as { from_date: ISODate; to_date: ISODate }[];
  return must(
    await db.from("bank_downtimes").select("from_date, to_date").eq("bank", bank).lte("from_date", on).gte("to_date", on),
  ) as { from_date: ISODate; to_date: ISODate }[];
}

// ---------------------------------------------------------------------------
// Failure Triage: get_mandate_status, get_bank_downtime, get_failure_history, get_obligation
// ---------------------------------------------------------------------------

export function triageTools(db: SupabaseClient, ob: ObligationRow, dueDate: ISODate): AgentTool[] {
  return [
    mandateStatusTool(ob),
    {
      name: "get_bank_downtime",
      description: "Whether a downtime at the customer's bank covered the time of the failed debit.",
      inputSchema: NO_INPUT,
      run: async () => ({ downtime_covered_attempt: (await downtimesFor(db, ob.bank, dueDate)).length > 0 }),
    },
    {
      name: "get_failure_history",
      description:
        "Dates and reason codes of this customer's past failed debits on this same obligation, oldest first. No amounts.",
      inputSchema: NO_INPUT,
      run: async () => {
        const rows = must(
          await db
            .from("transactions")
            .select("date, reason_code")
            .eq("obligation_id", ob.id)
            .eq("status", "failed")
            .lt("date", dueDate)
            .order("date"),
        ) as { date: ISODate; reason_code: string | null }[];
        return { failures: rows.map((r) => ({ date: r.date, reason_code: r.reason_code ?? "not recorded" })) };
      },
    },
    {
      name: "get_obligation",
      description: "The kind of recurring debit, its due day of the month and the payment rail.",
      inputSchema: NO_INPUT,
      run: async () => ({ kind: ob.kind, due_day: ob.due_day, rail: ob.products.rail }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Exceptions desk: get_case, get_mandate_status, get_bank_downtime, get_sent_messages, list_allowed_fixes
// ---------------------------------------------------------------------------

export interface DeskCaseFacts {
  caseId: string;
  ob: ObligationRow;
  dueDate: ISODate;
  limits: LimitsSnapshot;
  trigger: DeskTrigger;
  state: string;
  attemptsUsed: number;
  today: ISODate;
}

export function deskTools(db: SupabaseClient, facts: DeskCaseFacts): AgentTool[] {
  const { ob, dueDate, limits } = facts;
  return [
    {
      name: "get_case",
      description:
        "The case: kind, amount, due date, state, retries used, and its deadline (the lender's overdue cap or the end of insurance cover).",
      inputSchema: NO_INPUT,
      run: async () => {
        const deadline =
          ob.kind === "EMI"
            ? { kind: "overdue cap", date: addDays(dueDate, limits.lastAllowedDay) }
            : { kind: "end of cover", date: endOfCover(dueDate, ob.products) };
        return {
          kind: ob.kind,
          amount: formatRupees(ob.amount_paise),
          due_date: dueDate,
          state: facts.state,
          retries_used: facts.attemptsUsed,
          deadline,
          today: facts.today,
        };
      },
    },
    mandateStatusTool(ob),
    {
      name: "get_bank_downtime",
      description: "Whether a downtime at the customer's bank is active today, and the day it ends.",
      inputSchema: NO_INPUT,
      run: async () => {
        const active = await downtimesFor(db, ob.bank, facts.today);
        const ends = active.map((d) => d.to_date).sort().at(-1) ?? null;
        return { active: active.length > 0, ends_on: ends };
      },
    },
    {
      name: "get_sent_messages",
      description: "Dates and types of the messages already sent to the customer for this case.",
      inputSchema: NO_INPUT,
      run: async () => {
        const rows = must(
          await db.from("messages").select("created_at, audience, channel").eq("case_id", facts.caseId).order("created_at"),
        ) as { created_at: string; audience: string; channel: string }[];
        return { messages: rows.map((r) => ({ date: r.created_at.slice(0, 10), audience: r.audience, channel: r.channel })) };
      },
    },
    {
      name: "list_allowed_fixes",
      description: "The fixes allowed for this case's trigger, from the fixed catalogue, and whether each contacts the customer.",
      inputSchema: NO_INPUT,
      run: async () => ({
        trigger: facts.trigger,
        fixes: allowedFixes(facts.trigger).map((fix) => ({
          fix,
          description: FIX_CATALOGUE[fix].description,
          contacts_customer: FIX_CATALOGUE[fix].contactsCustomer,
        })),
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Ops assistant: search_audit_log, get_case, get_triage_result
// ---------------------------------------------------------------------------

export interface AuditCitation {
  id: number;
  clock_date: ISODate;
  case_id: string | null;
  decision: string;
  internal_reason: string | null;
  policy_version: string;
  model_version: string | null;
}

const AUDIT_FIELDS = "id, clock_date, case_id, decision, internal_reason, policy_version, model_version";
const SEARCH_LIMIT = 25;

/** A case id ("L-1041:2026-04-02") or an obligation id ("L-1041"), as the audit page accepts. */
const CASE_REF = /^[A-Za-z0-9-]{1,40}(:\d{4}-\d{2}-\d{2})?$/;

function optionalString(input: Record<string, unknown>, key: string, max: number): string | null {
  const value = input[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > max) throw new Error(`${key} must be text of at most ${max} characters.`);
  return value.trim() || null;
}

function caseRef(input: Record<string, unknown>): string {
  const value = optionalString(input, "case_id", 60);
  if (!value || !CASE_REF.test(value)) throw new Error('case_id must look like "L-1041:2026-04-02" or "L-1041".');
  return value;
}

/** Escapes the wildcards of a LIKE pattern, so a search is always a plain substring. */
function likeText(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

async function findCase(db: SupabaseClient, ref: string): Promise<CaseRecord | null> {
  const query = db.from("cases").select(CASE_SELECT);
  const rows = must(
    await (ref.includes(":") ? query.eq("id", ref) : query.eq("obligation_id", ref)).order("cycle_due_date", { ascending: false }).limit(1),
  ) as CaseRecord[];
  return rows[0] ?? null;
}

/**
 * The Ops assistant's tools. Every audit row a tool returns is recorded in `seen`, so the answer's
 * citations can be checked against what the assistant actually read (validateOpsAnswer).
 */
export function opsTools(db: SupabaseClient, seen: Map<number, AuditCitation>): AgentTool[] {
  return [
    {
      name: "search_audit_log",
      description:
        "Search the audit log, newest first, at most 25 rows. All filters are optional and combine. case_id matches a case or obligation id in part (\"L-1041\"); decision matches the decision name in part (\"case_opened\", \"fix_run\", \"attempt\"); text matches the internal reason in part.",
      inputSchema: {
        type: "object",
        properties: {
          case_id: { type: "string", description: 'A case id ("L-1041:2026-04-02") or an obligation id ("L-1041").' },
          decision: { type: "string" },
          text: { type: "string" },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const caseId = optionalString(input, "case_id", 60);
        const decision = optionalString(input, "decision", 60);
        const text = optionalString(input, "text", 100);
        if (caseId && !CASE_REF.test(caseId)) throw new Error('case_id must look like "L-1041:2026-04-02" or "L-1041".');
        let query = db.from("audit_log").select(AUDIT_FIELDS);
        if (caseId) query = query.ilike("case_id", likeText(caseId));
        if (decision) query = query.ilike("decision", likeText(decision));
        if (text) query = query.ilike("internal_reason", likeText(text));
        const rows = must(await query.order("id", { ascending: false }).limit(SEARCH_LIMIT)) as AuditCitation[];
        for (const r of rows) seen.set(r.id, r);
        return { rows };
      },
    },
    {
      name: "get_case",
      description:
        "One case: route, state, fail-open reason, limits, standing default, chosen schedule, its actions with their outcomes, and any exceptions desk fixes. Takes a case id or an obligation id (its latest case).",
      inputSchema: {
        type: "object",
        properties: { case_id: { type: "string" } },
        required: ["case_id"],
        additionalProperties: false,
      },
      run: async (input) => {
        const rec = await findCase(db, caseRef(input));
        if (!rec) return { found: false };
        const [actions, desk] = await Promise.all([
          db.from("plan_actions").select("action_number, kind, day, status, executed_date").eq("case_id", rec.id).order("action_number").then(must),
          db.from("desk_items").select("fix_type, mode, status").eq("case_id", rec.id).order("id").then(must),
        ]);
        const limits = rec.limits_snapshot;
        return {
          found: true,
          case_id: rec.id,
          customer: rec.obligations.customers.label,
          kind: rec.obligations.kind,
          amount: formatRupees(rec.obligations.amount_paise),
          due_date: rec.cycle_due_date,
          route: rec.route,
          state: rec.state,
          fail_open_reason: rec.fail_open_reason,
          policy_version: rec.policy_version,
          limits: limits
            ? {
                last_allowed_day: limits.lastAllowedDay,
                last_allowed_date: addDays(rec.cycle_due_date, limits.lastAllowedDay),
                max_representations: limits.maxRepresentations,
                result_delay_days: limits.resultDelayDays,
                original_retry_days: limits.baselineRetryDays,
              }
            : null,
          chosen_schedule: rec.sim_snapshot?.chosen ?? null,
          chosen_by: rec.sim_snapshot?.chosenBy ?? null,
          actions: (actions as { action_number: number; kind: string; day: number; status: string; executed_date: ISODate | null }[]).map((a) => ({
            kind: a.kind,
            date: addDays(rec.cycle_due_date, a.day),
            status: a.status,
            executed_date: a.executed_date,
          })),
          desk_fixes: desk,
        };
      },
    },
    {
      name: "get_triage_result",
      description: "How a case's failure was labelled: the label, what decided it (rule, lookup or agent) and the evidence.",
      inputSchema: {
        type: "object",
        properties: { case_id: { type: "string" } },
        required: ["case_id"],
        additionalProperties: false,
      },
      run: async (input) => {
        const rec = await findCase(db, caseRef(input));
        if (!rec) return { found: false };
        const triage = await loadCaseTriage(db, rec.obligation_id, rec.cycle_due_date);
        if (!triage) return { found: false, case_id: rec.id };
        return {
          found: true,
          case_id: rec.id,
          label: triage.label,
          decided_by: triage.decided_by,
          evidence: triage.evidence ?? [],
          agent_strength: triage.agent_strength,
        };
      },
    },
  ];
}
