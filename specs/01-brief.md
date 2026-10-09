# 01. Product brief

## The problem

A loan EMI or an insurance premium is collected by a recurring debit. When the account is short on the due date, the debit fails. Today the retries follow a fixed calendar that knows nothing about the customer, so they often run before the money arrives and fail again. Each failed attempt can cost the borrower a bounce charge, and the lender still has not collected.

## The idea

Most people are funded on a regular day: payday. Razorpay sees payment timing across many merchants. The Funding Score Layer estimates each customer's funded day and suggests retry dates that wait for it.

It is advice only. The merchant decides, the layer never moves money, and any doubt falls back to Razorpay's original retries.

## Users

| User | Job |
| --- | --- |
| Lender's collections lead (lead user) | For each failed EMI, choose when to present it again so it lands on a funded day and the borrower avoids another bounce charge |
| Insurer's renewals manager | Collect each failed premium inside the grace period, before the policy lapses |
| Razorpay ops analyst | Explain any suggestion and check the lift against a holdout group |
| Customer (borrower or policyholder) | Gives consent, receives dated messages, can pay by link. Shown as a phone mock |

## Measures

| Measure | Definition |
| --- | --- |
| Lending | Failed presentations per EMI collected, against a holdout group on Razorpay's original retries |
| Insurance | Share of failed premiums collected inside the grace period, against a holdout |
| Guardrail | Days to collect must not get worse by more than the lender accepts |
| Prototype | All tests pass, the model card shows the model against the baseline, and the demo runs in 3 minutes |

## Where AI earns its place

| Task | Method | Why |
| --- | --- | --- |
| Predict days until funded | Machine-learning regression, trained offline, two objectives compared | Learns patterns fixed rules miss |
| Recognize a salary | Rule | A wrong payday is worse than none, so precision beats reach |
| Label a failure | Code table and lookups first; a Claude agent only for catch-all codes | Most codes are clear |
| Build schedules, apply limits, consent and caps | Rules | Must be testable case by case |
| Propose fixes for non-balance failures | A Claude agent choosing from a fixed catalogue | Several lookups per case; the merchant keeps control |
| Explain a suggestion to ops | A Claude agent reading the audit log | A free-text question over structured records |
| Word customer messages | A template, optionally polished by Claude | Natural wording, fixed facts |

## Version 1 journeys

1. A failed EMI arrives. Triage labels it a balance failure, the checks and the gate pass, and the lender sees two or three schedules with likelihood bands.
2. The lender picks one, or the standing default applies. Ops advances the clock, and the case moves through Result pending to Paid.
3. The funded day is out of reach. A payment link goes out on that day and no debit is presented.
4. A premium fails for an insurer. The standing default runs inside the grace period, and each date appears once it locks.
5. A non-balance failure reaches the exceptions desk, which proposes a fix. The merchant approves it, or it runs at once if that fix type is automatic.
6. Ops asks why a suggestion was made and gets an answer drawn from the audit log.

## Constraints

- Synthetic data only. No real customer data and no live keys.
- The app says it is a prototype and does not present itself as an official Razorpay product.
- Synthetic data shows that the logic works. It does not show real-world lift, and the demo says so.
