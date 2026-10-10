// reset-demo (specs/03). Ops only. Puts the demo back to the seeded state through the owner-run
// database function reset_demo (migration 20261010000003): cases, events and the audit log are
// emptied, the seeded settings and clock come back, and one audit row records who reset it.
// Today's agent-run counts are kept (migration 20261010000007), so the cap of 50 is not restarted.

import "server-only";
import { POLICY_VERSION } from "@/lib/engine";
import type { FlowContext, FlowResult } from "../route";

export async function resetDemo({ db, caller }: FlowContext): Promise<FlowResult> {
  const { data, error } = await db.rpc("reset_demo", { p_actor: caller.actor, p_policy_version: POLICY_VERSION });
  if (error) throw error;
  return { body: { today: data as string } };
}
