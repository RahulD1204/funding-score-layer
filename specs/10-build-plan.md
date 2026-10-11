# 10. Build plan

Eleven steps. Steps 1 to 3 are done and are in this repository. Steps 4 to 11 are prompts to paste into Claude Code, one per session, in order.

The rules and their tests came before any screen, because a wrong rule is cheapest to catch in a test. Agents come after the rule-based flow works, so a model problem cannot hide a rule problem.

## Status

| # | Step | Status | Check before moving on |
| --- | --- | --- | --- |
| 1 | Specs and CLAUDE.md | Done | `specs/` and `CLAUDE.md` exist |
| 2 | App scaffold | Done | `npm run build` succeeds |
| 3 | Rule engine, golden cases, engine preview | Done | `npm test` passes; the home page plays the demo cases |
| 0 | Your setup: GitHub, Vercel, Supabase, Anthropic key | **Next, yours** | The Vercel link shows the preview |
| 4 | Synthetic data and models | Done | The model card prints all three models; the ten seeded cases are in the export |
| 5 | Database, access rules and seed | Done | Tables are seeded; the merchant-access tests pass |
| 6 | Server functions and flow tests | Done | The seeded cases play through the server functions |
| 7 | Screens on live data | Done | Seeded cases 2, 5 and 9 play through on the Vercel preview link |
| 8 | Three agents | Done (live runs 11 and 12 October) | Mocked agent tests pass; three live runs per agent read sensibly |
| 9 | Message text | Done (live polish 11 October) | The template shows first; the polish tests pass |
| 10 | Security review | Done (two console settings are yours) | Every row of `08-security.md` is checked and findings are fixed |
| 11 | README, demo reset, demo script | Done | Reset works; all tests pass; the demo runs in 3 minutes |

Notes from step 5:

- Both projects are migrated and seeded. The demo project's variables come from `npx vercel@latest env pull .env.local`, which adds to the file and keeps local-only lines. Rerun `npm run db:migrate -- --target demo` and `npm run db:seed -- --target demo` after any new migration.
- No app role can delete rows, and `audit_log` refuses updates and deletes from every role, the database owner included. Only the owner can empty tables, which is how the seed resets. The Reset demo button (step 11) will need an owner-only database function to do the same.

Notes from step 6 (decided 10 October 2026):

- The five route handlers are in `app/api/`, the work in `lib/server/flows/`. They take the login token in the `Authorization: Bearer` header. Cookie logins and `proxy.ts` come with the login page in step 7.
- Migration `20261010000003_server_writes.sql` adds `save_case_bundle` (one transaction per case write) and `reset_demo`. Reset empties cases, events and `audit_log`, then writes one "demo reset" audit row. It restores settings, consents and the clock from `private.seed_snapshot`, a copy the seed script saves. That table is in the hidden `private` schema and is not one of the 26 app tables.
- Until the signed customer link exists (customer phone mock, steps 7 and 9), ops stands in for the customer: `withdraw_consent` and `pay_by_link` in `update-controls` are ops-only. Replace this with the signed case token then.
- `vercel.json` runs every function in Mumbai (`bom1`), next to Supabase.
- A failed debit event is accepted only while the clock is between the due date and the day the failure is known. Inject events on the due date, or reset the demo to replay.
- The Triage agent and the desk agent are not connected yet. A `needs_agent` result fails open as unknown, and desk cases store the rule-based fixes as proposed.

Notes from step 7 (decided 10 October 2026):

- Login is a cookie (`@supabase/ssr`, `proxy.ts`). Pages check it with `getClaims()` and read the role from `profiles`, with the user's own login, so row-level security applies. The server functions accept the cookie or a Bearer token; a cookie request from another site is refused (`cross_site`) and not audited.
- Migration `20261010000004_demo_today.sql` adds `demo_today()`: the simulated date for any logged-in user. The `sim_clock` table stays ops-only.
- The customer phone mock is built (`/c/<token>`). The token is the case id signed with `CUSTOMER_LINK_SECRET` (Vercel Production and Preview, and `.env.local`). `withdraw_consent` and `pay_by_link` in `update-controls` now take that token only; ops no longer stands in. `customer-case` returns the phone's fields. Ops opens the link from the internal case view.
- Merchants read only merchant tables, which hold no per-attempt history. The lender's plan panel shows the chosen schedule's dates, the next action, the result date and retries used; the full activity is on the ops internal view. The customer message is the filled template until step 9 stores it.
- Pick and lock dates on screen use the engine's `lockDay` and `lastPickDay`, the same functions `pickSchedule` and the clock use.
- The desk shows its queue; approving fixes waits for `approve-fixes` in step 8. The polish switch is shown, not editable, until step 9. The Ops assistant box is shown, not connected.
- The engine preview moved to `/preview`. The home page is the login.

