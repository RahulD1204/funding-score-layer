# ml/: synthetic data and models

Offline Python work for the prototype (specs/05-data-and-model.md). It invents customers, trains the models, checks them and writes the CSV files the app loads. Nothing here is deployed. All data is synthetic.

## Run it

You need Homebrew's Python 3.12 and its `libomp` library (XGBoost needs it on a Mac). Run these from the repository root.

```bash
brew install libomp
```

```bash
/opt/homebrew/bin/python3.12 -m venv ml/.venv
```

```bash
ml/.venv/bin/pip install -r ml/requirements.txt
```

```bash
ml/.venv/bin/python ml/run_all.py
```

The full run takes about two minutes. It uses a fixed seed (20260402), so every run writes identical files. To rerun one step, name it, for example `ml/.venv/bin/python ml/run_all.py train`.

## The steps

| Step | File | What it does |
| --- | --- | --- |
| generate | `fsl/generate.py` | 5,000 training customers and 200 app customers, each with 24 months of daily balance, income, spending, EMIs and premiums. Adds salary delays, bank downtime, cancelled or paused mandates, closed accounts, catch-all codes with bank free text, refunds and Re 1 test debits. Draws the ten seeded demo cases until the rule gives their scripted days. |
| features | `fsl/features.py` | One row per failed due-date debit (insufficient funds). Each feature uses only transactions dated before the due date. The labels are the last failed day and the first successful day. |
| train | `fsl/train.py` | Trains XGBoost AFT and XGBoost quantile on months 13 to 18, tunes on 19 to 21, keeps the better one, and calibrates it. |
| evaluate | `fsl/evaluate.py` | Scores the test months (22 to 24) against the true funded day: day error (overall and by customer type, the fairness check of specs/08 row 18), range coverage, band calibration, gate pass rates, failed presentations per payment, salary recognition and catch-all codes. |
| export | `fsl/export.py` | Writes `export/*.csv` and the model card (`export/model_card.md`). |
| check | `tests/ml-export.test.ts` | Plays the exported seeded cases through the real engine to their endings in specs/05. |

`fsl/rule.py` is the median-day baseline: a Python copy of `estimateFunding`. Two checks keep it honest. `fsl/parity.py` compares it with the real engine on 500 historical debits and every app obligation, and `tests/ml-export.test.ts` compares every exported rule row. Schedules, the case clock and triage are never copied into Python. `bridge/engine.ts` runs the real `lib/engine` code through Node 24's built-in TypeScript support.

## What is exported

| File | Rows | Notes |
| --- | --- | --- |
| merchants, products | 2 each | Northfield Finance (lender) and Harbour Life (insurer) |
| customers | 200 | Including the ten seeded cases. `archetype` is internal |
| obligations | 249 | Adds a `bank` column, so the downtime lookup knows which bank to check |
| consents | 251 | One merchant row per merchant, one customer row per obligation; about 3% withdrawn |
| bank_downtimes | 89 | One- or two-day windows per bank |
| transactions | about 31,700 | 1 April 2025 to 1 April 2026. `merchant_id` is empty for everyday shops. `own_merchant` marks a collection by the merchant in `merchant_id` |
| customer_signals | 200 | As of 2 April 2026, for each customer's first obligation. Adds `has_failure_evidence` and `identity_linked` |
| predictions | 488 | A rule row per obligation with history, and a model row for every obligation except the ten seeded cases |
| sim_truth | 249 | The April 2026 cycle. Adds `obligation_id`, plus the `reason_code` and `bank_text` the bank returns on the due date (empty when the debit succeeds) |
| model_card | 1 | The report in machine form; `model_card.md` is the readable version |

Lists and objects are JSON text. Empty cells are nulls. A prediction's `confidence` is before the affordability and drift deductions, the same meaning as `ModelScore.confidence`.

The ten seeded cases have a rule row only, decided on 10 October 2026. The model is a day or more off on most of them (the model card lists each), and their scripted endings in specs/05 rest on the rule's days.

Intermediate files go to `ml/work/` (about 300 MB, not committed).
