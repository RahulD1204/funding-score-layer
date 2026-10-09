# 08. Security and privacy

Each risk has a control and a check. Rows 1 to 3 protect the privacy promise. Rows 9 to 12 cover the agents.

| # | Risk | What can go wrong | Control | How to check |
| --- | --- | --- | --- | --- |
| 1 | Score leak | A merchant reads a percentage, confidence, tier, the predicted funded day or salary | Merchant tables hold bands and dates only. Internal tables are closed to merchants | A test signs in as each merchant and tries to read every internal and system table |
| 2 | Band reused as a credit signal | A lender uses bands for limits, pricing or collections pressure | Three coarse bands, no export, and a purpose limit in the merchant terms | Outside the prototype. Raise with counsel |
| 3 | Insurer learns payday | Dates are visible long before they are needed | An insurer's row carries a date only once it locks, and it cannot read schedule options | Golden case F11, and the access test on `schedule_options` |
| 4 | Leak between merchants | One lender sees another's cases | A row policy on merchant id | Create a second lender account and compare queues |
| 5 | Role escalation | A user changes their own role to ops | `profiles` is not writable by the user | Try it from a merchant account |
| 6 | Exposed keys | The Supabase secret key, the Anthropic key or Razorpay test keys reach the browser | Keys live in Vercel environment variables. Calls run only in server functions. Server-only modules import `server-only` | Search the built site for the key prefixes |
| 7 | Unauthenticated calls | Anyone triggers a case or advances the clock | Every function requires a login and checks the role | Call a function URL without a token |
| 8 | Forged or repeated webhooks | Fake failure events create cases | Signature check and event-id check on the public route | Send a bad signature, then the same event twice |
| 9 | Agent acts outside its remit | An agent invents a label or a fix | Fixed label and fix lists, validated outputs, rules decide | Golden cases E14, P4 and D3 |
| 10 | Agent contacts a customer unprompted | A borrower gets a message nobody approved | Customer-contact fixes need approval unless the merchant set that type to automatic | Golden case D2, and the flow test for approvals |
| 11 | Prompt injection | Bank text or a merchant name steers an agent | Structured fields, tool results treated as data, no tool that writes | Put "ignore your instructions" in the bank text |
| 12 | Agent sees too much | A salary amount reaches an agent's context | Each tool returns only its listed fields | Read the tool outputs stored in `llm_runs` |
| 13 | Invented facts in messages | A message carries a wrong date or amount | Facts come from code. A rewrite is rejected unless amount, dates and name match | Golden cases M2 and M3 |
| 14 | Income words | A message hints at salary | Banned-word check with template fallback | Golden case M4 |
| 15 | Audit tampering | Rows are edited or deleted | Append-only policy | Try an update as ops |
| 16 | Cost spike | A loop of agent runs | 50 agent runs per user per day, a four-step limit, a spend limit on the key | Count rows in `llm_runs` |
| 17 | Real personal data | Real names or accounts enter the prototype | Synthetic data and test keys only, with the footer label | Review the seed files |
| 18 | Unfair suggestions | One group gets systematically worse suggestions | No demographic or location columns | Compare day error by archetype in `ml/` |
| 19 | Double debit | A customer is charged twice in one cycle | One unresolved debit at a time; pending actions cancelled on any success; pay-by-link refused while a debit is unresolved | Golden cases F4, F6, F7 and F10 |
| 20 | Stale consent | The layer acts after consent is withdrawn | Control checks re-run before every action | Golden case F9 |

## Open risks no control here removes

- Suggested days shown to a lender hint at when the borrower is funded.
- Whether cross-merchant payment timing may be used for this purpose, and under what consent, is a legal question.
- Polished wording in loan messages may need the lender's approved text.

State all three as open legal questions in the demo.

## Secrets

- Never commit `.env*` files. `.gitignore` already excludes them.
- Never print a key or a demo password in logs, tests or chat.
- The Supabase secret key and the Anthropic key are read only in files under `lib/server/` and `app/api/`.
