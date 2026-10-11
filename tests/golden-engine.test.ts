// Golden cases E1 to E18: the pure rules. See specs/09-testing.md.
// Never edit an expected value to make a test pass. Change the spec first.

import { describe, expect, it } from "vitest";
import {
  acceptAgentTriage,
  bandFor,
  bestAnchor,
  buildCards,
  buildSchedules,
  circularMad,
  circularMedian,
  estimateFunding,
  evaluateGate,
  nextOccurrence,
  recognizeSalary,
  resolveOption,
  runControlChecks,
  summarizeEvidence,
  triageByRules,
  type Credit,
} from "@/lib/engine";
import {
  AROUND_THE_7TH,
  CONTROLS_OK,
  DUE,
  EMI_PAISE,
  INSURANCE,
  LENDER_COST,
  LENDING,
  MONTHS_5,
  PREMIUM_PAISE,
  day,
  observations,
} from "./fixtures";

const days = (o: { attempts: { day: number }[] }) => o.attempts.map((a) => a.day);

describe("E1 schedules for a payday inside the cap", () => {
  const build = buildSchedules({ ...LENDING, h: 5, u: 7, likelihoodByDay: { 5: 0.55, 6: 0.75, 8: 0.9 } });

  it("knows the due-date failure on day 2 and never starts before day 3", () => {
    expect(build.failureKnownDay).toBe(2);
    expect(build.minDay).toBe(3);
  });

  it("builds Earliest, Balanced and Safest", () => {
    expect(build.route).toBe("schedules");
    expect(build.options.map((o) => o.label)).toEqual(["Earliest", "Balanced", "Safest"]);
    expect(days(build.options[0])).toEqual([5, 8]); // 7 and 10 April
    expect(days(build.options[1])).toEqual([6, 9]); // 8 and 11 April
    expect(days(build.options[2])).toEqual([8]); // 10 April; a backup on day 11 is past the cap
    expect(day(6)).toBe("2026-04-08");
  });

  it("spaces the backup so the first result is known before it runs", () => {
    for (const o of build.options) {
      if (o.attempts.length > 1) expect(o.attempts[1].day - o.attempts[0].day).toBe(3);
    }
  });

  it("gives lending no day-1 probe", () => {
    expect(build.options.flatMap((o) => o.attempts).some((a) => a.kind === "probe")).toBe(false);
  });
});

describe("E2 likelihood bands", () => {
  it("reads the band at the main attempt day", () => {
    const build = buildSchedules({ ...LENDING, h: 5, u: 7, likelihoodByDay: { 5: 0.55, 6: 0.75, 8: 0.9 } });
    expect(build.options.map((o) => o.band)).toEqual(["Lower", "Medium", "High"]);
  });
  it("uses 80% and 60% as the band edges", () => {
    expect(bandFor(0.8)).toBe("High");
    expect(bandFor(0.79)).toBe("Medium");
    expect(bandFor(0.6)).toBe("Medium");
    expect(bandFor(0.59)).toBe("Lower");
  });
});

describe("E3 payday close to the cap", () => {
  const build = buildSchedules({ ...LENDING, h: 9, u: 11, likelihoodByDay: [] });
  it("clamps to the cap and merges identical schedules", () => {
    expect(build.options).toHaveLength(2);
    expect(days(build.options[0])).toEqual([9]); // 11 April
    expect(days(build.options[1])).toEqual([10]); // 12 April
    expect(build.options[1].labels).toEqual(["Balanced", "Safest"]);
  });
  it("still resolves a merged label", () => {
    expect(resolveOption(build.options, "Safest")?.label).toBe("Balanced");
  });
});

describe("E4 payday out of reach", () => {
  it("builds no schedule and times a link to payday for a loan", () => {
    const build = buildSchedules({ ...LENDING, h: 20, u: 22, likelihoodByDay: [] });
    expect(build.route).toBe("out_of_reach");
    expect(build.options).toEqual([]);
    expect(build.linkDay).toBe(20);
    expect(day(20)).toBe("2026-04-22");
  });
  it("sends a premium link at once, because waiting risks a lapse", () => {
    const build = buildSchedules({ ...INSURANCE, h: 20, u: 22, likelihoodByDay: [] });
    expect(build.route).toBe("out_of_reach");
    expect(build.linkDay).toBe(1);
  });
});

