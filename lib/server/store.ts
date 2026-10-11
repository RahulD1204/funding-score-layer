// Reading and writing the database for the server functions. Storage only: no rule lives here.
// The engine gets its inputs from loadDebitInput and controlsFor; its outputs are stored by
// saveBundle (rows.ts builds the rows).

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  POLICY_VERSION,
  runControlChecks,
  type Credit,
  type FailedDebitInput,
  type FixSettings,
  type FixMode,
  type FixType,
  type ISODate,
  type MandateStatus,
  type MerchantType,
  type ModelScore,
  type Observation,
  type Rail,
  type ScheduleLabel,
  type Segment,
  type SimCase,
} from "@/lib/engine";
import { HttpError } from "./http-error";

// ---------------------------------------------------------------------------
// Row shapes, as PostgREST returns them
// ---------------------------------------------------------------------------

export interface MerchantRow {
  id: string;
  name: string;
  type: MerchantType;
  layer_enabled: boolean;
  kill_switch: boolean;
  polish_on: boolean;
}

export interface ProductRow {
  id: string;
  merchant_id: string;
  segment: Segment;
  rail: Rail;
  last_allowed_day: number | null;
  max_representations: number | null;
  standing_default: ScheduleLabel;
  penal_charge_per_day_paise: number | null;
  bounce_charge_paise: number | null;
  baseline_retry_days: number[];
  grace_days: number | null;
}

export interface ObligationRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  kind: "EMI" | "premium";
  amount_paise: number;
  due_day: number;
  mandate_status: MandateStatus;
  bank: string | null;
  products: ProductRow;
  merchants: MerchantRow;
  customers: { id: string; label: string; holdout: boolean };
}

// Each embed names its foreign key, because other tables (customer_signals, sim_truth, transactions)
// also link obligations to customers and would make a bare name ambiguous.
export const OBLIGATION_SELECT =
  "*, products!obligations_product_id_fkey(*), merchants!obligations_merchant_id_fkey(*), customers!obligations_customer_id_fkey(id, label, holdout)";

/** What a case row holds, with its obligation, product, merchant and customer. */
export interface CaseRecord {
  id: string;
  obligation_id: string;
  cycle_due_date: ISODate;
  route: string;
  state: string | null;
  fail_open_reason: string | null;
  policy_version: string;
  limits_snapshot: LimitsSnapshot | null;
  sim_snapshot: SimCase | null;
  updated_at: string;
  obligations: ObligationRow;
}

export const CASE_SELECT = `*, obligations!cases_obligation_id_fkey(${OBLIGATION_SELECT})`;

/** The limits and charges a case was opened with. Later settings changes do not touch an open case. */
export interface LimitsSnapshot {
  merchantType: MerchantType;
  segment: Segment;
  rail: Rail;
  lastAllowedDay: number;
  maxRepresentations: number;
  resultDelayDays: number;
  baselineRetryDays: number[];
  penalChargePerDayPaise: number | null;
  bounceChargePaise: number | null;
}

export interface ConsentRow {
  customer_id: string | null;
  merchant_id: string;
  party: "merchant" | "customer";
  status: "granted" | "withdrawn";
}

export interface PredictionRow {
  id: number;
  source: "rule" | "model";
  h: number | null;
  u: number | null;
  likelihood_by_day: number[] | null;
  confidence: number | null;
  model_version: string;
}

