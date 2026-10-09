// Golden cases F1 to F14: what happens to a case as the simulated clock moves.
// These run the same state machine the server functions wrap. See specs/09-testing.md.
// Never edit an expected value to make a test pass. Change the spec first.
//
// Lending set-up: EMI due on day 0 (2 April 2026), failure known on day 2, cap on day 10,
// 2 re-presentations, results take 2 days, standing default Balanced.
// Schedules: Earliest [5, 8], Balanced [6, 9], Safest [8].

import { describe, expect, it } from "vitest";
import {
  advanceDay,
  advanceTo,
  buildSchedules,
  merchantView,
  openCase,
  outcomeOf,
  pickSchedule,
  recordOutsidePayment,
  simulateBaseline,
  stopLayer,
  type SimCase,
  type SimWorld,
} from "@/lib/engine";
import { INSURANCE, LENDING } from "./fixtures";

const CURVE = { 5: 0.67, 6: 0.83, 8: 1 };
const lendingBuild = (overrides: Partial<typeof LENDING> = {}) =>
  buildSchedules({ ...LENDING, ...overrides, h: 5, u: 7, likelihoodByDay: CURVE });

const openLender = (overrides: Partial<typeof LENDING> = {}): SimCase =>
  openCase({
    merchantType: "lender",
    build: lendingBuild(overrides),
    standingDefault: "Balanced",
    resultDelayDays: 2,
    lastAllowedDay: overrides.lastAllowedDay ?? LENDING.lastAllowedDay,
  });

const funded = (day: number | null): SimWorld => ({ fundedOnDay: day });
const statuses = (c: SimCase) => c.actions.map((a) => `${a.kind}:${a.day}:${a.status}`);
const events = (c: SimCase) => c.log.map((l) => `${l.day}:${l.event}`);

describe("F1 nobody picks, so the standing default runs", () => {
  const world = funded(5);
  const opened = openLender();

  it("opens on the day the failure is known and waits for a choice", () => {
    expect(opened.today).toBe(2);
    expect(opened.state).toBe("awaiting_choice");
    expect(opened.actions).toEqual([]);
  });

  it("keeps waiting until the day before the default's first date", () => {
    expect(advanceTo(opened, 4, world).state).toBe("awaiting_choice");
    const day5 = advanceTo(opened, 5, world);
    expect(day5.state).toBe("scheduled");
    expect(day5.chosen).toBe("Balanced");
    expect(day5.chosenBy).toBe("default");
    expect(statuses(day5)).toEqual(["attempt:6:locked", "backup:9:planned"]);
  });

  it("presents the debit on day 6 and learns the result on day 8", () => {
    expect(advanceTo(opened, 6, world).state).toBe("result_pending");
    expect(advanceTo(opened, 7, world).state).toBe("result_pending");
    const day8 = advanceTo(opened, 8, world);
    expect(outcomeOf(day8)).toEqual({
      state: "paid",
      failedAttempts: 0,
      debitsPresented: 1,
      paidDay: 6,
      paidVia: "debit",
    });
    expect(statuses(day8)).toEqual(["attempt:6:succeeded", "backup:9:cancelled"]);
  });

  it("beats Razorpay's original retries on failed attempts", () => {
    const original = simulateBaseline([3, 6, 9], 2, 5);
    expect(original.failedAttempts).toBe(1); // day 3 bounces
    expect(original.paidDay).toBe(6);
  });
});

describe("F2 the lender picks Safest", () => {
  const picked = pickSchedule(advanceTo(openLender(), 3, funded(5)), "Safest");

  it("accepts the pick on day 3", () => {
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.case.chosen).toBe("Safest");
    expect(picked.case.chosenBy).toBe("merchant");
    expect(statuses(picked.case)).toEqual(["attempt:8:planned"]);
  });

  it("runs one attempt on day 8 and confirms it on day 10", () => {
    if (!picked.ok) throw new Error("pick failed");
    expect(advanceTo(picked.case, 9, funded(5)).state).toBe("result_pending");
    const done = advanceTo(picked.case, 10, funded(5));
    expect(outcomeOf(done)).toMatchObject({ state: "paid", paidDay: 8, failedAttempts: 0, debitsPresented: 1 });
  });
});

