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
| 8 | Three agents | To do | Mocked agent tests pass; three live runs per agent read sensibly |
| 9 | Message text | To do | The template shows first; the polish tests pass |
| 10 | Security review | To do | Every row of `08-security.md` is checked and findings are fixed |
| 11 | README, demo reset, demo script | To do | Reset works; all tests pass; the demo runs in 3 minutes |

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
