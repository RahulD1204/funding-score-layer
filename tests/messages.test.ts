// Customer message text (specs/06 section 9, specs/07 "Message polish", specs/09 "Messages"),
// with the model mocked and a stand-in for the database. No test calls Claude.
//
//   20 filled templates keep their amount and dates and contain no banned word; polish sends only
//   the filled template; a rewrite is used only if validatePolish passes; a failed, refused,
//   malformed or rejected call keeps the template; every call is one llm_runs row; the daily limit
//   stops the call; polish off makes no call; a link's text is never polished.
// The flows through the real server functions are in tests/db/messages.test.ts.

import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, buildLinkMessage, buildRetryMessage, findBannedWords, validatePolish } from "@/lib/engine";
import { POLISH_PROMPT } from "@/lib/server/agents/prompts";
import { composeCaseMessages, type MessageCase } from "@/lib/server/flows/compose-message";
import { polishMessage } from "@/lib/server/polish";
import type { ObligationRow } from "@/lib/server/store";

// ---------------------------------------------------------------------------
// The model: a queue of answers. An empty queue means the model is unavailable.
// ---------------------------------------------------------------------------

type Params = Anthropic.MessageCreateParamsNonStreaming;
type Responder = (params: Params) => Anthropic.Message;
const model = vi.hoisted(() => ({ queue: [] as unknown[], calls: [] as unknown[] }));

vi.mock("@/lib/server/agents/model", () => ({
  modelFor: (tier: string) => `test-model-${tier}`,
  createMessage: async (params: Params) => {
    model.calls.push(structuredClone(params));
    const next = model.queue.shift() as Responder | Error | undefined;
    if (!next) throw new Error("The model is unavailable in this test.");
    if (next instanceof Error) throw next;
    return next(params);
  },
}));

function message(text: string, stop_reason: Anthropic.StopReason = "end_turn"): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [{ type: "text", text }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 80, output_tokens: 30 },
  } as unknown as Anthropic.Message;
}
const rewrites = (rewrite: string): Responder => () => message(JSON.stringify({ rewrite }));
const sent = () => model.calls as Params[];

// ---------------------------------------------------------------------------
// A stand-in for the database: the active prompt, the daily limit, llm_runs and stored messages.
// ---------------------------------------------------------------------------

function fakeDb({ allowRun = true } = {}) {
  const logged: Record<string, unknown>[] = [];
  const stored: { p_message: Record<string, unknown>; p_audit: Record<string, unknown> }[] = [];
  const rpcs: string[] = [];
  const db = {
    from(table: string) {
      if (table === "prompts") {
        const result = { data: { version: POLISH_PROMPT.version, text: POLISH_PROMPT.text }, error: null };
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => result }) }) }) };
      }
      if (table === "llm_runs") {
        return {
          insert: async (row: Record<string, unknown>) => {
            logged.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`Message text must not read ${table}.`);
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push(name);
      if (name === "claim_agent_run") return { data: allowRun, error: null };
      if (name === "store_customer_message") {
        stored.push(args as (typeof stored)[number]);
        return { data: stored.length, error: null };
      }
      throw new Error(`Unexpected database function ${name}.`);
    },
  };
  return { db: db as unknown as SupabaseClient, logged, stored, rpcs };
}

// ---------------------------------------------------------------------------

const DUE = "2026-04-02";
const LENDING = buildRetryMessage({ segment: "lending", merchantName: "Northfield Finance", amountPaise: 12_000_00, dueDate: DUE, plannedDate: "2026-04-08" });
const KIND_WORDS = "Your Northfield Finance EMI of Rs 12,000 didn't go through on 2 April. No need to do anything: we'll try again on 8 April.";

const polish = (db: SupabaseClient, userId: string | null = "user-1") =>
  polishMessage(db, { userId, caseId: "L-1041:2026-04-02", messageType: "retry", message: LENDING });

beforeEach(() => {
  model.queue = [];
  model.calls = [];
});

