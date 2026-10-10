// Engine 11: the Ops assistant's answer (specs/07 section 3).
// The assistant answers only from the audit log and must cite the rows it used. Code, not the
// model, decides which citations count: only rows its own tools returned during this run.

export const NOT_FOUND_ANSWER = "Not found in the audit log.";

export interface OpsAnswerDecision {
  /** False when the raw answer is not the agreed shape. The screen then says the assistant gave no answer. */
  wellFormed: boolean;
  /** The text to show: the model's answer, or NOT_FOUND_ANSWER when no citation survives. */
  answer: string;
  /** Cited audit row ids that the tools actually returned, in the order cited, without repeats. */
  cited: number[];
  /** Cited ids the tools never returned. They are dropped. */
  dropped: unknown[];
}

/**
 * Validates the Ops assistant's raw answer `{ answer, cited_audit_ids }` against the audit row ids
 * its tools returned (`seenIds`). An answer with no surviving citation is shown as not found.
 */
export function validateOpsAnswer(raw: unknown, seenIds: Iterable<number>): OpsAnswerDecision {
  const notFound = (wellFormed: boolean, dropped: unknown[] = []): OpsAnswerDecision => ({
    wellFormed,
    answer: NOT_FOUND_ANSWER,
    cited: [],
    dropped,
  });
  if (typeof raw !== "object" || raw === null) return notFound(false);
  const r = raw as Record<string, unknown>;
  if (typeof r.answer !== "string" || !r.answer.trim() || !Array.isArray(r.cited_audit_ids)) return notFound(false);

  const seen = new Set(seenIds);
  const cited: number[] = [];
  const dropped: unknown[] = [];
  for (const id of r.cited_audit_ids) {
    if (typeof id === "number" && seen.has(id)) {
      if (!cited.includes(id)) cited.push(id);
    } else {
      dropped.push(id);
    }
  }
  if (cited.length === 0) return notFound(true, dropped);
  return { wellFormed: true, answer: r.answer.trim(), cited, dropped };
}
