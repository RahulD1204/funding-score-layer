// Golden cases P1 to P9: one failed debit through the whole decision pipeline,
// plus D1 to D5 (exceptions desk) and M1 to M7 (messages). See specs/09-testing.md.
// Never edit an expected value to make a test pass. Change the spec first.

import { describe, expect, it } from "vitest";
import {
  POLICY_VERSION,
  FIX_CATALOGUE,
  allowedFixes,
  buildLinkMessage,
  buildRetryMessage,
  evaluateFailedDebit,
  fallbackProposals,
  fillTemplate,
  findBannedWords,
  formatRupees,
  checkReasonText,
  messagesDue,
  resolveMode,
  validateDeskOutput,
  validatePolish,
  type FailedDebitInput,
  type SimAction,
  type SimCase,
} from "@/lib/engine";
import { AROUND_THE_7TH, CONTROLS_OK, DUE, EMI_PAISE, LENDER_COST, MONTHS_5, observations } from "./fixtures";

const BASE: FailedDebitInput = {
  dueDate: DUE,
  segment: "lending",
  rail: "bank_mandate",
  amountPaise: EMI_PAISE,
  errorReason: "insufficient_funds",
  mandateStatus: "active",
  downtimeActive: false,
  controls: CONTROLS_OK,
  hasFailureEvidence: true,
  identityLinked: true,
  observations: AROUND_THE_7TH,
  limits: { lastAllowedDay: 10, maxRepresentations: 2 },
  cost: LENDER_COST,
};

describe("P1 a balance failure with a clear pattern", () => {
  const d = evaluateFailedDebit(BASE);

  it("produces three schedules", () => {
    expect(d.route).toBe("schedules");
    expect(d.policyVersion).toBe(POLICY_VERSION);
    expect(d.triage).toMatchObject({ label: "balance", decidedBy: "rule" });
    expect(d.gate?.tier).toBe("A");
    expect(d.estimate).toMatchObject({ h: 5, u: 7, confidence: 100, source: "history", fundedDate: "2026-04-07" });
    expect(d.cards?.map((c) => [c.label, c.attemptDays, c.band])).toEqual([
      ["Earliest", [5, 8], "Medium"],
      ["Balanced", [6, 9], "High"],
      ["Safest", [8], "High"],
    ]);
  });

  it("puts the lender's own charges on each card", () => {
    // Rs 8 a day overdue. Razorpay's original first retry is day 3.
    expect(d.cards?.map((c) => [c.daysOverdue, c.waitingChargePaise, c.versusOriginal])).toEqual([
      [5, 40_00, { daysLater: 2, extraChargePaise: 16_00 }],
      [6, 48_00, { daysLater: 3, extraChargePaise: 24_00 }],
      [8, 64_00, { daysLater: 5, extraChargePaise: 40_00 }],
    ]);
    expect(d.baseline).toEqual({ days: [3, 6, 9], waitingChargePaise: [24_00, 48_00, 72_00], bounceChargePaise: 500_00 });
  });

  it("keeps the two reason lines apart", () => {
    expect(d.publicReason).toBe("Suggested from payment timing. Advice only.");
    expect(d.internalReason).toBe("Payment pattern around the 7th, based on 30 observations, confidence 100%.");
    expect(findBannedWords(d.publicReason)).toEqual([]);
  });

  it("gives the merchant-facing cards nothing that reveals the estimate", () => {
    const text = JSON.stringify({ cards: d.cards, baseline: d.baseline, reason: d.publicReason });
    for (const hidden of ["likelihood", "confidence", "fundedDate", "anchor", "0.6", "0.8"]) {
      expect(text).not.toContain(hidden);
    }
  });
});

describe("P2 too little history", () => {
  const thin = observations(["2026-02", "2026-03"], [6, 7, 8]);
  const d = evaluateFailedDebit({ ...BASE, observations: thin });

  it("fails open as tier C and builds nothing", () => {
    expect(d.route).toBe("fail_open");
    expect(d.failOpenReason).toBe("tier_c");
    expect(d.gate?.failed).toEqual(["too_few_observations", "too_few_months"]);
    expect(d.cards).toBeUndefined();
    expect(d.publicReason).toBe("Razorpay's original retries apply.");
  });

  it("also needs failure evidence and a linked identity", () => {
    expect(evaluateFailedDebit({ ...BASE, hasFailureEvidence: false }).gate?.failed).toEqual(["no_failure_evidence"]);
    expect(evaluateFailedDebit({ ...BASE, identityLinked: false }).gate?.failed).toEqual(["identity_not_linked"]);
  });
});

