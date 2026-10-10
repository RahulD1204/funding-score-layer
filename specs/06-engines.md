# 06. Engines

The rules, in the order they run on a failed debit. Each rule is implemented in `lib/engine` and covered by a golden case in `tests/`. If this file and the code disagree, stop and ask.

Days count from the due date: day 0 is the due date. In the examples the due date is 2 April 2026, so day 5 is 7 April.

Symbols: `h` = days from the due date to the estimated funded day. `u` = the upper day. `L` = the merchant's last allowed day. `R` = the merchant's maximum re-presentations. `d` = the result delay (2 for bank mandates, 0 for UPI Autopay).

## 1. Event intake (`process-debit-event`)

- Accept a failed-debit event with an event id, an obligation, a cycle due date, a reason code and the bank's free text.
- A repeated event id is dropped: one case and one audit entry per event.
- Only failures of the due-date debit open a case.

## 2. Failure triage (`triage.ts`)

Three stages, in order. The agent is called only when the first two cannot decide.

| Stage | Input | Result |
| --- | --- | --- |
| Code table | A clear reason code | `insufficient_funds` → balance. `mandate_cancelled`, `mandate_revoked`, `mandate_expired` → mandate cancelled. `mandate_paused` → mandate paused. `account_closed`, `instrument_closed` → instrument closed. `bank_technical_error`, `gateway_technical_error` → bank downtime |
| Lookups | A catch-all code (`payment_failed`, `bank_declined`, `transaction_declined`, or anything unlisted) | Mandate cancelled or expired → mandate cancelled. Mandate paused → mandate paused. A bank downtime at the time → bank downtime |
| Agent | Still unlabelled | The Triage agent returns a label, a strength and evidence |

Accepting the agent's answer (`acceptAgentTriage`):

- The label must be in the list and not "unknown". The strength must be "strong". There must be evidence.
- A "balance" label is refused unless the mandate is active and no downtime applies. Code checks these facts, not the agent.
- Anything else becomes "unknown" and the case fails open.

Routing: balance continues. Mandate cancelled, mandate paused, instrument closed and bank downtime go to the exceptions desk. Unknown fails open.

The mandate and account reason codes are illustrative. Replace them with Razorpay's real codes before a pilot.

## 3. Control and consent checks (`runControlChecks`)

In this order. The first failure is the fail-open reason.

1. The merchant's layer is on.
2. The kill switch is off.
3. The product's limits are set.
4. Merchant consent is recorded.
5. Customer consent is granted and not withdrawn.
6. The customer is not in the holdout group.
7. The mandate is active.
8. The amount is inside the rail's limit for debits without extra authentication: Rs 15,000 on UPI Autopay, Rs 1 lakh for insurance premiums. Bank mandates are not checked.
9. The merchant has not forced original retries for this customer.
10. The cycle has not been paid outside the plan.

The same checks run again before every action, because a mandate can be cancelled or consent withdrawn after a schedule is set.

## 4. Evidence gate (`evaluateGate`)

Uses only data dated before the due date, inside the last 12 months.

| Check | Tier A requires |
| --- | --- |
| Timing observations | At least 25 successful payments of any size |
| Span | At least 3 calendar months |
| Failure evidence | At least one insufficient-funds failure or late rescue |
| Identity | The same customer id across merchants |

Any failed check is Tier C: fail open.

Affordability is separate. Fewer than 3 past successful debits of at least half this debit takes 10 points off confidence. It never blocks on its own.

## 5. Estimate (`estimateFunding`)

1. **Salary first.** Credits from one source in at least 3 consecutive months, ending this month or last; every amount within 10% of the median; every date within 3 days of the circular median. If found, the funded day comes from those credits.
2. **Otherwise payment history.** All successful payments in the window. This merchant's own collections count twice.
3. **Anchor.** Fit the dates two ways: as a day of the month ("the 7th") and as days before month-end ("the last day"). Keep the one whose dates sit closer to its median, by total distance. A tie keeps the day of the month.
4. **Circular median.** Days sit on a 31-day circle, so the 31st and the 1st are neighbours. The days 29, 30, 31, 1, 2 have a median of 31 and a spread (MAD) of 1.
5. **Drift.** If at least 6 observations fall in the last 3 months and their usual day is more than 3 days from the 12-month one, use the recent pattern and take 10 points off.
6. **Confidence.** The share of observations within 2 days of the funded day, as a percentage, minus the affordability and drift deductions.
7. **Floor.** Below 80% for lending or 70% for insurance, fail open.
8. **`h`.** Days from the due date to the next occurrence of the funded day, on or after the due date. A day that does not exist in a month falls on that month's last day.
9. **Likelihood by day.** For each day `k` from 0 to 30: the share of observations whose own next occurrence falls on or before day `k`.
10. **`u`.** The first day with a likelihood of at least 85%, and never less than `h + 1`.
11. **Model score.** When a stored model score exists, its `h`, `u`, likelihood and confidence replace the rule's. The same deductions and floor apply.

## 6. Schedule builder (`buildSchedules`)

The due-date failure is known on day `d`. No retry runs before day `d + 1`.

**Out of reach** when `h > L`, or `R < 1`, or `d + 1 > L`: no schedules. A loan gets a payment link on day `max(h, d + 1)`. A premium gets one on day `d + 1`.

Otherwise three schedules:

| Label | Main attempt day, before limits |
| --- | --- |
| Earliest | `h` |
| Balanced | `h + 1`, because money often lands late in the day |
| Safest | `u + 1` |

