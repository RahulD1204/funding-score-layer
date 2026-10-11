// Replayed history (specs/00 "Replayed history"). Plays every failed February and March 2026 debit of
// the app's obligations through the real server functions, with the demo clock walking day by day,
// so the screens open with two months of resolved cases. Called by scripts/seed.ts after the tables
// are loaded. Standing defaults apply (nobody picks), and no model is called: the agents and polish
// fall back as designed, which keeps the history the same on every seed and spends nothing.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Caller } from "@/lib/server/auth";
import { advanceDay } from "@/lib/server/flows/advance-day";
import { processDebitEvent } from "@/lib/server/flows/process-debit-event";
import { addDays } from "../lib/engine/dates";
import type { TargetConfig } from "./targets";

/** The actor the replay's own audit rows carry. */
export const HISTORY_ACTOR = "system:history-replay";

function must<T>(r: { data: T | null; error: unknown }): T {
  if (r.error) throw r.error;
  return r.data as T;
}

/** Builds the history up to `until` (the seeded demo date), leaving the clock there. Returns case counts by route. */
export async function buildHistory(config: TargetConfig, until: string): Promise<Record<string, number>> {
  // No model call during the replay: without a model name, every agent and polish call is unavailable
  // before it claims a daily run, and the rules' fallbacks apply.
  delete process.env.CLAUDE_MODEL_FAST;
  delete process.env.CLAUDE_MODEL_SMART;
  delete process.env.ANTHROPIC_API_KEY;

  const db: SupabaseClient = createClient(config.url, config.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const ops = must(await db.from("profiles").select("user_id").eq("role", "ops").limit(1)) as { user_id: string }[];
  if (ops.length === 0) throw new Error("No ops profile: the demo users must be seeded first.");
  const caller: Caller = { userId: ops[0].user_id, role: "ops", merchantId: null, actor: HISTORY_ACTOR };

  const failures = must(
    await db
      .from("sim_truth")
      .select("obligation_id, cycle_due_date, reason_code, bank_text")
      .lt("cycle_due_date", until)
      .not("reason_code", "is", null)
      .order("cycle_due_date")
      .order("obligation_id"),
  ) as { obligation_id: string; cycle_due_date: string; reason_code: string; bank_text: string | null }[];
  if (failures.length === 0) return {};

  const byDay = new Map<string, typeof failures>();
  for (const f of failures) byDay.set(f.cycle_due_date, [...(byDay.get(f.cycle_due_date) ?? []), f]);

  let today = failures[0].cycle_due_date;
  must(await db.from("sim_clock").update({ today }).eq("id", true).select("today"));
  const routes: Record<string, number> = {};
  for (;;) {
    // Each failure is injected on its due date, inside the window process-debit-event accepts.
    for (const f of byDay.get(today) ?? []) {
      const result = await processDebitEvent({
        db,
        caller,
        body: {
          eventId: `HIST-${f.obligation_id}-${f.cycle_due_date}`,
          eventType: "debit.failed",
          obligationId: f.obligation_id,
          cycleDueDate: f.cycle_due_date,
          reasonCode: f.reason_code,
          bankText: f.bank_text,
        },
      });
      const route = String((result.body as { route?: string }).route ?? (result.body as { error?: string }).error ?? "other");
      routes[route] = (routes[route] ?? 0) + 1;
    }
    if (today >= until) break;
    await advanceDay({ db, caller, body: {} });
    today = addDays(today, 1);
    if (today.endsWith("-01") || today.endsWith("-15")) console.log(`  history: ${today}`);
  }
  return routes;
}