Notes from step 8 (decided 10 October 2026):

- The agents are in `lib/server/agents/`: one runner for all three (`runner.ts`), their tools (`tools.ts`), prompts (`prompts.ts`, loaded into the `prompts` table by the seed) and the one file that calls Claude (`model.ts`). Models: `CLAUDE_MODEL_FAST` = `claude-haiku-5-5` (triage), `CLAUDE_MODEL_SMART` = `claude-sonnet-5-5` (desk, Ops assistant). Each answer has a fixed JSON shape; on the fourth model call tools are switched off, so the agent must answer.
- Triage and desk tools are bound to the one case being handled and take no input, so a model cannot point them at another customer. `get_mandate_status` returns an empty `last_changed`: the data does not record when a mandate status changed.
- Every model call is one `llm_runs` row; rows of one run share `input_fields.run_id`, and the last row holds what the rules did with the answer.
- The daily limit of 50 agent runs per user counts against the real date in UTC, not the demo clock, because it caps real spending (`claim_agent_run`, migration `20261010000005_agents.sql`). It is the only thing that reads the real date. Reset demo clears it. (Changed in step 10: Reset demo now keeps it.)
- Running a desk fix marks its desk item done and writes a `fix_run:<fix>` audit row. Nothing is sent to a customer yet, and the case stays in Needs action: what follows a fix (a new mandate, a downtime ending) is not modelled. Automatic fixes are saved as done with the case; `approve-fixes` runs waiting ones (`run_desk_items`, all or nothing).
- A payment outside the plan does not call the desk agent. `recordOutsidePayment` already cancels the pending attempt, which is the only fix allowed for that trigger, so the desk covers non-balance failures only.
- `run-exceptions-desk` is also an ops-only route, for a desk case that has no desk items (for example after an outage). `process-debit-event` runs the same desk for every new desk case.
- The Ops assistant's citations are checked by `validateOpsAnswer` in `lib/engine/assistant.ts` (golden cases O1 to O3): only rows its own tools returned count.
- Live runs deferred (decided 10 October 2026): the Anthropic account has no credit yet, so the nine live runs (triage on L-1047, L-1041 and L-1045; desk on L-1046, L-1043 and I-2011; three Ops questions) got "credit balance is too low". Every case failed open or fell back to the rules as designed, and each attempt was logged. Rerun them once the account has credit; until then the deployed agents show their fallbacks.
- Open for step 10: the desk agent's one-line reason is shown to the merchant as written. Its tools return no score or income, but no word check runs on it yet.

Notes from step 9 (decided 10 October 2026):

- `compose-message` is `lib/server/flows/compose-message.ts`. The engine's `messagesDue` (golden case M6) says which messages a change calls for: a retry notice when a debit locks, or when a locked debit is held to a new date, and the link text when a link is sent. `advance-day` and `process-debit-event` call it after the case is saved: an insurer's standing default can lock the first debit the day the case opens. `choose-schedule` does not, because a pick is allowed only before anything locks. The ops-only route `/api/compose-message` composes a notice a running case is missing (for example after an outage).
- Polish is `lib/server/polish.ts`: one call through `createMessage` with `modelFor("fast")`, no tools, not the agent runner. It sends the filled template only; the instructions are the `message_polish` prompt (`polish-v1`) in the `prompts` table. `validatePolish` must pass or the template is kept. Every attempt is one `llm_runs` row with purpose `message_polish`; turning polish off makes no call and no row.
- Polish counts toward the 50 agent runs per user per day (decided 10 October 2026): the cap limits real spending. Over the cap, the template is kept. Messages composed by Next day count against the ops user who clicked it.
- A payment link's text is always the template: `validatePolish` does not check the link, so a rewrite could break it and still pass. The prototype has no real link; the text says "[payment link]" and the phone mock's Pay button stands in.
- Migration `20261010000006_messages.sql` adds `messages.clock_date` (the simulated date, since `created_at` is the real time) and the merchant's copy in `merchant_cases` (`customer_message`, `customer_message_date`, `customer_message_source`), because merchants cannot read the internal `messages` table. `store_customer_message` stores the message, the merchant's copy and a `message_composed:<type>` audit row in one transaction. If storing fails, the case fails open: a debit must not run without its notice.
- The merchant case screens and the phone mock show the stored message; nothing is filled on the fly any more. The ops internal view lists every message with how it was worded (template, polished, or why polish was rejected). The channel is `phone_mock`: nothing is sent.
- `set_polish` in `update-controls`: lender or insurer, own merchant only, with an audit row. Settings has the on/off button. The seed starts it off for Northfield and on for Harbour (decision record). Reset demo restores it.
- The templates stay in code (`lib/engine/messages.ts`, `TEMPLATE_VERSION` "t1"), so every fact comes from code. Spec 04 now says so.
- Live polish deferred: the Anthropic account has no credit, so a live polish call fails and the template is kept, which is the designed fallback. On the demo, Harbour's notices show "Template text" and each attempt has a `model_error` row in `llm_runs`. Try a live run once the account has credit.

