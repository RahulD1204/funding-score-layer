# Funding Score Layer (prototype)

@AGENTS.md

An advisory layer for lenders and insurers. When an EMI or premium debit fails for lack of funds, it suggests retry schedules timed to the customer's funded day, and the merchant chooses. It never moves money. All data is synthetic. It is a prototype for a product challenge and not an official Razorpay product.

**Version 1 retimes retries only.** The due-date debit always runs as usual. The layer never changes a due date.

## Stack

- Next.js 16 (App Router, TypeScript, Tailwind 4) on Vercel. Cache Components are on. Read the guide in `node_modules/next/dist/docs/` before writing Next.js code, as AGENTS.md says.
- Supabase for Postgres, login and row-level security.
- Claude through an Anthropic API key, called only from server code.
- Python in `ml/` for synthetic data and model training. Never deployed.
- Vitest for tests.

## Source of truth

The `specs/` folder. Read the relevant spec before any change.
`specs/00-decision-record.md` wins over every other file.
If code and spec disagree, stop and ask. Do not guess.
`specs/10-build-plan.md` says what is built and what comes next.

## What is built

- `lib/engine/`: every rule, as pure functions, with golden cases in `tests/`.
- `components/preview/` and `lib/demo/`: the home page preview, which plays fixed demo cases through the real engine with no database.
- `ml/`: synthetic data, the median-day baseline, the XGBoost models and the model card. Exports CSV files to `ml/export/`. See `ml/README.md`.
- `supabase/migrations/`: the 26 tables and their access rules. `scripts/`: the migration runner and the seed, which loads `ml/export/` and creates the three demo users. `tests/db/`: access tests against the test Supabase project. Applied to both the test and the demo project.
- `app/api/` and `lib/server/`: the five server functions (process-debit-event, choose-schedule, advance-day, update-controls, reset-demo), with login and role checks, storage and fail-open. `tests/db/flows.test.ts`: flow tests against the test project. Notes in `specs/10-build-plan.md` under step 6.
- `app/` pages, `components/` and `lib/data/`: the nine screens on live data (step 7). Login by cookie (`proxy.ts`, `lib/supabase/`); pages read with the user's own login. The engine preview is at `/preview`. Notes in `specs/10-build-plan.md` under step 7.
- `lib/server/agents/`: the three agents (Failure Triage, exceptions desk, Ops assistant), their read-only tools and prompts. Routes `run-exceptions-desk`, `approve-fixes`, `ask-ops-assistant`. Tests with the model mocked in `tests/agents.test.ts` and `tests/db/agents.test.ts`. Notes in `specs/10-build-plan.md` under step 8.
- `lib/server/flows/compose-message.ts` and `lib/server/polish.ts`: customer message text. The template is filled when a debit locks or a link is sent, polished by Claude only if the merchant's switch is on and `validatePolish` passes, and stored with the merchant's copy. Tests with the model mocked in `tests/messages.test.ts` and `tests/db/messages.test.ts`. Notes in `specs/10-build-plan.md` under step 9.

## Hard rules

- Merchants never see a score, a percentage, confidence, tier, the predicted funded day, salary, income or employer. A likelihood band (High, Medium, Lower) is allowed.
- Lenders see suggested schedules. Insurers see a date only once it has locked, and never see schedule options.
- Merchant tables are plain tables written only by server functions. They are not views.
- `audit_log` is append-only.
- Any error or failed check fails open to Razorpay's original retries and writes an audit row.
- All time logic uses `sim_clock.today`, never the real date. The engine takes dates as arguments and never reads a clock.
- Amounts are integers in paise. Display as "Rs 12,000". Dates display as "8 April".
- Engines in `lib/engine` are pure: no database, no clock, no network, no model call. Server functions add storage and nothing else. Never re-implement a rule outside `lib/engine`.
- Agents use a fixed, read-only tool list and at most four steps. They never query the database. Rules decide what happens with their output.
- Nothing is sent to a customer unless a merchant approved it or set that fix type to automatic.
- Facts in messages come from code, never from a model.
- The Supabase secret key and the Anthropic key are used only in server code. Never give a secret a `NEXT_PUBLIC_` name.
- A user must not be able to change their own role.
- Synthetic data only. No real names, accounts or keys.
- Never edit a golden case to make it pass. Change the spec and `POLICY_VERSION` first.
- Do not add features, tables or screens that are not in the specs. The due-date switch and the mandate-setup suggestion are a later phase.
- Never print or commit a secret or a demo password.

## Commands

- `npm test`: all golden cases, plus the database tests when the test project's variables are set
- `npm run test:db`: only the database tests
- `npm run db:migrate` and `npm run db:seed`: the test project. Add `-- --target demo` for the demo project
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run dev`: local site at http://localhost:3000

Run all four checks after every change and show the output.

## Working rules

- One task per session. Show a plan and wait before large changes.
- The owner is not a developer. Explain choices in plain words, define a term the first time it appears, and give exact click-by-click steps for anything done in a browser.
- Commit with a clear message once the check for the task passes. Push only when asked.

## Words

"Retry", "Razorpay's original retries", "likelihood", "charges for waiting", "your overdue cap". Never "score" on a merchant screen. See `specs/02-design.md` for the design system.
