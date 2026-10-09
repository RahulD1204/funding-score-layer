// Database access rules, checked against the test Supabase project (never the demo one).
// specs/09-testing.md "Database" and specs/08-security.md rows 1, 3, 4, 5 and 15.
//
// Signs in as the seeded lender, insurer and ops users, plus a second lender this file creates and
// removes, and tries to read and change what each should not. Needs the test project migrated and
// seeded (npm run db:migrate, npm run db:seed). Skipped when the test project's variables are missing.
//
// Fixture rows carry the TEST-ACCESS prefix and are removed afterwards, except the audit_log row,
// which cannot be removed: that is the point of the table.

import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_SSL, DEMO_USERS, demoPassword } from "@/scripts/targets";

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

// specs/04-data-model.md
const MERCHANT_TABLES = ["profiles", "merchants", "products", "fix_settings", "merchant_cases", "schedule_options", "desk_items"];
const INTERNAL_TABLES = [
  "customers", "obligations", "consents", "transactions", "bank_downtimes", "customer_signals", "predictions",
  "debit_events", "triage_results", "cases", "plan_actions", "audit_log", "messages", "model_card",
];
const SYSTEM_TABLES = ["sim_clock", "sim_truth", "prompts", "llm_runs", "usage"];
const CLOSED_TABLES = [...INTERNAL_TABLES, ...SYSTEM_TABLES];

const FIRST_LENDER = "m-northfield";
const INSURER = "m-harbour";
const SECOND = {
  merchantId: "m-test-second-lender",
  productId: "p-test-second-lender",
  email: "second-lender@fsl-test.example",
  password: randomBytes(24).toString("base64url"),
};
const LENDER_CASE = "TEST-ACCESS-LENDER";
const INSURER_CASE = "TEST-ACCESS-INSURER";
const EVENT = "TEST-ACCESS-EVENT";
const FIXTURE_CYCLE = "2000-01-02";

type Who = "lender" | "insurer" | "ops" | "second lender";
type Row = Record<string, unknown>;

/** Which merchant a merchant-table row belongs to. */
function merchantOf(table: string, row: Row): unknown {
  return table === "merchants" ? row.id : row.merchant_id;
}

/** A read is blocked when the database refuses it or returns no rows. */
function readBlocked(res: { data: unknown[] | null; error: unknown }): boolean {
  return res.error !== null || (res.data ?? []).length === 0;
}

