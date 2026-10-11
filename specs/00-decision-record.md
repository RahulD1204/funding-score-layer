# 00. Decision record

Every product decision for version 1, in one place. **This file wins over every other spec.** If code and this file disagree, stop and ask.

Numbers marked *placeholder* are starting values to tune on data. Change `POLICY_VERSION` in `lib/engine/policy.ts` whenever a rule or number changes, then rerun all tests.

## Final scope for version 1

**Version 1 retimes retries only.** The debit on the due date always runs as usual. When it fails for lack of funds, the layer suggests when to try again. It never changes the due date, never skips the due-date debit, and never moves money.

| In version 1 | Left for a later phase |
| --- | --- |
| Retry schedules timed to the customer's funded day | Changing the due date to match payday (the "salary-aligned switch"), with pro-rata interest for the bridge days |
| Lender picks a schedule per case; a standing default applies otherwise | Suggesting a debit date at mandate setup |
| Insurer runs on the standing default and sees a date only once it locks | SIPs, recurring deposits, several obligations per customer |
| Payment link when the funded day is out of reach | Real WhatsApp or SMS delivery, a customer reply agent |
| Exceptions desk for failures that waiting cannot fix | Real payroll and inbound-credit data, live scoring |
| Three agents: Failure Triage, Exceptions desk, Ops assistant | Tier B (partial evidence) customers |

Why retries only: retiming a retry stays inside the existing mandate and loan contract. Skipping the due-date debit would make the loan overdue by the layer's own choice. Changing the due date is a contract change that needs disclosed terms, customer consent and the lender's written policy. Those two are compliance work, so they wait.

## Product

