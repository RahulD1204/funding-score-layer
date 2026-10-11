# 02. Design

## Screens

Nine screens: seven behind a login for three roles, one customer mock, and the login itself. The home page's engine preview (`components/preview/`) is the visual reference for the lender, insurer and ops views. Build the real screens to match it.

| # | Screen | Role | What is on it |
| --- | --- | --- | --- |
| 1 | Login | All | Three one-click buttons, "Sign in as lender", "Sign in as insurer" and "Sign in as Razorpay ops", with the line "Demo accounts on synthetic data. Click Reset demo on the ops console before you start." Email sign-in below them. One seeded demo account each for a lender, an insurer and ops |
| 2 | Collections queue | Lender | Summary strip: awaiting choice, in progress, paid, on original retries, failed retries. Table of failed EMIs: borrower, amount, state, next date, retries used, chosen schedule. Badge: "Advice only, you decide". Under the table: "February and March are replayed history on synthetic data." |
| 3 | Case detail | Lender | Two or three schedule cards. Each card: label, dates, likelihood band, days overdue, charges for waiting, difference against the original first retry, a pick button and its deadline. A greyed row with Razorpay's original retries. Plan table, customer message, outcome, activity |
| 4 | Renewals dashboard | Insurer | Failed premiums with state, end of cover, attempts used, and the next date once it locks. No schedule cards. Under the table: "February and March are replayed history on synthetic data." |
| 5 | Exceptions desk | Lender and insurer | A Needs action queue: items waiting for approval first, then the rest, each group sorted by deadline. Failure label, proposed fix, reason and mode. Approve selected, approve all |
| 6 | Settings | Lender and insurer | Per product: last allowed day, maximum re-presentations, standing default, the disclosed penal charge per day and bounce charge. Per fix type: automatic or needs approval. Polish switch, kill switch, consent status |
| 7 | Customer phone mock | No login | Consent notice, dated message, pay-by-link button, withdraw consent |
| 8 | Ops console | Ops | Demo clock, event injector with a reason code, triage view (label, evidence, rule or agent), internal case view, the Ops assistant box, Reset demo |
| 9 | Audit log and model card | Ops | Every decision with its inputs, schedules, choice and versions. Model card with baseline, quantile and AFT side by side |

## States a merchant sees

Every state is a word plus a colour.

| State | Trigger | Shown | Colour |
| --- | --- | --- | --- |
| Awaiting choice | Schedules are ready and the lender has not picked | The cards, and when the standing default will apply | Amber |
| Scheduled | A schedule is picked or the default applied | The next date. An insurer sees it once it locks | Blue |
| Result pending | A bank-mandate debit was presented and its result is due | Attempt date and result date | Amber |
| Link sent | The funded day is out of reach | Date the link was sent | Blue |
| Paid | A debit or a link succeeds, or the merchant marks it paid | Paid date | Green |
| Needs action | A non-balance failure has a proposed fix | The fix and its mode | Amber |
| Original retries | The layer is not acting: unknown failure, no consent, thin data, low confidence, kill switch, holdout | Razorpay's original retries, with no reason given to the merchant | Grey |
| Failed | The schedule is used up | Normal failure state | Red |

## AI behaviour

| Topic | Choice |
| --- | --- |
| Waiting | Schedules appear at once, because scores are looked up. Agent answers take seconds, so the screen shows progress steps such as "checking mandate" |
| Trust | The "Advice only" badge, bands instead of percentages, and the evidence behind every agent output with a note of whether a rule or the agent decided |
| Control | A lender picks or changes a schedule until its first date locks. Each fix type has its own switch. Nothing reaches a customer without approval unless the merchant set that fix to automatic |
| Input | The event injector accepts only known codes and existing obligations. The Ops assistant answers only about cases in the audit log |
| Failure | Any error fails open and is logged. A failed agent call leaves the label unknown. A failed polish call keeps the template |
| History | The audit log, filterable by obligation, including each agent step |
| Empty state | Seeded cases, so no screen is empty |

## Words

- "Retry" for a re-presentation after the due date. "Razorpay's original retries" for the baseline.
- "Likelihood", shown as High, Medium or Lower. Never "score" or "probability" on a merchant screen.
- "Charges for waiting", never "cost of delay" or "penalty interest".
- "Your overdue cap" for the lender's last allowed day.
- Never on a merchant or customer screen: salary, payday, income, employer, wage, balance.
- Amounts as "Rs 12,000" with Indian digit grouping. Dates as "8 April".

## Design system

Navy `#0B1F3A` for headers, blue `#2563EB` for actions, background `#F7F9FC`, text `#111827`. State colours: green `#15803D` paid, amber `#B45309` waiting, blue for scheduled and link, grey `#6B7280` idle, red `#B91C1C` failed. Font Inter, bundled in `app/fonts` so the build fetches nothing. 8 px corners, compact tables, plain formal tone. Desktop first, with every screen readable on a phone and no sideways scrolling. Tokens live in `app/globals.css`.