describe.skipIf(!READY)("database access rules (test project)", () => {
  let owner: pg.Client;
  let admin: SupabaseClient;
  const users = new Map<Who, SupabaseClient>();
  const userIds = new Map<Who, string>();
  let auditId: number;

  const ownerRows = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
  const ownerCount = async (table: string) => Number((await ownerRows(`select count(*) from public."${table}"`))[0].count);

  function newClient(key: string): SupabaseClient {
    return createClient(env.TEST_SUPABASE_URL!, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async function signIn(who: Who, email: string, password: string) {
    const client = newClient(env.TEST_SUPABASE_PUBLISHABLE_KEY!);
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`Could not sign in as the ${who}: ${error.message}`);
    users.set(who, client);
    userIds.set(who, data.user.id);
  }

  async function removeFixtures() {
    await owner.query(`delete from public.usage where user_id in (select id from auth.users where email = $1)`, [SECOND.email]);
    await owner.query(`delete from public.llm_runs where purpose = 'test-access'`);
    await owner.query(`delete from public.prompts where name = 'test-access'`);
    for (const table of ["messages", "plan_actions", "desk_items", "schedule_options", "merchant_cases"]) {
      await owner.query(`delete from public."${table}" where case_id like 'TEST-ACCESS%'`);
    }
    await owner.query(`delete from public.triage_results where event_id like 'TEST-ACCESS%'`);
    await owner.query(`delete from public.debit_events where event_id like 'TEST-ACCESS%'`);
    await owner.query(`delete from public.cases where id like 'TEST-ACCESS%'`);
    await owner.query(`delete from public.profiles where merchant_id = $1`, [SECOND.merchantId]);
    await owner.query(`delete from public.fix_settings where merchant_id = $1`, [SECOND.merchantId]);
    await owner.query(`delete from public.products where merchant_id = $1`, [SECOND.merchantId]);
    await owner.query(`delete from public.merchants where id = $1`, [SECOND.merchantId]);
    const stale = await ownerRows(`select id from auth.users where email = $1`, [SECOND.email]);
    for (const { id } of stale) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw new Error(`Could not remove the second lender user: ${error.message}`);
    }
  }

  beforeAll(async () => {
    const demoUrls = [env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_URL].filter(Boolean);
    if (demoUrls.includes(env.TEST_SUPABASE_URL)) throw new Error("TEST_SUPABASE_URL points at the demo project. Refusing to run.");

    owner = new pg.Client({ connectionString: env.TEST_SUPABASE_DB_URL, ssl: DB_SSL });
    await owner.connect();
    admin = newClient(env.TEST_SUPABASE_SECRET_KEY!);
    await removeFixtures();

    if ((await ownerCount("merchants")) < 2) throw new Error("The test project is not seeded. Run npm run db:seed first.");

    // The second lender: its own merchant, product, fix setting and login.
    await owner.query(
      `insert into public.merchants (id, name, type, layer_enabled, kill_switch, polish_on, consent_date)
       values ($1, 'Second Test Lender', 'lender', true, false, false, '2025-01-15')`,
      [SECOND.merchantId],
    );
    await owner.query(
      `insert into public.products (id, merchant_id, name, segment, rail, last_allowed_day, max_representations,
         standing_default, result_delay_days, penal_charge_per_day_paise, bounce_charge_paise, baseline_retry_days)
       values ($1, $2, 'Test loan', 'lending', 'bank_mandate', 10, 2, 'Balanced', 2, 800, 50000, '{3,6,9}')`,
      [SECOND.productId, SECOND.merchantId],
    );
    await owner.query(`insert into public.fix_settings values ($1, 'stop_attempts', 'automatic')`, [SECOND.merchantId]);
    const { data: created, error } = await admin.auth.admin.createUser({ email: SECOND.email, password: SECOND.password, email_confirm: true });
    if (error || !created.user) throw new Error(`Could not create the second lender user: ${error?.message}`);
    await owner.query(`insert into public.profiles (user_id, role, merchant_id) values ($1, 'lender', $2)`, [created.user.id, SECOND.merchantId]);

    // One case per seeded merchant, with something in every merchant, internal and system table.
    const [lenderObligation] = await ownerRows(`select id from public.obligations where merchant_id = $1 order by id limit 1`, [FIRST_LENDER]);
    const [insurerObligation] = await ownerRows(`select id from public.obligations where merchant_id = $1 order by id limit 1`, [INSURER]);
    for (const [caseId, obligationId] of [[LENDER_CASE, lenderObligation.id], [INSURER_CASE, insurerObligation.id]]) {
      await owner.query(
        `insert into public.cases (id, obligation_id, cycle_due_date, route, state, policy_version)
         values ($1, $2, $3, 'schedules', 'awaiting_choice', 'test')`,
        [caseId, obligationId, FIXTURE_CYCLE],
      );
    }
    await owner.query(
      `insert into public.merchant_cases (case_id, merchant_id, customer_label, kind, amount_paise, due_date, state, retries_allowed)
       values ($1, $2, 'Test Customer', 'EMI', 1200000, $4, 'awaiting_choice', 2),
              ($3, $5, 'Test Customer', 'premium', 250000, $4, 'scheduled', 3)`,
      [LENDER_CASE, FIRST_LENDER, INSURER_CASE, FIXTURE_CYCLE, INSURER],
    );
    await owner.query(
      `insert into public.schedule_options (case_id, merchant_id, label, merged_labels, attempt_days, main_day, band,
         attempts, days_overdue, waiting_charge_paise, days_later_than_original, extra_charge_paise)
       values ($1, $2, 'Earliest', '{Earliest}', '{5,8}', 5, 'Medium', 2, 5, 4000, 2, 1600),
              ($1, $2, 'Balanced', '{Balanced}', '{6,9}', 6, 'High', 2, 6, 4800, 3, 2400)`,
      [LENDER_CASE, FIRST_LENDER],
    );
    await owner.query(
      `insert into public.desk_items (merchant_id, case_id, trigger, fix_type, reason, mode)
       values ($1, $2, 'bank_downtime', 'hold_and_represent', 'Test reason', 'automatic'),
              ($3, $4, 'mandate_paused', 'send_resume_request', 'Test reason', 'needs_approval')`,
      [FIRST_LENDER, LENDER_CASE, INSURER, INSURER_CASE],
    );
    await owner.query(
      `insert into public.debit_events (event_id, event_type, obligation_id, cycle_due_date, reason_code, clock_date)
       values ($1, 'debit.failed', $2, $3, 'insufficient_funds', $3)`,
      [EVENT, lenderObligation.id, FIXTURE_CYCLE],
    );
    await owner.query(`insert into public.triage_results (event_id, label, decided_by) values ($1, 'balance', 'rule')`, [EVENT]);
    await owner.query(`insert into public.plan_actions (case_id, action_number, kind, day, status) values ($1, 1, 'attempt', 6, 'planned')`, [LENDER_CASE]);
    await owner.query(
      `insert into public.messages (case_id, audience, channel, body, source, template_version)
       values ($1, 'customer', 'sms', 'Test message', 'template', 'test')`,
      [LENDER_CASE],
    );
    await owner.query(`insert into public.prompts (name, version, text) values ('test-access', 'v1', 'Test prompt')`);
    await owner.query(`insert into public.llm_runs (purpose, status) values ('test-access', 'ok')`);
    await owner.query(`insert into public.usage (user_id, date, agent_runs) values ($1, $2, 1)`, [created.user.id, FIXTURE_CYCLE]);

    // The server's way in: the secret key may append to the audit log.
    const { data: audit, error: auditError } = await admin
      .from("audit_log")
      .insert({ clock_date: FIXTURE_CYCLE, actor: "test:access", decision: "test_row", policy_version: "test" })
      .select("id")
      .single();
    if (auditError) throw new Error(`The secret key could not append to audit_log: ${auditError.message}`);
    auditId = audit.id;

    for (const user of DEMO_USERS) await signIn(user.key, user.email, demoPassword(user));
    await signIn("second lender", SECOND.email, SECOND.password);
  }, 120_000);

  afterAll(async () => {
    if (!owner) return;
    await removeFixtures();
    await owner.end();
  }, 60_000);

  it("has the 26 tables of specs/04 in their three groups, every one with row-level security on", async () => {
    const rows = await ownerRows(
      `select c.relname as name, obj_description(c.oid, 'pg_class') as comment, c.relrowsecurity as rls
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
    );
    const group = (prefix: string) => rows.filter((r) => String(r.comment).startsWith(`${prefix}:`)).map((r) => r.name).sort();
    expect(rows).toHaveLength(26);
    expect(group("merchant-readable")).toEqual([...MERCHANT_TABLES].sort());
    expect(group("internal")).toEqual([...INTERNAL_TABLES].sort());
    expect(group("system")).toEqual([...SYSTEM_TABLES].sort());
    expect(rows.filter((r) => !r.rls).map((r) => r.name)).toEqual([]);
  });

  it("merchant tables have no score, percentage, confidence, tier, funded day, salary, income, employer or archetype column", async () => {
    const rows = await ownerRows(
      `select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name = any($1)`,
      [MERCHANT_TABLES],
    );
    const banned = /score|percent|confidence|tier|funded|salary|income|employer|archetype|likelihood|probab/;
    const found = rows.filter((r) => banned.test(r.column_name) || r.column_name === "h" || r.column_name === "u");
    expect(found.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([]);
  });

  describe.each(["lender", "insurer", "second lender"] as Who[])("signed in as the %s", (who) => {
    it("reads no row of any internal or system table", async () => {
      const leaks: string[] = [];
      for (const table of CLOSED_TABLES) {
        expect(await ownerCount(table), `${table} should hold rows for this check to mean anything`).toBeGreaterThan(0);
        const res = await users.get(who)!.from(table).select("*").limit(5);
        if (!readBlocked(res)) leaks.push(`${table} (${res.data!.length} rows)`);
      }
      expect(leaks).toEqual([]);
    });

    it("sees only its own merchant's rows in the merchant tables, and only its own profile", async () => {
      const own = who === "lender" ? FIRST_LENDER : who === "insurer" ? INSURER : SECOND.merchantId;
      const foreign: string[] = [];
      for (const table of MERCHANT_TABLES) {
        const { data, error } = await users.get(who)!.from(table).select("*");
        expect(error).toBeNull();
        for (const row of data ?? []) if (merchantOf(table, row) !== own) foreign.push(`${table}: ${String(merchantOf(table, row))}`);
      }
      expect(foreign).toEqual([]);
      const { data: profiles } = await users.get(who)!.from("profiles").select("user_id");
      expect(profiles).toEqual([{ user_id: userIds.get(who) }]);
      const { data: merchants } = await users.get(who)!.from("merchants").select("id");
      expect(merchants).toEqual([{ id: own }]);
    });

    it("cannot write a merchant table directly", async () => {
      const own = who === "lender" ? FIRST_LENDER : who === "insurer" ? INSURER : SECOND.merchantId;
      const client = users.get(who)!;
      const attempts = [
        await client.from("merchants").update({ kill_switch: true }).eq("id", own),
        await client.from("fix_settings").update({ mode: "automatic" }).eq("merchant_id", own),
        await client.from("products").update({ last_allowed_day: 30 }).eq("merchant_id", own),
        await client.from("merchant_cases").update({ state: "paid" }).eq("merchant_id", own),
        await client.from("desk_items").update({ status: "approved" }).eq("merchant_id", own),
        await client.from("schedule_options").update({ chosen: true }).eq("merchant_id", own),
        await client.from("merchant_cases").insert({
          case_id: LENDER_CASE, merchant_id: own, customer_label: "x", kind: "EMI", amount_paise: 1, due_date: FIXTURE_CYCLE, state: "paid", retries_allowed: 0,
        }),
        await client.from("desk_items").delete().eq("merchant_id", own),
      ];
      expect(attempts.map((a) => a.error?.code)).toEqual(Array(attempts.length).fill("42501"));
      const [m] = await ownerRows(`select kill_switch from public.merchants where id = $1`, [own]);
      expect(m.kill_switch).toBe(false);
    });
  });

  it("ops reads internal and system tables, but not the ground truth in sim_truth", async () => {
    const ops = users.get("ops")!;
    for (const table of CLOSED_TABLES.filter((t) => t !== "sim_truth")) {
      const { data, error } = await ops.from(table).select("*").limit(1);
      expect(error, table).toBeNull();
      expect(data, table).toHaveLength(1);
    }
    expect(readBlocked(await ops.from("sim_truth").select("*").limit(1))).toBe(true);
    const { data: merchants } = await ops.from("merchants").select("id");
    expect(merchants!.length).toBeGreaterThanOrEqual(3);
  });

  it("the insurer cannot read schedule_options; the first lender reads only its own", async () => {
    expect(await ownerCount("schedule_options")).toBeGreaterThan(0);
    const insurer = await users.get("insurer")!.from("schedule_options").select("*");
    expect(readBlocked(insurer)).toBe(true);

    const lender = await users.get("lender")!.from("schedule_options").select("case_id, label").order("label");
    expect(lender.error).toBeNull();
    expect(lender.data).toEqual([
      { case_id: LENDER_CASE, label: "Balanced" },
      { case_id: LENDER_CASE, label: "Earliest" },
    ]);
  });

  it("schedule options can never be stored for an insurer, even by the database owner", async () => {
    await expect(
      owner.query(
        `insert into public.schedule_options (case_id, merchant_id, label, merged_labels, attempt_days, main_day, band, attempts, days_overdue)
         values ($1, $2, 'Earliest', '{Earliest}', '{3}', 3, 'High', 1, 3)`,
        [INSURER_CASE, INSURER],
      ),
    ).rejects.toThrow(/lenders only/);
  });

  it("a second lender sees none of the first lender's rows", async () => {
    const second = users.get("second lender")!;
    const firstLenderUser = userIds.get("lender");
    for (const table of MERCHANT_TABLES) {
      // The first lender has rows in every merchant table, so an empty answer means the rule held.
      const firstRows = await ownerRows(
        table === "merchants"
          ? `select 1 from public.merchants where id = $1`
          : `select 1 from public."${table}" where merchant_id = $1`,
        [FIRST_LENDER],
      );
      expect(firstRows.length, `${table} needs a first-lender row`).toBeGreaterThan(0);

      const { data, error } = await second.from(table).select("*");
      expect(error).toBeNull();
      const seen = (data ?? []).filter((row) => merchantOf(table, row) === FIRST_LENDER || row.user_id === firstLenderUser);
      expect(seen, table).toEqual([]);
    }
    // Asking for the first lender's case by its id returns nothing either.
    const direct = await second.from("merchant_cases").select("*").eq("case_id", LENDER_CASE);
    expect(direct.data).toEqual([]);
  });

  it("no user can change their own role or merchant", async () => {
    for (const who of ["lender", "insurer", "second lender", "ops"] as Who[]) {
      const client = users.get(who)!;
      const id = userIds.get(who)!;
      const [before] = await ownerRows(`select role, merchant_id from public.profiles where user_id = $1`, [id]);

      const attempts = [
        await client.from("profiles").update({ role: who === "ops" ? "lender" : "ops" }).eq("user_id", id),
        await client.from("profiles").update({ merchant_id: who === "lender" ? INSURER : FIRST_LENDER }).eq("user_id", id),
        await client.from("profiles").upsert({ user_id: id, role: "ops", merchant_id: null }),
        await client.from("profiles").delete().eq("user_id", id),
      ];
      expect(attempts.map((a) => a.error?.code), who).toEqual(["42501", "42501", "42501", "42501"]);

      const [after] = await ownerRows(`select role, merchant_id from public.profiles where user_id = $1`, [id]);
      expect(after, who).toEqual(before);
    }
  });

  it("writing 'ops' into the login's own metadata gives no extra access", async () => {
    const lender = users.get("lender")!;
    const { error } = await lender.auth.updateUser({ data: { role: "ops" } });
    expect(error).toBeNull();
    await lender.auth.refreshSession();
    expect(readBlocked(await lender.from("customers").select("*").limit(1))).toBe(true);
    const [profile] = await ownerRows(`select role from public.profiles where user_id = $1`, [userIds.get("lender")]);
    expect(profile.role).toBe("lender");
    await lender.auth.updateUser({ data: { role: null } });
  });

  it("audit_log cannot be updated or deleted by any role, the secret key and the database owner included", async () => {
    const callers: [string, SupabaseClient][] = [
      ["lender", users.get("lender")!],
      ["insurer", users.get("insurer")!],
      ["ops", users.get("ops")!],
      ["secret key", admin],
    ];
    for (const [who, client] of callers) {
      const update = await client.from("audit_log").update({ decision: "tampered" }).eq("id", auditId);
      const remove = await client.from("audit_log").delete().eq("id", auditId);
      expect([update.error?.code, remove.error?.code], who).toEqual(["42501", "42501"]);
    }
    await expect(owner.query(`update public.audit_log set decision = 'tampered' where id = $1`, [auditId])).rejects.toThrow(/append-only/);
    await expect(owner.query(`delete from public.audit_log where id = $1`, [auditId])).rejects.toThrow(/append-only/);

    const rows = await ownerRows(`select decision from public.audit_log where id = $1`, [auditId]);
    expect(rows).toEqual([{ decision: "test_row" }]);
  });

  it("without a login, no table is readable", async () => {
    const anon = newClient(env.TEST_SUPABASE_PUBLISHABLE_KEY!);
    const open: string[] = [];
    for (const table of [...MERCHANT_TABLES, ...CLOSED_TABLES]) {
      if (!readBlocked(await anon.from(table).select("*").limit(1))) open.push(table);
    }
    expect(open).toEqual([]);
  });
});