describe("P3 a scattered pattern", () => {
  // Payments spread across the month: no day has most of them within 2 days.
  const scattered = observations(MONTHS_5, [2, 7, 12, 17, 22, 27], 10_000_00);
  const d = evaluateFailedDebit({ ...BASE, observations: scattered });

  it("fails open on low confidence", () => {
    expect(d.route).toBe("fail_open");
    expect(d.failOpenReason).toBe("low_confidence");
    expect(d.estimate?.confidence).toBeLessThan(80);
    expect(d.internalReason).toContain("floor 80%");
  });
});

describe("P4 a catch-all reason code", () => {
  const input = { ...BASE, errorReason: "payment_failed" };

  it("asks for the Triage agent on the first pass", () => {
    const d = evaluateFailedDebit(input);
    expect(d.route).toBe("needs_agent");
    expect(d.triage.needsAgent).toBe(true);
  });

  it("continues to schedules on a strong balance answer", () => {
    const d = evaluateFailedDebit({
      ...input,
      agentTriage: { label: "balance", strength: "strong", evidence: ["bank text: FUNDS INSUFFICIENT"] },
    });
    expect(d.route).toBe("schedules");
    expect(d.triage).toMatchObject({ label: "balance", decidedBy: "agent" });
  });

  it("fails open on a weak answer", () => {
    const d = evaluateFailedDebit({
      ...input,
      agentTriage: { label: "balance", strength: "weak", evidence: ["bank text: DECLINED"] },
    });
    expect(d.route).toBe("fail_open");
    expect(d.failOpenReason).toBe("triage_unknown");
    expect(d.triage.evidence).toContain("agent answer rejected: weak");
  });

  it("fails open on an answer that is not in the label list", () => {
    const d = evaluateFailedDebit({
      ...input,
      agentTriage: { label: "fraud", strength: "strong", evidence: ["x"] },
    });
    expect(d.failOpenReason).toBe("triage_unknown");
  });

  it("sends a strong non-balance answer to the desk", () => {
    const d = evaluateFailedDebit({
      ...input,
      agentTriage: { label: "instrument_closed", strength: "strong", evidence: ["bank text: ACCOUNT CLOSED"] },
    });
    expect(d.route).toBe("exceptions_desk");
    expect(d.deskTrigger).toBe("instrument_closed");
  });

  it("uses the lookups before any agent", () => {
    const d = evaluateFailedDebit({ ...input, downtimeActive: true });
    expect(d.route).toBe("exceptions_desk");
    expect(d.triage).toMatchObject({ label: "bank_downtime", decidedBy: "lookup" });
  });
});

describe("P5 a failure that waiting cannot fix", () => {
  it("goes to the exceptions desk, not to a schedule", () => {
    const d = evaluateFailedDebit({ ...BASE, errorReason: "mandate_cancelled", mandateStatus: "cancelled" });
    expect(d.route).toBe("exceptions_desk");
    expect(d.deskTrigger).toBe("mandate_cancelled");
    expect(d.estimate).toBeUndefined();
  });
});

describe("P6 control checks", () => {
  it("leaves holdout customers on the original retries", () => {
    const d = evaluateFailedDebit({ ...BASE, controls: { ...CONTROLS_OK, inHoldout: true } });
    expect(d.route).toBe("fail_open");
    expect(d.failOpenReason).toBe("holdout");
    expect(d.estimate).toBeUndefined();
  });

  it("stops everything on the kill switch", () => {
    expect(evaluateFailedDebit({ ...BASE, controls: { ...CONTROLS_OK, killSwitch: true } }).failOpenReason).toBe("kill_switch");
  });

  it("needs the customer's consent", () => {
    expect(evaluateFailedDebit({ ...BASE, controls: { ...CONTROLS_OK, customerConsent: false } }).failOpenReason).toBe(
      "no_customer_consent",
    );
  });
});