- Each main day is raised to at least `d + 1` and lowered to at most `L`.
- **Backup** on main day + `d` + 1, if that is on or before `L` and `R` allows. This spacing means the first result is known before the backup runs.
- **Insurance only**, with an attempt still unused: if no salary is recognized and the main day is after `d + 1`, add an early attempt on day `d + 1`. If a salary is recognized, add a second backup instead.
- Lending never gets an early attempt.
- Schedules with identical attempts merge. The card keeps the first label and lists the others.
- **Band** at the main day: High at 80% or more, Medium at 60% or more, otherwise Lower.

Example: `h = 5`, `u = 7`, `L = 10`, `R = 2`, `d = 2`. Earliest: 7 and 10 April. Balanced: 8 and 11 April. Safest: 10 April only, because a backup on 13 April is past the cap.

**Cards** (`buildCards`): days overdue = the main day. Charges for waiting = days overdue × the lender's per-day penal charge. Against the original = the main day minus the first original retry day, and the same in charges. The bounce charge is listed once as a fixed amount per failed attempt.

## 7. Choice and execution (`simulate.ts`)

- A case opens on day `d`, when the failure is known.
- **Lender.** State is Awaiting choice. A pick is allowed while the picked schedule's first date is more than one day away and nothing has locked. The lender can change a pick under the same rule.
- **Standing default.** Applies when its first date is one day away and nobody has picked. For an insurer it applies at once.
- **Lock.** An action locks when the clock reaches the day before its date. The customer message is composed then.
- **Each day, in order:** apply a due default; lock tomorrow's actions; deliver results due today; mark a sent link paid once the customer is funded; run today's actions.
- **Before each action:** re-run the control checks. A failure cancels pending actions. An inactive mandate sets Needs action; anything else sets Original retries.
- **Presenting a debit:** it succeeds if the customer is funded that day (ground truth). The result is known after the rail's delay.
- **No overlap:** a debit is never presented while an earlier one is unresolved. It is held to the day after that result, or dropped if that would pass `L`.
- **Success:** the case is Paid and every pending action is cancelled.
- **Failure:** the failed-retry count rises. When nothing is left, the case is Failed.
- **Paid outside the plan:** allowed at any time except while a debit is unresolved.
- **Stepping back:** pending actions are cancelled and the remaining original retry days are listed.

**What a merchant row may carry** (`merchantView`): state, next date and kind, result date, attempts used, and for a lender the chosen label and the options. For an insurer the next date is filled only once that action has locked, and there are no options. It never carries `h`, `u`, a likelihood number or confidence.

## 8. Exceptions desk (`desk.ts`)

| Trigger | Fix | Contacts the customer | Starting mode |
| --- | --- | --- | --- |
| Mandate cancelled | Stop further attempts | No | Automatic |
| Mandate cancelled | Send a re-registration link | Yes | Needs approval |
| Mandate paused | Hold attempts | No | Automatic |
| Mandate paused | Send a resume request | Yes | Needs approval |
| Account or instrument closed | Stop further attempts | No | Automatic |
| Account or instrument closed | Send the payment-method change link | Yes | Needs approval |
| Bank downtime | Hold, then present again once the downtime ends | No | Automatic |
| Customer paid outside the plan | Cancel the pending attempt | No | Automatic |

- The agent's output is a list of `{ fix, reason }`. A fix outside the catalogue, not allowed for the trigger, without a reason, or repeated is rejected.
- The merchant reads the reason, so it must pass `checkReasonText` (section 9). A reason that fails keeps its fix, and the catalogue's own description is shown instead. Policy v1.1.
- The mode always comes from the merchant's setting for that fix type, never from the agent.
- If the agent is unavailable or returns nothing usable, the desk proposes every allowed fix by rule.

## 9. Message and reason text (`messages.ts`)

| Text | Template |
| --- | --- |
| Lending retry | Your EMI of {amount} to {merchant} didn't go through on {dueDate}. We'll try again on {plannedDate}. |
| Insurance retry | Your premium of {amount} to {merchant} didn't go through on {dueDate}. We'll try again on {plannedDate}. Your cover continues until {graceEnd}. |
| Payment link | You can pay your {kind} of {amount} to {merchant} here: {link} |
| Merchant reason | Suggested from payment timing. Advice only. |
| Ops reason | Payment pattern around {anchor}, based on {observations} observations, confidence {confidence}%. |

- Never in customer or merchant text: salary, payday, pay day, income, employer, wage, wages, balance, paycheck, earnings. Each word also covers its plural and spelling variants: salaries, salaried, paydays, pay-day, incomes, employers, balances, paycheque. Policy v1.1.
- Never in model-written customer or merchant text: a word for a score, confidence, tier, probability, a percentage, or "funded". Policy v1.1.
- A polished rewrite is accepted only if it keeps the amount, every date and the merchant name, adds no other amount or date, contains no banned word and stays under 400 characters. Once the amount, the dates (written "8 April") and the name are taken out, no number, month name or day word (today, tomorrow, a weekday) may be left, so a date written another way ("April 12", "12/04", "the 7th") or a percentage is rejected. "May" is left to the number check, because it is also an ordinary word. Otherwise the template is sent. Policy v1.1.
- A reason a model writes for a merchant (the desk agent's one line) passes `checkReasonText`: one line, at most 200 characters, no banned word and none of the words above. Policy v1.1.
- The ops reason never states a salary amount or an employer.

## 10. Decision pipeline (`evaluateFailedDebit`)

Triage → exceptions desk for a non-balance label → control checks → gate → estimate → schedules and cards. The result is one of: `schedules`, `out_of_reach`, `exceptions_desk`, `fail_open` (with a reason), or `needs_agent` (ask the Triage agent, then call again with its answer). It carries a public reason that is safe for a merchant and an internal reason for the audit log.
