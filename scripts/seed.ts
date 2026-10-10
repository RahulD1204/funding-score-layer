// Loads the synthetic data from ml/export/ into a Supabase project, creates the three demo users,
// sets the simulated clock and saves the copy that Reset demo restores. Safe to rerun: it empties
// every table and loads them again.
//
//   npm run db:seed                     the test project
//   npm run db:seed -- --target demo    the demo project
//
// Demo passwords come from DEMO_LENDER_PASSWORD, DEMO_INSURER_PASSWORD and DEMO_OPS_PASSWORD.
// They are never printed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { FIX_CATALOGUE, FIX_TYPES } from "../lib/engine/desk";
import { ALL_PROMPTS } from "../lib/server/agents/prompts";
import { parseCsv } from "./csv";
import { DB_SSL, DEMO_USERS, SEED_TODAY, demoPassword, loadTarget, targetFromArgs, type TargetConfig } from "./targets";

const EXPORT_DIR = join(import.meta.dirname, "..", "ml", "export");

/** CSV files and the tables they fill, in an order that satisfies the foreign keys. */
const CSV_TABLES = [
  "merchants",
  "products",
  "customers",
  "obligations",
  "consents",
  "bank_downtimes",
  "transactions",
  "customer_signals",
  "predictions",
  "sim_truth",
  "model_card",
] as const;

const BATCH_ROWS = 1000;

interface Column {
  name: string;
  /** Postgres type: boolean, integer, bigint, numeric, date, jsonb, text, or ARRAY with udt _int4 or _text. */
  dataType: string;
  udt: string;
}

// ---------------------------------------------------------------------------
// Turning CSV text into database values. ml/README.md: lists and objects are JSON text, empty cells are nulls.
// ---------------------------------------------------------------------------

function toWholeNumber(raw: string, where: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${where}: "${raw}" is not a whole number`);
  return n;
}

function convert(raw: string, column: Column, where: string): unknown {
  if (raw === "") return null;
  switch (column.dataType) {
    case "boolean":
      if (/^true$/i.test(raw)) return true;
      if (/^false$/i.test(raw)) return false;
      throw new Error(`${where}: "${raw}" is not True or False`);
    case "integer":
    case "bigint":
      return toWholeNumber(raw, where);
    case "numeric":
      if (!Number.isFinite(Number(raw))) throw new Error(`${where}: "${raw}" is not a number`);
      return raw;
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`${where}: "${raw}" is not a date`);
      return raw;
    case "jsonb":
      JSON.parse(raw);
      return raw;
    case "ARRAY": {
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) throw new Error(`${where}: "${raw}" is not a list`);
      return column.udt === "_int4" ? list.map((v) => toWholeNumber(String(v), where)) : list.map(String);
    }
    default:
      return raw;
  }
}

async function columnsOf(db: pg.Client, table: string): Promise<Map<string, Column>> {
  const { rows } = await db.query(
    `select column_name, data_type, udt_name from information_schema.columns
     where table_schema = 'public' and table_name = $1`,
    [table],
  );
  return new Map(rows.map((r) => [r.column_name, { name: r.column_name, dataType: r.data_type, udt: r.udt_name }]));
}

async function insertRows(db: pg.Client, table: string, columns: string[], rows: unknown[][]) {
  for (let start = 0; start < rows.length; start += BATCH_ROWS) {
    const batch = rows.slice(start, start + BATCH_ROWS);
    const params: unknown[] = [];
    const tuples = batch.map((row) => {
      const slots = row.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${slots.join(", ")})`;
    });
    const names = columns.map((c) => `"${c}"`).join(", ");
    await db.query(`insert into public."${table}" (${names}) values ${tuples.join(", ")}`, params);
  }
}

