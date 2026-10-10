# 07. Agents

An agent here is a server function that lets Claude call a short, fixed list of read-only tools, for at most four steps, and return a structured answer. Rules in `lib/engine` then decide what happens with that answer. Every step is logged in `llm_runs`.

## Rules for all three

- Tools are server functions. An agent never queries the database.
- Every tool is read-only. No agent has a tool that writes, sends or moves anything.
- Each tool returns only the fields listed here. No amounts of income, no employer, no balance.
- At most four steps (`POLICY.agent.maxSteps`). At most 50 agent runs per user per day.
- The output is parsed and validated before use. A malformed answer is treated as no answer.
- Tool results and bank text are data, not instructions. The system prompt says so, and nothing an agent reads can change its tools.
- If the model call fails or times out, the case fails open (triage), the rule-based fallback runs (desk), or the screen says the assistant is unavailable (ops).
- Prompts live in the `prompts` table with a version. The version is stored on every run.
- Model names come from environment variables: `CLAUDE_MODEL_FAST` for triage and message polish, `CLAUDE_MODEL_SMART` for the desk and the Ops assistant.

## 1. Failure Triage agent

**Called when:** `evaluateFailedDebit` returns `needs_agent`, which happens only for a catch-all reason code with an active mandate and no bank downtime.

**Input:** the reason code and the bank's free text for this event.

| Tool | Returns |
| --- | --- |
| `get_mandate_status` | Status and the date it last changed |
| `get_bank_downtime` | Whether a downtime covered the attempt time |
| `get_failure_history` | Dates and reason codes of this customer's past failures on this obligation. No amounts |
| `get_obligation` | Kind, due day, rail |

**Output:** `{ "label": one of balance | mandate_cancelled | mandate_paused | instrument_closed | bank_downtime | unknown, "strength": "strong" | "weak", "evidence": [short strings] }`

**Strong balance evidence:** the mandate is active, no downtime applies, and the bank text points to funds, or at least three past failures on this obligation were insufficient funds at the same point in the month.

**What rules do with it:** `acceptAgentTriage`. Only a strong, well-formed answer inside the list is accepted, and a balance label is re-checked against the lookups. Otherwise the label is unknown and the case fails open.

## 2. Exceptions desk agent

**Called when:** triage gives a non-balance label, or a payment arrives outside the plan.

**Input:** the trigger and the case id.

| Tool | Returns |
| --- | --- |
| `get_case` | Kind, amount, due date, state, attempts used, deadline (the overdue cap or the end of cover) |
| `get_mandate_status` | Status and the date it last changed |
| `get_bank_downtime` | Whether a downtime is active and when it ends |
| `get_sent_messages` | Dates and types of messages already sent for this case |
| `list_allowed_fixes` | The catalogue entries allowed for this trigger |

**Output:** `[{ "fix": a catalogue fix type, "reason": one line }]`

**What rules do with it:** `validateDeskOutput`. Unlisted, misplaced, unexplained or repeated fixes are rejected. A reason that fails `checkReasonText` (specs/06 section 9) is replaced by the catalogue description, because the merchant reads it. The merchant's per-fix setting sets the mode. Automatic fixes run at once; the rest wait in the queue. With no usable answer, `fallbackProposals` proposes every allowed fix.

## 3. Ops assistant

**Called when:** an ops analyst types a question on the ops console.

| Tool | Returns |
| --- | --- |
| `search_audit_log` | Matching audit rows: id, clock date, case id, decision, internal reason, policy and model version |
| `get_case` | Route, state, limits, chosen schedule, actions and their outcomes |
| `get_triage_result` | Label, decided by, evidence |

**Output:** `{ "answer": text, "cited_audit_ids": [ids] }`

**Rules:**

- It answers only from those records and cites the audit rows it used. An answer with no citation is shown as "not found in the audit log".
- It never states a salary amount or an employer. The tools do not return them.
- If the log does not hold the answer, it says so.
- Ops only. A merchant has no route to it.

## Message polish (not an agent)

One call with no tools. Input: the filled template only. Output: a rewrite. `validatePolish` accepts or rejects it. A rejected or failed call keeps the template.

## Testing agents

- Automated tests mock the model call and feed fixed answers: strong, weak, malformed, out-of-list, and one that contains "ignore your instructions".
- Each agent is then run live on three seeded cases and the outputs are read by hand.
