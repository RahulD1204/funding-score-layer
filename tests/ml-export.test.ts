// The exported synthetic data (ml/export/) against the real engine.
// 1. Parity: every rule row in predictions.csv equals estimateFunding on the exported transactions.
//    The Python median-day rule in ml/fsl/rule.py wrote those rows, so this proves the two agree.
// 2. The ten seeded cases, built from the CSV files the way a server function would, end as
//    specs/05-data-and-model.md says.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  advanceTo,
  estimateFunding,
  evaluateFailedDebit,
  formatDate,
  openCase,
  outcomeOf,
  pickSchedule,
  POLICY,
  type Credit,
  type FailedDebitInput,
  type MandateStatus,
  type Observation,
  type ScheduleLabel,
  type Segment,
  type SimCase,
} from "@/lib/engine";

const EXPORT = join(__dirname, "..", "ml", "export");
const AS_OF = "2026-04-02";

type Row = Record<string, string>;

/** A small CSV reader for the files pandas writes: comma-separated, quoted when a field holds a comma. */
function readCsv(name: string): Row[] {
  const text = readFileSync(join(EXPORT, `${name}.csv`), "utf8");
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field !== "" || record.length) records.push([...record, field]);
  const [header, ...rows] = records;
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

const obligations = readCsv("obligations");
const products = readCsv("products");
const merchants = readCsv("merchants");
const customers = readCsv("customers");
const consents = readCsv("consents");
const downtimes = readCsv("bank_downtimes");
const transactions = readCsv("transactions");
const predictions = readCsv("predictions");
const truth = readCsv("sim_truth");

const txByCustomer = new Map<string, Row[]>();
for (const t of transactions) {
  const list = txByCustomer.get(t.customer_id) ?? [];
  list.push(t);
  txByCustomer.set(t.customer_id, list);
}

const one = (rows: Row[], pred: (r: Row) => boolean, what: string): Row => {
  const found = rows.filter(pred);
  if (found.length !== 1) throw new Error(`expected one ${what}, found ${found.length}`);
  return found[0];
};

/**
 * The engine inputs a server function would build for one obligation from the exported tables:
 * its April 2026 cycle, or a replayed February or March cycle when its due date is given.
 */
function inputsFor(obligationId: string, cycleDueDate?: string) {
  const ob = one(obligations, (r) => r.id === obligationId, `obligation ${obligationId}`);
  const product = one(products, (r) => r.id === ob.product_id, "product");
  const merchant = one(merchants, (r) => r.id === ob.merchant_id, "merchant");
  const customer = one(customers, (r) => r.id === ob.customer_id, "customer");
  const t = one(
    truth,
    (r) => r.obligation_id === obligationId && (cycleDueDate ? r.cycle_due_date === cycleDueDate : r.cycle_due_date >= AS_OF),
    "truth row",
  );
  const dueDate = t.cycle_due_date;
  const asOf = dueDate < AS_OF ? dueDate : AS_OF;
  const rows = (txByCustomer.get(ob.customer_id) ?? []).filter((r) => r.date < asOf);

  const observations: Observation[] = rows
    .filter((r) => r.direction === "debit" && r.status === "success")
    .map((r) => ({
      date: r.date,
      amountPaise: Number(r.amount_paise),
      ownMerchant: r.own_merchant === "True" && r.merchant_id === ob.merchant_id,
    }));
  const credits: Credit[] = rows
    .filter((r) => r.direction === "credit")
    .map((r) => ({ date: r.date, amountPaise: Number(r.amount_paise), source: r.source }));

  const windowStart = addMonths(asOf, -POLICY.gate.lookbackMonths);
  const hasFailureEvidence = rows.some(
    (r) => r.status === "failed" && r.reason_code === "insufficient_funds" && r.date >= windowStart,
  );
  const downtimeActive = downtimes.some((d) => d.bank === ob.bank && d.from_date <= dueDate && dueDate <= d.to_date);
  const customerConsent = consents.some(
    (c) => c.party === "customer" && c.customer_id === ob.customer_id && c.merchant_id === ob.merchant_id && c.status === "granted",
  );
  const merchantConsent = consents.some((c) => c.party === "merchant" && c.merchant_id === ob.merchant_id && c.status === "granted");
  const segment = product.segment as Segment;

  const input: FailedDebitInput = {
    dueDate,
    asOf,
    segment,
    rail: product.rail as FailedDebitInput["rail"],
    amountPaise: Number(ob.amount_paise),
    errorReason: t.reason_code,
    mandateStatus: ob.mandate_status as MandateStatus,
    downtimeActive,
    controls: {
      layerEnabled: merchant.layer_enabled === "True",
      killSwitch: merchant.kill_switch === "True",
      productConfigured: true,
      merchantConsent,
      customerConsent,
      inHoldout: customer.holdout === "True",
      forcedNormalRetries: false,
    },
    hasFailureEvidence,
    identityLinked: true,
    observations,
    credits,
    limits: { lastAllowedDay: Number(product.last_allowed_day), maxRepresentations: Number(product.max_representations) },
    cost: {
      penalChargePerDayPaise: product.penal_charge_per_day_paise ? Number(product.penal_charge_per_day_paise) : null,
      bounceChargePaise: product.bounce_charge_paise ? Number(product.bounce_charge_paise) : null,
      baselineRetryDays: JSON.parse(product.baseline_retry_days),
    },
  };
  const modelRow = predictions.find((p) => p.obligation_id === obligationId && p.cycle_due_date === dueDate && p.source === "model");
  if (modelRow) {
    input.modelScore = {
      h: Number(modelRow.h),
      u: Number(modelRow.u),
      likelihoodByDay: JSON.parse(modelRow.likelihood_by_day),
      confidence: Number(modelRow.confidence),
      modelVersion: modelRow.model_version,
    };
  }
  return {
    input,
    merchantType: merchant.type as "lender" | "insurer",
    standingDefault: product.standing_default as ScheduleLabel,
    graceDays: product.grace_days ? Number(product.grace_days) : null,
    fundedOnDay: t.funded_on_day === "" ? null : Number(t.funded_on_day),
    dueDate,
  };
}

