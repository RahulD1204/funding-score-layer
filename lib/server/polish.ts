// Message polish (specs/07 "Message polish", specs/06 section 9). One call to Claude with no tools,
// not an agent, so it does not use the agent runner's loop:
//
//   1. Read the fast model's name and the active message_polish prompt. Missing either: unavailable.
//   2. Count the call against the user's daily limit of agent runs (decided 10 October 2026). Over it: no call.
//   3. Send the filled template and nothing else. The answer's shape is fixed by a JSON schema.
//   4. validatePolish decides. Only a rewrite that keeps every fact and has no banned word is used.
//
// Anything else (an error, a timeout, a refusal, a malformed or rejected answer) keeps the template.
// Every attempt is one llm_runs row with purpose "message_polish", including the ones that made no call.

import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { POLICY, validatePolish, type BuiltMessage } from "@/lib/engine";
import { createMessage, modelFor } from "./agents/model";
import { claimRun, loadPrompt } from "./agents/runner";
import { errorText } from "./store";

export type PolishStatus =
  | "accepted"
  | "rejected"
  | "malformed"
  | "refused"
  | "max_tokens"
  | "model_error"
  | "limit_reached"
  | "unavailable";

export interface PolishOutcome {
  /** The text to send: the rewrite when accepted, otherwise the template. */
  text: string;
  source: "template" | "polished";
  status: PolishStatus;
  /** Why validatePolish rejected the rewrite. */
  problems: string[];
}

export interface PolishRequest {
  /** The user the call counts against. */
  userId: string | null;
  caseId: string;
  messageType: string;
  message: BuiltMessage;
}

const MAX_TOKENS = 1000;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: { rewrite: { type: "string", description: "The reworded message" } },
  required: ["rewrite"],
  additionalProperties: false,
};

function parseRewrite(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const rewrite = (parsed as { rewrite?: unknown }).rewrite;
    return typeof rewrite === "string" && rewrite.trim() ? rewrite.trim() : null;
  } catch {
    return null;
  }
}

export async function polishMessage(db: SupabaseClient, request: PolishRequest): Promise<PolishOutcome> {
  const template = request.message.text;
  const outcome: PolishOutcome = { text: template, source: "template", status: "unavailable", problems: [] };
  const row: Record<string, unknown> = {
    user_id: request.userId,
    purpose: "message_polish",
    agent: null,
    prompt_version: null,
    model: null,
    steps: 0,
    input_fields: { case_id: request.caseId, message_type: request.messageType, text: template },
  };

  try {
    let prompt: { version: string; text: string };
    try {
      if (!request.userId) throw new Error("No user to count the call against.");
      row.model = modelFor("fast");
      prompt = await loadPrompt(db, "message_polish");
      row.prompt_version = prompt.version;
    } catch (error) {
      row.output = { error: errorText(error) };
      return outcome;
    }

    if (!(await claimRun(db, request.userId))) {
      outcome.status = "limit_reached";
      row.output = { error: `Daily limit of ${POLICY.agent.dailyRunsPerUser} agent runs reached.` };
      return outcome;
    }

    const started = Date.now();
    let message: Anthropic.Message;
    try {
      message = await createMessage({
        model: row.model as string,
        max_tokens: MAX_TOKENS,
        system: prompt.text,
        // The filled template only: no customer name, no case data, nothing about the estimate.
        messages: [{ role: "user", content: template }],
        output_config: { effort: "low", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      });
    } catch (error) {
      outcome.status = "model_error";
      Object.assign(row, { steps: 1, output: { error: errorText(error) }, duration_ms: Date.now() - started });
      return outcome;
    }

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    Object.assign(row, {
      steps: 1,
      output: { stop_reason: message.stop_reason, text },
      tokens: message.usage,
      duration_ms: Date.now() - started,
    });

    if (message.stop_reason === "refusal" || message.stop_reason === "max_tokens") {
      outcome.status = message.stop_reason === "refusal" ? "refused" : "max_tokens";
      return outcome;
    }
    const rewrite = parseRewrite(text);
    if (rewrite === null) {
      outcome.status = "malformed";
      return outcome;
    }
    const check = validatePolish(rewrite, request.message.facts);
    if (!check.ok) {
      outcome.status = "rejected";
      outcome.problems = check.problems;
      return outcome;
    }
    outcome.status = "accepted";
    outcome.text = rewrite;
    outcome.source = "polished";
    return outcome;
  } finally {
    row.status = outcome.status;
    row.validation_result = { used: outcome.source, problems: outcome.problems };
    const { error } = await db.from("llm_runs").insert(row);
    if (error) throw error;
  }
}
