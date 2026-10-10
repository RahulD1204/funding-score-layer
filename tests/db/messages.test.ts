// Customer message text through the real server functions, against the test Supabase project, with
// the model mocked: no test calls Claude. specs/09-testing.md "Messages" and specs/08-security.md rows 13 and 14.
//
//   an insurer's first debit locks the day its case opens, and its notice is polished (switch on);
//   a failed polish call keeps the template; a lender's notice is the template (switch off) and appears
//   only once the attempt locks; set_polish changes only the caller's own merchant; a payment link's
//   text is never polished; the ops-only compose-message route fills a missing notice once.
//
// Needs the test project migrated and seeded (npm run db:migrate, npm run db:seed).
// Skipped when the test project's variables are missing.

import { randomBytes } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DB_SSL, DEMO_USERS, demoPassword } from "@/scripts/targets";
import { POST as advanceDay } from "@/app/api/advance-day/route";
import { POST as composeMessage } from "@/app/api/compose-message/route";
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

// Point the server at the test project, and refuse to run if that would reach the demo project.
const DEMO_URLS = [env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_URL].filter(Boolean);
if (READY) {
  if (DEMO_URLS.includes(env.TEST_SUPABASE_URL)) throw new Error("TEST_SUPABASE_URL points at the demo project. Refusing to run.");
  process.env.SUPABASE_URL = env.TEST_SUPABASE_URL;
  process.env.SUPABASE_SECRET_KEY = env.TEST_SUPABASE_SECRET_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.TEST_SUPABASE_PUBLISHABLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
}

// The customer link's signing key. Any value works for the tests; a fresh one is never printed.
if (!process.env.CUSTOMER_LINK_SECRET) process.env.CUSTOMER_LINK_SECRET = randomBytes(32).toString("base64url");

// ---------------------------------------------------------------------------
// The model: each test queues the answers it wants. An empty queue means the model is unavailable.
// ---------------------------------------------------------------------------

type Params = Anthropic.MessageCreateParamsNonStreaming;
type Responder = (params: Params) => Anthropic.Message;
const model = vi.hoisted(() => ({ queue: [] as unknown[], calls: [] as unknown[] }));

vi.mock("@/lib/server/agents/model", () => ({
  modelFor: (tier: string) => `test-model-${tier}`,
  createMessage: async (params: Params) => {
    model.calls.push(structuredClone(params));
    const next = model.queue.shift() as Responder | undefined;
    if (!next) throw new Error("The model is unavailable in this test.");
    return next(params);
  },
}));

/** A rewrite that keeps every fact: it rewords the template the model was sent. */
const rewords: Responder = (params) => {
  const template = String(params.messages[0].content);
  const rewrite = template.replace("didn't go through on", "could not be collected on").replace("We'll try again on", "We will try once more on");
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [{ type: "text", text: JSON.stringify({ rewrite }) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 80, output_tokens: 30 },
  } as unknown as Anthropic.Message;
};
const sent = () => model.calls as Params[];

// ---------------------------------------------------------------------------

const ROUTES = {
  "process-debit-event": processDebitEvent,
  "advance-day": advanceDay,
  "compose-message": composeMessage,
  "customer-case": customerCase,
  "update-controls": updateControls,
  "reset-demo": resetDemo,
} as const;
type RouteName = keyof typeof ROUTES;
type Who = "lender" | "insurer" | "ops";

const DUE = "2026-04-02";
const caseOf = (obligationId: string) => `${obligationId}:${DUE}`;

const INSURER_TEMPLATE =
  "Your premium of Rs 2,500 to Harbour Life didn't go through on 2 April. We'll try again on 3 April. Your cover continues until 17 April.";
const INSURER_POLISHED =
  "Your premium of Rs 2,500 to Harbour Life could not be collected on 2 April. We will try once more on 3 April. Your cover continues until 17 April.";