async function loadCsv(db: pg.Client, table: string): Promise<number> {
  const records = parseCsv(readFileSync(join(EXPORT_DIR, `${table}.csv`), "utf8"));
  if (records.length === 0) return 0;
  const tableColumns = await columnsOf(db, table);
  const header = Object.keys(records[0]);
  const unknown = header.filter((h) => !tableColumns.has(h));
  if (unknown.length > 0) throw new Error(`${table}.csv has columns the table does not: ${unknown.join(", ")}`);
  const rows = records.map((record, n) =>
    header.map((name) => convert(record[name], tableColumns.get(name)!, `${table}.csv row ${n + 2}, ${name}`)),
  );
  await insertRows(db, table, header, rows);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Demo users. Created through Supabase's login service, so the passwords are stored hashed.
// ---------------------------------------------------------------------------

async function ensureDemoUsers(config: TargetConfig): Promise<Map<string, string>> {
  const admin = createClient(config.url, config.secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error(`Could not list users: ${error.message}`);

  const ids = new Map<string, string>();
  for (const user of DEMO_USERS) {
    const password = demoPassword(user);
    const existing = data.users.find((u) => u.email === user.email);
    if (existing) {
      const { error: updateError } = await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
      if (updateError) throw new Error(`Could not update the ${user.key} user: ${updateError.message}`);
      ids.set(user.key, existing.id);
      console.log(`  ${user.key.padEnd(8)} user exists, password reset from ${user.passwordVariable}  (${user.email})`);
    } else {
      const { data: created, error: createError } = await admin.auth.admin.createUser({ email: user.email, password, email_confirm: true });
      if (createError || !created.user) throw new Error(`Could not create the ${user.key} user: ${createError?.message}`);
      ids.set(user.key, created.user.id);
      console.log(`  ${user.key.padEnd(8)} user created, password from ${user.passwordVariable}  (${user.email})`);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------

async function main() {
  const config = loadTarget(targetFromArgs(process.argv));
  // Read every password before touching anything, so a missing one stops the seed early.
  DEMO_USERS.forEach(demoPassword);
  console.log(`Target: ${config.target} project`);

  console.log("Demo users:");
  const userIds = await ensureDemoUsers(config);

  const db = new pg.Client({ connectionString: config.dbUrl, ssl: DB_SSL });
  await db.connect();
  const counts: [string, number][] = [];
  try {
    await db.query("begin");
    const { rows: tables } = await db.query("select tablename from pg_tables where schemaname = 'public' order by tablename");
    await db.query(`truncate table ${tables.map((t) => `public."${t.tablename}"`).join(", ")} restart identity cascade`);

    for (const table of CSV_TABLES) counts.push([table, await loadCsv(db, table)]);

    // Every fix starts in the catalogue's starting mode: anything that contacts a customer needs approval.
    const { rows: merchants } = await db.query("select id from public.merchants order by id");
    const fixRows = merchants.flatMap((m) => FIX_TYPES.map((fix) => [m.id, fix, FIX_CATALOGUE[fix].startingMode]));
    await insertRows(db, "fix_settings", ["merchant_id", "fix_type", "mode"], fixRows);
    counts.push(["fix_settings", fixRows.length]);

    const profileRows = DEMO_USERS.map((u) => [userIds.get(u.key), u.role, u.merchantId]);
    await insertRows(db, "profiles", ["user_id", "role", "merchant_id"], profileRows);
    counts.push(["profiles", profileRows.length]);

    await db.query("insert into public.sim_clock (today) values ($1)", [SEED_TODAY]);
    counts.push(["sim_clock", 1]);

    // The agents' system prompts and the polish prompt, each active at its current version (specs/07).
    const promptRows = Object.entries(ALL_PROMPTS).map(([name, p]) => [name, p.version, p.text, true]);
    await insertRows(db, "prompts", ["name", "version", "text", "active"], promptRows);
    counts.push(["prompts", promptRows.length]);

    // The copy Reset demo restores the seeded settings and clock from (migration 20261010000003).
    await db.query("select private.take_seed_snapshot()");

    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    await db.end();
  }

  console.log("Rows loaded:");
  for (const [table, n] of counts) console.log(`  ${table.padEnd(18)} ${n.toLocaleString("en-IN")}`);
  console.log(`sim_clock.today is ${SEED_TODAY}.`);
}

main().catch((error) => {
  console.error(`Seed stopped, nothing was changed in the tables: ${(error as Error).message}`);
  process.exit(1);
});