function open(obligationId: string) {
  const s = inputsFor(obligationId);
  const decision = evaluateFailedDebit(s.input);
  let sim: SimCase | null = null;
  if ((decision.route === "schedules" || decision.route === "out_of_reach") && decision.build) {
    sim = openCase({
      merchantType: s.merchantType,
      build: decision.build,
      standingDefault: s.standingDefault,
      resultDelayDays: POLICY.resultDelayDays[s.input.rail],
      lastAllowedDay: s.input.limits.lastAllowedDay,
    });
  }
  return { ...s, decision, sim };
}

const on = (dueDate: string, day: number) => formatDate(addDays(dueDate, day));

describe("ml export: the Python median-day rule matches estimateFunding", () => {
  const ruleRows = predictions.filter((p) => p.source === "rule");

  it("has a rule row for the obligations with history", () => {
    expect(ruleRows.length).toBeGreaterThan(200);
  });

  it("gives the same funded day, upper day, confidence and likelihood on every exported rule row", () => {
    for (const row of ruleRows) {
      const { input } = inputsFor(row.obligation_id, row.cycle_due_date);
      const e = estimateFunding({
        dueDate: input.dueDate,
        asOf: input.asOf,
        segment: input.segment,
        debitAmountPaise: input.amountPaise,
        observations: input.observations,
        credits: input.credits,
      });
      expect(e.h, `${row.obligation_id} h`).toBe(Number(row.h));
      expect(e.u, `${row.obligation_id} u`).toBe(Number(row.u));
      expect(e.confidenceBeforeDeductions, `${row.obligation_id} confidence`).toBe(Number(row.confidence));
      const likelihood: number[] = JSON.parse(row.likelihood_by_day);
      e.likelihoodByDay.forEach((share, k) => expect(share).toBeCloseTo(likelihood[k], 12));
    }
  });

  it("stores no model row for the ten seeded cases, so they run on the rule", () => {
    const seeded = ["L-1040", "L-1041", "L-1042", "L-1043", "L-1044", "L-1045", "L-1046", "L-1047", "I-2011", "I-2012"];
    for (const id of seeded) {
      expect(predictions.some((p) => p.obligation_id === id && p.source === "model"), id).toBe(false);
    }
  });

  it("keeps internal numbers out of the merchant-readable files", () => {
    const header = readFileSync(join(EXPORT, "merchants.csv"), "utf8").split("\n")[0] + readFileSync(join(EXPORT, "products.csv"), "utf8").split("\n")[0];
    for (const hidden of ["score", "confidence", "likelihood", "tier", "salary", "archetype"]) expect(header).not.toContain(hidden);
  });
});