describe("P7 payday past the cap", () => {
  // Payments cluster on the 22nd, 20 days after a 2 April due date. The cap is day 10.
  const late = observations(MONTHS_5, [21, 22, 22, 22, 23, 22], 10_000_00);
  const d = evaluateFailedDebit({ ...BASE, observations: late });

  it("routes to a payment link timed to payday", () => {
    expect(d.estimate?.h).toBe(20);
    expect(d.route).toBe("out_of_reach");
    expect(d.build?.linkDay).toBe(20);
    expect(d.cards).toEqual([]);
  });
});

describe("P8 insurance on UPI Autopay", () => {
  const d = evaluateFailedDebit({
    ...BASE,
    segment: "insurance",
    rail: "upi_autopay",
    amountPaise: 2_500_00,
    limits: { lastAllowedDay: 12, maxRepresentations: 3 },
    cost: undefined,
  });

  it("adds an early probe and uses the insurance retry days as the original", () => {
    expect(d.route).toBe("schedules");
    expect(d.build?.minDay).toBe(1);
    expect(d.cards?.map((c) => c.attemptDays)).toEqual([
      [1, 5, 6],
      [1, 6, 7],
      [1, 8, 9],
    ]);
    expect(d.baseline?.days).toEqual([1, 2, 3]);
    expect(d.cards?.[0].waitingChargePaise).toBeNull();
  });
});

describe("P9 a model score replaces the rule's days", () => {
  const curve = Array.from({ length: 31 }, (_, k) => (k < 4 ? 0.1 : k < 6 ? 0.7 : 0.9));
  const d = evaluateFailedDebit({
    ...BASE,
    modelScore: { h: 4, u: 6, likelihoodByDay: curve, confidence: 88, modelVersion: "xgb-aft-0.1" },
  });

  it("uses the model's h and u, inside the same limits", () => {
    expect(d.estimate).toMatchObject({ source: "model", h: 4, u: 6, confidence: 88, modelVersion: "xgb-aft-0.1" });
    expect(d.cards?.map((c) => [c.attemptDays, c.band])).toEqual([
      [[4, 7], "Medium"],
      [[5, 8], "Medium"],
      [[7, 10], "High"],
    ]);
  });

  it("still fails open when the model's confidence is under the floor", () => {
    const low = evaluateFailedDebit({
      ...BASE,
      modelScore: { h: 4, u: 6, likelihoodByDay: curve, confidence: 75, modelVersion: "xgb-aft-0.1" },
    });
    expect(low.failOpenReason).toBe("low_confidence");
  });
});

// ---------------------------------------------------------------------------
// Exceptions desk
// ---------------------------------------------------------------------------

describe("D1 fixes allowed for each trigger", () => {
  it("lists only catalogue fixes", () => {
    expect(allowedFixes("mandate_cancelled")).toEqual(["stop_attempts", "send_reregistration_link"]);
    expect(allowedFixes("mandate_paused")).toEqual(["hold_attempts", "send_resume_request"]);
    expect(allowedFixes("instrument_closed")).toEqual(["stop_attempts", "send_method_change_link"]);
    expect(allowedFixes("bank_downtime")).toEqual(["hold_and_represent"]);
    expect(allowedFixes("customer_paid")).toEqual(["cancel_pending_attempt"]);
  });
});

describe("D2 the merchant's switch decides the mode", () => {
  const raw = [
    { fix: "stop_attempts", reason: "The mandate was cancelled at the bank." },
    { fix: "send_reregistration_link", reason: "A new mandate is needed before the next EMI.", mode: "automatic" },
  ];

  it("starts customer-facing fixes as needs approval, whatever the agent says", () => {
    expect(validateDeskOutput("mandate_cancelled", raw).accepted).toEqual([
      { fix: "stop_attempts", reason: "The mandate was cancelled at the bank.", mode: "automatic" },
      { fix: "send_reregistration_link", reason: "A new mandate is needed before the next EMI.", mode: "needs_approval" },
    ]);
  });

  it("follows the merchant's per-fix setting", () => {
    const settings = { send_reregistration_link: "automatic", stop_attempts: "needs_approval" } as const;
    expect(validateDeskOutput("mandate_cancelled", raw, settings).accepted.map((p) => p.mode)).toEqual([
      "needs_approval",
      "automatic",
    ]);
    expect(resolveMode("hold_and_represent")).toBe("automatic");
  });
});