describe("filled templates", () => {
  it("20 filled templates keep their amount and dates and contain no banned word", () => {
    const amounts = [1_00, 48_50, 2_500_00, 12_000_00, 1_25_000_00];
    const built = amounts.flatMap((amountPaise, i) => {
      const dueDate = addDays("2026-01-05", i * 37);
      const plannedDate = addDays(dueDate, 3 + i);
      return [
        buildRetryMessage({ segment: "lending", merchantName: "Northfield Finance", amountPaise, dueDate, plannedDate }),
        buildRetryMessage({ segment: "insurance", merchantName: "Harbour Life", amountPaise, dueDate, plannedDate, graceEnd: addDays(dueDate, 15) }),
        buildRetryMessage({ segment: "lending", merchantName: "Test Lender Two", amountPaise, dueDate, plannedDate: addDays(dueDate, 28) }),
        buildLinkMessage({ kind: i % 2 ? "EMI" : "premium", merchantName: "Harbour Life", amountPaise, link: "[payment link]" }),
      ];
    });
    expect(built).toHaveLength(20);
    for (const m of built) {
      expect(m.text).toContain(m.facts.amount);
      for (const d of m.facts.dates) expect(m.text).toContain(d);
      expect(findBannedWords(m.text)).toEqual([]);
      // The template itself always passes the check a rewrite must pass.
      expect(validatePolish(m.text, m.facts), m.text).toEqual({ ok: true, problems: [] });
    }
  });
});

describe("polish", () => {
  it("sends only the filled template, with the fast model, the stored prompt and no tools", async () => {
    const { db } = fakeDb();
    model.queue.push(rewrites(KIND_WORDS));
    await polish(db);
    expect(sent()).toHaveLength(1);
    const [params] = sent();
    expect(params.model).toBe("test-model-fast");
    expect(params.system).toBe(POLISH_PROMPT.text);
    expect(params.messages).toEqual([{ role: "user", content: LENDING.text }]);
    expect(params.tools).toBeUndefined();
  });

  it("uses a rewrite that keeps every fact, and logs the call", async () => {
    const { db, logged } = fakeDb();
    model.queue.push(rewrites(KIND_WORDS));
    expect(await polish(db)).toEqual({ text: KIND_WORDS, source: "polished", status: "accepted", problems: [] });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      user_id: "user-1",
      purpose: "message_polish",
      agent: null,
      model: "test-model-fast",
      prompt_version: POLISH_PROMPT.version,
      steps: 1,
      status: "accepted",
      input_fields: { case_id: "L-1041:2026-04-02", message_type: "retry", text: LENDING.text },
      validation_result: { used: "polished", problems: [] },
    });
  });

  it.each([
    ["a changed date", KIND_WORDS.replace("8 April", "9 April"), ["date missing: 8 apr", "unexpected date 9 apr"]],
    ["an extra amount", `${KIND_WORDS} A late fee of Rs 500 may apply.`, ["unexpected amount 500"]],
    ["a banned word", KIND_WORDS.replace("No need to do anything", "Once your salary arrives"), ["banned word: salary"]],
    ["a missing name", KIND_WORDS.replace("Northfield Finance ", ""), ["merchant name missing"]],
  ])("keeps the template when the rewrite has %s", async (_, rewrite, problems) => {
    const { db, logged } = fakeDb();
    model.queue.push(rewrites(rewrite));
    expect(await polish(db)).toEqual({ text: LENDING.text, source: "template", status: "rejected", problems });
    expect(logged[0]).toMatchObject({ status: "rejected", validation_result: { used: "template", problems } });
  });

  it("keeps the template when the call fails, and logs the error", async () => {
    const { db, logged } = fakeDb();
    model.queue.push(new Error("Your credit balance is too low to access the Anthropic API."));
    expect(await polish(db)).toEqual({ text: LENDING.text, source: "template", status: "model_error", problems: [] });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      purpose: "message_polish",
      steps: 1,
      status: "model_error",
      output: { error: "Your credit balance is too low to access the Anthropic API." },
      validation_result: { used: "template", problems: [] },
    });
  });

  it.each([
    ["a refusal", () => message("", "refusal"), "refused"],
    ["a cut-off answer", () => message('{"rewrite": "Your', "max_tokens"), "max_tokens"],
    ["an answer that is not JSON", () => message(KIND_WORDS), "malformed"],
    ["an empty rewrite", rewrites("  "), "malformed"],
  ] as const)("keeps the template on %s", async (_, responder, status) => {
    const { db, logged } = fakeDb();
    model.queue.push(responder);
    expect(await polish(db)).toMatchObject({ text: LENDING.text, source: "template", status });
    expect(logged[0]).toMatchObject({ status });
  });

  it("over the daily limit, makes no call and keeps the template", async () => {
    const { db, logged, rpcs } = fakeDb({ allowRun: false });
    model.queue.push(rewrites(KIND_WORDS));
    expect(await polish(db)).toMatchObject({ source: "template", status: "limit_reached" });
    expect(sent()).toHaveLength(0);
    expect(rpcs).toEqual(["claim_agent_run"]);
    expect(logged[0]).toMatchObject({ steps: 0, status: "limit_reached" });
  });

  it("with no user to count the call against, makes no call", async () => {
    const { db, logged, rpcs } = fakeDb();
    expect(await polish(db, null)).toMatchObject({ source: "template", status: "unavailable" });
    expect(sent()).toHaveLength(0);
    expect(rpcs).toEqual([]);
    expect(logged[0]).toMatchObject({ steps: 0, status: "unavailable" });
  });
});