describe("F3 when a pick is allowed", () => {
  const world = funded(5);

  it("allows Earliest on day 3, the day before its first date locks", () => {
    const r = pickSchedule(advanceTo(openLender(), 3, world), "Earliest");
    expect(r.ok).toBe(true);
    if (r.ok) expect(statuses(r.case)).toEqual(["attempt:5:planned", "backup:8:planned"]);
  });

  it("refuses Earliest on day 4, because 7 April is already too close", () => {
    expect(pickSchedule(advanceTo(openLender(), 4, world), "Earliest")).toEqual({ ok: false, error: "locked" });
  });

  it("still allows a later schedule on day 4", () => {
    expect(pickSchedule(advanceTo(openLender(), 4, world), "Safest").ok).toBe(true);
  });

  it("lets the lender change an earlier pick while nothing is locked", () => {
    const first = pickSchedule(advanceTo(openLender(), 3, world), "Safest");
    if (!first.ok) throw new Error("pick failed");
    const second = pickSchedule(first.case, "Balanced");
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.case.chosen).toBe("Balanced");
  });

  it("refuses any pick once the default has locked", () => {
    expect(pickSchedule(advanceTo(openLender(), 5, world), "Safest")).toEqual({ ok: false, error: "locked" });
  });

  it("refuses a pick on a closed case", () => {
    expect(pickSchedule(advanceTo(openLender(), 8, world), "Safest")).toEqual({ ok: false, error: "case_closed" });
  });
});

describe("F4 the first attempt is a day early, and the backup rescues it", () => {
  const world = funded(7);
  const opened = openLender();

  it("fails on day 6, known on day 8", () => {
    const day8 = advanceTo(opened, 8, world);
    expect(day8.failedAttempts).toBe(1);
    expect(day8.state).toBe("scheduled");
    expect(statuses(day8)).toEqual(["attempt:6:failed", "backup:9:locked"]);
  });

  it("collects on the day 9 backup, confirmed on day 11", () => {
    expect(advanceTo(opened, 10, world).state).toBe("result_pending");
    const done = advanceTo(opened, 11, world);
    expect(outcomeOf(done)).toEqual({
      state: "paid",
      failedAttempts: 1,
      debitsPresented: 2,
      paidDay: 9,
      paidVia: "debit",
    });
  });

  it("never has two debits unresolved at once", () => {
    let c = opened;
    for (let d = 3; d <= 11; d++) {
      c = advanceDay(c, world);
      expect(c.actions.filter((a) => a.status === "in_flight").length).toBeLessThanOrEqual(1);
    }
  });
});

describe("F5 payday is past the lender's cap", () => {
  const build = buildSchedules({ ...LENDING, h: 20, u: 22, likelihoodByDay: { 20: 0.7 } });
  const opened = openCase({
    merchantType: "lender",
    build,
    standingDefault: "Balanced",
    resultDelayDays: 2,
    lastAllowedDay: 10,
  });
  const world = funded(20);

  it("plans a payment link for payday and no debit", () => {
    expect(build.route).toBe("out_of_reach");
    expect(statuses(opened)).toEqual(["link:20:planned"]);
    expect(pickSchedule(opened, "Balanced")).toEqual({ ok: false, error: "case_closed" });
  });

  it("sends the link on day 20 and is paid through it", () => {
    expect(advanceTo(opened, 19, world).state).toBe("scheduled");
    const done = advanceTo(opened, 20, world);
    expect(outcomeOf(done)).toEqual({
      state: "paid",
      failedAttempts: 0,
      debitsPresented: 0,
      paidDay: 20,
      paidVia: "link",
    });
  });

  it("waits with the link open when the money comes later", () => {
    const late = funded(23);
    expect(advanceTo(opened, 21, late).state).toBe("link_sent");
    expect(advanceTo(opened, 23, late)).toMatchObject({ state: "paid", paidDay: 23, paidVia: "link" });
  });

  it("saves the three bounces the original retries would have caused", () => {
    const original = simulateBaseline([3, 6, 9], 2, 20);
    expect(original.failedAttempts).toBe(3);
    expect(original.paidDay).toBeNull();
  });
});

