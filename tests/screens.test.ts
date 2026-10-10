// The display helpers the screens use (lib/view/cases.ts), the customer link token and the
// same-site check on cookie logins. No database: these are plain functions.

import { describe, expect, it } from "vitest";
import { lastPickDay, lockDay } from "@/lib/engine";
import type { MerchantCaseRow, ScheduleOptionRow } from "@/lib/data/rows";
import { cardFromRow, defaultAppliesOn, failedRetries, hasLocked, messageSourceWords, pickWindow, queueSummary } from "@/lib/view/cases";

process.env.CUSTOMER_LINK_SECRET = "test-only-secret-for-the-unit-tests-0123456789";
const { caseIdFromToken, customerToken } = await import("@/lib/server/customer-link");
const { sameSite } = await import("@/lib/server/auth");

const DUE = "2026-04-02";

function row(over: Partial<MerchantCaseRow> = {}): MerchantCaseRow {
  return {
    case_id: `L-1041:${DUE}`,
    merchant_id: "m-northfield",
    customer_label: "Test Borrower",
    kind: "EMI",
    amount_paise: 1_200_000,
    due_date: DUE,
    failure_words: "Insufficient funds",
    state: "awaiting_choice",
    retries_used: 0,
    retries_allowed: 2,
    chosen_schedule: null,
    chosen_by: null,
    next_date: null,
    next_action_kind: null,
    result_due_date: null,
    paid_date: null,
    paid_via: null,
    public_reason: "Suggested from payment timing. Advice only.",
    customer_message: null,
    customer_message_date: null,
    customer_message_source: null,
    updated_at: "",
    ...over,
  };
}

// Golden case E1: h = 5, u = 7. Earliest 7 and 10 April, Balanced 8 and 11 April, Safest 10 April only.
const OPTION_ROWS: ScheduleOptionRow[] = [
  { label: "Earliest", merged_labels: ["Earliest"], attempt_days: [5, 8], main_day: 5 },
  { label: "Balanced", merged_labels: ["Balanced"], attempt_days: [6, 9], main_day: 6 },
  { label: "Safest", merged_labels: ["Safest"], attempt_days: [8], main_day: 8 },
].map((o) => ({
  ...o,
  case_id: `L-1041:${DUE}`,
  merchant_id: "m-northfield",
  band: "High",
  attempts: o.attempt_days.length,
  days_overdue: o.main_day,
  waiting_charge_paise: o.main_day * 800,
  days_later_than_original: o.main_day - 3,
  extra_charge_paise: (o.main_day - 3) * 800,
  chosen: false,
})) as ScheduleOptionRow[];
const [EARLIEST, BALANCED, SAFEST] = OPTION_ROWS.map(cardFromRow);

describe("schedule cards from merchant rows", () => {
  it("carry the same fields as the engine's ScheduleCard, and no likelihood number", () => {
    expect(EARLIEST).toEqual({
      label: "Earliest",
      labels: ["Earliest"],
      attemptDays: [5, 8],
      mainDay: 5,
      band: "High",
      attempts: 2,
      daysOverdue: 5,
      waitingChargePaise: 4000,
      versusOriginal: { daysLater: 2, extraChargePaise: 1600 },
    });
    expect(JSON.stringify(EARLIEST)).not.toMatch(/likelihood|confidence|percent|score/i);
  });
});

