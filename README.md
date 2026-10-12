# Funding Score Layer (prototype)

## For judges

- **Try it:** https://funding-score-layer.vercel.app. Click **Sign in as lender**, **Sign in as insurer** or **Sign in as Razorpay ops**; no password needed. As ops, press **Reset demo** on the ops console before you start. February and March 2026 are already played as history; `DEMO-SCRIPT.md` walks through April in three minutes.
- **All data is synthetic.** No real customers, accounts or keys. **This is not an official Razorpay product**; it was built for Razorpay's AI PM Build Challenge.
- **The rules** are in `lib/engine/`: every decision (triage, consent checks, evidence gate, funded-day estimate, schedules, case clock, exceptions desk, message checks) as pure functions with no database, clock, network or model. Their golden cases are in `tests/`.
- **The agents** (Failure Triage, Exceptions desk, Ops assistant) are in `lib/server/agents/`: prompts in `prompts.ts`, read-only tools in `tools.ts`. `specs/07-agents.md` says what each may do and what the rules do with its answer.
- **The model card** is `ml/export/model_card.md`: the model against the rule baseline, calibration, fairness by customer type, the replay breakdown and the live agent results. The Python that builds it is in `ml/`.
- **Run the tests** (built with Node 24): `npm install`, then `npm test`. The golden cases need nothing else: in a fresh copy, 218 tests pass and 55 are skipped. The skipped ones are the database tests, which need a test Supabase project, and the check that the built site holds no demo password, which needs a build and the passwords.
- **Why it is built this way:** `specs/00-decision-record.md` holds every product decision; `HANDOFF-FOR-STRATEGY.md` is the full write-up with results and caveats.

When a loan EMI or an insurance premium debit fails because the account is short, the usual retries follow a fixed calendar and often fail again before the money arrives. This layer estimates the day each customer is usually funded and suggests retry dates that wait for it.

It is **advice only**. The merchant decides, the layer never moves money, and any doubt falls back to Razorpay's original retries. Version 1 retimes retries only: the due-date debit always runs as usual and no due date ever changes.

Built for Razorpay's AI PM Build Challenge. **All data is synthetic. This is not an official Razorpay product.**

## What it does

Two invented merchants use it: Northfield Finance, a lender, and Harbour Life, an insurer. Razorpay ops runs the demo.

1. **A debit fails.** Ops sends a failed-debit event from the ops console. It stands in for Razorpay's webhook.
2. **Triage.** A code table and lookups label the failure. Only a balance failure continues. A cancelled mandate, a closed account or a bank downtime goes to the exceptions desk. An unclear code is read by the Triage agent; a weak answer leaves the original retries in place.
3. **Checks.** Layer on, kill switch off, both consents, not in the holdout group, mandate active, amount inside the authentication limit. They run again before every later action.
4. **Gate.** At least 25 past payments over at least 3 months. Otherwise the layer stays out.
5. **Estimate.** A recognized monthly credit first, otherwise the pattern in the customer's payment dates. Below the confidence floor (80% for loans, 70% for premiums) the layer stays out.
6. **Schedules.** Earliest, Balanced and Safest, inside the merchant's own limits, each with a backup spaced so two debits are never unresolved at once. If no debit can reach the funded day inside the lender's overdue cap, the case is "out of reach": a payment link goes out instead and nothing bounces.
7. **Choice.** A lender picks, or its standing default applies. An insurer runs on its default and sees a date only once it has locked.
8. **Every day after.** The demo clock moves one day at a time. Dates lock, the bank answers, attempts run, and the customer gets a notice the day before each debit.

### What a merchant never sees

A score, a percentage, confidence, a tier, the predicted funded day, or anything about a customer's salary, income or employer. A lender sees suggested dates and a likelihood band (High, Medium, Lower). An insurer never sees schedule options. Customer messages never mention pay, income or balance.

## The live demo

Three demo users, created by the seed script:

| Login | Role | Sees |
| --- | --- | --- |
| `lender@northfield.example` | Lender | Collections queue, case screens with schedule cards, exceptions desk, settings |
| `insurer@harbour.example` | Insurer | Renewals, case screens with locked dates only, exceptions desk, settings |
| `ops@fsl.example` | Razorpay ops | Ops console (demo clock, Reset demo, event injector, Ops assistant), the internal case view, the audit log and model card |

The login page has a one-click button for each ("Sign in as lender", "Sign in as insurer", "Sign in as Razorpay ops"). The button calls `POST /api/demo-sign-in` (`lib/server/demo-sign-in.ts`): the server asks Supabase's admin service for a one-time sign-in token for that user, sends no email, and redeems the token at once, which sets the login cookie. No password is involved, so none reaches the browser. Only the three demo emails are accepted, and only from the site's own pages. The email and password form stays below the buttons.