describe("D3 anything outside the list is rejected", () => {
  it("rejects invented, misplaced, unexplained and repeated fixes", () => {
    const result = validateDeskOutput("bank_downtime", [
      { fix: "refund_customer", reason: "Seems fair." },
      { fix: "send_reregistration_link", reason: "Just in case." },
      { fix: "hold_and_represent", reason: "  " },
      { fix: "hold_and_represent", reason: "Downtime ends at 18:00." },
      { fix: "hold_and_represent", reason: "Again." },
    ]);
    expect(result.accepted).toEqual([{ fix: "hold_and_represent", reason: "Downtime ends at 18:00.", mode: "automatic" }]);
    expect(result.rejected.map((r) => r.why)).toEqual([
      "not_in_catalogue",
      "not_allowed_for_trigger",
      "no_reason",
      "duplicate",
    ]);
  });

  it("accepts nothing from output that is not a list", () => {
    expect(validateDeskOutput("bank_downtime", "hold_and_represent").accepted).toEqual([]);
    expect(validateDeskOutput("bank_downtime", null).accepted).toEqual([]);
  });
});

describe("D4 the desk still works with the agent switched off", () => {
  it("proposes every allowed fix by rule", () => {
    expect(fallbackProposals("mandate_paused").map((p) => [p.fix, p.mode])).toEqual([
      ["hold_attempts", "automatic"],
      ["send_resume_request", "needs_approval"],
    ]);
  });
});