describe("compose-message", () => {
  function messageCase(polishOn: boolean, segment: "lending" | "insurance" = "lending"): MessageCase {
    const ob = {
      id: "L-1041",
      merchant_id: "m-northfield",
      customer_id: "c-1",
      kind: segment === "lending" ? "EMI" : "premium",
      amount_paise: 12_000_00,
      merchants: { id: "m-northfield", name: "Northfield Finance", type: "lender", layer_enabled: true, kill_switch: false, polish_on: polishOn },
      products: { segment, grace_days: segment === "insurance" ? 15 : null },
      customers: { id: "c-1", label: "Test Borrower", holdout: false },
    } as unknown as ObligationRow;
    return { caseId: "L-1041:2026-04-02", ob, dueDate: DUE };
  }
  const ctx = { userId: "user-1", today: "2026-04-07" };

  it("polish off: stores the template and makes no model call and no llm_runs row", async () => {
    const { db, logged, stored } = fakeDb();
    const out = await composeCaseMessages(db, messageCase(false), [{ type: "retry", actionId: 1, day: 6 }], ctx);
    expect(out).toEqual([{ messageId: 1, type: "retry", source: "template", polish: null, body: LENDING.text }]);
    expect(sent()).toHaveLength(0);
    expect(logged).toEqual([]);
    expect(stored[0].p_message).toMatchObject({
      case_id: "L-1041:2026-04-02",
      audience: "customer",
      channel: "phone_mock",
      body: LENDING.text,
      source: "template",
      template_version: "t1",
      clock_date: "2026-04-07",
      facts: { type: "retry", action_id: 1, planned_date: "2026-04-08", amount: "Rs 12,000", dates: ["2 April", "8 April"], polish: null },
    });
    expect(stored[0].p_audit).toMatchObject({ case_id: "L-1041:2026-04-02", decision: "message_composed:retry", clock_date: "2026-04-07" });
  });

  it("polish on: stores the accepted rewrite, and the outcome travels with the message", async () => {
    const { db, stored } = fakeDb();
    model.queue.push(rewrites(KIND_WORDS));
    const [out] = await composeCaseMessages(db, messageCase(true), [{ type: "retry", actionId: 1, day: 6 }], ctx);
    expect(out).toMatchObject({ source: "polished", polish: "accepted", body: KIND_WORDS });
    expect(stored[0].p_message).toMatchObject({ body: KIND_WORDS, source: "polished", facts: { polish: { status: "accepted", problems: [] } } });
  });

  it("polish on and the call fails: stores the template", async () => {
    const { db, stored, logged } = fakeDb();
    const [out] = await composeCaseMessages(db, messageCase(true), [{ type: "retry", actionId: 1, day: 6 }], ctx);
    expect(out).toMatchObject({ source: "template", polish: "model_error", body: LENDING.text });
    expect(stored[0].p_message).toMatchObject({ body: LENDING.text, source: "template" });
    expect(stored[0].p_audit.internal_reason).toContain("template kept");
    expect(logged).toHaveLength(1);
  });

  it("an insurer's notice carries the end of cover", async () => {
    const { db } = fakeDb();
    const [out] = await composeCaseMessages(db, messageCase(false, "insurance"), [{ type: "retry", actionId: 1, day: 1 }], ctx);
    expect(out.body).toBe(
      "Your premium of Rs 12,000 to Northfield Finance didn't go through on 2 April. We'll try again on 3 April. Your cover continues until 17 April.",
    );
  });

  it("a link's text is never polished, even with polish on", async () => {
    const { db, logged } = fakeDb();
    model.queue.push(rewrites("Pay here: https://example.invalid"));
    const [out] = await composeCaseMessages(db, messageCase(true), [{ type: "link", actionId: 1 }], ctx);
    expect(out).toMatchObject({ type: "link", source: "template", polish: null, body: "You can pay your EMI of Rs 12,000 to Northfield Finance here: [payment link]" });
    expect(sent()).toHaveLength(0);
    expect(logged).toEqual([]);
  });
});