describe("F6 and F7 the customer pays outside the plan", () => {
  const world = funded(5);

  it("F6 cancels the planned debit when payment arrives before it", () => {
    const r = recordOutsidePayment(advanceTo(openLender(), 5, world), "outside");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.case).toMatchObject({ state: "paid", paidDay: 5, paidVia: "outside" });
    expect(statuses(r.case)).toEqual(["attempt:6:cancelled", "backup:9:cancelled"]);
    // The clock moving on must not present anything.
    expect(outcomeOf(advanceTo(r.case, 10, world)).debitsPresented).toBe(0);
  });

  it("F7 refuses a payment while a debit is in flight, so the customer is never charged twice", () => {
    const inFlight = advanceTo(openLender(), 7, world);
    expect(recordOutsidePayment(inFlight, "link")).toEqual({ ok: false, error: "attempt_in_flight" });
  });

  it("refuses a second payment on a paid case", () => {
    const paid = advanceTo(openLender(), 8, world);
    expect(recordOutsidePayment(paid)).toEqual({ ok: false, error: "already_paid" });
  });
});

describe("F8 the layer steps back", () => {
  const stopped = stopLayer(advanceTo(openLender(), 4, funded(5)), "kill_switch", [3, 6, 9]);

  it("hands the remaining days back to Razorpay's original retries", () => {
    expect(stopped.state).toBe("normal_retries");
    expect(stopped.stopReason).toBe("kill_switch");
    expect(stopped.baselineRemaining).toEqual([6, 9]);
  });

  it("presents nothing afterwards and refuses a pick", () => {
    const later = advanceTo(stopped, 10, funded(5));
    expect(later.state).toBe("normal_retries");
    expect(outcomeOf(later).debitsPresented).toBe(0);
    expect(pickSchedule(stopped, "Safest")).toEqual({ ok: false, error: "case_closed" });
  });

  it("cancels a schedule that was already set", () => {
    const set = stopLayer(advanceTo(openLender(), 5, funded(5)), "forced_normal_retries", [3, 6, 9]);
    expect(statuses(set)).toEqual(["attempt:6:cancelled", "backup:9:cancelled"]);
    expect(set.baselineRemaining).toEqual([6, 9]);
  });
});

describe("F9 the mandate is cancelled after the schedule was set", () => {
  const world: SimWorld = { fundedOnDay: 5, controlFailure: (day) => (day >= 6 ? "mandate_not_active" : null) };
  const done = advanceTo(openLender(), 6, world);

  it("re-checks before the attempt and presents nothing", () => {
    expect(done.state).toBe("needs_action");
    expect(done.stopReason).toBe("mandate_not_active");
    expect(outcomeOf(done).debitsPresented).toBe(0);
    expect(statuses(done)).toEqual(["attempt:6:cancelled", "backup:9:cancelled"]);
  });

  it("falls back to normal retries for any other failed check", () => {
    const consent: SimWorld = { fundedOnDay: 5, controlFailure: () => "no_customer_consent" };
    expect(advanceTo(openLender(), 6, consent).state).toBe("normal_retries");
  });
});

describe("F10 a bank confirmation arrives late", () => {
  // The day 6 result takes 4 days instead of 2, so it is known on day 10.
  const late: SimWorld = { fundedOnDay: 7, resultDelayOverride: { 1: 4 } };

  it("drops the backup when holding it would pass the cap", () => {
    const day9 = advanceTo(openLender(), 9, late);
    expect(statuses(day9)).toEqual(["attempt:6:in_flight", "backup:9:dropped"]);
    expect(events(day9)).toContain("9:debit_dropped");
    const done = advanceTo(openLender(), 10, late);
    expect(outcomeOf(done)).toMatchObject({ state: "failed", failedAttempts: 1, debitsPresented: 1 });
  });

  it("holds the backup until the result is known when the cap allows", () => {
    const roomy = openLender({ lastAllowedDay: 12 });
    const day9 = advanceTo(roomy, 9, late);
    expect(statuses(day9)).toEqual(["attempt:6:in_flight", "backup:11:locked"]);
    expect(events(day9)).toContain("9:debit_held");
    const done = advanceTo(roomy, 13, late);
    expect(outcomeOf(done)).toMatchObject({ state: "paid", paidDay: 11, failedAttempts: 1, debitsPresented: 2 });
  });
});

