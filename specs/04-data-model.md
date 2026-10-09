# 04. Data model

26 tables in three access groups. The grouping is the privacy design: a merchant can read only the first group.

Amounts are whole numbers in paise. Dates are plain dates. "Day" columns count days after the due date, as the engine does.

## Merchant-readable (7)

| Table | Key columns | Purpose |
| --- | --- | --- |
| `profiles` | user id, role (`lender`, `insurer`, `ops`), merchant id | Who is logged in and which merchant they belong to. Not writable by the user |
| `merchants` | id, name, type (`lender` or `insurer`), layer enabled, kill switch, polish on, consent date | Merchant settings and consent |
| `products` | id, merchant id, name, segment, rail, last allowed day, max re-presentations, standing default, result delay days, penal charge per day, bounce charge, baseline retry days, grace days | Limits, defaults and the disclosed charges per product |
| `fix_settings` | merchant id, fix type, mode (`automatic` or `needs_approval`) | The per-fix switch |
| `merchant_cases` | case id, merchant id, customer label, kind, amount, due date, failure words, state, retries used, retries allowed, chosen schedule, chosen by, next date, next action kind, result due date, paid date, paid via, public reason | The only case data a merchant reads. Mirrors `merchantView` in `lib/engine/simulate.ts` |
| `schedule_options` | case id, merchant id, label, merged labels, attempt days, main day, band, attempts, days overdue, waiting charge, days later than original, extra charge, chosen flag | The cards, for lenders only. Mirrors `ScheduleCard` |
| `desk_items` | id, merchant id, case id, trigger, fix type, reason, mode, status (`proposed`, `approved`, `done`, `rejected`), decided by, deadline | The exceptions desk queue |

## Internal (14)

| Table | Key columns | Purpose |
| --- | --- | --- |
| `customers` | id, label, holdout flag, archetype | Stand-in for Razorpay's unique customer id |
| `obligations` | id, merchant id, product id, customer id, kind (`EMI` or `premium`), amount, due day of month, mandate status, status, bank | The recurring debit |
| `consents` | customer id, merchant id, party, purpose, status, granted date, withdrawn date | Consent records |
| `transactions` | id, customer id, merchant id (empty for everyday shops), date, amount, direction, kind, own-merchant flag, status, reason code, bank text, source, obligation id, cycle due date, attempt day | Every synthetic transaction the customer makes through Razorpay. Credits carry a source id |
| `bank_downtimes` | bank, from date, to date | Lookup for triage |
| `customer_signals` | customer id, as-of date, obligation id, timing observations, months covered, affordability observations, failure evidence, identity linked, anchor kind, anchor value, spread, confidence, tier, salary recognized, likelihood by day | Signal store |
| `predictions` | obligation id, cycle due date, source (`rule` or `model`), h, u, likelihood by day, confidence, model version | Stored scores |
| `debit_events` | event id (unique), event type, obligation id, cycle due date, reason code, bank text, clock date, raw payload, processed flag | Event intake |
| `triage_results` | event id, label, decided by (`rule`, `lookup`, `agent`), evidence, agent strength | Triage output |
| `cases` | id, obligation id, cycle due date, route, state, fail-open reason, prediction id, policy version, limits snapshot, standing default, state machine snapshot (the `SimCase` as JSON) | One case per failed cycle |
| `plan_actions` | case id, action number, kind, day, status, result due day, executed date | Attempts and links. A cancelled action keeps its row |
| `audit_log` | id, time, clock date, actor, case id, decision, internal reason, public reason, inputs, policy version, model version | Every decision. Append-only |
| `messages` | case id, audience, channel, body, source (`template` or `polished`), template version, facts | Customer text |
| `model_card` | model version, training period, day error for baseline, quantile and AFT, 80% coverage, band calibration, eligible share, chosen model | Evidence for the ops screen |

## System (5)

| Table | Key columns | Purpose |
| --- | --- | --- |
| `sim_clock` | today | The simulated date. One row |
| `sim_truth` | customer id, obligation id, cycle due date, funded on day, true cause, reason code and bank text returned on the due date | Ground truth. Read only by `advance-day` and the tests |
| `prompts` | name, version, text, active flag | Agent prompts and message templates in one place |
| `llm_runs` | id, time, user id, purpose, agent, prompt version, model, tools called, steps, input fields, output, validation result, tokens, time taken, status | Every model call and agent step, with what the rules did with the answer |
| `usage` | user id, date, agent runs | The per-user daily limit of 50 agent runs |

## Rules to enforce

- A merchant user reads only their own rows in the merchant-readable group, and nothing in the other two groups.
- `schedule_options` is readable only when the merchant's type is lender.
- For an insurer, `next date` in `merchant_cases` is written only when the action locks.
- Merchant tables are plain tables written by server functions. They are not views over internal tables.
- Merchant tables never hold a score, a percentage, confidence, tier, the predicted funded day, salary, employer or archetype. A band is allowed.
- An ops user reads everything. Only server functions write.
- Any logged-in user may call `demo_today()`, which returns `sim_clock.today` and nothing else (build step 7). The `sim_clock` table stays closed to merchants.
- Agents never query the database. Their tools are server functions that return listed fields only (`07-agents.md`).
- `audit_log` is append-only. No role can update or delete a row.
- No table has a demographic or location column.
- Every case stores its policy version. Every prediction stores its model version.
- Nothing is hard-deleted.
- The Supabase secret key is used only inside server functions.
- Tables and access rules are migration files in `supabase/migrations/`, so the database can be rebuilt from scratch.
- A user cannot change their own role or merchant.