**Anyone with the link can use the demo.** The login page has one-click buttons that sign in the lender, the insurer or Razorpay ops, with no password. What limits the damage: the data is synthetic; sign-ups are off, so no one can create a login; each login has 50 agent runs a day; the Anthropic key has its own spend limit; only the three seeded demo emails can be signed in this way, from the site's own pages; no password reaches the browser. Because everyone shares the same three logins, one visitor can use up a login's runs for the day or press Reset demo during someone else's session.

The passwords are the values of `DEMO_LENDER_PASSWORD`, `DEMO_INSURER_PASSWORD` and `DEMO_OPS_PASSWORD`. They are not in this repository, and the deployed site does not need them. Sign-ups are turned off in both Supabase projects, so no one else can create a login. **Replayed history.** The demo opens with February and March 2026 already played: the seed sends every failed due-date debit of those two months (191) through the real server functions, walking the demo clock day by day (`scripts/history.ts`). Standing defaults apply and no model is called, so the agents and polish fall back as designed: catch-all codes keep Razorpay's original retries and notices use the template. Waiting customer-contact fixes from that history are marked rejected, so the exceptions desk holds only live items. The queues list the newest cycle first and say "February and March are replayed history on synthetic data." History cases show what the layer would have done; the raw transactions still show Razorpay's original retries for those months.

The customer's side is a phone mock at `/c/<token>`, opened from the ops internal case view. The engine preview, with no database, is at `/preview`.

[DEMO-SCRIPT.md](DEMO-SCRIPT.md) is a three-minute walkthrough.

## Server functions

Route handlers in `app/api/`, with the work in `lib/server/flows/`. Each one checks the login and the role, calls the rules in `lib/engine/`, and stores the result. It adds storage and nothing else. Any error fails open to Razorpay's original retries and writes an audit row.

| Route | Who may call it | What it does |
| --- | --- | --- |
| `process-debit-event` | Ops | Takes a failed debit (a repeated event id opens no second case), triages it, and opens the case: schedules, an out-of-reach link, the exceptions desk, or the original retries |
| `choose-schedule` | Lender, own cases | Picks a schedule before its first date locks |
| `advance-day` | Ops | Moves the demo clock one day and brings every open case to the new day |
| `update-controls` | Lender or insurer, own merchant; the customer through the signed phone link | Limits, standing default, per-fix mode, kill switch and polish switch; mark paid and force original retries; the customer's withdraw consent and pay by link |
| `reset-demo` | Ops | Puts the demo back to the seeded state (see "Resetting the demo") |
| `run-exceptions-desk` | Ops | Runs the desk again for a desk case that has no desk items, for example after an outage |
| `approve-fixes` | Lender or insurer, own desk items | Runs the fixes the merchant approved, all or nothing |
| `ask-ops-assistant` | Ops | Answers a question from the audit log, citing the rows it used |
| `compose-message` | Ops | Writes a customer notice a running case is missing |
| `customer-case` | The customer, through the signed phone link | The phone mock's fields and nothing else |

Logins are a cookie (`proxy.ts`, `lib/supabase/`). The routes also accept a `Bearer` token, which the tests use. A cookie request from another site is refused.

## The agents and their tools

Three Claude agents, in `lib/server/agents/`. Each has a fixed list of read-only tools and at most four steps. The tools are server functions bound to the one case being handled; no agent queries the database or can write anything. Rules in `lib/engine/` decide what happens with each answer.

| Agent | Model variable | Tools | What the rules do with its answer |
| --- | --- | --- | --- |
| Failure Triage | `CLAUDE_MODEL_FAST` | `get_mandate_status`, `get_bank_downtime`, `get_failure_history`, `get_obligation` | `acceptAgentTriage` accepts a strong answer only. A closed-account label also needs a past closed-account code on the obligation, and a mandate or downtime label the lookups ruled out is refused (policy v1.3). A weak, refused or missing answer leaves the original retries |
| Exceptions desk | `CLAUDE_MODEL_SMART` | `get_case`, `get_mandate_status`, `get_bank_downtime`, `get_sent_messages`, `list_allowed_fixes` | `validateDeskOutput` keeps only fixes from the catalogue for that failure. Its one-line reason must pass `checkReasonText`, or the merchant sees the catalogue description. With no usable answer, the rules propose every allowed fix |
| Ops assistant | `CLAUDE_MODEL_SMART` | `search_audit_log`, `get_case`, `get_triage_result` | `validateOpsAnswer` keeps only citations of audit rows its own tools returned. An answer with none shows as "not found in the audit log" |

