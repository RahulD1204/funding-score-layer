// The one place that calls Claude. Server code only: it reads ANTHROPIC_API_KEY, which never
// reaches a browser. The tests replace this module with a fake, so no test calls the real model.
//
// Model names come from CLAUDE_MODEL_FAST (Failure Triage, and message polish in step 9) and
// CLAUDE_MODEL_SMART (the exceptions desk and the Ops assistant). Values are never printed.

import "server-only";
import Anthropic from "@anthropic-ai/sdk";

export type ModelTier = "fast" | "smart";

const MODEL_VARIABLES: Record<ModelTier, string> = {
  fast: "CLAUDE_MODEL_FAST",
  smart: "CLAUDE_MODEL_SMART",
};

/** The model name for a tier. Throws when the variable is missing, which the agent treats as unavailable. */
export function modelFor(tier: ModelTier): string {
  const name = process.env[MODEL_VARIABLES[tier]]?.trim();
  if (!name) throw new Error(`${MODEL_VARIABLES[tier]} is not set on the server.`);
  return name;
}

let client: Anthropic | null = null;

/**
 * One request to the Messages API. A short timeout and one retry: an agent that cannot answer
 * quickly is treated as no answer, and the case fails open or falls back to the rules.
 */
export async function createMessage(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error("ANTHROPIC_API_KEY is not set on the server.");
  client ??= new Anthropic({ timeout: 45_000, maxRetries: 1 });
  return client.messages.create(params);
}