describe("E5 payday before the failure is even known", () => {
  it("collapses to one schedule on the first possible day", () => {
    const build = buildSchedules({ ...LENDING, h: 1, u: 2, likelihoodByDay: [] });
    expect(build.options).toHaveLength(1);
    expect(days(build.options[0])).toEqual([3, 6]); // 5 and 8 April
    expect(build.options[0].labels).toEqual(["Earliest", "Balanced", "Safest"]);
  });
});

describe("E6 card arithmetic", () => {
  const build = buildSchedules({ ...LENDING, h: 5, u: 7, likelihoodByDay: { 5: 0.55, 6: 0.75, 8: 0.9 } });
  const { cards, baseline } = buildCards(build.options, LENDER_COST);

  it("shows days overdue and charges for waiting", () => {
    expect(cards.map((c) => c.daysOverdue)).toEqual([5, 6, 8]);
    expect(cards.map((c) => c.waitingChargePaise)).toEqual([40_00, 48_00, 64_00]);
  });
  it("compares each card with Razorpay's original first retry on day 3", () => {
    expect(cards.map((c) => c.versusOriginal)).toEqual([
      { daysLater: 2, extraChargePaise: 16_00 },
      { daysLater: 3, extraChargePaise: 24_00 },
      { daysLater: 5, extraChargePaise: 40_00 },
    ]);
  });
  it("shows the original retries as a comparison row", () => {
    expect(baseline.days).toEqual([3, 6, 9]);
    expect(baseline.waitingChargePaise).toEqual([24_00, 48_00, 72_00]);
    expect(baseline.bounceChargePaise).toBe(500_00);
  });
  it("never puts a likelihood number, h, u or confidence on a card", () => {
    const keys = new Set(cards.flatMap((c) => Object.keys(c)));
    for (const forbidden of ["likelihood", "confidence", "h", "u", "score", "tier"]) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(JSON.stringify(cards)).not.toMatch(/0\.\d+/);
  });
  it("hides the charge lines when the lender has not entered a rate", () => {
    const plain = buildCards(build.options, { ...LENDER_COST, penalChargePerDayPaise: null });
    expect(plain.cards[0].waitingChargePaise).toBeNull();
    expect(plain.cards[0].versusOriginal).toEqual({ daysLater: 2, extraChargePaise: null });
  });
});

describe("E7 gate and confidence floors", () => {
  it("puts a customer with 8 payments in 2 months in Tier C", () => {
    const thin = observations(["2026-02", "2026-03"], [5, 6, 7, 8]);
    const evidence = summarizeEvidence(thin, DUE, EMI_PAISE);
    const gate = evaluateGate({ ...evidence, hasFailureEvidence: true, identityLinked: true });
    expect(evidence.timingObservations).toBe(8);
    expect(gate.tier).toBe("C");
    expect(gate.failed).toEqual(["too_few_observations", "too_few_months"]);
  });

  // 25 payments: 18 on the 7th and 7 on the 12th, so 72% fall within 2 days of the 7th.
  const seventyTwo = [
    ...observations(MONTHS_5.slice(0, 3), [7, 7, 7, 7, 12], 10_000_00),
    ...observations(MONTHS_5.slice(3), [7, 7, 7, 12, 12], 10_000_00),
  ];

  it("fails open on a loan at 72% confidence", () => {
    const e = estimateFunding({ dueDate: DUE, segment: "lending", debitAmountPaise: EMI_PAISE, observations: seventyTwo });
    expect(e.confidence).toBe(72);
    expect(e.ok).toBe(false);
    expect(e.failReason).toBe("low_confidence");
  });
  it("acts on a premium at 72% confidence", () => {
    const e = estimateFunding({
      dueDate: DUE,
      segment: "insurance",
      debitAmountPaise: PREMIUM_PAISE,
      observations: seventyTwo,
    });
    expect(e.confidence).toBe(72);
    expect(e.ok).toBe(true);
  });
});

