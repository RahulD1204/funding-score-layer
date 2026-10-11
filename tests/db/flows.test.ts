// The server functions end to end, against the test Supabase project (never the demo one).
// specs/09-testing.md "Server functions" and specs/08-security.md row 7.
//
// Each test calls the real route handlers in app/api/ with real logins, the way the browser will.
// Reset demo runs before each scenario, so the order of the tests does not matter.
// Needs the test project migrated and seeded (npm run db:migrate, npm run db:seed).
// Skipped when the test project's variables are missing.

import { randomBytes } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DB_SSL, DEMO_USERS, demoPassword } from "@/scripts/targets";
import { POST as advanceDay } from "@/app/api/advance-day/route";
import { POST as chooseSchedule } from "@/app/api/choose-schedule/route";
import { POST as customerCase } from "@/app/api/customer-case/route";
import { POST as processDebitEvent } from "@/app/api/process-debit-event/route";
import { POST as resetDemo } from "@/app/api/reset-demo/route";
import { POST as updateControls } from "@/app/api/update-controls/route";
import { customerToken } from "@/lib/server/customer-link";

try {
  process.loadEnvFile(".env.local");
} catch {
  // No local file: rely on the environment.
}

const env = process.env;
const READY = Boolean(
  env.TEST_SUPABASE_URL &&
    env.TEST_SUPABASE_SECRET_KEY &&
    env.TEST_SUPABASE_PUBLISHABLE_KEY &&
    env.TEST_SUPABASE_DB_URL &&
    DEMO_USERS.every((u) => env[u.passwordVariable]),
);

// The server reads the Marketplace's variable names. Point them at the test project, and refuse
// to run if that would reach the demo project.
const DEMO_URLS = [env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_URL].filter(Boolean);
if (READY) {
  if (DEMO_URLS.includes(env.TEST_SUPABASE_URL)) throw new Error("TEST_SUPABASE_URL points at the demo project. Refusing to run.");
  process.env.SUPABASE_URL = env.TEST_SUPABASE_URL;
  process.env.SUPABASE_SECRET_KEY = env.TEST_SUPABASE_SECRET_KEY;
  // The login cookie is checked with the publishable key, as the screens send it.
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.TEST_SUPABASE_PUBLISHABLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
}

// No flow test calls Claude. Here the model is always unavailable, so the Triage agent gives no
// answer (the case fails open) and the desk falls back to the rule-based fixes. The agents with
// answers are tested in tests/db/agents.test.ts.
vi.mock("@/lib/server/agents/model", () => ({
  modelFor: (tier: string) => `test-model-${tier}`,
  createMessage: async () => {
    throw new Error("No model in the flow tests.");
  },
}));

// The customer link's signing key. Any value works for the tests; a fresh one is never printed.
if (!process.env.CUSTOMER_LINK_SECRET) process.env.CUSTOMER_LINK_SECRET = randomBytes(32).toString("base64url");

const ROUTES = {
  "process-debit-event": processDebitEvent,
  "customer-case": customerCase,
  "choose-schedule": chooseSchedule,
  "advance-day": advanceDay,
  "update-controls": updateControls,
  "reset-demo": resetDemo,
} as const;
type RouteName = keyof typeof ROUTES;
type Who = "lender" | "insurer" | "ops";

const DUE = "2026-04-02";
const caseOf = (obligationId: string) => `${obligationId}:${DUE}`;

