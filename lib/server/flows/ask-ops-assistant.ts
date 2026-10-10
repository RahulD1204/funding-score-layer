// ask-ops-assistant (specs/03, specs/07 section 3). Ops only. Answers a question from the audit log
// and cites the rows used. validateOpsAnswer keeps only citations of rows the tools returned; an
// answer with none is shown as "not found in the audit log". If the model cannot answer, the screen
// says the assistant is unavailable.

import "server-only";
import { POLICY } from "@/lib/engine";
import { askOpsAssistant } from "../agents";
import type { FlowContext, FlowResult } from "../route";
import { text } from "../validate";

export async function askOpsAssistantFlow({ db, caller, body }: FlowContext): Promise<FlowResult> {
  const question = text(body, "question", 500);
  const { run, decision, citedRows } = await askOpsAssistant(db, caller.userId!, question);

  if (run.status === "limit_reached") {
    return {
      body: { available: false, message: `You have used today's ${POLICY.agent.dailyRunsPerUser} assistant runs. Try again tomorrow.`, runId: run.runId },
    };
  }
  if (!decision) {
    return { body: { available: false, message: "The assistant is unavailable right now. Read the audit log directly.", runId: run.runId } };
  }
  if (!decision.wellFormed) {
    return { body: { available: false, message: "The assistant gave no usable answer. Read the audit log directly.", runId: run.runId } };
  }
  return { body: { available: true, answer: decision.answer, cited: citedRows, runId: run.runId } };
}
