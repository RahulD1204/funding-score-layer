# Three-minute demo script

Five moments on the live site: one failed EMI from failure to paid, one out-of-reach case, one insurer case, one exceptions-desk case and one Ops assistant question, then the limits. Words to say are in quotes. Everything else is what you click.

The agents run live: Harbour's notices are polished by Claude, the exceptions desk agent writes its own reasons, and the Ops assistant answers from the audit log. Each live step has a fallback line in *italics*, to use if that call fails on the day. A failed call never breaks the demo: the site falls back to the template, the rule-based fixes, or "unavailable", which is the fail-open design.

## Before you start (not timed)

1. Open three separate browser windows, because each login is a cookie and one window holds one login:
   - Chrome, normal window: sign in as `ops@fsl.example`.
   - Chrome, Incognito window (File > New Incognito Window): sign in as `lender@northfield.example`.
   - Safari, or a second Chrome profile: sign in as `insurer@harbour.example`.
2. In the ops window, press **Reset demo** and confirm. The demo clock reads **2 April 2026**.
3. Rehearse once and time one **Next day** click. The script needs 20 of them (2 April to 22 April). In testing a click took about 0.5 to 0.8 seconds, and about 3 seconds on 11 April, when Priya's notice is polished. If clicks take more than about 3 seconds, use the short ending in step 6.
4. Check the agents are live: after the rehearsal, Priya's notice should say **Polished wording**. If it says **Template text**, the live calls are failing; use the fallback lines.
5. Reset the demo again just before you present.

Each full run of this script uses 4 of the 50 agent runs the ops login has per real day: Priya's notice twice (2 and 11 April), the desk agent once and the Ops assistant once. The lender and insurer logins use none. That allows about 12 full runs a day (10 if you add Sunita Rao). Reset demo does not give runs back; the count restarts on a new real date (UTC). Over the cap, the site shows the fallbacks.

## The script

### 0:00 to 0:15 · The problem

"When an EMI bounces for lack of funds, Razorpay's retries follow a fixed calendar, so they often bounce again before the salary lands. This layer suggests retry dates timed to the day each customer is usually funded. It is advice only: the merchant decides, it never moves money, and any doubt falls back to Razorpay's original retries. Everything here is synthetic."

### 0:15 to 0:40 · Four debits fail (ops window)

In **Event injector**, for each of these, click the chip and then **Simulate failed debit**:

