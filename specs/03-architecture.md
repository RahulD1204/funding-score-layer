# 03. Architecture

## Layers

| Layer | Job | How |
| --- | --- | --- |
| Front end | Nine screens | Next.js App Router pages on Vercel |
| Server functions | Event intake, triage, checks, merchant choice, executor, desk, message text | Next.js route handlers under `app/api/`. They run on Vercel and are the only code that writes data |
| Engine library | Every rule | Pure TypeScript in `lib/engine`. No database, no clock, no network, no model call. Built and tested |
| Data and login | Signals, predictions, cases, schedules, desk queue, audit log, consent, clock, three roles | Supabase: Postgres with row-level security, plus its login service |
| AI | Three agents and message polish | Claude, called only from server functions |
| Model work | Synthetic data, features, training, scoring | Python in `ml/`. Run by hand or by Claude Code. Never deployed |
| Razorpay, mocked | Failed-debit events, debits, results, links | Event injector and simulated clock. One optional test-mode link call |

Scores cross into the database once, as stored predictions. Server functions read them, run the engine, and write a few plain tables that a merchant can read. Nothing internal reaches a merchant through a join, because merchant tables are not views.

## Folders

```text
app/                 pages, layouts, route handlers (app/api/*)
app/fonts/           Inter, bundled
components/          screens and shared UI
components/preview/  the engine preview on the home page (the visual reference)
lib/engine/          the pure rule engine (built)
lib/demo/            fixed demo cases for the preview (replaced by seeded tables)
lib/server/          Supabase clients, auth and role checks, agent runner (to build)
ml/                  Python: synthetic data, features, models, exports (to build)
supabase/migrations/ tables and access rules as SQL files (to build)
scripts/             seed and reset scripts (to build)
specs/               these files
tests/               golden cases
```

## The engine, already built

| File | Engine |
| --- | --- |
| `policy.ts` | Every number and the policy version |
| `dates.ts` | Date arithmetic on ISO strings in UTC, and display formats |
| `circular.ts` | Circular median and spread for days of the month; start-of-month and end-of-month anchors |
| `triage.ts` | Failure triage by code table and lookups; acceptance of the agent's answer; control and consent checks |
| `estimate.ts` | Evidence gate, salary recognition, funded-day estimate, confidence, likelihood by day |
| `schedule.ts` | Schedule builder, bands, card arithmetic |
| `desk.ts` | Fix catalogue, modes, validation of the desk agent's output, rule-based fallback |
| `messages.ts` | Templates, banned words, polish validation |
| `simulate.ts` | The case state machine: pick, lock, present, result, link, stop, baseline |
| `pipeline.ts` | One failed debit through triage, checks, gate, estimate and schedules |

The server functions wrap these functions and add storage. They add no rules of their own.

## Server functions

Each one requires a login and checks the role, except the customer mock routes, which take a signed case token.

| Function | Triggered by | Role | What it does |
| --- | --- | --- | --- |
| `process-debit-event` | The event injector, or a Razorpay test webhook | Ops | Drops a repeated event id. Loads the inputs, calls `evaluateFailedDebit`, calls the Triage agent if the result is `needs_agent`, then writes the case, the schedule options, the merchant row and the audit entry |
| `choose-schedule` | The lender's pick button | Lender | Calls `pickSchedule`. Writes the choice, the actions and an audit entry |
| `advance-day` | The Next day button | Ops | Moves `sim_clock.today` one day. For each open case calls `advanceDay` with the control checks re-run from live data. Writes results and merchant rows |
| `run-exceptions-desk` | A non-balance triage label, or a payment outside the plan | System | Calls the desk agent, validates with `validateDeskOutput`, falls back to `fallbackProposals`. Automatic fixes run at once; the rest wait |
| `approve-fixes` | The desk's approve buttons | Lender, insurer | Runs the approved fixes and audits them |
| `ask-ops-assistant` | The Ops assistant box | Ops | Answers from the audit log and cites rows |
| `update-controls` | Settings and the customer mock | Lender, insurer, customer token | Limits, standing default, fix switches, kill switch, consent withdrawal, pay by link, mark as paid, force original retries. Calls `recordOutsidePayment` or `stopLayer` |
| `compose-message` | An action locks, or a link is sent | System | Fills the template, optionally polishes with Claude, validates with `validatePolish`, stores the text |
| `reset-demo` | The Reset demo button | Ops | Restores the seeded state |
| `create-payment-link` (optional) | A link action | System | Calls Razorpay's Payment Links API with test keys |

## Event path

1. Ops clicks Simulate failed debit. The browser calls `process-debit-event` with the user's login token.
2. The function checks the role, validates the input and stores the event. A repeated event id stops here.
3. Triage labels the failure. A balance failure continues. A non-balance label goes to the exceptions desk. An unknown label fails open.
4. Control and consent checks, then the evidence gate. Any failure stops the flow and is logged as fail open.
5. The stored prediction is read (or the live rule runs), the confidence floor is applied, and schedules are built inside the merchant's limits.
6. A lender's case waits in Awaiting choice. An insurer's standing default applies at once.
7. The case, its options and the merchant row are saved, and the audit entry is written.

## Clock path

1. Ops clicks Next day. `advance-day` moves the stored date forward.
2. The standing default applies to any lender case whose first date locks tomorrow.
3. Tomorrow's actions lock, and their customer messages are composed.
4. Results due today are delivered. Ground truth as of the attempt date decides success.
5. Today's actions run: the control checks first, then the debit or the link. An insurance result is instant; a lending result is held for 2 days.
6. On success the case is Paid and remaining actions are cancelled. On failure the attempt is counted and the backup stays.
7. Merchant rows and the audit log are updated.

All time logic reads `sim_clock.today`. Nothing reads the real date.

## Environment variables

| Name | Used by | Notes |
| --- | --- | --- |
| Supabase URL and public key | Browser and server | Added by the Vercel Marketplace integration under its own names (they start with `NEXT_PUBLIC_`). Safe in the browser because row-level security is on |
| Supabase secret key (also called the service-role key) | Server only | Added by the same integration. Bypasses access rules. Never imported from a client component, never given a `NEXT_PUBLIC_` name |
| `ANTHROPIC_API_KEY` | Server only | Set a monthly spend limit on the key |
| `CLAUDE_MODEL_FAST`, `CLAUDE_MODEL_SMART` | Server only | Model names for triage and polish, and for the desk and the Ops assistant. Check the current names in Anthropic's documentation |
| `DEMO_LENDER_PASSWORD`, `DEMO_INSURER_PASSWORD`, `DEMO_OPS_PASSWORD` | Seed script | Never printed, never committed |
| `TEST_SUPABASE_URL`, `TEST_SUPABASE_SECRET_KEY` | Tests | The second Supabase project |
| `TEST_SUPABASE_PUBLISHABLE_KEY` | Tests | The test project's public key. The access tests sign in with it, as a browser would |
| `TEST_SUPABASE_DB_URL` | Migrations, seed, tests | The test project's database connection string (Session pooler). Local `.env.local` only |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Optional | Test keys only |

## Framework note

This repository uses Next.js 16 with Cache Components and Partial Prefetching turned on. Conventions differ from older versions. Read the relevant guide in `node_modules/next/dist/docs/` before writing any Next.js code. Pages that read the database per request must do so inside a `<Suspense>` boundary or a cached function, as that guide explains.