export interface AuditRow {
  clock_date: ISODate;
  actor: string;
  case_id: string | null;
  decision: string;
  internal_reason: string | null;
  public_reason: string | null;
  inputs: unknown;
  policy_version: string;
  model_version: string | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The message of anything thrown, including Supabase's plain error objects. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

function must<T>(result: { data: T | null; error: unknown }): T {
  if (result.error) throw result.error;
  return result.data as T;
}

export async function readToday(db: SupabaseClient): Promise<ISODate> {
  const row = must<{ today: ISODate }>(await db.from("sim_clock").select("today").single());
  return row.today;
}

export function auditRow(
  today: ISODate,
  actor: string,
  decision: string,
  fields: { caseId?: string | null; internal?: string | null; public?: string | null; inputs?: unknown; modelVersion?: string | null } = {},
): AuditRow {
  return {
    clock_date: today,
    actor,
    case_id: fields.caseId ?? null,
    decision,
    internal_reason: fields.internal ?? null,
    public_reason: fields.public ?? null,
    inputs: fields.inputs ?? null,
    policy_version: POLICY_VERSION,
    model_version: fields.modelVersion ?? null,
  };
}

export async function appendAudit(db: SupabaseClient, row: AuditRow): Promise<void> {
  must(await db.from("audit_log").insert(row));
}

// ---------------------------------------------------------------------------
// Saving: one transaction per case (save_case_bundle in migration 20261010000003)
// ---------------------------------------------------------------------------

export interface CaseBundle {
  case: Record<string, unknown>;
  /** Leave out for a new case. A string means "only if unchanged since"; null means "save regardless". */
  expected_updated_at?: string | null;
  merchant_case?: Record<string, unknown>;
  schedule_options?: Record<string, unknown>[];
  plan_actions?: Record<string, unknown>[];
  desk_items?: Record<string, unknown>[];
  triage_result?: Record<string, unknown>;
  event_id?: string;
  audit?: AuditRow[];
}

export async function saveBundle(db: SupabaseClient, bundle: CaseBundle): Promise<string> {
  const { data, error } = await db.rpc("save_case_bundle", { bundle });
  if (error) {
    if (error.code === "40001") {
      throw new HttpError(409, "case_changed", "The case changed while you were looking at it. Reload and try again.", {
        caseId: String(bundle.case.id),
      });
    }
    throw error;
  }
  return (data as { updated_at: string }).updated_at;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function loadObligation(db: SupabaseClient, obligationId: string): Promise<ObligationRow | null> {
  return must(await db.from("obligations").select(OBLIGATION_SELECT).eq("id", obligationId).maybeSingle()) as ObligationRow | null;
}

export async function loadCase(db: SupabaseClient, caseId: string): Promise<CaseRecord | null> {
  return must(await db.from("cases").select(CASE_SELECT).eq("id", caseId).maybeSingle()) as CaseRecord | null;
}

export async function loadConsents(db: SupabaseClient, merchantIds: string[], customerIds: string[]): Promise<ConsentRow[]> {
  const merchants = [...new Set(merchantIds)];
  const customers = [...new Set(customerIds)];
  if (merchants.length === 0) return [];
  const query = db.from("consents").select("customer_id, merchant_id, party, status").in("merchant_id", merchants);
  const filtered =
    customers.length === 0
      ? query.eq("party", "merchant")
      : query.or(`party.eq.merchant,customer_id.in.(${customers.map((c) => `"${c}"`).join(",")})`);
  return must(await filtered) as ConsentRow[];
}

export async function loadFixSettings(db: SupabaseClient, merchantId: string): Promise<FixSettings> {
  const rows = must(await db.from("fix_settings").select("fix_type, mode").eq("merchant_id", merchantId)) as {
    fix_type: FixType;
    mode: FixMode;
  }[];
  return Object.fromEntries(rows.map((r) => [r.fix_type, r.mode]));
}

/** Ground truth for the simulated bank: the day each obligation's customer is funded. */
export async function loadFundedDays(db: SupabaseClient, keys: { obligationId: string; dueDate: ISODate }[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (keys.length === 0) return out;
  const rows = must(
    await db
      .from("sim_truth")
      .select("obligation_id, cycle_due_date, funded_on_day")
      .in("obligation_id", [...new Set(keys.map((k) => k.obligationId))]),
  ) as { obligation_id: string; cycle_due_date: ISODate; funded_on_day: number | null }[];
  for (const r of rows) out.set(`${r.obligation_id}|${r.cycle_due_date}`, r.funded_on_day);
  return out;
}

/** The control inputs, from live data. The checks themselves are the engine's runControlChecks. */
export function controlsFor(ob: ObligationRow, consents: ConsentRow[]): FailedDebitInput["controls"] {
  const merchantRows = consents.filter((c) => c.party === "merchant" && c.merchant_id === ob.merchant_id);
  const customerRows = consents.filter(
    (c) => c.party === "customer" && c.merchant_id === ob.merchant_id && c.customer_id === ob.customer_id,
  );
  const allGranted = (rows: ConsentRow[]) => rows.length > 0 && rows.every((c) => c.status === "granted");
  return {
    layerEnabled: ob.merchants.layer_enabled,
    killSwitch: ob.merchants.kill_switch,
    productConfigured: ob.products.last_allowed_day !== null && ob.products.max_representations !== null,
    merchantConsent: allGranted(merchantRows),
    customerConsent: allGranted(customerRows),
    inHoldout: ob.customers.holdout,
    forcedNormalRetries: false,
  };
}

/** The engine's control checks for one obligation, as the clock's controlFailure callback wants them. */
export function controlFailureFor(ob: ObligationRow, consents: ConsentRow[]): (day: number) => string | null {
  const controls = controlsFor(ob, consents);
  return () => {
    const result = runControlChecks({
      ...controls,
      mandateStatus: ob.mandate_status,
      rail: ob.products.rail,
      segment: ob.products.segment,
      amountPaise: ob.amount_paise,
    });
    return result.ok ? null : result.failed!;
  };
}

const PAGE = 1000;

/** Every transaction the customer made before `asOf`, oldest first. */
async function loadTransactions(db: SupabaseClient, customerId: string, asOf: ISODate) {
  type Tx = {
    date: ISODate;
    amount_paise: number;
    direction: "credit" | "debit";
    status: "success" | "failed";
    own_merchant: boolean;
    merchant_id: string | null;
    source: string | null;
    obligation_id: string | null;
    reason_code: string | null;
  };
  const out: Tx[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = must(
      await db
        .from("transactions")
        .select("date, amount_paise, direction, status, own_merchant, merchant_id, source, obligation_id, reason_code")
        .eq("customer_id", customerId)
        .lt("date", asOf)
        .order("date")
        .order("id")
        .range(from, from + PAGE - 1),
    ) as Tx[];
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

export interface LoadedDebit {
  input: FailedDebitInput;
  rulePrediction: PredictionRow | null;
  modelPrediction: PredictionRow | null;
}

/**
 * The inputs evaluateFailedDebit needs for one failed due-date debit, from the database.
 * A field-by-field copy, the same as tests/ml-export.test.ts builds from the exported files.
 * The evidence flags come from the signal store (customer_signals); a missing row fails the gate.
 */
export async function loadDebitInput(
  db: SupabaseClient,
  ob: ObligationRow,
  dueDate: ISODate,
  errorReason: string,
  limits: LimitsSnapshot,
): Promise<LoadedDebit> {
  const asOf = dueDate;
  const [transactions, consents, downtimes, signals, predictions] = await Promise.all([
    loadTransactions(db, ob.customer_id, asOf),
    loadConsents(db, [ob.merchant_id], [ob.customer_id]),
    ob.bank
      ? db.from("bank_downtimes").select("id").eq("bank", ob.bank).lte("from_date", dueDate).gte("to_date", dueDate).then(must)
      : Promise.resolve([]),
    db
      .from("customer_signals")
      .select("has_failure_evidence, identity_linked")
      .eq("customer_id", ob.customer_id)
      .lte("as_of_date", asOf)
      .order("as_of_date", { ascending: false })
      .limit(1)
      .then(must),
    db
      .from("predictions")
      .select("id, source, h, u, likelihood_by_day, confidence, model_version")
      .eq("obligation_id", ob.id)
      .eq("cycle_due_date", dueDate)
      .then(must),
  ]);

  const observations: Observation[] = transactions
    .filter((t) => t.direction === "debit" && t.status === "success")
    .map((t) => ({ date: t.date, amountPaise: t.amount_paise, ownMerchant: t.own_merchant && t.merchant_id === ob.merchant_id }));
  const credits: Credit[] = transactions
    .filter((t) => t.direction === "credit")
    .map((t) => ({ date: t.date, amountPaise: t.amount_paise, source: t.source ?? "" }));

  const signal = (signals as { has_failure_evidence: boolean; identity_linked: boolean }[])[0];
  const preds = predictions as PredictionRow[];
  const rulePrediction = preds.find((p) => p.source === "rule") ?? null;
  const modelPrediction = preds.find((p) => p.source === "model") ?? null;

  const input: FailedDebitInput = {
    dueDate,
    asOf,
    segment: limits.segment,
    rail: limits.rail,
    amountPaise: ob.amount_paise,
    errorReason,
    mandateStatus: ob.mandate_status,
    downtimeActive: (downtimes as unknown[]).length > 0,
    // The same rows the Triage agent's get_failure_history reads: failed debits on this obligation.
    pastFailureCodes: transactions
      .filter((t) => t.obligation_id === ob.id && t.status === "failed" && t.reason_code)
      .map((t) => t.reason_code!),
    controls: controlsFor(ob, consents),
    hasFailureEvidence: signal?.has_failure_evidence ?? false,
    identityLinked: signal?.identity_linked ?? false,
    observations,
    credits,
    limits: { lastAllowedDay: limits.lastAllowedDay, maxRepresentations: limits.maxRepresentations },
    cost: {
      penalChargePerDayPaise: limits.penalChargePerDayPaise,
      bounceChargePaise: limits.bounceChargePaise,
      baselineRetryDays: limits.baselineRetryDays,
    },
  };
  if (
    modelPrediction &&
    modelPrediction.h !== null &&
    modelPrediction.u !== null &&
    modelPrediction.likelihood_by_day !== null
  ) {
    const score: ModelScore = {
      h: modelPrediction.h,
      u: modelPrediction.u,
      likelihoodByDay: modelPrediction.likelihood_by_day,
      modelVersion: modelPrediction.model_version,
    };
    if (modelPrediction.confidence !== null) score.confidence = modelPrediction.confidence;
    input.modelScore = score;
  }
  return { input, rulePrediction, modelPrediction };
}

export interface TriageRecord {
  event_id: string;
  label: string;
  decided_by: "rule" | "lookup" | "agent";
  evidence: string[] | null;
  agent_strength: string | null;
}

/** The triage row of the event that opened a case (one case per failed cycle). */
export async function loadCaseTriage(db: SupabaseClient, obligationId: string, dueDate: ISODate): Promise<TriageRecord | null> {
  const events = must(
    await db.from("debit_events").select("event_id").eq("obligation_id", obligationId).eq("cycle_due_date", dueDate),
  ) as { event_id: string }[];
  if (events.length === 0) return null;
  const rows = must(
    await db
      .from("triage_results")
      .select("event_id, label, decided_by, evidence, agent_strength")
      .in("event_id", events.map((e) => e.event_id)),
  ) as TriageRecord[];
  return rows[0] ?? null;
}