describe("E8 affordability lowers confidence instead of blocking", () => {
  // 50 payments, 43 on the 7th: 86% before deductions. Only two are at least half the EMI.
  let index = 0;
  const amount = () => (index++ < 2 ? 7_000_00 : 500_00);
  const eightySix = [
    ...observations(MONTHS_5.slice(0, 3), [7, 7, 7, 7, 7, 7, 7, 7, 7, 12], amount),
    ...observations(MONTHS_5.slice(3), [7, 7, 7, 7, 7, 7, 7, 7, 12, 12], amount),
  ];
  it("takes 10 points off, which drops a loan below its floor", () => {
    const e = estimateFunding({ dueDate: DUE, segment: "lending", debitAmountPaise: EMI_PAISE, observations: eightySix });
    expect(e.confidenceBeforeDeductions).toBe(86);
    expect(e.deductions.affordability).toBe(10);
    expect(e.confidence).toBe(76);
    expect(e.ok).toBe(false);
  });
});

describe("E9 insurance without a salary signal", () => {
  it("adds a day-1 probe, then the main attempt and a backup", () => {
    const build = buildSchedules({ ...INSURANCE, h: 9, u: 10, likelihoodByDay: [] });
    const balanced = resolveOption(build.options, "Balanced")!;
    expect(balanced.attempts).toEqual([
      { day: 1, kind: "probe" }, // 3 April
      { day: 10, kind: "attempt" }, // 12 April
      { day: 11, kind: "backup" }, // 13 April
    ]);
    expect(balanced.mainDay).toBe(10);
    expect(balanced.firstActionDay).toBe(1);
  });
});

describe("E10 insurance with a recognized salary", () => {
  it("drops the probe and adds a second backup", () => {
    const build = buildSchedules({ ...INSURANCE, salaryRecognized: true, h: 9, u: 10, likelihoodByDay: [] });
    const balanced = resolveOption(build.options, "Balanced")!;
    expect(days(balanced)).toEqual([10, 11, 12]); // 12, 13 and 14 April
    expect(balanced.attempts.some((a) => a.kind === "probe")).toBe(false);
  });
});

describe("E11 circular median", () => {
  it("treats day 31 and day 1 as neighbours", () => {
    const values = [29, 30, 31, 1, 2];
    expect(circularMedian(values)).toBe(31);
    expect(circularMad(values, 31)).toBe(1);
  });
});

describe("E12 month-end anchor", () => {
  // Salary on the last working day: 30 January, 27 February and 31 March 2026.
  const dates = ["2026-01-30", "2026-02-27", "2026-03-31"];
  it("fits tighter from the month's end than from its start", () => {
    const fit = bestAnchor(dates);
    expect(fit.anchor).toEqual({ kind: "end", value: 1 });
    expect(fit.mad).toBe(0);
  });
  it("is not fooled by February when the salary sits near the 8th", () => {
    // Counted from the month's end, five of these six dates are 23 days out and only February differs,
    // so the MAD alone would pick the wrong anchor. Total distance picks the 8th.
    const fit = bestAnchor(["2025-10-08", "2025-11-07", "2025-12-08", "2026-01-09", "2026-02-09", "2026-03-08"]);
    expect(fit.anchor).toEqual({ kind: "start", value: 8 });
  });
  it("finds the next occurrence, and falls back to the last day in a short month", () => {
    expect(nextOccurrence("end", 1, DUE)).toBe("2026-04-29");
    expect(nextOccurrence("start", 31, DUE)).toBe("2026-04-30");
    expect(nextOccurrence("start", 1, DUE)).toBe("2026-05-01");
    expect(nextOccurrence("start", 2, DUE)).toBe(DUE);
  });
});