describe("ml export: the ten seeded cases end as specs/05 says", () => {
  it("1. L-1040 is paid on the due date: no case", () => {
    const t = one(truth, (r) => r.obligation_id === "L-1040" && r.cycle_due_date >= AS_OF, "truth");
    expect(t.cycle_due_date).toBe("2026-04-02");
    expect(t.funded_on_day).toBe("0");
    expect(t.reason_code).toBe("");
  });

  it("2. L-1041: nobody picks, Balanced applies, attempt on 8 April, confirmed paid on 10 April", () => {
    const c = open("L-1041");
    expect(c.decision.route).toBe("schedules");
    const done = advanceTo(c.sim!, 26, { fundedOnDay: c.fundedOnDay });
    expect(done.chosen).toBe("Balanced");
    expect(done.chosenBy).toBe("default");
    const paid = done.actions.find((a) => a.status === "succeeded")!;
    expect(on(c.dueDate, paid.day)).toBe("8 April");
    expect(on(c.dueDate, paid.resultDueDay!)).toBe("10 April");
    expect(outcomeOf(done)).toMatchObject({ state: "paid", failedAttempts: 0 });
  });

  it("3. L-1042: a recognized monthly credit lands on 9 April; Earliest fails on 8 April, the backup on 11 April succeeds", () => {
    const c = open("L-1042");
    expect(c.decision.estimate?.salaryRecognized).toBe(true);
    expect(on(c.dueDate, c.fundedOnDay!)).toBe("9 April");
    const picked = pickSchedule(c.sim!, "Earliest");
    if (!picked.ok) throw new Error(picked.error);
    const done = advanceTo(picked.case, 26, { fundedOnDay: c.fundedOnDay });
    const failed = done.actions.find((a) => a.status === "failed")!;
    const paid = done.actions.find((a) => a.status === "succeeded")!;
    expect(on(c.dueDate, failed.day)).toBe("8 April");
    expect(on(c.dueDate, paid.day)).toBe("11 April");
    expect(outcomeOf(done)).toMatchObject({ state: "paid", failedAttempts: 1 });
  });

  it("4. L-1043: close to the cap, two schedules only, paid on the 12 April attempt", () => {
    const c = open("L-1043");
    expect(c.decision.cards).toHaveLength(2);
    const done = advanceTo(c.sim!, 26, { fundedOnDay: c.fundedOnDay });
    expect(outcomeOf(done)).toMatchObject({ state: "paid", paidVia: "debit", failedAttempts: 0 });
    expect(on(c.dueDate, done.paidDay!)).toBe("12 April");
  });

  it("5. L-1044: out of reach, link on 22 April, paid by link, no debit presented", () => {
    const c = open("L-1044");
    expect(c.decision.route).toBe("out_of_reach");
    expect(on(c.dueDate, c.decision.build!.linkDay!)).toBe("22 April");
    const done = advanceTo(c.sim!, 26, { fundedOnDay: c.fundedOnDay });
    expect(outcomeOf(done)).toMatchObject({ state: "paid", paidVia: "link", debitsPresented: 0 });
    expect(on(c.dueDate, done.paidDay!)).toBe("22 April");
  });

  it("6. L-1045: two months of history, original retries", () => {
    const c = open("L-1045");
    expect(c.decision).toMatchObject({ route: "fail_open", failOpenReason: "tier_c" });
    expect(c.decision.gate?.failed).toContain("too_few_months");
  });

  it("7. L-1046: mandate cancelled, retries stopped, a re-registration link waits for approval", () => {
    const c = open("L-1046");
    expect(c.decision).toMatchObject({ route: "exceptions_desk", deskTrigger: "mandate_cancelled" });
  });

  it("8. L-1047: catch-all code, mandate active, no downtime; the Triage agent decides and a weak answer leaves the original retries", () => {
    const first = open("L-1047");
    expect(first.input.errorReason).toBe("payment_failed");
    expect(first.input.mandateStatus).toBe("active");
    expect(first.input.downtimeActive).toBe(false);
    expect(first.decision.route).toBe("needs_agent");
    const weak = evaluateFailedDebit({
      ...first.input,
      agentTriage: { label: "balance", strength: "weak", evidence: ["bank text is vague"] },
    });
    expect(weak).toMatchObject({ route: "fail_open", failOpenReason: "triage_unknown" });
  });

  it("9. I-2011: no salary signal, funded 11 April; early attempt on 3 April fails, paid 12 April inside the grace period", () => {
    const c = open("I-2011");
    expect(c.decision.estimate?.salaryRecognized).toBe(false);
    expect(on(c.dueDate, c.fundedOnDay!)).toBe("11 April");
    const done = advanceTo(c.sim!, 26, { fundedOnDay: c.fundedOnDay });
    const probe = done.actions.find((a) => a.kind === "probe")!;
    expect(on(c.dueDate, probe.day)).toBe("3 April");
    expect(probe.status).toBe("failed");
    expect(outcomeOf(done)).toMatchObject({ state: "paid", failedAttempts: 1 });
    expect(on(c.dueDate, done.paidDay!)).toBe("12 April");
    expect(done.paidDay!).toBeLessThanOrEqual(c.graceDays!);
  });

  it("10. I-2012: a monthly credit recognized on the 11th, no early attempt, paid 12 April", () => {
    const c = open("I-2012");
    expect(c.decision.estimate?.salaryRecognized).toBe(true);
    expect(c.decision.estimate?.fundedDate).toBe("2026-04-11");
    const done = advanceTo(c.sim!, 26, { fundedOnDay: c.fundedOnDay });
    expect(done.actions.some((a) => a.kind === "probe")).toBe(false);
    expect(outcomeOf(done)).toMatchObject({ state: "paid", failedAttempts: 0 });
    expect(on(c.dueDate, done.paidDay!)).toBe("12 April");
  });
});
