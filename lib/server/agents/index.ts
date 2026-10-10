// The three agents of specs/07: Failure Triage, the exceptions desk and the Ops assistant.
// Each is a model tier, a prompt, its listed tools and the shape of its answer. What an answer
// means is decided by the engine: acceptAgentTriage, validateDeskOutput and validateOpsAnswer.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FAILURE_LABELS,
  FIX_TYPES,
  acceptAgentTriage,
  validateDeskOutput,
  validateOpsAnswer,
  type AgentTriageContext,
  type FixSettings,
  type ISODate,
  type OpsAnswerDecision,
} from "@/lib/engine";
import type { ObligationRow } from "../store";
import { runAgent, type AgentRun } from "./runner";
import { deskTools, opsTools, triageTools, type AuditCitation, type DeskCaseFacts } from "./tools";

const TRIAGE_ANSWER = {
  type: "object",
  properties: {
    label: { type: "string", enum: [...FAILURE_LABELS] },
    strength: { type: "string", enum: ["strong", "weak"] },
    evidence: { type: "array", items: { type: "string" } },
  },
  required: ["label", "strength", "evidence"],
  additionalProperties: false,
};

const DESK_ANSWER = {
  type: "object",
  properties: {
    fixes: {
      type: "array",
      items: {
        type: "object",
        properties: { fix: { type: "string", enum: [...FIX_TYPES] }, reason: { type: "string" } },
        required: ["fix", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["fixes"],
  additionalProperties: false,
};

const OPS_ANSWER = {
  type: "object",
  properties: {
    answer: { type: "string" },
    cited_audit_ids: { type: "array", items: { type: "integer" } },
  },
  required: ["answer", "cited_audit_ids"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------

export interface TriageAsk {
  userId: string;
  ob: ObligationRow;
  dueDate: ISODate;
  reasonCode: string;
  bankText: string | null;
  /** The lookups code already did. acceptAgentTriage re-checks a balance label against them. */
  context: AgentTriageContext;
}

/** Asks the Triage agent. Pass `run.answer` (null when there is none) to evaluateFailedDebit as agentTriage. */
export function askTriageAgent(db: SupabaseClient, ask: TriageAsk): Promise<AgentRun> {
  return runAgent(db, {
    agent: "triage",
    prompt: "triage_agent",
    tier: "fast",
    effort: "low",
    tools: triageTools(db, ask.ob, ask.dueDate),
    outputSchema: TRIAGE_ANSWER,
    input: { reason_code: ask.reasonCode, bank_text: ask.bankText ?? "" },
    userId: ask.userId,
    judge: (answer) => acceptAgentTriage(answer, ask.context),
  });
}

/** Asks the desk agent. Its answer goes to validateDeskOutput as `answer.fixes`. */
export function askDeskAgent(db: SupabaseClient, userId: string, facts: DeskCaseFacts, settings: FixSettings): Promise<AgentRun> {
  return runAgent(db, {
    agent: "desk",
    prompt: "desk_agent",
    tier: "smart",
    effort: "medium",
    tools: deskTools(db, facts),
    outputSchema: DESK_ANSWER,
    input: { trigger: facts.trigger, case_id: facts.caseId },
    userId,
    judge: (answer) => (answer ? validateDeskOutput(facts.trigger, answer.fixes, settings) : { usable: false }),
  });
}

export interface OpsAsk {
  run: AgentRun;
  decision: OpsAnswerDecision | null;
  /** The audit rows the answer cites, as the tools returned them. */
  citedRows: AuditCitation[];
}

export async function askOpsAssistant(db: SupabaseClient, userId: string, question: string): Promise<OpsAsk> {
  const seen = new Map<number, AuditCitation>();
  const run = await runAgent(db, {
    agent: "ops",
    prompt: "ops_assistant",
    tier: "smart",
    effort: "medium",
    tools: opsTools(db, seen),
    outputSchema: OPS_ANSWER,
    input: { question },
    userId,
    judge: (answer) => (answer ? validateOpsAnswer(answer, seen.keys()) : { usable: false }),
  });
  const decision = run.answer ? validateOpsAnswer(run.answer, seen.keys()) : null;
  return { run, decision, citedRows: (decision?.cited ?? []).map((id) => seen.get(id)!) };
}

/** A short line for the audit log about one agent run. */
export function agentRunSummary(run: AgentRun) {
  return { runId: run.runId, agent: run.agent, status: run.status, steps: run.steps, model: run.model, promptVersion: run.promptVersion };
}