Notes from step 10 (decided 10 October 2026):

- Every row of `08-security.md` was checked. Secrets: none in tracked files, git history or the built site; the only `sb_secret_` text in browser code is the Supabase library checking a key's prefix.
- Stricter word checks, policy v1.1 (golden cases D5 and M7). The banned words now catch plurals and variants (salaries, paydays, pay-day, employers, paycheque, earnings). `validatePolish` also rejects any number, month name or day word left once the amount, the dates and the name are taken out, and words for a score, confidence, tier, a percentage or "funded". The desk agent's reason must pass `checkReasonText` (one line, at most 200 characters, the same words); otherwise the merchant sees the catalogue description, and the run's audit row lists the replaced reasons.
- Reset demo keeps the daily agent-run counts (migration `20261010000007_reset_keeps_usage.sql`), so the cap of 50 cannot be restarted by resetting. The database tests clear `usage` themselves.
- Row 8 reworded: version 1 has no public webhook route. Failed debits come only from the ops event injector, and repeated event ids open one case. The signature check comes with optional prompt 12.
- Row 18: `ml/export/model_card.md` now has day error by customer type. Gig workers, the self-employed and customers paid twice a month are several days further off than salaried customers. The type is never a model input.
- Exports rerun with policy v1.1: only the version labels in `predictions.csv` and `model_card.csv` changed.
- Yours, in the consoles: turn off "Allow new users to sign up" in both Supabase projects (a stranger's login has no role and is refused everywhere, but each refusal is audited), and put the Anthropic key in its own workspace with a monthly spend limit, auto-reload off.
- Say out loud in the demo: the customer phone link never expires; Reset demo empties the audit log; the three open legal questions in `08-security.md`.
- The test "refuses the wrong role, and audits the attempt" can exceed its 5-second limit on a slow network; rerun once (left as is, decided 10 October 2026).

Notes from step 11 (decided 10 October 2026):

- `README.md` now covers the product, the 26 tables, the ten routes, the agents and their tools, the environment variables, the tests, rebuilding the data and models, and Reset demo (which keeps today's agent-run counts).
- Reset demo needed no change: every table a server function writes is either emptied or restored from `private.seed_snapshot`. The flow test now compares each restored table with that copy row for row, checks every case table is empty, and checks `usage` is kept.
- `DEMO-SCRIPT.md` is the three-minute walkthrough. It is written for the agents' fallbacks (no Anthropic credit yet) and says what changes once credit is added.

Notes from the live agent runs (decided 12 October 2026):

- The Anthropic account has credit and the deployed site makes live calls. The deferred live runs of steps 8 and 9 are done; results are in `ml/export/model_card.md`, "Live agent results".
- Prompts `triage-v2`, `desk-v2` and `ops-v2` replace v1. Triage: no strong balance answer after a recent closed-account or mandate code, and a strong closed-account route (spec 07). Desk: dates written "12 April". Ops: a bank-mandate result arrives two days after the debit and is the same debit. Each was re-measured after the change. `polish-v1` is unchanged.
- `DEMO-SCRIPT.md` is now written for live agents, with a fallback line for each live step.
- The model card adds the replay breakdown (out-of-reach against schedule cases, insurance inside grace, days to collect) and the due-date count of catch-all failures, both computed by `ml/fsl/evaluate.py`. The live agent results are copied in by hand in `ml/fsl/export.py`, because the pipeline makes no model call.

Notes on policy v1.2 (decided 12 October 2026):

- The desk agent's reason may hold no number, month name or day word (`checkReasonText`, spec 06 section 9, golden case D6), because no code can confirm a date or amount a model states. A reason that fails keeps its fix and shows the catalogue wording. The test is the one `validatePolish` already used, now shared.
- Golden cases D3 and D5 changed with the spec, not to make them pass: D3's accepted reason no longer carries a time, and D5's "92% ... the 7th" reason now also lists its two numbers.
- `desk-v3` replaces `desk-v2`: no dates, amounts or numbers in a reason. In 4 live demo runs all 8 reasons passed and none was replaced.
- Exports rerun with policy v1.2: only the version labels in `predictions.csv`, `model_card.csv` and the model card title changed.

Notes on policy v1.3 (decided 12 October 2026):

- `acceptAgentTriage` accepts a closed-account label only when a past failure on the obligation carries `account_closed` or `instrument_closed`, and refuses mandate and downtime labels the lookups ruled out (spec 06 section 2, golden cases E14 and P4). A live check found a lack-of-funds case whose bank text falsely said "ACCOUNT CLOSED" was accepted and its attempts stopped; it now fails open.
- The codes come from the same rows the agent's `get_failure_history` reads. `loadDebitInput` reads two more columns (`obligation_id`, `reason_code`) from the transactions it already loads and passes the codes to the engine. No table changes.
- Golden case P4's closed-account answer changed with the spec: it reaches the desk with a past `account_closed` code, and the same answer on bank text alone fails open.
- 29 of the 30 test-month closed accounts have such a code, so the Triage table measured under v1.2 would not change. No prompt changed.

Cut line if time runs short: finish 4 to 7 for lending first, then insurance, then 8. The desk works without its agent.

## Step 0: your setup

You need four accounts: GitHub (stores the code), Vercel (runs the site), Supabase (the database, added from inside Vercel), and the Claude Console (the API key the three agents use). Then paste this into Claude Code with this folder open:

```text
This folder is the Funding Score Layer prototype. Read CLAUDE.md first.
Do not change any code in this session.
1. Run npm install, npm test and npm run build, and show me the results.
2. Turn this folder into a git repository, make the first commit, and
   walk me through creating a private GitHub repository and pushing to it.
3. Then tell me, one click at a time, how to import the repository into
   Vercel and deploy it. Check Vercel's current documentation first.
   Wait while I do each step.
4. Then walk me through adding Supabase from the Vercel Marketplace and
   creating a second free Supabase project for tests. Tell me which
   environment variables now exist. Never ask me to paste a secret key
   into this chat.
5. Tell me how to create an Anthropic API key with a monthly spend limit
   and add it to Vercel as ANTHROPIC_API_KEY.
```

## Prompt 4: synthetic data and models

```text
Read CLAUDE.md, specs/05-data-and-model.md and specs/06-engines.md.
In ml/, write Python scripts that:
1. generate the synthetic customers, loans, policies and 24 months of
   history, including catch-all reason codes with bank free text and
   non-balance failures,
2. build labels and features with no leakage,
3. train the median-day baseline, the XGBoost AFT model and the XGBoost
   quantile model on the time split, and keep the better model,
4. produce likelihood by day and check its calibration,
5. export the app's CSV files and a model card to ml/export/.
Use a fixed random seed. The median-day baseline must give the same
funded day as estimateFunding in lib/engine/estimate.ts on the ten
seeded cases; add a check that compares them.
The ten seeded cases must end as specs/05 says. Run everything and show
me the model card.
```

## Prompt 5: database, access rules and seed

```text
Read CLAUDE.md, specs/04-data-model.md and specs/08-security.md.
Write Supabase migrations in supabase/migrations/ for the 26 tables and
their access rules, with roles a user cannot change for themselves.
Write a seed script that loads the CSV files from ml/export/, creates
one lender user, one insurer user and one ops user, and sets
sim_clock.today to 2026-04-02. Read the demo passwords from environment
variables. Never print or commit them.
Add tests, run against the test Supabase project, that sign in as each
merchant and confirm: internal and system tables are unreadable, the
insurer cannot read schedule_options, a second lender sees none of the
first lender's rows, a user cannot change their role, and audit_log
cannot be updated or deleted.
Run migrations, seed and tests, and show me the output.
```

## Prompt 6: server functions and flow tests

```text
Read CLAUDE.md, specs/03-architecture.md, specs/06-engines.md and the
Next.js route handler guide in node_modules/next/dist/docs/.
Build these route handlers under app/api/, each requiring a login and
checking the role: process-debit-event, choose-schedule, advance-day,
update-controls and reset-demo.
They must call the functions in lib/engine and add storage only. Do not
re-implement a rule. Store each case's state machine snapshot and write
the merchant tables from merchantView and buildCards. On any error,
fail open and write an audit row.
For now, when evaluateFailedDebit returns needs_agent, treat the label
as unknown. When it returns exceptions_desk, store fallbackProposals.
Add flow tests against the test database: the same event id twice gives
one case; seeded cases 2 to 5, 9 and 10 play through to the endings in
specs/05; consent withdrawn mid-plan and the kill switch both resume
original retries; a call without a login is refused.
Run all tests and show me the output.
```

## Prompt 7: screens

```text
Read CLAUDE.md, specs/02-design.md and the Next.js guides on layouts,
server and client components, and caching in node_modules/next/dist/docs/.
Build the nine screens on live data. Use components/preview/ as the
visual reference and reuse its parts. Lender screens read only the
merchant tables. Insurer screens never show schedule cards and show a
date only once it has locked. The ops console has the demo clock, the
event injector and the internal case view.
Move the engine preview from the home page to /preview and make the
home page the login.
Push, then walk me through seeded cases 2, 5 and 9 on the Vercel
preview link.
```

## Prompt 8: three agents

```text
Read CLAUDE.md, specs/07-agents.md and Anthropic's current documentation
for tool use with the TypeScript SDK.
Build the Triage agent, the exceptions desk agent and the Ops assistant
as server functions. Each gets only its listed read-only tools, at most
four steps, and an output validated by the functions already in
lib/engine (acceptAgentTriage, validateDeskOutput). Tools are server
functions, never direct database access. Read model names from
CLAUDE_MODEL_FAST and CLAUDE_MODEL_SMART.
Wire the Triage agent into process-debit-event. Add run-exceptions-desk,
approve-fixes and ask-ops-assistant. Log every step in llm_runs. Cap
each user at 50 agent runs a day.
Add tests with the model mocked: a weak triage answer fails open; an
unlisted fix is rejected; a customer-contact fix waits for approval and
runs once approved; set to automatic it runs at once; bank text that
says "ignore your instructions" changes nothing.
Then run each agent live on three seeded cases and show me the outputs.
```

## Prompt 9: message text

```text
Read CLAUDE.md and section 9 of specs/06-engines.md.
Build compose-message as a server function. Fill the template with
buildRetryMessage and save it. If the merchant's polish switch is on,
call Claude to polish the wording, sending only the filled template.
Accept the rewrite only if validatePolish passes. Otherwise keep the
template. Log each call in llm_runs.
Show the message on the case screens and the customer phone mock.
Add tests with the model call mocked, including a failed call.
```

## Prompt 10: security review

```text
Review the whole repository against specs/08-security.md, as a security
reviewer who did not write this code. Check every row of the table,
search the code and the built site for secrets, confirm no merchant
route can reach an internal table, and confirm no agent can call a tool
outside its list.
Report your findings first. Fix them only after I agree.
```

## Prompt 11: README, demo reset and demo script

```text
Update README.md: what the product does, the tables, the server
functions, the agents and their tools, the environment variables, how
to run the tests, how to rebuild the data and models, and how to reset
the demo.
Make sure the Reset demo button on the ops console restores the seeded
state. Run all tests, push, and give me a three-minute demo script:
one failed EMI from failure to paid, one out-of-reach case, one insurer
case, one exceptions-desk case, one Ops assistant question, and the
limits to state out loud.
```

## Optional prompt 12: one real Razorpay test-mode call

```text
Add Razorpay test mode. I will set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
and RAZORPAY_WEBHOOK_SECRET as environment variables. Test keys only.
Check Razorpay's current API documentation first.
1. create-payment-link: when a link action runs, create a payment link
   for the amount with a reference id of the case id, and save the
   returned short URL on the action.
2. A public route that accepts Razorpay webhooks, verifies the signature
   over the raw body, ignores a repeated event id, and passes valid
   events to process-debit-event.
```

## Working habits

- One prompt per session. Start a new session for the next one.
- Ask Claude Code to show its plan before large changes, and read it.
- After each prompt, run the check in the status table yourself.
- If a test fails, ask why before allowing any change to the test.
- Commit after every passing step, so a bad change is easy to undo.
- Keep secrets in Vercel and in a local `.env.local` file. Never paste one into a chat.