describe("pick and lock dates come from the engine's rules", () => {
  it("lockDay and lastPickDay match the golden flow: Balanced's 8 April attempt locks on 7 April, pick by 6 April", () => {
    expect(lockDay(6)).toBe(5);
    expect(lastPickDay(6)).toBe(4);
    expect(defaultAppliesOn(row(), BALANCED)).toBe("2026-04-07");
  });

  it("a pick stays open until the card's last pick day, and closes once anything has locked", () => {
    expect(pickWindow(row(), BALANCED, null, "2026-04-06")).toEqual({ open: true, lastDay: "2026-04-06" });
    expect(pickWindow(row(), BALANCED, null, "2026-04-07").open).toBe(false);
    expect(pickWindow(row(), EARLIEST, null, "2026-04-05")).toEqual({ open: true, lastDay: "2026-04-05" });
    expect(pickWindow(row(), EARLIEST, null, "2026-04-06").open).toBe(false);

    // Balanced applied by default on 7 April: its 8 April attempt has locked, so Safest cannot be picked any more.
    const scheduled = row({ state: "scheduled", chosen_schedule: "Balanced", chosen_by: "default", next_date: "2026-04-08" });
    expect(pickWindow(scheduled, SAFEST, BALANCED, "2026-04-07").open).toBe(false);
    // Before that lock, changing the pick is allowed.
    const picked = row({ state: "scheduled", chosen_schedule: "Earliest", chosen_by: "merchant", next_date: "2026-04-07" });
    expect(pickWindow(picked, SAFEST, EARLIEST, "2026-04-05").open).toBe(true);
    expect(pickWindow(row({ state: "paid" }), SAFEST, null, "2026-04-03").open).toBe(false);
  });

  it("hasLocked: a date locks the day before it", () => {
    expect(hasLocked(DUE, "2026-04-08", "2026-04-06")).toBe(false);
    expect(hasLocked(DUE, "2026-04-08", "2026-04-07")).toBe(true);
  });
});

describe("the customer message on a case screen", () => {
  // The text itself is the stored message (compose-message); the screen only names its source.
  it("names where the wording came from", () => {
    expect(messageSourceWords(row({ customer_message_source: "template" }))).toBe("Template text");
    expect(messageSourceWords(row({ customer_message_source: "polished" }))).toBe("Polished wording");
    expect(messageSourceWords(row())).toBeNull();
  });
});

describe("queue summary", () => {
  it("counts states and failed retries", () => {
    const rows = [
      row(),
      row({ state: "paid", retries_used: 2, paid_via: "debit" }),
      row({ state: "result_pending", retries_used: 1 }),
      row({ state: "normal_retries" }),
      row({ state: "failed", retries_used: 2 }),
    ];
    expect(failedRetries(rows[1])).toBe(1);
    expect(failedRetries(rows[2])).toBe(0);
    expect(queueSummary(rows)).toEqual([
      { label: "Awaiting choice", value: 1 },
      { label: "In progress", value: 1 },
      { label: "Paid", value: 1 },
      { label: "On original retries", value: 1 },
      { label: "Failed retries", value: 3 },
    ]);
  });
});

describe("the customer link token", () => {
  it("names its case, and any change to it is refused", () => {
    const token = customerToken(`L-1041:${DUE}`);
    expect(caseIdFromToken(token)).toBe(`L-1041:${DUE}`);
    const [version, body, signature] = token.split(".");
    const otherCase = Buffer.from(`L-1043:${DUE}`).toString("base64url");
    expect(caseIdFromToken(`${version}.${otherCase}.${signature}`)).toBeNull();
    expect(caseIdFromToken(`${version}.${body}.${signature.slice(0, -2)}xx`)).toBeNull();
    expect(caseIdFromToken(`v2.${body}.${signature}`)).toBeNull();
    expect(caseIdFromToken("not a token")).toBeNull();
  });
});

describe("cookie logins only from this site", () => {
  const req = (headers: Record<string, string>) => new Request("https://fsl.example/api/advance-day", { method: "POST", headers });
  it("accepts a matching Origin and refuses another site or a missing one", () => {
    expect(sameSite(req({ origin: "https://fsl.example" }))).toBe(true);
    expect(sameSite(req({ origin: "https://fsl.example", "x-forwarded-host": "fsl.example" }))).toBe(true);
    expect(sameSite(req({ origin: "https://elsewhere.example" }))).toBe(false);
    expect(sameSite(req({ origin: "null" }))).toBe(false);
    expect(sameSite(req({}))).toBe(false);
    expect(sameSite(req({ "sec-fetch-site": "same-origin" }))).toBe(true);
  });
});
