// The preview's demo cases, run end to end through the engine and the clock.
// These keep the home page honest: if a rule changes, the story each case tells is checked here.

import { describe, expect, it } from "vitest";
import { advanceTo, outcomeOf, pickSchedule, simulateBaseline, type SimCase } from "@/lib/engine";
import { DEMO_START_DAY } from "@/lib/demo/cases";
import { prepareDemoCases, type PreparedCase } from "@/lib/demo/prepare";

const cases = prepareDemoCases();
const byId = (id: string): PreparedCase => {
  const c = cases.find((x) => x.id === id);
  if (!c) throw new Error(`no demo case ${id}`);
  return c;
};
const sim = (c: PreparedCase): SimCase => {
  if (!c.sim) throw new Error(`${c.id} has no plan`);
  return c.sim;
};
const play = (c: PreparedCase, to = 26) => outcomeOf(advanceTo(sim(c), to, c.world));
const original = (c: PreparedCase) =>
  simulateBaseline(c.merchant.baselineRetryDays, c.merchant.resultDelayDays, c.world.fundedOnDay);

describe("demo cases: what each one is routed to", () => {
  it("covers every route", () => {
    expect(cases.map((c) => [c.id, c.merchant.route])).toEqual([
      ["L-1041", "schedules"],
      ["L-1042", "schedules"],
      ["L-1043", "schedules"],
      ["L-1044", "out_of_reach"],
      ["L-1045", "original_retries"],
      ["L-1046", "exceptions_desk"],
      ["L-1047", "original_retries"],
      ["I-2011", "schedules"],
      ["I-2012", "schedules"],
    ]);
  });

  it("opens on 4 April, the day lenders learn of the failure", () => {
    for (const c of cases) if (c.sim) expect(c.sim.today).toBe(DEMO_START_DAY);
    expect(sim(byId("L-1041")).state).toBe("awaiting_choice");
  });

  it("builds the expected cards", () => {
    const cards = (id: string) => byId(id).merchant.cards.map((k) => [k.labels.join("+"), k.attemptDays, k.band]);
    expect(cards("L-1041")).toEqual([
      ["Earliest", [5, 8], "Medium"],
      ["Balanced", [6, 9], "High"],
      ["Safest", [8], "High"],
    ]);
    expect(cards("L-1042")).toEqual([
      ["Earliest", [6, 9], "Medium"],
      ["Balanced", [7, 10], "High"],
      ["Safest", [8], "High"],
    ]);
    expect(cards("L-1043")).toEqual([
      ["Earliest", [9], "Medium"],
      ["Balanced+Safest", [10], "High"],
    ]);
  });

  it("recognizes a monthly credit where there is one", () => {
    expect(byId("L-1042").ops.estimate?.source).toBe("salary");
    expect(byId("I-2012").ops.estimate?.source).toBe("salary");
    expect(byId("L-1041").ops.estimate?.source).toBe("history");
  });
});

describe("demo cases: how each one ends", () => {
  it("L-1041 collects first time on the default, where the original retries bounce once", () => {
    expect(play(byId("L-1041"))).toMatchObject({ state: "paid", paidDay: 6, failedAttempts: 0 });
    expect(original(byId("L-1041"))).toMatchObject({ paidDay: 6, failedAttempts: 1 });
  });

  it("L-1042 collects on the default, and Earliest needs its backup", () => {
    const c = byId("L-1042");
    expect(play(c)).toMatchObject({ state: "paid", paidDay: 7, failedAttempts: 0 });
    const picked = pickSchedule(sim(c), "Earliest");
    if (!picked.ok) throw new Error("pick failed");
    expect(outcomeOf(advanceTo(picked.case, 26, c.world))).toMatchObject({ state: "paid", paidDay: 9, failedAttempts: 1 });
    expect(original(c)).toMatchObject({ paidDay: 9, failedAttempts: 2 });
  });

  it("L-1043 collects on its single near-cap attempt", () => {
    expect(play(byId("L-1043"))).toMatchObject({ state: "paid", paidDay: 10, failedAttempts: 0 });
    expect(original(byId("L-1043"))).toMatchObject({ paidDay: 9, failedAttempts: 2 });
  });

  it("L-1044 is paid by link with no debit, where the original retries bounce three times", () => {
    expect(play(byId("L-1044"))).toMatchObject({ state: "paid", paidVia: "link", paidDay: 20, debitsPresented: 0 });
    expect(original(byId("L-1044"))).toMatchObject({ paidDay: null, failedAttempts: 3 });
  });

  it("I-2011 uses one early attempt, then collects inside the grace period", () => {
    expect(play(byId("I-2011"))).toMatchObject({ state: "paid", paidDay: 10, failedAttempts: 1 });
    expect(original(byId("I-2011"))).toMatchObject({ paidDay: null, failedAttempts: 3 });
  });

  it("I-2012 collects with no failed attempt", () => {
    expect(play(byId("I-2012"))).toMatchObject({ state: "paid", paidDay: 10, failedAttempts: 0 });
  });
});

describe("demo cases: the privacy split", () => {
  it("keeps every internal number out of the merchant part", () => {
    for (const c of cases) {
      const text = JSON.stringify({ merchant: c.merchant, options: c.sim?.options ?? [] });
      for (const hidden of ["confidence", "likelihood", "fundedDate", "tier", "salary", "payroll", "observations"]) {
        expect(text, `${c.id} leaks ${hidden}`).not.toContain(hidden);
      }
    }
  });

  it("gives the insurer no schedule cards to read", () => {
    // Cards are built for every schedules case; the insurer screen never renders them,
    // and in the full build the database refuses the read (specs/08-security.md).
    expect(byId("I-2011").merchant.merchantType).toBe("insurer");
    expect(byId("I-2011").merchant.desk).toBeNull();
  });

  it("proposes only catalogue fixes on the desk, and holds the one that contacts the customer", () => {
    expect(byId("L-1046").merchant.desk?.proposals.map((p) => [p.fix, p.mode])).toEqual([
      ["stop_attempts", "automatic"],
      ["send_reregistration_link", "needs_approval"],
    ]);
  });
});