1. **Case 2 · L-1041** (Asha Verma's EMI): opens with schedules.
2. **Case 5 · L-1044** (Imran Sheikh's EMI): out of reach.
3. **Case 9 · I-2011** (Priya Raman's premium): an insurer case.
4. **Case 7 · L-1046** (Vikram Nair's EMI): a cancelled mandate. This one takes about 6 seconds, because the desk agent runs. Talk over it.

"This button stands in for Razorpay's failed-debit webhook. Each failure is triaged by rules first. Only a lack of funds gets a schedule; anything else goes to the exceptions desk."

### 0:40 to 1:10 · A failed EMI, and an out-of-reach one (lender window)

Reload **Collections queue**. Open **Asha Verma**.

"The lender sees three schedules: Earliest, Balanced and Safest. Each has dates, a likelihood band, the charges for waiting and how many days later it is than the original retries. No score, no percentage, nothing about income. If nobody picks by the date shown, the lender's standing default applies, here Balanced. I'll leave it."

Go back and open **Imran Sheikh**.

"For Imran, no debit can reach his funded day inside the lender's overdue cap. So instead of a debit that would bounce, a payment link goes out on 22 April. Nothing bounces."

### 1:10 to 1:30 · The insurer case (insurer window)

Reload **Renewals**. Open **Priya Raman**.

"The insurer never sees schedule options. It runs on its standing default and sees a date only once it has locked: an early attempt tomorrow, 3 April. The customer notice is already written, and it says Polished wording: Claude reworded it. But the amount, the dates and the name come from code, and a rewrite is kept only if it keeps every one of them and passes the word checks."

*If it shows Template text: "Here the rewrite was not used, so the customer gets the template. Every fact still comes from code."*

### 1:30 to 1:50 · The exceptions desk (lender window)

Open **Exceptions desk**.

"Vikram cancelled his mandate, so waiting cannot help. The desk agent read the case and proposed two fixes, each with a reason. It can only pick from a fixed list, and it decides nothing: stopping further attempts ran at once because the lender set that fix to automatic, and the re-registration link contacts the customer, so it waits for approval. Nothing reaches a customer unless the merchant approved it."

*If the reasons are the plain catalogue wording: "The agent's answer was not used here, so the desk proposed every allowed fix by rule. The merchant still decides."*

Tick the re-registration link and press **Approve selected**.

"In the prototype the approval is recorded and audited; no message leaves the system."

### 1:50 to 2:35 · From failure to paid, and the Ops assistant (ops window)

Press **Next day** eight times, talking as you go, until the clock reads **10 April**.

"On 7 April the Balanced default locked for Asha. The debit ran on 8 April, the bank confirmed on 10 April: paid, with one retry and no extra bounce."

In the **Cases** list on the ops console, show Asha Verma's case as **Paid**. Then press **Next day** twice more to **12 April**.

"Priya's early attempt on 3 April failed. Her premium was collected on 12 April, inside the grace period."

In **Ops assistant**, type `Why did L-1041 retry on 8 April?` and press **Ask**.

It takes about 10 to 15 seconds. Keep talking: "The assistant can only read the audit log and the case record, with read-only tools, and it must cite the rows it used."

Read out its answer and point at the cited rows under it: the case opening, the default applied on 7 April, the retry notice, the debit on 8 April. "Only rows its own tools returned can be cited. If the log does not hold the answer, it says so."

*If it says the assistant is unavailable: "The assistant failed, so it says so rather than guess." Open **Audit log and model card** and point at L-1041's rows yourself.*

### 2:35 to 2:45 · The out-of-reach case pays (ops window)

Go back to the ops console and press **Next day** ten times to **22 April**. Show Imran's case as **Paid** by link, no debit presented.

Short ending, if Next day is slow: skip this step and say "On 22 April Imran gets the link and pays it. No debit is ever presented."

### 2:45 to 3:00 · Limits, out loud

"Four limits. The data is synthetic, so this shows the logic, not real-world lift. The customer's phone link never expires, and Reset demo empties the audit log. The guess is worse for some customers: gig workers and the self-employed are about five days off on average against about one for salaried customers, so their retries are timed less well. And three open legal questions: suggested dates hint to a lender when a borrower is funded; whether payment timing seen across merchants may be used this way, and under what consent; and whether polished loan messages need the lender's approved wording."

## If something goes wrong

- **A button shows "fetch failed" or a timeout.** The network to Supabase is sometimes slow. Click once more.
- **"The clock moved while you clicked."** Two clicks overlapped. Reload the page and carry on.
- **Simulate failed debit is refused.** The clock has moved past the window for that debit. Press **Reset demo** and start again.
- **A case shows "Razorpay's original retries apply".** That is the fail-open design working: any error or failed check goes back to the original retries and writes an audit row. Say so and move on.
- **An agent step is slow.** In testing, the desk agent took 5 to 7 seconds and the Ops assistant 9 to 15 seconds. Keep talking; a call that passes 45 seconds is dropped and the fallback shows.

## Optional: the Failure Triage agent (Sunita Rao, adds about 20 seconds)

In the ops window, add **Case 8 · L-1047** to the four debits at the start. It takes about 6 seconds, because the Triage agent runs. It worked in 8 of 8 test runs.

"Sunita's bank sent a catch-all code with no clear reason. The Triage agent checked the mandate, the downtime log and her past failures, and labelled it a lack of funds, strongly. Only a strong answer is accepted, and code re-checks the mandate and downtime itself. Otherwise she would stay on Razorpay's original retries."

*If her case shows Razorpay's original retries: "The agent's answer was weak or missing, so the layer stays out. That is the safe default."*

Each run with Sunita uses 5 agent runs instead of 4.
