# Three-minute demo script

Five moments on the live site: one failed EMI from failure to paid, one out-of-reach case, one insurer case, one exceptions-desk case and one Ops assistant question, then the limits. Words to say are in quotes. Everything else is what you click.

The Anthropic account has no credit yet, so every agent shows its fallback. The script is written for that. The last section says what changes once credit is added.

## Before you start (not timed)

1. Open three separate browser windows, because each login is a cookie and one window holds one login:
   - Chrome, normal window: sign in as `ops@fsl.example`.
   - Chrome, Incognito window (File > New Incognito Window): sign in as `lender@northfield.example`.
   - Safari, or a second Chrome profile: sign in as `insurer@harbour.example`.
2. In the ops window, press **Reset demo** and confirm. The demo clock reads **2 April 2026**.
3. Rehearse once and time one **Next day** click. The script needs 20 of them (2 April to 22 April). If one click takes more than about 3 seconds, use the short ending in step 6.
4. Reset the demo again just before you present.

Each rehearsal uses about five of the 50 agent runs each user has per real day (the desk agent, Harbour's message polish and the Ops assistant). Reset demo does not give them back; the count restarts on a new real date. With no credit nothing visible depends on it, because over the cap the site shows the same fallbacks.

## The script

### 0:00 to 0:15 · The problem

"When an EMI bounces for lack of funds, Razorpay's retries follow a fixed calendar, so they often bounce again before the salary lands. This layer suggests retry dates timed to the day each customer is usually funded. It is advice only: the merchant decides, it never moves money, and any doubt falls back to Razorpay's original retries. Everything here is synthetic."

### 0:15 to 0:40 · Four debits fail (ops window)

In **Event injector**, for each of these, click the chip and then **Simulate failed debit**:

1. **Case 2 · L-1041** (Asha Verma's EMI): opens with schedules.
2. **Case 5 · L-1044** (Imran Sheikh's EMI): out of reach.
3. **Case 9 · I-2011** (Priya Raman's premium): an insurer case.
4. **Case 7 · L-1046** (Vikram Nair's EMI): a cancelled mandate.

"This button stands in for Razorpay's failed-debit webhook. Each failure is triaged by rules first. Only a lack of funds gets a schedule; anything else goes to the exceptions desk."

### 0:40 to 1:10 · A failed EMI, and an out-of-reach one (lender window)

Reload **Collections queue**. Open **Asha Verma**.

"The lender sees three schedules: Earliest, Balanced and Safest. Each has dates, a likelihood band, the charges for waiting and how many days later it is than the original retries. No score, no percentage, nothing about income. If nobody picks by the date shown, the lender's standing default applies, here Balanced. I'll leave it."

Go back and open **Imran Sheikh**.

"For Imran, no debit can reach his funded day inside the lender's overdue cap. So instead of a debit that would bounce, a payment link goes out on 22 April. Nothing bounces."

### 1:10 to 1:30 · The insurer case (insurer window)

Reload **Renewals**. Open **Priya Raman**.

"The insurer never sees schedule options. It runs on its standing default and sees a date only once it has locked: an early attempt tomorrow, 3 April. The customer notice is already written. Its facts come from code, never from a model. Harbour has message polish on, but it shows Template text: polish needs Claude, and a rewrite is kept only if it passes the word checks."

### 1:30 to 1:50 · The exceptions desk (lender window)

Open **Exceptions desk**.

"Vikram cancelled his mandate, so waiting cannot help. Stopping further attempts ran at once, because that fix is set to automatic in the lender's settings. Sending a re-registration link contacts the customer, so it waits for approval. Nothing reaches a customer unless the merchant approved it."

Tick the re-registration link and press **Approve selected**.

"In the prototype the approval is recorded and audited; no message leaves the system."

### 1:50 to 2:35 · From failure to paid, and the Ops assistant (ops window)

Press **Next day** eight times, talking as you go, until the clock reads **10 April**.

"On 7 April the Balanced default locked for Asha. The debit ran on 8 April, the bank confirmed on 10 April: paid, with one retry and no extra bounce."

In the **Cases** list on the ops console, show Asha Verma's case as **Paid**. Then press **Next day** twice more to **12 April**.

"Priya's early attempt on 3 April failed. Her premium was collected on 12 April, inside the grace period."

In **Ops assistant**, type `Why did L-1041 retry on 8 April?` and press **Ask**.

It says: "The assistant is unavailable right now. Read the audit log directly."

"The assistant has no model credit today, so it says so rather than guess. Its answer would cite audit rows, and only rows its own read-only tools returned count." Open **Audit log and model card** and point at L-1041's rows: the case opening, then one row for each day something happened to it.

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

## Once the Anthropic account has credit

Nothing in the code changes. On the same script:

- **Priya's notice** may show **Polished wording** instead of Template text, if Claude's rewrite passes every word check. A rewrite that fails is dropped and the template is used.
- **The desk** shows the agent's own one-line reason for each fix instead of the catalogue description, if the reason passes the word check.
- **The Ops assistant** answers in a sentence or two and lists the audit rows it cited.
- **Case 8 · L-1047** (a catch-all bank code) becomes worth showing: the Triage agent reads the bank's text and the mandate status, and a weak answer still leaves Razorpay's original retries.

Rehearse with credit at least once, and watch the cap: each user has 50 agent runs per real day, and Reset demo does not restore them.