Every model call is one row in `llm_runs`. Each user may start 50 agent runs a day, counted against the real date in UTC because the cap limits real spending. Message polish counts toward the same 50.

**Nothing is sent to a customer** unless the merchant approved that fix or set that fix type to automatic. In the prototype an approved fix is recorded and audited; no message leaves the system.

**Today the Anthropic account has no credit.** Every model call fails, and the site shows the designed fallbacks: a catch-all failure keeps the original retries, the desk proposes fixes by rule with the catalogue wording, notices stay as template text, and the Ops assistant says it is unavailable. Once credit is added, nothing needs changing in the code.

## Customer messages and word checks

The notice text is a template in `lib/engine/messages.ts`, filled from code: the amount, the dates and the merchant name never come from a model. If a merchant's polish switch is on (Harbour's starts on, Northfield's off), Claude may reword the filled template. The rewrite is kept only if `validatePolish` passes:

- the amount, the dates and the name are unchanged,
- no other number, month name or day word appears,
- no banned word: salary, payday, employer, income, earnings, paycheque and their plurals and spellings, and no word for a score, confidence, tier, a percentage or "funded".

Otherwise the template is sent. The desk agent's reason goes through the same banned words. These stricter checks are policy v1.1 (golden cases D5 and M7). Since policy v1.2 the desk reason may also hold no number, month name or day word, so it states no date or amount that code cannot confirm; a reason that fails shows the catalogue wording (golden case D6).

## The tables

26 tables, defined in `supabase/migrations/`. Row-level security (rules in the database that decide which rows each login may read) is on for every table. Merchant tables are plain tables written only by server functions. Full columns are in `specs/04-data-model.md`.

**Merchant-readable (7):** `profiles` (who is logged in, their role and merchant; a user cannot change their own role), `merchants` (settings and consent), `products` (limits, default and disclosed charges), `fix_settings` (automatic or needs approval, per fix), `merchant_cases` (the only case data a merchant reads, plus its copy of the latest customer message), `schedule_options` (the schedule cards, lenders only), `desk_items` (the exceptions desk queue).