| Decision | Choice |
| --- | --- |
| Who it is for first | High-ticket recurring debits: lending leads, insurance second. Small-ticket subscriptions (service first, low value) are out of scope |
| What it is | An advisory layer. It suggests; the merchant decides. Any failed check or error falls back to Razorpay's original retries ("fail open") and is logged |
| Lender experience | Two or three schedules per failed EMI: Earliest, Balanced, Safest. The lender picks one, or the product's standing default applies when its first date is about to lock |
| Insurer experience | No schedule cards. The standing default applies at once. A date is shown only once it locks, the day before the attempt |
| How likelihood is shown | Three coarse bands, never a percentage: High (80% or more), Medium (60% to under 80%), Lower (under 60%) |
| What a card shows | Dates, band, number of attempts, days overdue at the first attempt, charges for waiting (days overdue × the lender's disclosed per-day penal charge), and the difference against Razorpay's original first retry. A greyed row lists the original retries |
| Bounce charge | Shown as a fixed fact per failed attempt. Never multiplied by a likelihood |
| The lender's "last allowed day" | Labelled as the lender's overdue cap |
| Never shown to a merchant | A score, a percentage, confidence, tier, the predicted funded day, salary, income, employer |
| Customer text | A template carries every fact. Claude may polish the wording; a rewrite that changes a fact or hints at income is rejected. Polish starts off for lenders and on for insurers |
| Exceptions desk | The merchant sets each fix type to automatic or needs approval. Anything that contacts the customer starts as needs approval |
| Baseline | Razorpay's original retries. Used for fail open, for the holdout group and for comparison |

## Build

| Decision | Choice |
| --- | --- |
| Tooling | Claude Code, in the desktop app's Code tab |
| App | Next.js (App Router, TypeScript, Tailwind) on Vercel |
| Data and login | Supabase (Postgres, login, row-level security), added through the Vercel Marketplace |
| Test database | A second, free Supabase project used only by the automated tests |
| AI | An Anthropic API key, called only from server code. A smaller, faster Claude model for Failure Triage and message polish; a mid-tier Claude model for the Exceptions desk and the Ops assistant. Model names live in environment variables |
| Scoring | The model is trained offline and its scores are stored. The app looks scores up and falls back to the live rule |
| Model work | Python scripts in `ml/`. Never deployed |
| Razorpay | Mocked: an event injector and a simulated clock. One optional test-mode payment-link call |
| Data | Synthetic only. No real customer data and no live keys |
| Replayed history | The demo opens with February and March 2026 already played: every failed due-date debit of the app's obligations in those two months goes through the real engine and server functions, with the clock walking day by day, standing defaults and no agent calls (their fallbacks apply). Waiting customer-contact fixes from that history are marked rejected, so the exceptions desk holds only live items. Reset demo restores this history. It shows what the layer would have done; the raw transactions still show Razorpay's original retries for those months. Decided 12 October 2026 |

## Signals and model

| Decision | Choice |
| --- | --- |
| Signals | (1) A recognized salary credit. (2) This lender's own collection history for the loan, counted twice. (3) Cross-merchant timing: every successful transaction the customer makes through Razorpay |
| Timing and affordability | Judged separately. Timing uses payments of any size. Affordability needs at least 3 past debits of at least half this debit; fewer takes 10 points off confidence instead of blocking |
| Salary rule | Same source, at least 3 consecutive months ending this month or last, every amount within 10% of the median, every date within 3 days of the circular median. A wrong payday is worse than none |
| Models | Train XGBoost AFT and XGBoost quantile; keep the one with lower day error and coverage closest to 80%. Baseline: the median-day rule |
| Confidence floor | 80% for lending, 70% for insurance. Below the floor the case fails open |
| Drift | If the last 3 months' pattern is more than 3 days from the 12-month pattern, use the recent one and take 10 points off |

## Policy

| Decision | Choice |
| --- | --- |
| Rails | Lending on bank mandates (eNACH): a result takes 2 calendar days. Insurance on UPI Autopay: the result is instant |
| First retry | Never before the day after the due-date failure is known |
| Backup | Spaced so the first result is known before it runs. Two debits are never unresolved at once |
| Early attempt ("probe") | Never for lending, because a failed attempt costs the borrower a bounce charge. For insurance, one early attempt when no salary is recognized |
| Lock | An action locks when the clock reaches the day before its date. A lender can pick or change a schedule until then |
| Out of reach | When the funded day is past the merchant's cap, no debit is planned. A loan gets a payment link on the funded day. A premium gets a link at once, because waiting risks a lapse |
| Paid outside the plan | Pending attempts are cancelled. Refused while a debit is unresolved, so the customer is never charged twice |
| Stepping back | Kill switch, consent withdrawn, or the merchant forces original retries: pending actions are cancelled and Razorpay's original retries resume |
| Authentication limit | On UPI Autopay, debits above Rs 15,000 (Rs 1 lakh for insurance premiums) need extra customer authentication, so the layer does not act on them. Bank mandates are not checked |
| Who presents the debit | In the prototype, the lender's pick is its instruction and the simulated executor presents on that day. In production, the lender's system or Razorpay's scheduler reads the pick |
| Starting limits (*placeholder*) | Lending: last allowed day 10, 2 re-presentations. Insurance: last allowed day 12, 3 attempts. Each merchant edits its own |
| Razorpay's original retry days (*placeholder, to confirm*) | Lending: days 3, 6, 9. Insurance: days 1, 2, 3 |

## Agents

| Agent | Called when | May do |
| --- | --- | --- |
| Failure Triage | Only for catch-all reason codes that the code table and the lookups cannot label | Return one label from a fixed list, a strength and its evidence. Only a strong answer is accepted. Code confirms the facts behind a "balance" label. A closed-account label needs a past closed-account code on the obligation, and a mandate or downtime label the lookups ruled out is refused (policy v1.3, decided 12 October 2026) |
| Exceptions desk | A non-balance failure, or a payment outside the plan | Propose fixes from a fixed catalogue with a reason. The merchant's setting decides the mode |
| Ops assistant | An ops analyst asks why | Answer from the audit log and cite the rows used |

All three: fixed read-only tools, at most four steps, validated output, rules decide what happens, every step logged. See `07-agents.md`.

## Build order and cut line

1. Lending rules and screens.
2. Insurance.
3. Exceptions desk agent and Ops assistant.

If time runs short, cut from the bottom. The desk works without its agent through the rule-based fallback.

## The later phase, recorded so it is not lost

The salary-aligned switch moves the EMI due date to just after payday.

- Offer it first only to borrowers who are not overdue. Then A/B test on overdue borrowers.
- New dates come from the lender's allowed dates, with settings to permit others once compliance is checked.
- The first debit after the switch runs up to the salary day. After that the EMI is pro-rated for the bridge days (broken-period interest).
- It is a change to the loan terms. It needs the lender's written policy, a disclosed fee or interest effect, and the borrower's explicit consent. Consent can be taken online: several banks and NBFCs already offer EMI date changes in their apps.

## Compliance notes (research, not legal advice)

- RBI rules on penal charges: a lender may levy penal charges, not penal interest, and they must be disclosed in the Key Facts Statement. The cards use the lender's own disclosed rates.
- A loan is overdue from the due date. The layer does not change that; it only changes when the next attempt runs.
- E-mandate rules set the amounts above which a recurring debit needs extra authentication.
- NACH presents on all days, including weekends and holidays.

## Open questions

| # | Question | Who answers |
| --- | --- | --- |
| 1 | What are Razorpay's real default retry days and counts for eNACH and UPI Autopay? | Razorpay |
| 2 | Can a merchant choose the day of each re-presentation today, or does Razorpay schedule them? | Razorpay |
| 3 | What reason codes and free text do banks return for recurring-debit failures? | Razorpay |
| 4 | May payment-timing signals across merchants be used for this purpose, and under what consent? | Counsel |
| 5 | Do suggested days shown to a lender count as sharing a signal about the borrower's income? | Counsel |
| 6 | May a lender's approved message text be reworded by a model? | Counsel, lender |
| 7 | Could likelihood bands be reused for credit limits or collections pressure, and how is that prevented? | Counsel |
| 8 | Is a 2-day result delay right for all sponsor banks? | Razorpay |
| 9 | What grace periods and attempt limits do insurers actually apply? | Insurers |
| 10 | What uplift is enough to justify the wait? | Rahul, with pilot lenders |
