// Applies the SQL files in supabase/migrations/ that the database has not seen yet, oldest first.
// Each file runs in one transaction, so a failed file leaves nothing half-done.
// Applied files are recorded in supabase_migrations.schema_migrations, the table the Supabase CLI uses.
//
//   npm run db:migrate                     the test project
//   npm run db:migrate -- --target demo    the demo project

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { DB_SSL, loadTarget, targetFromArgs } from "./targets";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "supabase", "migrations");

async function main() {
  const config = loadTarget(targetFromArgs(process.argv));
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

  const db = new pg.Client({ connectionString: config.dbUrl, ssl: DB_SSL });
  await db.connect();
  try {
    await db.query(`
      create schema if not exists supabase_migrations;
      create table if not exists supabase_migrations.schema_migrations (
        version text primary key, statements text[], name text
      )`);
    const done = new Set((await db.query("select version from supabase_migrations.schema_migrations")).rows.map((r) => r.version));

    console.log(`Target: ${config.target} project`);
    let applied = 0;
    for (const file of files) {
      const [version, ...rest] = file.replace(/\.sql$/, "").split("_");
      if (done.has(version)) {
        console.log(`  already applied  ${file}`);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await db.query("begin");
      try {
        await db.query(sql);
        await db.query("insert into supabase_migrations.schema_migrations (version, statements, name) values ($1, $2, $3)", [
          version,
          [sql],
          rest.join("_"),
        ]);
        await db.query("commit");
      } catch (error) {
        await db.query("rollback");
        throw new Error(`${file} failed and was rolled back: ${(error as Error).message}`);
      }
      console.log(`  applied          ${file}`);
      applied++;
    }
    console.log(applied === 0 ? "Nothing to apply." : `Applied ${applied} migration(s).`);
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(`Migration stopped: ${(error as Error).message}`);
  process.exit(1);
});