const LENDER_TEMPLATE = "Your EMI of Rs 12,000 to Northfield Finance didn't go through on 2 April. We'll try again on 8 April.";
const LENDER_POLISHED = "Your EMI of Rs 12,000 to Northfield Finance could not be collected on 2 April. We will try once more on 8 April.";

// Each test resets the demo and talks to the test project over the network, so allow a few minutes.
describe.skipIf(!READY)("customer messages through the server functions (test project, model mocked)", { timeout: 240_000 }, () => {
  let owner: pg.Client;
  const tokens = new Map<Who, string>();
  const userIds = new Map<Who, string>();
  const clients = new Map<Who, SupabaseClient>();

  async function call(route: RouteName, who: Who | null, body: unknown = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = who ? tokens.get(who) : undefined;
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await ROUTES[route](new Request(`http://localhost/api/${route}`, { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
  const today = async () => (await rows(`select today::text from public.sim_clock`))[0].today as string;

  async function inject(obligationId: string) {
    const [truth] = await rows(`select reason_code, bank_text from public.sim_truth where obligation_id = $1 and cycle_due_date = $2`, [obligationId, DUE]);
    const res = await call("process-debit-event", "ops", {
      eventId: `TEST-MSG-${obligationId}-${Math.random().toString(36).slice(2, 8)}`,
      eventType: "debit.failed",
      obligationId,
      cycleDueDate: DUE,
      reasonCode: truth.reason_code,
      bankText: truth.bank_text,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res;
  }

  async function advanceUntil(date: string) {
    while ((await today()) < date) {
      const res = await call("advance-day", "ops");
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect((res.json.cases as { failedOpen?: boolean }[]).filter((c) => c.failedOpen)).toEqual([]);
    }
  }

  const messages = (obligationId: string) =>
    rows(`select body, source, channel, template_version, clock_date::text, facts from public.messages where case_id = $1 order by id`, [caseOf(obligationId)]);
  const polishRuns = () =>
    rows(`select user_id::text, model, prompt_version, steps, status, input_fields, validation_result from public.llm_runs where purpose = 'message_polish' order by id`);
  const merchantCopy = async (who: Who, obligationId: string) => {
    const { data, error } = await clients
      .get(who)!
      .from("merchant_cases")
      .select("customer_message, customer_message_date, customer_message_source")
      .eq("case_id", caseOf(obligationId))
      .maybeSingle();
    if (error) throw error;
    return data;
  };
  const phone = async (obligationId: string) => {
    const res = await call("customer-case", null, { customerToken: customerToken(caseOf(obligationId)) });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  };

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
      userIds.set(user.key, data.user.id);
      clients.set(user.key, client);
    }
  }, 60_000);

  beforeEach(async () => {
    model.queue = [];
    model.calls = [];
    const res = await call("reset-demo", "ops");
    expect(res, JSON.stringify(res.json)).toMatchObject({ status: 200, json: { today: DUE } });
    // Reset demo keeps today's agent-run counts (migration 20261010000007), so each test starts from none here.
    await owner.query(`delete from public.usage`);
  }, 60_000);

  afterAll(async () => {
    if (!owner) return;
    await call("reset-demo", "ops");
    await owner.end();
  }, 60_000);

  it("the polish switch starts off for the lender and on for the insurer (decision record)", async () => {
    const merchants = await rows(`select id, polish_on from public.merchants order by id`);
    expect(merchants).toEqual([
      { id: "m-harbour", polish_on: true },
      { id: "m-northfield", polish_on: false },
    ]);
  });

  it("I-2011: the insurer's first debit locks the day the case opens, and the polished notice is stored and shown", async () => {
    model.queue.push(rewords);
    expect((await inject("I-2011")).json).toMatchObject({ route: "schedules", state: "scheduled", messages: 1 });

    // Only the filled template went to the model.
    expect(sent()).toHaveLength(1);
    expect(sent()[0].messages).toEqual([{ role: "user", content: INSURER_TEMPLATE }]);

    expect(await messages("I-2011")).toEqual([
      {
        body: INSURER_POLISHED,
        source: "polished",
        channel: "phone_mock",
        template_version: "t1",
        clock_date: DUE,
        facts: {
          type: "retry",
          action_id: 1,
          planned_date: "2026-04-03",
          amount: "Rs 2,500",
          dates: ["2 April", "3 April", "17 April"],
          merchant: "Harbour Life",
          polish: { status: "accepted", problems: [] },
        },
      },
    ]);
    const runs = await polishRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      user_id: userIds.get("ops"),
      model: "test-model-fast",
      prompt_version: "polish-v1",
      steps: 1,
      status: "accepted",
      input_fields: { case_id: caseOf("I-2011"), message_type: "retry", text: INSURER_TEMPLATE },
      validation_result: { used: "polished", problems: [] },
    });
    const [audit] = await rows(`select actor, internal_reason, inputs from public.audit_log where case_id = $1 and decision = 'message_composed:retry'`, [caseOf("I-2011")]);
    expect(audit.actor).toBe("system:compose-message");
    expect(audit.internal_reason).toBe("Retry notice for 3 April: polished wording, accepted by validatePolish.");

    // The insurer reads its copy with its own login; the messages table stays closed to it.
    expect(await merchantCopy("insurer", "I-2011")).toEqual({
      customer_message: INSURER_POLISHED,
      customer_message_date: DUE,
      customer_message_source: "polished",
    });
    const closed = await clients.get("insurer")!.from("messages").select("*").eq("case_id", caseOf("I-2011"));
    expect(closed.error !== null || closed.data!.length === 0).toBe(true);

    expect(await phone("I-2011")).toMatchObject({ status: "planned", message: INSURER_POLISHED });
  });

  it("I-2011: a failed polish call keeps the template, and the call is logged", async () => {
    expect((await inject("I-2011")).json).toMatchObject({ state: "scheduled", messages: 1 });
    expect(sent()).toHaveLength(1);
    expect(await messages("I-2011")).toMatchObject([{ body: INSURER_TEMPLATE, source: "template", facts: { polish: { status: "model_error" } } }]);
    expect(await polishRuns()).toMatchObject([{ steps: 1, status: "model_error", validation_result: { used: "template", problems: [] } }]);
    expect(await merchantCopy("insurer", "I-2011")).toMatchObject({ customer_message: INSURER_TEMPLATE, customer_message_source: "template" });
    expect(await phone("I-2011")).toMatchObject({ message: INSURER_TEMPLATE });
  });

  it("L-1041: the lender's notice is the template, written only when the 8 April attempt locks on 7 April", async () => {
    expect((await inject("L-1041")).json).toMatchObject({ state: "awaiting_choice", messages: 0 });
    await advanceUntil("2026-04-06");
    expect(await messages("L-1041")).toEqual([]);
    expect(await merchantCopy("lender", "L-1041")).toEqual({ customer_message: null, customer_message_date: null, customer_message_source: null });
    expect(await phone("L-1041")).toMatchObject({ status: "none", message: null });

    await advanceUntil("2026-04-07");
    expect(await messages("L-1041")).toMatchObject([{ body: LENDER_TEMPLATE, source: "template", clock_date: "2026-04-07", facts: { polish: null } }]);
    expect(await merchantCopy("lender", "L-1041")).toEqual({
      customer_message: LENDER_TEMPLATE,
      customer_message_date: "2026-04-07",
      customer_message_source: "template",
    });
    expect(await phone("L-1041")).toMatchObject({ status: "planned", message: LENDER_TEMPLATE });
    // Polish is off: no model call and no llm_runs row.
    expect(sent()).toHaveLength(0);
    expect(await polishRuns()).toEqual([]);

    // The message is written once, not again on the next day.
    await advanceUntil("2026-04-08");
    expect(await messages("L-1041")).toHaveLength(1);
  });

  it("set_polish: a merchant changes only its own switch, ops cannot, and the next notice follows it", async () => {
    expect(await call("update-controls", "lender", { action: "set_polish", on: true })).toMatchObject({ status: 200, json: { polish: true } });
    expect((await call("update-controls", "ops", { action: "set_polish", on: false })).status).toBe(403);
    expect(await call("update-controls", "insurer", { action: "set_polish", on: false })).toMatchObject({ status: 200, json: { polish: false } });
    expect((await call("update-controls", "lender", { action: "set_polish", on: "yes" })).status).toBe(400);
    expect(await rows(`select id, polish_on from public.merchants order by id`)).toEqual([
      { id: "m-harbour", polish_on: false },
      { id: "m-northfield", polish_on: true },
    ]);
    const audit = await rows(`select decision, internal_reason from public.audit_log where decision = 'controls_updated:set_polish' order by id`);
    expect(audit.map((a) => a.internal_reason)).toEqual(["Message polish on.", "Message polish off."]);

    // The insurer's switch is off now: its notice is the template, with no model call.
    await inject("I-2011");
    expect(sent()).toHaveLength(0);
    expect(await messages("I-2011")).toMatchObject([{ body: INSURER_TEMPLATE, source: "template" }]);

    // The lender's switch is on: its notice is polished.
    await inject("L-1041");
    model.queue.push(rewords);
    await advanceUntil("2026-04-07");
    expect(sent()).toHaveLength(1);
    expect(await messages("L-1041")).toMatchObject([{ body: LENDER_POLISHED, source: "polished" }]);
    expect(await merchantCopy("lender", "L-1041")).toMatchObject({ customer_message: LENDER_POLISHED, customer_message_source: "polished" });
  });

  it("L-1044: the payment link's text is written when the link is sent, and never polished", async () => {
    expect(await call("update-controls", "lender", { action: "set_polish", on: true })).toMatchObject({ status: 200 });
    expect((await inject("L-1044")).json).toMatchObject({ route: "out_of_reach", messages: 0 });
    await advanceUntil("2026-04-21");
    expect(await messages("L-1044")).toEqual([]);

    await advanceUntil("2026-04-22");
    const link = "You can pay your EMI of Rs 12,000 to Northfield Finance here: [payment link]";
    expect(await messages("L-1044")).toMatchObject([{ body: link, source: "template", clock_date: "2026-04-22", facts: { type: "link", polish: null } }]);
    expect(sent()).toHaveLength(0);
    expect(await merchantCopy("lender", "L-1044")).toMatchObject({ customer_message: link, customer_message_source: "template" });
    // The customer is funded that day, so the link is paid at once (seeded case 5) and the phone says so.
    expect(await phone("L-1044")).toMatchObject({ status: "paid", message: null });
  });

  it("compose-message: ops only, and it fills a missing notice once", async () => {
    await inject("I-2011");
    // Stand in for an outage: the stored notice is lost.
    await owner.query(`delete from public.messages where case_id = $1`, [caseOf("I-2011")]);

    expect((await call("compose-message", "insurer", { caseId: caseOf("I-2011") })).status).toBe(403);
    const first = await call("compose-message", "ops", { caseId: caseOf("I-2011") });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.composed).toMatchObject([{ type: "retry", source: "template", polish: "model_error", body: INSURER_TEMPLATE }]);
    expect(await call("compose-message", "ops", { caseId: caseOf("I-2011") })).toMatchObject({ status: 200, json: { composed: [] } });
    expect(await messages("I-2011")).toHaveLength(1);

    // A case the layer is not running has no notice to compose.
    await inject("L-1046");
    expect(await call("compose-message", "ops", { caseId: caseOf("L-1046") })).toMatchObject({ status: 409, json: { error: "no_plan" } });
  });
});