describe("F11 an insurer on UPI Autopay", () => {
  // Premium due on day 0, instant results, cover lapses after day 12, three attempts allowed.
  const build = buildSchedules({ ...INSURANCE, h: 9, u: 10, likelihoodByDay: { 9: 0.7, 10: 0.85, 11: 0.95 } });
  const opened = openCase({
    merchantType: "insurer",
    build,
    standingDefault: "Balanced",
    resultDelayDays: 0,
    lastAllowedDay: 12,
  });
  const world = funded(9);

  it("applies the standing default at once, with an early probe", () => {
    expect(opened.today).toBe(0);
    expect(opened.chosenBy).toBe("default");
    expect(statuses(opened)).toEqual(["probe:1:locked", "attempt:10:planned", "backup:11:planned"]);
  });

  it("cannot pick a schedule", () => {
    expect(pickSchedule(opened, "Safest")).toEqual({ ok: false, error: "not_a_lender" });
  });

  it("shows the insurer a date only once it has locked", () => {
    expect(merchantView(opened)).toMatchObject({ nextActionDay: 1, nextActionKind: "probe", options: null, chosen: null });
    const day5 = advanceTo(opened, 5, world);
    expect(day5.failedAttempts).toBe(1); // the probe on day 1 failed at once
    expect(merchantView(day5).nextActionDay).toBeNull();
    expect(merchantView(advanceTo(opened, 9, world)).nextActionDay).toBe(10);
  });

  it("collects on day 10 with an instant result", () => {
    const done = advanceTo(opened, 10, world);
    expect(outcomeOf(done)).toEqual({
      state: "paid",
      failedAttempts: 1,
      debitsPresented: 2,
      paidDay: 10,
      paidVia: "debit",
    });
    expect(statuses(done)).toEqual(["probe:1:failed", "attempt:10:succeeded", "backup:11:cancelled"]);
  });

  it("rescues a one-off failure with the probe on day 1", () => {
    const done = advanceTo(opened, 1, funded(0));
    expect(outcomeOf(done)).toMatchObject({ state: "paid", paidDay: 1, failedAttempts: 0, debitsPresented: 1 });
  });
});

describe("F12 what each merchant type may see", () => {
  it("shows a lender its options and the next date straight away", () => {
    const picked = pickSchedule(advanceTo(openLender(), 3, funded(5)), "Safest");
    if (!picked.ok) throw new Error("pick failed");
    const view = merchantView(picked.case);
    expect(view.nextActionDay).toBe(8);
    expect(view.chosen).toBe("Safest");
    expect(view.options?.map((o) => o.label)).toEqual(["Earliest", "Balanced", "Safest"]);
  });

  it("never carries a score, a likelihood number or the predicted funded day", () => {
    const view = merchantView(advanceTo(openLender(), 7, funded(5)));
    const text = JSON.stringify(view);
    for (const hidden of ["likelihood", "confidence", "fundedDate", "\"h\"", "\"u\"", "0.67", "0.83"]) {
      expect(text).not.toContain(hidden);
    }
    expect(view.resultDueDay).toBe(8);
    expect(view.attemptsUsed).toBe(1);
  });
});

describe("F13 the prediction is wrong", () => {
  const done = advanceTo(openLender(), 11, funded(25));

  it("uses both attempts, stops, and never exceeds the lender's limits", () => {
    expect(outcomeOf(done)).toEqual({
      state: "failed",
      failedAttempts: 2,
      debitsPresented: 2,
      paidDay: null,
      paidVia: null,
    });
    expect(Math.max(...done.actions.map((a) => a.day))).toBeLessThanOrEqual(10);
  });

  it("is no worse than the original retries, which fail three times", () => {
    expect(simulateBaseline([3, 6, 9], 2, 25).failedAttempts).toBe(3);
  });
});

describe("F14 Razorpay's original retries, played against the same truth", () => {
  it("stops at the first success", () => {
    expect(simulateBaseline([3, 6, 9], 2, 5)).toEqual({
      attempts: [
        { day: 3, success: false, resultDay: 5 },
        { day: 6, success: true, resultDay: 8 },
      ],
      failedAttempts: 1,
      paidDay: 6,
      confirmedDay: 8,
    });
  });

  it("succeeds first time when the money was already there", () => {
    expect(simulateBaseline([3, 6, 9], 2, 1)).toMatchObject({ failedAttempts: 0, paidDay: 3 });
  });

  it("fails every time when the money never comes", () => {
    expect(simulateBaseline([1, 2, 3], 0, null)).toMatchObject({ failedAttempts: 3, paidDay: null, confirmedDay: null });
  });
});