**Internal (14):** `customers`, `obligations` (the recurring debits), `consents`, `transactions`, `bank_downtimes`, `customer_signals`, `predictions`, `debit_events`, `triage_results`, `cases` (one per failed cycle, with the engine's state), `plan_actions` (attempts and links), `audit_log` (every decision, append-only: no role can edit or delete a row), `messages` (every customer text and how it was worded), `model_card`.

**System (5):** `sim_clock` (the simulated date; all time logic reads it, never the real date), `sim_truth` (when each customer is really funded, read only by `advance-day` and the tests), `prompts`, `llm_runs`, `usage` (agent runs per user per day).

The hidden `private` schema holds `seed_snapshot`, the copy of the seeded settings that Reset demo restores, and `history_snapshot`, the copy of the replayed February and March case rows it puts back. Neither is one of the 26.

## Environment variables

Kept in Vercel and, for local work, in `.env.local` (never committed). `.env.example` lists them with no values. No secret has a `NEXT_PUBLIC_` name, and the secret keys are read only in server code.

| Variable | Where | What it is |
| --- | --- | --- |
| `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL` | Vercel (from the Supabase integration), `.env.local` | The demo project's address |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Vercel, `.env.local` | The public key the browser signs in with |
| `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) | Vercel, `.env.local` | Server only. Bypasses access rules |
| `POSTGRES_URL_NON_POOLING` (or `SUPABASE_DB_URL`) | `.env.local` | The demo database connection. Only the migration and seed scripts use it |
| `ANTHROPIC_API_KEY` | Vercel | Server only. In its own Anthropic workspace with a monthly spend limit |
| `CLAUDE_MODEL_FAST`, `CLAUDE_MODEL_SMART` | Vercel, `.env.local` | Model names: triage and polish, then the desk and Ops assistant |
| `CUSTOMER_LINK_SECRET` | Vercel, `.env.local` | Signs the customer phone links. Any long random value |
| `DEMO_LENDER_PASSWORD`, `DEMO_INSURER_PASSWORD`, `DEMO_OPS_PASSWORD` | `.env.local` | The demo users' passwords, read by the seed and the database tests. Never printed |
| `TEST_SUPABASE_URL`, `TEST_SUPABASE_SECRET_KEY`, `TEST_SUPABASE_PUBLISHABLE_KEY`, `TEST_SUPABASE_DB_URL` | `.env.local` | The second Supabase project, used only by the tests |

Pull the Vercel values into `.env.local` with `npx vercel@latest env pull .env.local`. It adds to the file and keeps the local-only lines.

## Run it locally

You need [Node.js](https://nodejs.org) 24. The scripts and the export checks run TypeScript through Node's built-in support.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:3000. The engine preview at `/preview` needs no variables; the rest of the site needs the Supabase ones.

`npm install` may end with a warning about vulnerabilities. They sit in the code checker's own dependencies, which never reach the site. Do not run `npm audit fix --force`: it would downgrade the checker and break it.

## Tests

```bash
npm test
```

runs every test. The golden cases (fixed inputs with known right answers, in `tests/`) need nothing. The database tests in `tests/db/` run against the test Supabase project, and only when its four `TEST_SUPABASE_*` variables and the three demo passwords are set; otherwise they are skipped. They refuse to run if the test address is the demo one. No test calls Claude: the model is replaced by a fake.

```bash
npm run test:db
```

runs only the database tests. They take a few minutes. The network to Supabase can be slow: on "fetch failed" or a timeout, run once more before changing anything. The test "refuses the wrong role, and audits the attempt" can pass its 5-second limit on a slow network.

The other checks, run after every change:

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm run build
```

## Setting up a database

Apply the migrations, then load the data and create the three users. Without `--target demo` both commands use the test project, so nothing touches the demo by accident.

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

```bash
npm run db:migrate -- --target demo
```

```bash
npm run db:seed -- --target demo
```

The migration runner applies only files the database has not seen. The seed empties every table and loads them again from `ml/export/`, so it is safe to rerun. It creates the demo users through Supabase's admin service, or resets their passwords if they exist, and sets the demo clock to 2 April 2026. On the demo project it then replays February and March 2026 (about four minutes; `--no-history` skips it). The test project gets no history unless you add `--history`, because the flow tests start from empty case tables. After any new migration, run both commands on both projects.

## Rebuilding the data and models

The synthetic customers, the median-day baseline, the two XGBoost models and the model card come from Python in `ml/`. Nothing there is deployed. `ml/README.md` has the setup (Python 3.12 and `libomp`). Then:

```bash
ml/.venv/bin/python ml/run_all.py
```

It takes about two minutes, uses a fixed seed, and writes the same files every time: the CSV files and `ml/export/model_card.md`. `npm test` then plays the exported seeded cases through the real engine. To load new exports, run `npm run db:seed` on each project.

## Resetting the demo

Sign in as ops, open the ops console and press **Reset demo**, then confirm. It:

- empties every case, debit event, plan, schedule card, desk item, customer message, model-call record and the **audit log**, puts back the replayed February and March history with its own ids, then writes one "demo reset" audit row saying who reset it,
- puts back every merchant setting the screens can change (limits, standing defaults, fix modes, kill switches, polish switches) and every customer consent, from the copy the seed saved,
- sets the demo clock back to 2 April 2026,
- **keeps today's agent-run counts.** The cap of 50 runs per user restarts only on a new real date (UTC), so resetting cannot be used to start a fresh 50.

The demo users, the synthetic history and the prompts are untouched. To rebuild everything from the CSV files instead, run `npm run db:seed -- --target demo`.

## Folders

| Folder | Contents |
| --- | --- |
| `lib/engine/` | Every rule, as pure functions: no database, no clock, no network, no model |
| `lib/server/` | The server functions (`flows/`), the agents (`agents/`), message polish, storage and fail-open |
| `lib/data/` | What the pages read, with the user's own login |
| `app/` | Pages and route handlers |
| `components/` | Screen parts. `components/preview/` is the engine preview |
| `lib/demo/` | The demo cases and the screen wording |
| `supabase/migrations/` | The tables, access rules and database functions |
| `scripts/` | The migration runner and the seed |
| `tests/` | Golden cases; `tests/db/` the database tests |
| `ml/` | Synthetic data and models |
| `specs/` | The product decisions and the build plan. `00-decision-record.md` wins over everything else |
| `CLAUDE.md` | The standing instructions Claude Code reads at the start of every session |

## Limits to state in a demo

- Synthetic data shows the logic works. It does not show real-world lift.
- The customer phone link never expires.
- Reset demo empties the audit log.
- The estimate is less accurate for some customers. In `ml/export/model_card.md`, gig workers and the self-employed get guesses about 5 days off on average, against about 1 day for salaried customers. The customer type is never a model input.
- Razorpay's actual retry days, reason codes and scheduling controls are assumptions to confirm.
- Three open legal questions (`specs/08-security.md`): suggested days shown to a lender hint at when the borrower is funded; whether cross-merchant payment timing may be used this way, and under what consent; and whether polished wording in loan messages needs the lender's approved text.
- Version 1 retimes retries only. Moving a due date to match payday is a later phase with its own compliance work.