describe.skipIf(!READY)("server functions (test project)", () => {
  let owner: pg.Client;
  const tokens = new Map<Who, string>();

  async function call(route: RouteName, who: Who | null, body: unknown = {}, rawToken?: string) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = rawToken ?? (who ? tokens.get(who) : undefined);
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await ROUTES[route](new Request(`http://localhost/api/${route}`, { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  /** The customer acting through the signed case link of the phone mock. */
  const asCustomer = (caseId: string, route: RouteName, body: Record<string, unknown> = {}) =>
    call(route, null, { ...body, customerToken: customerToken(caseId) });

  const rows = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
  const today = async () => (await rows(`select today::text from public.sim_clock`))[0].today as string;

  async function reset() {
    const res = await call("reset-demo", "ops");
    expect(res, JSON.stringify(res.json)).toMatchObject({ status: 200, json: { today: DUE } });
    // Reset demo keeps today's agent-run counts (migration 20261010000007), so each test starts from none here.
    await owner.query(`delete from public.usage`);
  }

  /** A failed due-date debit as the simulated bank returns it (reason code and bank text from sim_truth). */
  async function inject(obligationId: string, eventId = `TEST-FLOW-${obligationId}`) {
    const [truth] = await rows(`select reason_code, bank_text from public.sim_truth where obligation_id = $1 and cycle_due_date = $2`, [obligationId, DUE]);
    return call("process-debit-event", "ops", {
      eventId,
      eventType: "debit.failed",
      obligationId,
      cycleDueDate: DUE,
      reasonCode: truth.reason_code,
      bankText: truth.bank_text,
    });
  }

  /** Clicks Next day until the clock shows `date`. */
  async function advanceUntil(date: string) {
    while ((await today()) < date) {
      const res = await call("advance-day", "ops");
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect((res.json.cases as { failedOpen?: boolean }[]).filter((c) => c.failedOpen)).toEqual([]);
    }
  }

  const merchantRow = async (obligationId: string) =>
    (
      await rows(
        `select state, chosen_schedule, chosen_by, next_date::text, next_action_kind, result_due_date::text,
                paid_date::text, paid_via, retries_used, public_reason
         from public.merchant_cases where case_id = $1`,
        [caseOf(obligationId)],
      )
    )[0];

  const actions = async (obligationId: string) =>
    rows(
      `select kind, day, status, executed_date::text from public.plan_actions where case_id = $1 order by action_number`,
      [caseOf(obligationId)],
    );

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: env.TEST_SUPABASE_DB_URL, ssl: DB_SSL });
    await owner.connect();
    for (const user of DEMO_USERS) {
      const client = createClient(env.TEST_SUPABASE_URL!, env.TEST_SUPABASE_PUBLISHABLE_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await client.auth.signInWithPassword({ email: user.email, password: demoPassword(user) });
      if (error) throw new Error(`Could not sign in as the ${user.key}: ${error.message}`);
      tokens.set(user.key, data.session.access_token);
    }
  }, 60_000);

  afterAll(async () => {
    if (!owner) return;
    // Leave the test project as seeded.
    await call("reset-demo", "ops");
    await owner.end();
  }, 60_000);

  describe("a call without a login, or with the wrong role, is refused", () => {
    it("refuses every route without a login or with a bad token, and changes nothing", async () => {
      await reset();
      for (const route of Object.keys(ROUTES) as RouteName[]) {
        expect((await call(route, null)).status, `${route} without a login`).toBe(401);
        expect((await call(route, null, {}, "not-a-real-token")).status, `${route} with a bad token`).toBe(401);
      }
      expect(await today()).toBe(DUE);
      expect(await rows(`select decision from public.audit_log`)).toEqual([{ decision: "demo_reset" }]);
    });

    it("refuses the wrong role, and audits the attempt", async () => {
      await reset();
      const refused: [RouteName, Who, unknown][] = [
        ["advance-day", "lender", {}],
        ["reset-demo", "insurer", {}],
        ["process-debit-event", "lender", { eventId: "x" }],
        ["choose-schedule", "insurer", { caseId: caseOf("I-2011"), label: "Balanced" }],
        ["choose-schedule", "ops", { caseId: caseOf("L-1041"), label: "Balanced" }],
        ["update-controls", "ops", { action: "set_kill_switch", on: true }],
        ["update-controls", "lender", { action: "withdraw_consent", caseId: caseOf("L-1041") }],
        ["update-controls", "ops", { action: "pay_by_link", caseId: caseOf("L-1041") }],
      ];
      for (const [route, who, body] of refused) {
        expect((await call(route, who, body)).status, `${who} on ${route}`).toBe(403);
      }
      expect(await today()).toBe(DUE);
      const [{ kill_switch }] = await rows(`select kill_switch from public.merchants where id = 'm-northfield'`);
      expect(kill_switch).toBe(false);
      const audit = await rows(`select count(*)::int as n from public.audit_log where decision = 'request_refused'`);
      expect(audit[0].n).toBe(refused.length);
    });
  });

  describe("event intake", () => {
    it("the same event id twice gives one case, one event row and one audit entry", async () => {
      await reset();
      const first = await inject("L-1041", "TEST-FLOW-DUPLICATE");
      const second = await inject("L-1041", "TEST-FLOW-DUPLICATE");
      expect(first).toMatchObject({ status: 200, json: { caseId: caseOf("L-1041"), route: "schedules" } });
      expect(second).toMatchObject({ status: 200, json: { duplicate: true, caseId: caseOf("L-1041") } });

      expect(await rows(`select id from public.cases where obligation_id = 'L-1041'`)).toHaveLength(1);
      expect(await rows(`select event_id from public.debit_events where event_id = 'TEST-FLOW-DUPLICATE'`)).toHaveLength(1);
      expect(await rows(`select id from public.audit_log where case_id = $1`, [caseOf("L-1041")])).toHaveLength(1);
      expect(await rows(`select case_id from public.merchant_cases where case_id = $1`, [caseOf("L-1041")])).toHaveLength(1);
    });

    it("a second event id for a cycle that already has a case opens nothing new", async () => {
      await reset();
      await inject("L-1041", "TEST-FLOW-FIRST");
      const again = await inject("L-1041", "TEST-FLOW-SECOND");
      expect(again).toMatchObject({ status: 200, json: { ignored: "case_exists" } });
      expect(await rows(`select id from public.cases where obligation_id = 'L-1041'`)).toHaveLength(1);
    });

    it("a catch-all code with no agent answer fails open, and a cancelled mandate goes to the desk with the rule-based fixes", async () => {
      await reset();
      expect(await inject("L-1047")).toMatchObject({ status: 200, json: { route: "fail_open", state: "normal_retries" } });
      const [c] = await rows(`select fail_open_reason from public.cases where id = $1`, [caseOf("L-1047")]);
      expect(c.fail_open_reason).toBe("triage_unknown");
      expect(await merchantRow("L-1047")).toMatchObject({ state: "normal_retries", public_reason: "Razorpay's original retries apply." });

      expect(await inject("L-1046")).toMatchObject({ status: 200, json: { route: "exceptions_desk", state: "needs_action" } });
      const desk = await rows(`select fix_type, mode, status from public.desk_items where case_id = $1 order by id`, [caseOf("L-1046")]);
      expect(desk).toEqual([
        // Automatic fixes run at once (build step 8); anything that contacts the customer waits.
        { fix_type: "stop_attempts", mode: "automatic", status: "done" },
        { fix_type: "send_reregistration_link", mode: "needs_approval", status: "proposed" },
      ]);
    });
  });

  describe("seeded cases 2 to 5, 9 and 10 play through to the endings in specs/05", () => {
    it("opens, picks, advances to 26 April and ends as scripted", async () => {
      await reset();
      const opened: Record<string, unknown> = {};
      for (const id of ["L-1041", "L-1042", "L-1043", "L-1044", "I-2011", "I-2012"]) {
        const res = await inject(id);
        expect(res.status, JSON.stringify(res.json)).toBe(200);
        opened[id] = res.json.route;
      }
      expect(opened).toEqual({
        "L-1041": "schedules",
        "L-1042": "schedules",
        "L-1043": "schedules",
        "L-1044": "out_of_reach",
        "I-2011": "schedules",
        "I-2012": "schedules",
      });

      // Cards: lenders only. Case 4 sits close to the cap, so it has two schedules.
      const cards = await rows(`select case_id, count(*)::int as n from public.schedule_options group by case_id order by case_id`);
      expect(cards).toEqual([
        { case_id: caseOf("L-1041"), n: 3 },
        { case_id: caseOf("L-1042"), n: 3 },
        { case_id: caseOf("L-1043"), n: 2 },
      ]);
      // An insurer sees a date only once it has locked: case 9's early attempt locks at once, case 10's attempt does not.
      expect(await merchantRow("I-2011")).toMatchObject({ state: "scheduled", next_date: "2026-04-03", next_action_kind: "probe" });
      expect(await merchantRow("I-2012")).toMatchObject({ state: "scheduled", next_date: null, chosen_schedule: null });
      expect(await merchantRow("L-1041")).toMatchObject({ state: "awaiting_choice", chosen_schedule: null });

      // Case 3: the lender picks Earliest. The insurer cannot pick.
      const pick = await call("choose-schedule", "lender", { caseId: caseOf("L-1042"), label: "Earliest" });
      expect(pick).toMatchObject({ status: 200, json: { state: "scheduled", chosen: "Earliest" } });
      expect(await merchantRow("L-1042")).toMatchObject({ chosen_schedule: "Earliest", chosen_by: "merchant", next_date: "2026-04-08" });
      const [chosenCard] = await rows(`select label from public.schedule_options where case_id = $1 and chosen`, [caseOf("L-1042")]);
      expect(chosenCard.label).toBe("Earliest");

      // Case 2: nobody picks. Result pending on 9 April, paid when the bank confirms on 10 April.
      await advanceUntil("2026-04-09");
      expect(await merchantRow("L-1041")).toMatchObject({ state: "result_pending", result_due_date: "2026-04-10", chosen_schedule: "Balanced", chosen_by: "default" });
      await advanceUntil("2026-04-10");
      expect(await merchantRow("L-1041")).toMatchObject({ state: "paid", paid_date: "2026-04-08", paid_via: "debit" });

      await advanceUntil("2026-04-26");

      // 2. L-1041: Balanced applies, attempt on 8 April, confirmed paid on 10 April, backup cancelled.
      expect(await merchantRow("L-1041")).toMatchObject({ state: "paid", paid_date: "2026-04-08", retries_used: 1 });
      expect(await actions("L-1041")).toEqual([
        { kind: "attempt", day: 6, status: "succeeded", executed_date: "2026-04-08" },
        { kind: "backup", day: 9, status: "cancelled", executed_date: null },
      ]);

      // 3. L-1042: the 8 April attempt fails, the backup on 11 April succeeds.
      expect(await merchantRow("L-1042")).toMatchObject({ state: "paid", paid_date: "2026-04-11", paid_via: "debit", retries_used: 2 });
      expect(await actions("L-1042")).toEqual([
        { kind: "attempt", day: 6, status: "failed", executed_date: "2026-04-08" },
        { kind: "backup", day: 9, status: "succeeded", executed_date: "2026-04-11" },
      ]);

      // 4. L-1043: paid on the 12 April attempt.
      expect(await merchantRow("L-1043")).toMatchObject({ state: "paid", paid_date: "2026-04-12", paid_via: "debit", retries_used: 1 });

      // 5. L-1044: link on 22 April, paid by link, no debit presented.
      expect(await merchantRow("L-1044")).toMatchObject({ state: "paid", paid_date: "2026-04-22", paid_via: "link", retries_used: 0 });
      expect(await actions("L-1044")).toEqual([{ kind: "link", day: 20, status: "sent", executed_date: "2026-04-22" }]);

      // 9. I-2011: the early attempt on 3 April fails; paid on 12 April, inside the 15-day grace period.
      expect(await merchantRow("I-2011")).toMatchObject({ state: "paid", paid_date: "2026-04-12", paid_via: "debit", chosen_schedule: null });
      const probe = (await actions("I-2011")).find((a) => a.kind === "probe");
      expect(probe).toMatchObject({ status: "failed", executed_date: "2026-04-03" });

      // 10. I-2012: no early attempt, paid on 12 April.
      expect(await merchantRow("I-2012")).toMatchObject({ state: "paid", paid_date: "2026-04-12", paid_via: "debit", retries_used: 1 });
      expect((await actions("I-2012")).some((a) => a.kind === "probe")).toBe(false);

      // The insurer never got cards, and every case has its audit trail.
      expect(await rows(`select 1 from public.schedule_options where merchant_id = 'm-harbour'`)).toEqual([]);
      for (const id of ["L-1041", "L-1042", "L-1043", "L-1044", "I-2011", "I-2012"]) {
        const audit = await rows(`select decision from public.audit_log where case_id = $1 order by id`, [caseOf(id)]);
        expect(audit[0].decision, id).toMatch(/^case_opened:/);
        expect(audit.some((a) => a.decision === "case_advanced"), id).toBe(true);
      }
    }, 600_000);
  });

  describe("stepping back resumes Razorpay's original retries", () => {
    it("consent withdrawn mid-plan stops the plan at once, and a withdrawal found by the daily re-check stops it too", async () => {
      await reset();
      await inject("L-1041");
      await inject("L-1043");
      // The standing default applied on 7 April, the day before its first attempt, which is now locked.
      await advanceUntil("2026-04-07");
      expect(await merchantRow("L-1041")).toMatchObject({ state: "scheduled", next_date: "2026-04-08", chosen_by: "default" });

      // Through update-controls, from the customer's signed link.
      const res = await asCustomer(caseOf("L-1041"), "update-controls", { action: "withdraw_consent", caseId: caseOf("L-1041") });
      expect(res).toMatchObject({ status: 200, json: { state: "normal_retries" } });
      expect(await merchantRow("L-1041")).toMatchObject({ state: "normal_retries", next_date: null, public_reason: "Razorpay's original retries apply." });
      expect((await actions("L-1041")).map((a) => a.status)).toEqual(["cancelled", "cancelled"]);
      const [c] = await rows(`select fail_open_reason, sim_snapshot->'baselineRemaining' as remaining from public.cases where id = $1`, [caseOf("L-1041")]);
      expect(c).toEqual({ fail_open_reason: "no_customer_consent", remaining: [6, 9] });
      const [consent] = await rows(
        `select status, withdrawn_date::text from public.consents where party = 'customer' and customer_id = 'C-S02' and merchant_id = 'm-northfield'`,
      );
      expect(consent).toEqual({ status: "withdrawn", withdrawn_date: "2026-04-07" });

      // Straight in the database, as if it arrived from elsewhere: the check before the 12 April attempt catches it.
      // Its own standing default applies only on 11 April, the day before its 12 April attempt.
      expect(await merchantRow("L-1043")).toMatchObject({ state: "awaiting_choice", next_date: null });
      await owner.query(`update public.consents set status = 'withdrawn', withdrawn_date = '2026-04-07' where party = 'customer' and customer_id = 'C-S04'`);

      await advanceUntil("2026-04-26");
      expect(await merchantRow("L-1041")).toMatchObject({ state: "normal_retries", retries_used: 0 });
      expect(await merchantRow("L-1043")).toMatchObject({ state: "normal_retries", retries_used: 0, paid_date: null });
      expect((await actions("L-1043")).every((a) => a.executed_date === null && a.status === "cancelled")).toBe(true);
      const [c43] = await rows(`select fail_open_reason from public.cases where id = $1`, [caseOf("L-1043")]);
      expect(c43.fail_open_reason).toBe("no_customer_consent");
    }, 300_000);

    it("the kill switch stops the lender's plans and leaves the insurer's alone", async () => {
      await reset();
      await inject("L-1043");
      await inject("I-2011");

      const res = await call("update-controls", "lender", { action: "set_kill_switch", on: true });
      expect(res).toMatchObject({ status: 200, json: { killSwitch: true, cases: [{ caseId: caseOf("L-1043"), state: "normal_retries" }] } });
      expect(await merchantRow("L-1043")).toMatchObject({ state: "normal_retries", next_date: null });

      // A new failure for the same lender now fails open at once.
      expect(await inject("L-1041")).toMatchObject({ status: 200, json: { route: "fail_open" } });
      const [c] = await rows(`select fail_open_reason from public.cases where id = $1`, [caseOf("L-1041")]);
      expect(c.fail_open_reason).toBe("kill_switch");

      await advanceUntil("2026-04-14");
      expect(await merchantRow("L-1043")).toMatchObject({ state: "normal_retries", retries_used: 0, paid_date: null });
      expect(await merchantRow("I-2011")).toMatchObject({ state: "paid", paid_date: "2026-04-12" });
    }, 300_000);
  });

  describe("other controls", () => {
    it("refuses a late pick and a payment while a debit awaits its result, changing nothing", async () => {
      await reset();
      await inject("L-1041");
      // 7 April: the standing default applied and its 8 April attempt has locked.
      await advanceUntil("2026-04-07");
      const late = await call("choose-schedule", "lender", { caseId: caseOf("L-1041"), label: "Safest" });
      expect(late).toMatchObject({ status: 409, json: { error: "locked" } });
      // 8 April: the attempt is presented and awaits the bank's result.
      await advanceUntil("2026-04-08");
      const closed = await call("choose-schedule", "lender", { caseId: caseOf("L-1041"), label: "Safest" });
      expect(closed).toMatchObject({ status: 409, json: { error: "case_closed" } });
      const paid = await call("update-controls", "lender", { action: "mark_paid", caseId: caseOf("L-1041") });
      expect(paid).toMatchObject({ status: 409, json: { error: "attempt_in_flight" } });
      expect(await merchantRow("L-1041")).toMatchObject({ state: "result_pending", chosen_schedule: "Balanced" });
    }, 120_000);

    it("a lender cannot reach another merchant's case", async () => {
      await reset();
      await inject("I-2011");
      const res = await call("update-controls", "lender", { action: "force_original_retries", caseId: caseOf("I-2011") });
      expect(res).toMatchObject({ status: 404, json: { error: "case_not_found" } });
      expect(await merchantRow("I-2011")).toMatchObject({ state: "scheduled" });
    });

    it("reset demo puts back the replayed history with its own ids, and new rows number after it", async () => {
      // A small stand-in for the seed's February and March history (migration 20261012000008).
      const tables = ["debit_events", "cases", "triage_results", "merchant_cases", "schedule_options", "plan_actions", "desk_items", "messages", "llm_runs", "audit_log"];
      const sorted = (list: { r: unknown }[]) => list.map(({ r }) => JSON.stringify(r)).sort();
      await reset();
      await inject("L-1046");
      await inject("I-2011");
      const history: Record<string, { r: unknown }[]> = {};
      for (const t of tables) history[t] = await rows(`select to_jsonb(t) as r from public."${t}" t`);
      expect(history.desk_items.length).toBeGreaterThan(0);
      expect(history.messages.length).toBeGreaterThan(0);
      await owner.query("select private.take_history_snapshot()");
      try {
        await inject("L-1041"); // a live case after the copy: Reset demo must remove it
        expect(await call("reset-demo", "ops")).toMatchObject({ status: 200, json: { today: DUE } });
        for (const t of tables.filter((t) => t !== "audit_log")) {
          expect(sorted(await rows(`select to_jsonb(t) as r from public."${t}" t`)), t).toEqual(sorted(history[t]));
        }
        const audit = await rows(`select to_jsonb(t) as r from public.audit_log t order by id`);
        const lastHistoryId = Math.max(...history.audit_log.map(({ r }) => (r as { id: number }).id));
        expect(sorted(audit.slice(0, -1))).toEqual(sorted(history.audit_log));
        expect(audit.at(-1)!.r).toMatchObject({ decision: "demo_reset", id: lastHistoryId + 1 });
        // The id counters moved past the copy, so a new case's rows number after it.
        await inject("L-1041");
        const fresh = await rows(`select min(id)::int as id from public.audit_log where case_id = $1`, [caseOf("L-1041")]);
        expect(fresh[0].id).toBeGreaterThan(lastHistoryId + 1);
      } finally {
        await owner.query("delete from private.history_snapshot where true");
        await reset();
      }
    });

    it("reset demo puts back settings, consents, the clock, and empties cases and the audit log", async () => {
      await reset();
      await inject("L-1041");
      await inject("L-1046");
      await inject("I-2011");
      await call("update-controls", "lender", { action: "set_limits", productId: "p-northfield-personal-loan", lastAllowedDay: 12, maxRepresentations: 3 });
      await call("update-controls", "lender", { action: "set_standing_default", productId: "p-northfield-personal-loan", label: "Safest" });
      await call("update-controls", "lender", { action: "set_fix_mode", fixType: "send_reregistration_link", mode: "automatic" });
      await call("update-controls", "insurer", { action: "set_polish", on: false });
      await asCustomer(caseOf("L-1041"), "update-controls", { action: "withdraw_consent", caseId: caseOf("L-1041") });
      await call("update-controls", "lender", { action: "set_kill_switch", on: true });
      await advanceUntil("2026-04-04");
      await owner.query(
        `insert into public.usage (user_id, date, agent_runs) select user_id, current_date, 7 from public.profiles where role = 'ops'
         on conflict (user_id, date) do update set agent_runs = excluded.agent_runs`,
      );

      // The route itself, not reset(), which also clears the usage table for the other tests.
      expect(await call("reset-demo", "ops")).toMatchObject({ status: 200, json: { today: DUE } });
      // Every setting the server functions can change is back exactly as the seed saved it.
      for (const table of ["merchants", "products", "fix_settings", "consents", "sim_clock"]) {
        const sorted = (list: { r: unknown }[]) => list.map(({ r }) => JSON.stringify(r)).sort();
        const now = await rows(`select to_jsonb(t) as r from public."${table}" t`);
        const seeded = await rows(`select jsonb_array_elements(rows) as r from private.seed_snapshot where table_name = $1`, [table]);
        expect(seeded.length, table).toBeGreaterThan(0);
        expect(sorted(now), table).toEqual(sorted(seeded));
      }
      for (const table of ["cases", "debit_events", "triage_results", "plan_actions", "merchant_cases", "schedule_options", "desk_items", "messages", "llm_runs"]) {
        expect(await rows(`select count(*)::int as n from public."${table}"`), table).toEqual([{ n: 0 }]);
      }
      // Today's agent-run count is kept (migration 20261010000007), so resetting cannot restart the cap of 50.
      expect(await rows(`select agent_runs from public.usage where date = current_date`)).toEqual([{ agent_runs: 7 }]);
      expect(await today()).toBe(DUE);
      expect(await rows(`select count(*)::int as n from public.cases`)).toEqual([{ n: 0 }]);
      expect(await rows(`select decision, actor like 'ops:%' as by_ops from public.audit_log`)).toEqual([{ decision: "demo_reset", by_ops: true }]);
      expect(await rows(`select kill_switch from public.merchants where id = 'm-northfield'`)).toEqual([{ kill_switch: false }]);
      expect(await rows(`select last_allowed_day, max_representations, standing_default from public.products where id = 'p-northfield-personal-loan'`)).toEqual([
        { last_allowed_day: 10, max_representations: 2, standing_default: "Balanced" },
      ]);
      expect(await rows(`select polish_on from public.merchants where id = 'm-harbour'`)).toEqual([{ polish_on: true }]);
      expect(await rows(`select mode from public.fix_settings where merchant_id = 'm-northfield' and fix_type = 'send_reregistration_link'`)).toEqual([
        { mode: "needs_approval" },
      ]);
      expect(await rows(`select status from public.consents where party = 'customer' and customer_id = 'C-S02'`)).toEqual([{ status: "granted" }]);
    }, 120_000);
  });

  describe("the customer's signed link (phone mock)", () => {
    it("shows only the listed fields, and acts on that one case alone", async () => {
      await reset();
      await inject("L-1041");
      await inject("L-1043");
      await advanceUntil("2026-04-07");

      const view = await asCustomer(caseOf("L-1041"), "customer-case");
      expect(view.status, JSON.stringify(view.json)).toBe(200);
      expect(Object.keys(view.json).sort()).toEqual(
        ["amountPaise", "caseId", "consent", "customer", "dueDate", "kind", "merchant", "message", "paidDate", "status"],
      );
      expect(view.json).toMatchObject({ caseId: caseOf("L-1041"), status: "planned", consent: "granted", amountPaise: 1200000 });
      expect(view.json.message).toContain("8 April");
      expect(String(view.json.message)).not.toMatch(/salary|payday|income|employer|wage|balance/i);

      // A link reaches its own case only. Another case answers "not found"; a forged link is refused.
      const other = await asCustomer(caseOf("L-1041"), "update-controls", { action: "pay_by_link", caseId: caseOf("L-1043") });
      expect(other).toMatchObject({ status: 404, json: { error: "case_not_found" } });
      const forged = `${customerToken(caseOf("L-1041")).slice(0, -4)}AAAA`;
      expect((await call("customer-case", null, { customerToken: forged })).status).toBe(401);
      expect((await call("update-controls", null, { action: "pay_by_link", caseId: caseOf("L-1041"), customerToken: "v1.x.y" })).status).toBe(401);
      expect(await merchantRow("L-1043")).toMatchObject({ state: "awaiting_choice" });

      const paid = await asCustomer(caseOf("L-1041"), "update-controls", { action: "pay_by_link", caseId: caseOf("L-1041") });
      expect(paid).toMatchObject({ status: 200, json: { state: "paid" } });
      expect(await merchantRow("L-1041")).toMatchObject({ state: "paid", paid_via: "link", paid_date: "2026-04-07" });
      expect(await rows(`select actor from public.audit_log where decision = 'paid_outside_plan'`)).toEqual([{ actor: `customer:${caseOf("L-1041")}` }]);
      // The link is a credential: it never reaches the audit log.
      expect(await rows(`select id from public.audit_log where inputs::text like '%customerToken%' or inputs::text like '%v1.%'`)).toEqual([]);
    }, 120_000);
  });

  describe("the screens' login cookie", () => {
    /** Signs in the way the login page does, and returns the Cookie header the browser would send. */
    async function cookieFor(who: Who): Promise<string> {
      const jar = new Map<string, string>();
      const client = createServerClient(env.TEST_SUPABASE_URL!, env.TEST_SUPABASE_PUBLISHABLE_KEY!, {
        cookies: {
          getAll: () => [...jar].map(([name, value]) => ({ name, value })),
          setAll: (list) => list.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
        },
      });
      const user = DEMO_USERS.find((u) => u.key === who)!;
      const { error } = await client.auth.signInWithPassword({ email: user.email, password: demoPassword(user) });
      if (error) throw new Error(`Could not sign in as the ${who}: ${error.message}`);
      return [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
    }

    async function withCookie(route: RouteName, cookie: string, origin: string | null, body: unknown) {
      const headers: Record<string, string> = { "content-type": "application/json", cookie };
      if (origin) headers.origin = origin;
      const response = await ROUTES[route](new Request(`http://localhost/api/${route}`, { method: "POST", headers, body: JSON.stringify(body) }));
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    }

    it("works from this site's own pages, and is refused from another site without an audit row", async () => {
      await reset();
      await inject("L-1041");
      const cookie = await cookieFor("lender");
      const before = await rows(`select count(*)::int as n from public.audit_log`);

      const foreign = await withCookie("choose-schedule", cookie, "https://elsewhere.example", { caseId: caseOf("L-1041"), label: "Safest" });
      expect(foreign).toMatchObject({ status: 403, json: { error: "cross_site" } });
      const noOrigin = await withCookie("choose-schedule", cookie, null, { caseId: caseOf("L-1041"), label: "Safest" });
      expect(noOrigin).toMatchObject({ status: 403, json: { error: "cross_site" } });
      expect(await rows(`select count(*)::int as n from public.audit_log`)).toEqual(before);
      expect(await merchantRow("L-1041")).toMatchObject({ state: "awaiting_choice", chosen_schedule: null });

      const own = await withCookie("choose-schedule", cookie, "http://localhost", { caseId: caseOf("L-1041"), label: "Safest" });
      expect(own).toMatchObject({ status: 200, json: { chosen: "Safest" } });
      expect(await merchantRow("L-1041")).toMatchObject({ chosen_schedule: "Safest", chosen_by: "merchant" });

      // The role still comes from profiles: the lender's cookie cannot move the clock.
      expect((await withCookie("advance-day", cookie, "http://localhost", {})).status).toBe(403);
      // A cookie that is not a login is refused.
      expect((await withCookie("advance-day", "sb-x-auth-token=nonsense", "http://localhost", {})).status).toBe(401);
    }, 120_000);
  });

  describe("on any error, the case fails open and an audit row is written", () => {
    it("a broken case snapshot hands the case back to the original retries", async () => {
      await reset();
      await inject("L-1041");
      await owner.query(`update public.cases set sim_snapshot = '{"broken": true}' where id = $1`, [caseOf("L-1041")]);

      const res = await call("advance-day", "ops");
      expect(res.status).toBe(200);
      expect(res.json.cases).toEqual([{ caseId: caseOf("L-1041"), state: "normal_retries", failedOpen: true }]);

      const [c] = await rows(`select state, fail_open_reason from public.cases where id = $1`, [caseOf("L-1041")]);
      expect(c).toEqual({ state: "normal_retries", fail_open_reason: "server_error" });
      expect(await merchantRow("L-1041")).toMatchObject({ state: "normal_retries", public_reason: "Razorpay's original retries apply." });
      const [audit] = await rows(`select decision, internal_reason from public.audit_log where case_id = $1 and decision = 'fail_open'`, [caseOf("L-1041")]);
      expect(audit.internal_reason).toMatch(/^Fail open: server_error\./);

      // It is not retried every day afterwards.
      const next = await call("advance-day", "ops");
      expect(next.json.cases).toEqual([]);
    });
  });
});
