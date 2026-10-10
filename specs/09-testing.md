# 09. Testing

A golden case is a fixed input with a known right answer, rerun after every change to catch anything that broke.

**Never edit an expected value to make a test pass.** If a rule should change, change the spec and the policy version first, then the code, then the case.

Run everything with `npm test`. Also run `npm run typecheck`, `npm run lint` and `npm run build` before every commit.

## Default set-up

Unless a case says otherwise: a Rs 12,000 EMI due on 2 April 2026 fails on day 0 for insufficient funds. The lender's cap is day 10 (12 April), 2 re-presentations, results take 2 days, standing default Balanced. Insurance cases: a Rs 2,500 premium due on 2 April, last allowed day 12 (14 April), 3 attempts, instant results. Shared set-up is in `tests/fixtures.ts`.

## Built and passing

### Engine cases, `tests/golden-engine.test.ts`

| Case | Checks |
| --- | --- |
| E1 | `h = 5`, `u = 7`: Earliest 7 and 10 April, Balanced 8 and 11 April, Safest 10 April only |
| E2 | Bands: 55% Lower, 75% Medium, 90% High |
| E3 | Funded day close to the cap: two schedules, Safest merges into Balanced |
| E4 | Funded day past the cap: out of reach, link on that day |
| E5 | Funded day before the failure is known: no retry before day 3 |
| E6 | Card arithmetic, and that a card reveals no likelihood number |
| E7 | Gate, tier C, and the 80% and 70% floors at 72% confidence |
| E8 | Thin affordability evidence: 86% becomes 76% and fails open on a loan |
| E9 | Insurance, no salary: early attempt on 3 April |
| E10 | Insurance, salary recognized: a second backup, no early attempt |
| E11 | Days 29, 30, 31, 1, 2 give a median of 31 and a spread of 1 |
| E12 | Month-end anchor, and February not fooling it |
| E13 | Triage by code table and by lookup, with no agent |
| E14 | Accepting or rejecting the Triage agent's answer |
| E15 | Control checks in order, and the authentication limit by rail |
| E16 | Drift after a job change |
| E17 | Estimate from payment history; data on or after the due date is ignored |
| E18 | Salary recognition and its refusals |

### Flow cases, `tests/golden-flow.test.ts`

These run the case state machine with a simulated clock and ground truth.

| Case | Checks |
| --- | --- |
| F1 | Nobody picks: default applies on 7 April, attempt 8 April, paid on 10 April, backup cancelled |
| F2 | The lender picks Safest: one attempt on 10 April |
| F3 | When a pick is allowed, changed or refused |
| F4 | First attempt a day early: the backup rescues it, never two debits unresolved |
| F5 | Out of reach: link on the funded day, no debit, paid by link |
| F6, F7 | Paid outside the plan cancels the debit; refused while a debit is unresolved |
| F8 | Stepping back hands the remaining days to the original retries |
| F9 | Mandate cancelled after scheduling: nothing is presented |
| F10 | A late bank confirmation: the backup is held, or dropped past the cap |
| F11 | Insurer: default at once, early attempt, date visible only once locked |
| F12 | What each merchant type may see |
| F13 | A wrong prediction never exceeds the limits |
| F14 | Razorpay's original retries against the same truth |

### Pipeline, desk and message cases, `tests/golden-pipeline.test.ts`

| Case | Checks |
| --- | --- |
| P1 to P9 | One failed debit end to end: schedules, tier C, low confidence, catch-all codes with and without an agent answer, exceptions desk, control checks, out of reach, insurance, a model score |
| D1 to D4 | Fix catalogue, modes from merchant settings, rejections, rule-based fallback |
| M1 to M5 | Templates, polish accepted and rejected, banned words, formats |
| M6 | A retry notice when a debit locks or a locked debit moves; the link text when a link is sent; nothing for planned, cancelled or dropped debits |

### Demo cases, `tests/demo-cases.test.ts`

The nine preview cases end to end, plus a check that the merchant-facing part of each case contains nothing internal.

## Still to build

| Where | Cases | Added by |
| --- | --- | --- |
| `ml/` | Model beats the median-day rule on the test months. The predicted 80th percentile covers about 80% of cases, within 5 points. Each band holds its stated range. Salary-recognition precision and recall. Share of catch-all codes resolved without the agent | Prompt 4 |
| Database | Signed in as each merchant: internal and system tables are unreadable; the insurer cannot read `schedule_options`; a second lender sees none of the first's rows; a user cannot change their role; `audit_log` cannot be updated or deleted | Prompt 5 |
| Server functions | The same event id twice gives one case and one audit entry. Seeded cases 2 to 5, 9 and 10 play through `process-debit-event`, `choose-schedule` and `advance-day` to the endings in `05-data-and-model.md`. Consent withdrawn or kill switch mid-plan resumes original retries. A call without a login is refused | Prompt 6 |
| Agents | With the model mocked: a weak triage answer fails open; an unlisted fix is rejected; a customer-contact fix waits for approval and runs once approved; set to automatic it runs at once; bank text containing "ignore your instructions" changes nothing. Then three live runs per agent, read by hand | Prompt 8 |
| Messages | 20 filled templates keep their amount and dates and contain no banned word. A failed polish call keeps the template (`tests/messages.test.ts`, and through the server functions in `tests/db/messages.test.ts`) | Prompt 9 |
| Security | Every row of `08-security.md` | Prompt 10 |

Database tests run against the second Supabase project, never the demo one.