describe("E13 triage by rule and by lookup", () => {
  it("labels a clear reason by rule", () => {
    const t = triageByRules({ errorReason: "insufficient_funds", mandateStatus: "active", downtimeActive: false });
    expect(t).toMatchObject({ label: "balance", decidedBy: "rule", needsAgent: false });
  });
  it("labels a catch-all reason by the mandate lookup", () => {
    const t = triageByRules({ errorReason: "payment_failed", mandateStatus: "cancelled", downtimeActive: false });
    expect(t).toMatchObject({ label: "mandate_cancelled", decidedBy: "lookup", needsAgent: false });
  });
  it("labels a catch-all reason by the downtime lookup", () => {
    const t = triageByRules({ errorReason: "payment_failed", mandateStatus: "active", downtimeActive: true });
    expect(t).toMatchObject({ label: "bank_downtime", decidedBy: "lookup", needsAgent: false });
  });
  it("asks the agent only when rules and lookups cannot decide", () => {
    const t = triageByRules({ errorReason: "payment_failed", mandateStatus: "active", downtimeActive: false });
    expect(t).toMatchObject({ label: "unknown", needsAgent: true });
    const unlisted = triageByRules({ errorReason: "something_new", mandateStatus: "active", downtimeActive: false });
    expect(unlisted.needsAgent).toBe(true);
  });
});

describe("E14 accepting the Triage agent's answer", () => {
  const clean = { mandateStatus: "active" as const, downtimeActive: false };
  it("accepts a strong answer inside the label list", () => {
    const d = acceptAgentTriage({ label: "balance", strength: "strong", evidence: ["Bank text says funds not available"] }, clean);
    expect(d).toMatchObject({ label: "balance", accepted: true });
  });
  it("turns a weak answer into unknown", () => {
    const d = acceptAgentTriage({ label: "balance", strength: "weak", evidence: ["unclear"] }, clean);
    expect(d).toMatchObject({ label: "unknown", accepted: false, rejection: "weak" });
  });
  it("rejects a label outside the list, a missing reason and a malformed answer", () => {
    expect(acceptAgentTriage({ label: "fraud", strength: "strong", evidence: ["x"] }, clean).rejection).toBe("label_not_allowed");
    expect(acceptAgentTriage({ label: "balance", strength: "strong", evidence: [] }, clean).rejection).toBe("no_evidence");
    expect(acceptAgentTriage("balance", clean).rejection).toBe("malformed");
    expect(acceptAgentTriage(null, clean).rejection).toBe("malformed");
  });
  it("rejects a balance label that contradicts the lookups", () => {
    const d = acceptAgentTriage(
      { label: "balance", strength: "strong", evidence: ["looks like low funds"] },
      { mandateStatus: "active", downtimeActive: true },
    );
    expect(d).toMatchObject({ label: "unknown", accepted: false, rejection: "contradicts_lookup" });
  });

  // Policy v1.3: code confirms a closed-account label, and the agent cannot overrule the lookups.
  const closedAnswer = { label: "instrument_closed", strength: "strong", evidence: ["Bank text reads ACCOUNT CLOSED"] };
  it("refuses a closed-account label resting on bank text alone, on a lack-of-funds history", () => {
    const d = acceptAgentTriage(closedAnswer, { ...clean, pastFailureCodes: ["insufficient_funds", "insufficient_funds", "payment_failed"] });
    expect(d).toMatchObject({ label: "unknown", accepted: false, rejection: "closed_not_in_history" });
    expect(acceptAgentTriage(closedAnswer, clean).rejection).toBe("closed_not_in_history");
  });
  it("accepts a closed-account label when a past failure carries a closed-account code", () => {
    expect(acceptAgentTriage(closedAnswer, { ...clean, pastFailureCodes: ["insufficient_funds", "account_closed"] })).toMatchObject({
      label: "instrument_closed",
      accepted: true,
    });
    expect(acceptAgentTriage(closedAnswer, { ...clean, pastFailureCodes: ["instrument_closed"] }).accepted).toBe(true);
  });
  it("refuses mandate and downtime labels the lookups already ruled out", () => {
    for (const label of ["mandate_cancelled", "mandate_paused", "bank_downtime"]) {
      const d = acceptAgentTriage({ label, strength: "strong", evidence: ["bank text says so"] }, clean);
      expect(d).toMatchObject({ label: "unknown", accepted: false, rejection: "contradicts_lookup" });
    }
  });
});

