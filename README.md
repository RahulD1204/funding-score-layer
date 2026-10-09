# Funding Score Layer (prototype)

When a loan EMI or an insurance premium debit fails because the account is short, the usual retries follow a fixed calendar and often fail again before the money arrives. This layer estimates the day each customer is usually funded and suggests retry dates that wait for it.

It is **advice only**. The merchant decides, the layer never moves money, and any doubt falls back to Razorpay's original retries.

Built for Razorpay's AI PM Build Challenge. **All data is synthetic. This is not an official Razorpay product.**

## What works today

- **The rule engine** (`lib/engine/`): failure triage, consent and control checks, the evidence gate, the funded-day estimate, the schedule builder, the day-by-day case flow, the exceptions-desk rules and the message checks. Pure functions with no database.
- **Golden cases** (`tests/`): fixed inputs with known right answers. `npm test` reruns them all.
- **An engine preview** (the home page): nine invented cases played through the real engine, viewed as a lender, an insurer and Razorpay ops, with a simulated clock.

Not built yet: the trained model, the database, sign-in, the server functions and the three Claude agents. `specs/10-build-plan.md` lists the remaining steps as prompts for Claude Code.

## Try it

You need [Node.js](https://nodejs.org) 20.9 or later.

```bash
npm install
npm run dev
```

`npm install` may end with a warning about vulnerabilities. They sit in the code checker's own dependencies, which never reach the site. Do not run `npm audit fix --force`: it would downgrade the checker and break it.

Open http://localhost:3000. Press **Next day** to move the simulated clock. Switch between **Lender**, **Insurer** and **Razorpay ops** at the top.

Things to try as the lender:

1. Leave Asha Verma alone. On 7 April the standing default applies, and the EMI is collected on 8 April with no failed retry. The outcome table compares this with the original retries.
2. Reset. For Rohan Mehta, pick **Earliest**. The first attempt lands a day early and fails; the backup collects.
3. Open Imran Sheikh. No debit can reach his funded day inside the lender's cap, so a payment link goes out instead and nothing bounces.
4. Open Vikram Nair. A cancelled mandate goes to the exceptions desk, not to a schedule.

## Checks

```bash
npm test          # golden cases
npm run typecheck
npm run lint
npm run build
```

## How a failed debit is handled

1. **Triage.** A code table and lookups label the failure. Only a balance failure continues. A cancelled mandate, a closed account or a bank downtime goes to the exceptions desk. An unclear code is read by the Triage agent; a weak answer leaves the original retries in place.
2. **Checks.** Layer on, kill switch off, both consents, not in the holdout group, mandate active, amount inside the authentication limit.
3. **Gate.** At least 25 past payments over at least 3 months. Otherwise the layer stays out.
4. **Estimate.** A recognized monthly credit first, otherwise the pattern in the customer's payment dates. Below the confidence floor (80% for loans, 70% for premiums) the layer stays out.
5. **Schedules.** Earliest, Balanced and Safest, inside the merchant's own limits, each with a backup spaced so two debits are never unresolved at once.
6. **Choice.** A lender picks, or the standing default applies. An insurer runs on the default and sees a date only once it is fixed.

## What a merchant never sees

A score, a percentage, confidence, the predicted funded day, or anything about a customer's income. A lender sees suggested dates and a coarse likelihood band. Customer messages never mention pay, income or balance.

## Folders

| Folder | Contents |
| --- | --- |
| `lib/engine/` | The rules |
| `tests/` | Golden cases |
| `lib/demo/` | The nine demo cases and their wording |
| `components/preview/` | The preview screens |
| `app/` | Next.js pages, styles and the bundled Inter font |
| `specs/` | The product decisions and the build plan. `00-decision-record.md` wins over everything else |
| `CLAUDE.md` | The standing instructions Claude Code reads at the start of every session |

## Deploying

The app is a standard Next.js project. Import the GitHub repository into Vercel and deploy; no settings or environment variables are needed for the preview. Step 0 in `specs/10-build-plan.md` has a prompt that walks through it.

## Limits to state in a demo

- Synthetic data shows the logic works. It does not show real-world lift.
- Razorpay's actual retry days, reason codes and scheduling controls are assumptions to confirm.
- Whether cross-merchant payment timing may be used this way, and whether suggested dates reveal too much about a borrower, are open legal questions.
- Version 1 retimes retries only. Moving a due date to match payday is a later phase with its own compliance work.