describe("D5 the merchant reads the desk reason, so it is checked (policy v1.1)", () => {
  it("replaces a reason that hints at income, a score or the funded day with the catalogue description", () => {
    const result = validateDeskOutput("mandate_cancelled", [
      { fix: "stop_attempts", reason: "Insufficient balance until salary day." },
      { fix: "send_reregistration_link", reason: "92% likely to be funded by the 7th." },
    ]);
    expect(result.accepted).toEqual([
      { fix: "stop_attempts", reason: FIX_CATALOGUE.stop_attempts.description, mode: "automatic" },
      { fix: "send_reregistration_link", reason: FIX_CATALOGUE.send_reregistration_link.description, mode: "needs_approval" },
    ]);
    expect(result.replacedReasons).toEqual([
      { fix: "stop_attempts", problems: ["banned word: salary", "banned word: balance"] },
      { fix: "send_reregistration_link", problems: ["internal word: funded", "internal word: percent"] },
    ]);
    expect(result.rejected).toEqual([]);
  });

  it("replaces a reason of two lines or over 200 characters, and keeps a plain one as written", () => {
    expect(checkReasonText("The mandate was cancelled.\nSend a link.")).toEqual(["more than one line"]);
    expect(checkReasonText("x".repeat(201))).toEqual(["reason too long"]);
    expect(checkReasonText("Customer's employers changed the score tier.")).toEqual([
      "banned word: employer",
      "internal word: score",
      "internal word: tier",
    ]);
    expect(checkReasonText("Downtime ends at 18:00.")).toEqual([]);
    expect(checkReasonText("The mandate was cancelled at the bank.")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

describe("M1 the customer message carries every fact", () => {
  it("builds the lending text", () => {
    const m = buildRetryMessage({
      segment: "lending",
      merchantName: "Northfield Finance",
      amountPaise: EMI_PAISE,
      dueDate: DUE,
      plannedDate: "2026-04-08",
    });
    expect(m.text).toBe(
      "Your EMI of Rs 12,000 to Northfield Finance didn't go through on 2 April. We'll try again on 8 April.",
    );
    expect(m.facts).toEqual({ amount: "Rs 12,000", dates: ["2 April", "8 April"], merchant: "Northfield Finance" });
    expect(findBannedWords(m.text)).toEqual([]);
  });

  it("builds the insurance text with the end of cover", () => {
    const m = buildRetryMessage({
      segment: "insurance",
      merchantName: "Harbour Life",
      amountPaise: 2_500_00,
      dueDate: DUE,
      plannedDate: "2026-04-12",
      graceEnd: "2026-05-02",
    });
    expect(m.text).toBe(
      "Your premium of Rs 2,500 to Harbour Life didn't go through on 2 April. We'll try again on 12 April. Your cover continues until 2 May.",
    );
  });

  it("refuses to build an insurance text without the end of cover", () => {
    expect(() =>
      buildRetryMessage({ segment: "insurance", merchantName: "Harbour Life", amountPaise: 1, dueDate: DUE, plannedDate: DUE }),
    ).toThrow();
  });
});

describe("M2 to M4 a rewrite must not change a fact", () => {
  const m = buildRetryMessage({
    segment: "lending",
    merchantName: "Northfield Finance",
    amountPaise: EMI_PAISE,
    dueDate: DUE,
    plannedDate: "2026-04-08",
  });

  it("M2 accepts a rewrite that keeps the amount, both dates and the name", () => {
    const rewrite =
      "Your Northfield Finance EMI of Rs 12,000 didn't go through on 2 April. No action is needed: we'll try again on 8 April.";
    expect(validatePolish(rewrite, m.facts)).toEqual({ ok: true, problems: [] });
  });

  it("M3 rejects a changed date, a changed amount or a missing name", () => {
    expect(validatePolish(m.text.replace("8 April", "9 April"), m.facts).problems).toEqual([
      "date missing: 8 apr",
      "unexpected date 9 apr",
    ]);
    expect(validatePolish(m.text.replace("12,000", "12,500"), m.facts).ok).toBe(false);
    expect(validatePolish(m.text.replace("Northfield Finance", "your lender"), m.facts).problems).toEqual([
      "merchant name missing",
    ]);
    expect(validatePolish("", m.facts).ok).toBe(false);
  });

  it("M4 rejects any hint about income", () => {
    const hint = m.text.replace("We'll try again on 8 April.", "We'll try again on 8 April, after your salary arrives.");
    expect(validatePolish(hint, m.facts).problems).toEqual(["banned word: salary"]);
    expect(findBannedWords("Once your Pay Day comes, your balance will cover it.")).toEqual(["pay day", "balance"]);
  });
});

describe("M5 formatting", () => {
  it("writes rupees with Indian digit grouping", () => {
    expect(formatRupees(12_000_00)).toBe("Rs 12,000");
    expect(formatRupees(1_25_000_00)).toBe("Rs 1,25,000");
    expect(formatRupees(1_00_00_000_00)).toBe("Rs 1,00,00,000");
    expect(formatRupees(48_50)).toBe("Rs 48.50");
  });

  it("fails loudly when a template value is missing", () => {
    expect(() => fillTemplate("payment_link", { kind: "EMI", amount: "Rs 12,000", merchant: "Northfield Finance" })).toThrow(
      /link/,
    );
  });
});

describe("M6 a message is composed when a debit locks or a link is sent", () => {
  const sim = (actions: SimAction[]): SimCase => ({
    merchantType: "lender",
    route: "schedules",
    resultDelayDays: 2,
    lastAllowedDay: 10,
    options: [],
    standingDefault: "Balanced",
    chosen: "Balanced",
    chosenBy: "default",
    state: "scheduled",
    actions,
    today: 5,
    failedAttempts: 0,
    paidDay: null,
    paidVia: null,
    stopReason: null,
    baselineRemaining: [],
    log: [],
  });
  const debit = (id: number, day: number, status: SimAction["status"]): SimAction => ({ id, kind: id === 1 ? "attempt" : "backup", day, status });
  const link = (status: SimAction["status"]): SimAction => ({ id: 1, kind: "link", day: 8, status });

  it("a debit that locks needs a retry notice for its date; a planned one needs nothing yet", () => {
    expect(messagesDue(sim([debit(1, 6, "planned"), debit(2, 9, "planned")]), sim([debit(1, 6, "locked"), debit(2, 9, "planned")]))).toEqual([
      { type: "retry", actionId: 1, day: 6 },
    ]);
    // A new case whose first debit locked the day it opened (an insurer's standing default).
    expect(messagesDue(null, sim([debit(1, 3, "locked"), debit(2, 9, "planned")]))).toEqual([{ type: "retry", actionId: 1, day: 3 }]);
    expect(messagesDue(null, sim([debit(1, 6, "planned")]))).toEqual([]);
  });

  it("a debit already announced needs nothing more, unless it is held to a new date", () => {
    expect(messagesDue(sim([debit(1, 6, "locked")]), sim([debit(1, 6, "in_flight")]))).toEqual([]);
    expect(messagesDue(sim([debit(1, 6, "in_flight")]), sim([debit(1, 6, "failed")]))).toEqual([]);
    expect(messagesDue(sim([debit(1, 6, "locked")]), sim([debit(1, 8, "locked")]))).toEqual([{ type: "retry", actionId: 1, day: 8 }]);
  });

  it("a cancelled or dropped debit needs no notice", () => {
    expect(messagesDue(sim([debit(1, 6, "planned")]), sim([debit(1, 6, "cancelled")]))).toEqual([]);
    expect(messagesDue(sim([debit(1, 6, "locked")]), sim([debit(1, 6, "dropped")]))).toEqual([]);
  });

  it("a link needs its text once it is sent, and only once", () => {
    expect(messagesDue(sim([link("planned")]), sim([link("locked")]))).toEqual([]);
    expect(messagesDue(sim([link("locked")]), sim([link("sent")]))).toEqual([{ type: "link", actionId: 1 }]);
    expect(messagesDue(sim([link("sent")]), sim([link("sent")]))).toEqual([]);
  });

  it("the link text keeps the amount and the name, and has no date to keep", () => {
    const m = buildLinkMessage({ kind: "EMI", merchantName: "Northfield Finance", amountPaise: EMI_PAISE, link: "[payment link]" });
    expect(m.text).toBe("You can pay your EMI of Rs 12,000 to Northfield Finance here: [payment link]");
    expect(m.facts).toEqual({ amount: "Rs 12,000", dates: [], merchant: "Northfield Finance" });
  });
});

describe("M7 a rewrite may not slip a fact or an income word past the checks (policy v1.1)", () => {
  const m = buildRetryMessage({
    segment: "lending",
    merchantName: "Northfield Finance",
    amountPaise: EMI_PAISE,
    dueDate: DUE,
    plannedDate: "2026-04-08",
  });
  const plus = (extra: string) => validatePolish(`${m.text} ${extra}`, m.facts).problems;

  it("catches plurals and variants of the banned words", () => {
    expect(findBannedWords("Their salaries and paydays vary; ask employers about pay-day.")).toEqual([
      "salary",
      "payday",
      "employer",
    ]);
    expect(findBannedWords("Incomes, balances, a paycheque and earnings.")).toEqual(["income", "balance", "paycheck", "earnings"]);
    expect(findBannedWords("A salaried customer.")).toEqual(["salary"]);
  });

  it("rejects a date written another way, a stray number or a day word", () => {
    expect(plus("If that fails, we'll retry on April 12.")).toEqual(["unexpected number 12", "unexpected date word april"]);
    expect(plus("Next try: 12/04/2026.")).toEqual(["unexpected number 12/04/2026"]);
    expect(plus("Or by the 7th.")).toEqual(["unexpected number 7"]);
    expect(plus("We'll call tomorrow.")).toEqual(["unexpected date word tomorrow"]);
  });

  it("rejects a percentage or a word for a score or the funded day", () => {
    expect(plus("You are 92% likely to be funded.")).toEqual([
      "unexpected number 92",
      "internal word: funded",
      "internal word: percent",
    ]);
    expect(plus("Your score is good.")).toEqual(["internal word: score"]);
  });

  it("still accepts the template itself and a plain rewrite, including the word may", () => {
    expect(validatePolish(m.text, m.facts)).toEqual({ ok: true, problems: [] });
    expect(plus("You may also pay earlier if you wish.")).toEqual([]);
    const insurance = buildRetryMessage({
      segment: "insurance",
      merchantName: "Harbour Life",
      amountPaise: 2_500_00,
      dueDate: DUE,
      plannedDate: "2026-04-12",
      graceEnd: "2026-05-02",
    });
    expect(validatePolish(insurance.text, insurance.facts)).toEqual({ ok: true, problems: [] });
  });
});