describe("E15 control and consent checks", () => {
  const base = {
    ...CONTROLS_OK,
    mandateStatus: "active" as const,
    rail: "bank_mandate" as const,
    segment: "lending" as const,
    amountPaise: EMI_PAISE,
  };
  it("passes when everything is in place", () => {
    expect(runControlChecks(base)).toEqual({ ok: true });
  });
  it("stops at the first failure, in a fixed order", () => {
    expect(runControlChecks({ ...base, killSwitch: true, customerConsent: false }).failed).toBe("kill_switch");
    expect(runControlChecks({ ...base, customerConsent: false, inHoldout: true }).failed).toBe("no_customer_consent");
    expect(runControlChecks({ ...base, inHoldout: true }).failed).toBe("holdout");
    expect(runControlChecks({ ...base, mandateStatus: "cancelled" }).failed).toBe("mandate_not_active");
    expect(runControlChecks({ ...base, forcedNormalRetries: true }).failed).toBe("forced_normal_retries");
    expect(runControlChecks({ ...base, paidOutside: true }).failed).toBe("paid_outside");
  });
  it("applies the authentication limit by rail and segment", () => {
    const big = 18_000_00;
    expect(runControlChecks({ ...base, rail: "upi_autopay", amountPaise: big }).failed).toBe("amount_above_afa_limit");
    expect(runControlChecks({ ...base, rail: "upi_autopay", segment: "insurance", amountPaise: big }).ok).toBe(true);
    expect(runControlChecks({ ...base, rail: "bank_mandate", amountPaise: 40_000_00 }).ok).toBe(true);
  });
});

describe("E16 drift after a job change", () => {
  // Eight months of payments around the 25th, then three months around the 5th.
  const old = observations(
    ["2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12"],
    [24, 25, 26],
    10_000_00,
  );
  const recent = observations(["2026-01", "2026-02", "2026-03"], [4, 5, 6], 10_000_00);
  const e = estimateFunding({ dueDate: DUE, segment: "lending", debitAmountPaise: EMI_PAISE, observations: [...old, ...recent] });

  it("uses the recent pattern and takes 10 points off", () => {
    expect(e.driftApplied).toBe(true);
    expect(e.anchor).toEqual({ kind: "start", value: 5 });
    expect(e.deductions.drift).toBe(10);
    expect(e.confidence).toBe(90);
    expect(e.observationsUsed).toBe(9);
  });
  it("counts days to the new funded day", () => {
    expect(e.fundedDate).toBe("2026-04-05");
    expect(e.h).toBe(3);
  });
});

describe("E17 estimate from payment history", () => {
  const e = estimateFunding({ dueDate: DUE, segment: "lending", debitAmountPaise: EMI_PAISE, observations: AROUND_THE_7TH });
  it("finds the funded day and its spread", () => {
    expect(e.source).toBe("history");
    expect(e.anchor).toEqual({ kind: "start", value: 7 });
    expect(e.confidence).toBe(100);
    expect(e.ok).toBe(true);
  });
  it("converts the day of the month to days after the due date", () => {
    expect(e.fundedDate).toBe("2026-04-07");
    expect(e.h).toBe(5);
    expect(e.u).toBe(7);
  });
  it("builds the likelihood curve from each observation's next occurrence", () => {
    expect(e.likelihoodByDay).toHaveLength(31);
    expect(e.likelihoodByDay[4]).toBeCloseTo(5 / 30);
    expect(e.likelihoodByDay[5]).toBeCloseTo(20 / 30);
    expect(e.likelihoodByDay[6]).toBeCloseTo(25 / 30);
    expect(e.likelihoodByDay[7]).toBe(1);
  });
  it("uses only data dated before the as-of day", () => {
    const leaked = [...AROUND_THE_7TH, ...observations(["2026-04"], [20, 20, 20, 20, 20, 20, 20, 20])];
    const again = estimateFunding({ dueDate: DUE, segment: "lending", debitAmountPaise: EMI_PAISE, observations: leaked });
    expect(again.anchor).toEqual(e.anchor);
    expect(again.observationsUsed).toBe(30);
  });
  it("counts the merchant's own collections twice", () => {
    const own = observations(MONTHS_5, [10], EMI_PAISE, true);
    const withOwn = estimateFunding({
      dueDate: DUE,
      segment: "lending",
      debitAmountPaise: EMI_PAISE,
      observations: [...AROUND_THE_7TH, ...own],
    });
    expect(withOwn.observationsUsed).toBe(40);
  });
  it("lets a model score replace the rule's days", () => {
    const scored = estimateFunding({
      dueDate: DUE,
      segment: "lending",
      debitAmountPaise: EMI_PAISE,
      observations: AROUND_THE_7TH,
      modelScore: { h: 6, u: 8, likelihoodByDay: new Array(31).fill(0.9), modelVersion: "m1" },
    });
    expect(scored.source).toBe("model");
    expect(scored.h).toBe(6);
    expect(scored.fundedDate).toBe("2026-04-08");
    expect(scored.modelVersion).toBe("m1");
  });
});

describe("E18 salary recognition", () => {
  const salary = (dates: string[], amounts: number[], source = "payroll:acme"): Credit[] =>
    dates.map((date, i) => ({ date, amountPaise: amounts[i], source }));

  it("recognizes three consecutive months from one source", () => {
    const s = recognizeSalary(salary(["2026-01-07", "2026-02-06", "2026-03-07"], [60_000_00, 61_000_00, 60_000_00]), DUE);
    expect(s?.source).toBe("payroll:acme");
    expect(s?.fit.anchor).toEqual({ kind: "start", value: 7 });
    expect(s?.months).toBe(3);
  });
  it("refuses two months, uneven amounts, scattered dates and a stale salary", () => {
    expect(recognizeSalary(salary(["2026-02-07", "2026-03-07"], [60_000_00, 60_000_00]), DUE)).toBeNull();
    expect(
      recognizeSalary(salary(["2026-01-07", "2026-02-07", "2026-03-07"], [60_000_00, 80_000_00, 42_000_00]), DUE),
    ).toBeNull();
    expect(
      recognizeSalary(salary(["2026-01-03", "2026-02-12", "2026-03-21"], [60_000_00, 60_000_00, 60_000_00]), DUE),
    ).toBeNull();
    expect(
      recognizeSalary(salary(["2025-10-07", "2025-11-07", "2025-12-07"], [60_000_00, 60_000_00, 60_000_00]), DUE),
    ).toBeNull();
  });
  it("puts the salary day ahead of payment history in the estimate", () => {
    const e = estimateFunding({
      dueDate: DUE,
      segment: "lending",
      debitAmountPaise: EMI_PAISE,
      observations: observations(MONTHS_5, [20, 21, 22, 20, 21, 22], 10_000_00),
      credits: salary(["2026-01-07", "2026-02-06", "2026-03-07"], [60_000_00, 61_000_00, 60_000_00]),
    });
    expect(e.source).toBe("salary");
    expect(e.salaryRecognized).toBe(true);
    expect(e.h).toBe(5);
  });
  it("handles a last-working-day salary through the month-end anchor", () => {
    const e = estimateFunding({
      dueDate: DUE,
      segment: "lending",
      debitAmountPaise: EMI_PAISE,
      observations: observations(MONTHS_5, [1, 2, 3, 1, 2, 3], 10_000_00),
      credits: salary(["2026-01-30", "2026-02-27", "2026-03-31"], [60_000_00, 60_000_00, 60_000_00]),
    });
    expect(e.anchor).toEqual({ kind: "end", value: 1 });
    expect(e.fundedDate).toBe("2026-04-29");
    expect(e.h).toBe(27);
  });
});
