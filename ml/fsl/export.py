"""Step 5: the app's CSV files and the model card, in ml/export/ (specs/05).

Conventions for the seed script (step 5 of the build plan):
  - Amounts are whole paise. Dates are ISO dates ("2026-04-02").
  - Lists (likelihood_by_day, baseline_retry_days) and objects are JSON text.
  - Empty cells are nulls.
  - transactions.merchant_id is empty for everyday payments at other shops; only the two
    merchants exist as rows. own_merchant marks a collection by the merchant in merchant_id,
    so a server function counts it twice only when that merchant is the one asking.
  - predictions: the rule row's confidence is before the affordability and drift deductions,
    the same meaning as ModelScore.confidence, so either row can be passed to the engine.
  - The ten seeded cases have a rule row only, so they play exactly as specs/05 says
    (decision of 10 October 2026). Every other obligation also has a model row.
"""

from __future__ import annotations

import json
import pickle
from datetime import date

import numpy as np
import pandas as pd

from . import config as C
from . import evaluate as EV
from . import parity
from . import train as TR
from .features import CustomerView
from .generate import SEEDED, _status_at

DEMO_ORD = C.DEMO_DUE.toordinal()
TX_FROM = date(2025, 4, 1).toordinal()


def iso(o) -> str | None:
    return None if o is None or (isinstance(o, float) and np.isnan(o)) else date.fromordinal(int(o)).isoformat()


def _write(df: pd.DataFrame, name: str):
    df.to_csv(C.EXPORT_DIR / f"{name}.csv", index=False)
    print(f"  {name}.csv: {len(df):,} rows")


def obligation_ids(profiles) -> dict[str, str]:
    """Readable ids: seeded cases keep theirs, the rest become L-1100... and I-2100..."""
    seeded = {s["oid"] for s in SEEDED}
    mapping, nl, ni = {}, 1100, 2100
    for p in profiles:
        for ob in p.obligations:
            if ob.oid in seeded:
                mapping[ob.oid] = ob.oid
            elif ob.segment == "lending":
                mapping[ob.oid], nl = f"L-{nl}", nl + 1
            else:
                mapping[ob.oid], ni = f"I-{ni}", ni + 1
    return mapping


def model_version(chosen: str) -> str:
    return f"fsl-{chosen}-{C.policy_version()}-s{C.SEED}"


def main():
    C.EXPORT_DIR.mkdir(exist_ok=True)
    with open(C.WORK_DIR / "app.pkl", "rb") as f:
        app = pickle.load(f)
    with open(C.WORK_DIR / "models.pkl", "rb") as f:
        models = pickle.load(f)
    with open(C.WORK_DIR / "downtimes.pkl", "rb") as f:
        down = pickle.load(f)
    with open(C.WORK_DIR / "evaluation.json") as f:
        report = json.load(f)
    events = pd.read_pickle(C.WORK_DIR / "app_events.pkl")
    profiles = sorted(app["profiles"], key=lambda p: (not p.seeded, p.cid))
    oid = obligation_ids(profiles)
    seeded_oids = {s["oid"] for s in SEEDED}
    version = model_version(models["chosen"])

    # --- merchants and products ------------------------------------------------
    _write(pd.DataFrame([
        {"id": C.LENDER_ID, "name": "Northfield Finance", "type": "lender", "layer_enabled": True, "kill_switch": False,
         "polish_on": False, "consent_date": "2025-01-15"},
        {"id": C.INSURER_ID, "name": "Harbour Life", "type": "insurer", "layer_enabled": True, "kill_switch": False,
         "polish_on": True, "consent_date": "2025-01-15"},
    ]), "merchants")
    _write(pd.DataFrame([
        {"id": C.LOAN_PRODUCT_ID, "merchant_id": C.LENDER_ID, "name": "Personal loan", "segment": "lending",
         "rail": "bank_mandate", "last_allowed_day": 10, "max_representations": 2, "standing_default": "Balanced",
         "result_delay_days": 2, "penal_charge_per_day_paise": 800, "bounce_charge_paise": 50000,
         "baseline_retry_days": json.dumps(C.BASELINE_RETRY_DAYS["lending"]), "grace_days": None},
        {"id": C.POLICY_PRODUCT_ID, "merchant_id": C.INSURER_ID, "name": "Term plan, monthly premium", "segment": "insurance",
         "rail": "upi_autopay", "last_allowed_day": 12, "max_representations": 3, "standing_default": "Balanced",
         "result_delay_days": 0, "penal_charge_per_day_paise": None, "bounce_charge_paise": None,
         "baseline_retry_days": json.dumps(C.BASELINE_RETRY_DAYS["insurance"]), "grace_days": C.GRACE_DAYS},
    ]), "products")

    # --- customers, obligations, consents ---------------------------------------
    _write(pd.DataFrame([{"id": p.cid, "label": p.label, "holdout": p.holdout, "archetype": p.archetype} for p in profiles]), "customers")

    cyc_by = {(c["oid"]): c for c in app["cycles"] if c["due"] >= DEMO_ORD and C.month_no(date.fromordinal(c["due"])) == 25}
    ob_rows, consent_rows = [], []
    rng = np.random.default_rng([C.SEED, 7])
    for m in (C.LENDER_ID, C.INSURER_ID):
        consent_rows.append({"customer_id": None, "merchant_id": m, "party": "merchant", "purpose": "retry_timing",
                             "status": "granted", "granted_date": "2025-01-15", "withdrawn_date": None})
    for p in profiles:
        for ob in p.obligations:
            cyc = cyc_by[ob.oid]
            merchant = C.LENDER_ID if ob.segment == "lending" else C.INSURER_ID
            ob_rows.append({
                "id": oid[ob.oid], "merchant_id": merchant,
                "product_id": C.LOAN_PRODUCT_ID if ob.segment == "lending" else C.POLICY_PRODUCT_ID,
                "customer_id": p.cid, "kind": "EMI" if ob.segment == "lending" else "premium", "amount_paise": ob.amount,
                "due_day": ob.due_day, "mandate_status": _status_at(cyc["mandate_timeline"], cyc["due"]), "status": "active",
                "bank": p.bank,
            })
            withdrawn = None
            if not p.seeded and rng.random() < 0.03:
                withdrawn = iso(DEMO_ORD - int(rng.integers(5, 50)))
            consent_rows.append({"customer_id": p.cid, "merchant_id": merchant, "party": "customer", "purpose": "retry_timing",
                                 "status": "withdrawn" if withdrawn else "granted",
                                 "granted_date": iso(max(ob.start, TX_FROM)), "withdrawn_date": withdrawn})
    _write(pd.DataFrame(ob_rows), "obligations")
    _write(pd.DataFrame(consent_rows), "consents")

    windows = []
    for bank, days in down.items():
        for o in sorted(days):
            if windows and windows[-1]["bank"] == bank and windows[-1]["_to"] == o - 1:
                windows[-1]["_to"] = o
            else:
                windows.append({"bank": bank, "_from": o, "_to": o})
    _write(pd.DataFrame([{"bank": w["bank"], "from_date": iso(w["_from"]), "to_date": iso(w["_to"])} for w in windows]), "bank_downtimes")

    # --- transactions: the last 12 months before 2 April 2026 -------------------
    tx = app["tx"]
    tx = tx[(tx.ord >= TX_FROM) & (tx.ord < DEMO_ORD)].copy()
    order = {p.cid: i for i, p in enumerate(profiles)}
    tx["_c"] = tx.customer_id.map(order)
    tx = tx.sort_values(["_c", "ord", "seq"], kind="stable").reset_index(drop=True)
    out = pd.DataFrame({
        "id": [f"TX-{i:06d}" for i in range(1, len(tx) + 1)],
        "customer_id": tx.customer_id,
        "merchant_id": tx.merchant_id,
        "date": tx.ord.map(iso),
        "amount_paise": tx.amount_paise,
        "direction": tx.direction,
        "kind": tx.kind,
        "own_merchant": tx.own_merchant.astype(bool),
        "status": tx.status,
        "reason_code": tx.reason_code,
        "bank_text": tx.bank_text,
        "source": tx.source,
        "obligation_id": tx.obligation_id.map(lambda x: oid.get(x) if isinstance(x, str) else None),
        "cycle_due_date": tx.cycle_due_ord.map(lambda x: iso(x) if x == x and x is not None else None),
        "attempt_day": tx.attempt_day.astype("Int64"),
    })
    _write(out, "transactions")

    # --- signals, predictions, truth ------------------------------------------
    views = {cid: CustomerView(g) for cid, g in tx.groupby("customer_id")}
    empty = CustomerView(tx.iloc[0:0])
    ev = events.copy()
    ev["oid"] = ev.obligation_id.map(oid)
    ev = ev.set_index("oid").loc[[r["id"] for r in ob_rows]].reset_index()

    raw = TR.quantile_cdf(models["quantile"], ev) if models["chosen"] == "quantile" else TR.aft_cdf(models["aft"], ev)
    cdf = np.round(TR.calibrate(models["calibration"], raw), 4)
    mh = TR.point_h(cdf)
    mu = EV.model_u(cdf, mh)
    mconf = EV.model_confidence(cdf, mh)

    pred_rows, seeded_compare = [], []
    for i, r in enumerate(ev.itertuples()):
        due = iso(r.due)
        est = r.rule_estimate
        if est is not None:
            pred_rows.append({"obligation_id": r.oid, "cycle_due_date": due, "source": "rule", "h": est["h"], "u": est["u"],
                              "likelihood_by_day": json.dumps(est["likelihood"]), "confidence": est["confidence_before"],
                              "model_version": f"rule-{C.policy_version()}"})
        if r.oid in seeded_oids:
            seeded_compare.append({"obligation_id": r.oid, "rule_h": est["h"] if est else None, "model_h": int(mh[i])})
            continue
        pred_rows.append({"obligation_id": r.oid, "cycle_due_date": due, "source": "model", "h": int(mh[i]), "u": int(mu[i]),
                          "likelihood_by_day": json.dumps([float(x) for x in cdf[i]]), "confidence": int(mconf[i]),
                          "model_version": version})
    _write(pd.DataFrame(pred_rows), "predictions")

    truth_rows = []
    for r in ob_rows:
        p = next(p for p in profiles if p.cid == r["customer_id"])
        src = next(ob.oid for ob in p.obligations if oid[ob.oid] == r["id"])
        cyc = cyc_by[src]
        d0 = cyc["day0"]
        failed = d0 is not None and d0["cause"] is not None
        truth_rows.append({
            "customer_id": r["customer_id"], "obligation_id": r["id"], "cycle_due_date": iso(cyc["due"]),
            "funded_on_day": cyc["funded"], "true_cause": d0["cause"] if failed else None,
            "reason_code": d0["code"] if failed else None, "bank_text": d0["text"] if failed else None,
        })
    truth = pd.DataFrame(truth_rows)
    truth["funded_on_day"] = truth.funded_on_day.astype("Int64")
    _write(truth, "sim_truth")

    signal_rows = []
    for p in profiles:
        ob = p.obligations[0]
        e = ev[ev.obligation_id == ob.oid].iloc[0]
        est = e.rule_estimate
        signal_rows.append({
            "customer_id": p.cid, "as_of_date": C.DEMO_DUE.isoformat(), "obligation_id": oid[ob.oid],
            "timing_observations": int(e.timing), "months_covered": int(e.months), "affordability_observations": int(e.afford),
            "has_failure_evidence": bool(e.failure_evidence), "identity_linked": True,
            "anchor_kind": est["anchor_kind"] if est else None, "anchor_value": est["anchor_value"] if est else None,
            "spread": est["mad"] if est else None, "confidence": est["confidence"] if est else None, "tier": e.tier,
            "salary_recognized": bool(est and est["salary"]),
            "likelihood_by_day": json.dumps(est["likelihood"]) if est else None,
        })
    _write(pd.DataFrame(signal_rows), "customer_signals")

    # --- parity on every exported obligation ------------------------------------
    rows = [(views.get(r.customer_id, empty), r.segment, int(r.amount), int(r.due), DEMO_ORD) for r in ev.itertuples()]
    check = parity.compare(rows)
    print(f"  parity on every app obligation: {check['checked']} checked, {len(check['mismatches'])} mismatches")
    if check["mismatches"]:
        raise SystemExit(f"The Python rule disagrees with lib/engine: {check['mismatches'][:3]}")

    # --- model card -------------------------------------------------------------
    write_model_card(report, version, seeded_compare, check)


def _pct(x):
    return "n/a" if x is None else f"{100 * x:.1f}%"


def write_model_card(report: dict, version: str, seeded_compare: list, app_parity: dict):
    m = report["methods"]
    chosen = report["chosen"]
    cal = m["chosen_calibrated"]
    card = {
        "model_version": version,
        "policy_version": C.policy_version(),
        "training_period": "Failed debits due April 2025 to September 2025 (months 13 to 18)",
        "tune_period": "October 2025 to December 2025 (months 19 to 21)",
        "test_period": "January 2026 to March 2026 (months 22 to 24)",
        "day_error_baseline": round(m["rule"]["day_error"], 3),
        "day_error_quantile": round(m["quantile"]["day_error"], 3),
        "day_error_aft": round(m["aft"]["day_error"], 3),
        "day_error_chosen": round(cal["day_error"], 3),
        "coverage_80": json.dumps({k: round(v["coverage80"], 4) for k, v in m.items()}),
        "band_calibration": json.dumps(cal["bands"]),
        "eligible_share": json.dumps({k: v["eligible_share_by_floor"] for k, v in m.items()}),
        "chosen_model": chosen,
        "failed_per_collected": json.dumps(report["simulation"]),
        "salary_recognition": json.dumps(report["salary"]),
        "catch_all": json.dumps(report["catch_all"]),
        "seed": C.SEED,
        "data": "synthetic",
    }
    pd.DataFrame([card]).to_csv(C.EXPORT_DIR / "model_card.csv", index=False)
    print("  model_card.csv: 1 row")

    names = {"rule": "Median-day rule (baseline)", "aft": "XGBoost AFT", "quantile": "XGBoost quantile",
             "chosen_calibrated": f"Chosen ({chosen}), calibrated"}
    L = []
    L.append(f"# Model card: {version}\n")
    L.append("Synthetic data only. These numbers show the logic works on invented customers generated by rules we chose. "
             "They do not show real-world lift.\n")
    L.append("## What it predicts\n")
    L.append("For a failed EMI or premium debit, the chance the customer is funded by each day from the due date (day 0) "
             "to day 30. The app reads `h` (first day at 50% or more), `u` (first day at 85% or more, at least `h + 1`) "
             "and a confidence: the likelihood within 2 days of `h`.\n")
    L.append("## Data and split\n")
    L.append(f"- 5,000 training customers in 7 archetypes, 24 months of daily history (April 2024 to March 2026), seed {C.SEED}.")
    L.append(f"- Train: {card['training_period']}. Tune: {card['tune_period']}. Test: {card['test_period']}. Months 1 to 12 are history only.")
    L.append(f"- Test rows: {report['test_rows']:,} failed due-date debits with an insufficient-funds code.")
    L.append("- Labels: the last failed attempt day and the first successful day (a retry or a payment link). "
             "The true funded day is used only to evaluate, and to calibrate on the tune months.")
    L.append("- 200 app customers, including the ten seeded cases, never enter training.\n")
    L.append("## Day error and range coverage (test months)\n")
    L.append("Day error is the average number of days between the predicted funded day and the true one.\n")
    L.append("| Method | Day error | Median error | Within 1 day | Day error, eligible cases | 80% range coverage |")
    L.append("| --- | --- | --- | --- | --- | --- |")
    for k, v in m.items():
        eligible = "n/a" if v["day_error_eligible"] is None else f"{v['day_error_eligible']:.2f}"
        L.append(f"| {names[k]} | {v['day_error']:.2f} | {v['day_error_median']:.0f} | {_pct(v['within_1_day'])} | "
                 f"{eligible} | {_pct(v['coverage80'])} |")
    L.append("")
    L.append("The 80% range runs from the first day the likelihood reaches 10% to the first day it reaches 90%. "
             "Share of cases funded by the first day the likelihood reaches 80%: "
             + ", ".join(f"{names[k]} {_pct(v['funded_by_80th_percentile_day'])}" for k, v in m.items())
             + ". These sit above 80% because likelihood moves in whole-day steps, so the first day at or above 80% often holds more.\n")
    L.append(f"**Chosen: {chosen}.** Chosen on the tune months, never the test months: "
             f"tune day error AFT {report['tune']['aft']['day_error']:.2f} against quantile {report['tune']['quantile']['day_error']:.2f}; "
             f"tune coverage AFT {_pct(report['tune']['aft']['coverage80'])} against quantile {_pct(report['tune']['quantile']['coverage80'])} "
             f"({report['choice_note']}).\n")
    L.append("Why AFT does badly here: the history only shows retries on days 3, 6 and 9, so most labels say "
             "\"funded somewhere between day 9 and day 24\". AFT fits such a range by aiming at its middle, so customers funded "
             "late in the month are predicted around day 14. The quantile model learns the first successful day directly and "
             "does not have that bias.\n")
    L.append("## Calibration of each band (chosen model, calibrated)\n")
    L.append("Every day a schedule could use (lending days 3 to 10, insurance days 1 to 12), for every test case. "
             "A band holds when the observed share falls inside its stated range.\n")
    L.append("| Band | Stated | Cases x days | Mean predicted | Observed | Holds |")
    L.append("| --- | --- | --- | --- | --- | --- |")
    for b in cal["bands"]:
        L.append(f"| {b['band']} | {b['stated']} | {b['n']:,} | {_pct(b['mean_predicted'])} | {_pct(b['observed'])} | {'Yes' if b['holds'] else 'No'} |")
    L.append("")
    L.append("Before calibration, and for comparison:\n")
    L.append("| Method | High observed | Medium observed | Lower observed |")
    L.append("| --- | --- | --- | --- |")
    for k in ("rule", "aft", "quantile"):
        b = {x["band"]: x for x in m[k]["bands"]}
        L.append(f"| {names[k]} | " + " | ".join(f"{_pct(b[n]['observed'])}{'' if b[n]['holds'] else ' (off)'}" for n in ("High", "Medium", "Lower")) + " |")
    L.append("")
    L.append("Calibration uses isotonic regression fitted on the tune months against the true funded day. "
             "In production the outcomes of the layer's own planned retries would replace the true day.\n")
    L.append("## Share passing the gate at each confidence floor (test months)\n")
    L.append("Tier A evidence and confidence at or above the floor, after the affordability and drift deductions. "
             "The live floors are 80% for lending and 70% for insurance.\n")
    L.append("| Method | " + " | ".join(f"{f}%" for f in EV.FLOORS) + " | At the live floors |")
    L.append("| --- | " + " | ".join("---" for _ in EV.FLOORS) + " | --- |")
    for k, v in m.items():
        L.append(f"| {names[k]} | " + " | ".join(_pct(v["eligible_share_by_floor"][str(f)]) for f in EV.FLOORS) + f" | {_pct(v['eligible_share'])} |")
    L.append("")
    L.append("## Failed presentations per payment collected (test months, real engine)\n")
    L.append("Each test failure is played through the engine's schedules and clock with the standing default (Balanced). "
             "Cases that fail open run Razorpay's original retries. Lending: retries on days 3, 6 and 9. Insurance: days 1, 2 and 3.\n")
    L.append("| Segment | Plan | Cases the layer acts on | Failed presentations | Collected by debit | Paid by link | Failed per debit collected |")
    L.append("| --- | --- | --- | --- | --- | --- | --- |")
    for seg in ("lending", "insurance"):
        o = report["simulation"]["model"][seg]["original_retries"]
        L.append(f"| {seg.title()} | Razorpay's original retries | 0 of {report['simulation']['model'][seg]['cases']:,} | {o['failed']:,} | {o['collected_by_debit']:,} | n/a | {o['failed_per_collected']:.2f} |")
        for key, label in (("rule", "Layer on the rule"), ("model", "Layer on the chosen model")):
            s = report["simulation"][key][seg]
            w = s["with_layer"]
            L.append(f"| {seg.title()} | {label} | {s['layer_acts']:,} | {w['failed']:,} | {w['collected_by_debit']:,} | {w['paid_by_link']:,} | {w['failed_per_collected']:.2f} |")
    L.append("")
    L.append("Payment links go out only on the layer's out-of-reach route, so the original retries show none.\n")
    sal = report["salary"]
    L.append("## Salary recognition (test months)\n")
    L.append(f"- Recognized: {sal['recognized']:,}. Right day (within 1 day of the true funded day): {sal['correct_day']:,}. "
             f"Recognized where no monthly salary exists: {sal['recognized_without_true_salary']}.")
    L.append(f"- Precision {_pct(sal['precision'])}, recall {_pct(sal['recall'])}. The rule is strict on purpose: a wrong payday is worse than none.\n")
    ca = report["catch_all"]
    L.append("## Catch-all reason codes (months 13 to 24, every presentation)\n")
    L.append(f"- Catch-all failures: {ca['catch_all_failures']:,}. Labelled by the code table and lookups: {ca['resolved_by_rules_and_lookups']:,} "
             f"({_pct(ca['resolved_share'])}), of which {_pct(ca['resolved_correct_share'])} match the true cause.")
    L.append(f"- Left for the Triage agent: {ca['left_for_triage_agent']:,}. True causes of those: "
             + ", ".join(f"{k} {_pct(v)}" for k, v in ca["true_cause_of_those_left"].items()) + ".")
    L.append("- Lookups resolve only failures with a cancelled or paused mandate or a bank downtime. "
             "Most catch-all failures are plain lack of funds, which only the agent (reading the bank's text) can label.\n")
    L.append("## Seeded demo cases\n")
    L.append("The ten scripted cases store the rule's estimate only, so they play exactly as specs/05 says. "
             "For transparency, what the chosen model would have said:\n")
    L.append("| Case | Rule funded day (h) | Model funded day (h) |")
    L.append("| --- | --- | --- |")
    for s in seeded_compare:
        L.append(f"| {s['obligation_id']} | {'none' if s['rule_h'] is None else s['rule_h']} | {s['model_h']} |")
    L.append("")
    L.append("## Checks\n")
    ps = report["parity_sample"]
    L.append(f"- The Python median-day rule against `estimateFunding`: {ps['checked']} sampled test failures and "
             f"{app_parity['checked']} app obligations, {len(ps['mismatches']) + len(app_parity['mismatches'])} mismatches.")
    L.append("- `tests/ml-export.test.ts` repeats the comparison on every exported rule row and plays the ten seeded cases "
             "through the engine to their endings in specs/05.\n")
    L.append("## Limits\n")
    L.append("- Synthetic customers follow rules we wrote, so the model partly learns those rules back. Real data will be noisier.")
    L.append("- The labels depend on Razorpay's original retry days (3, 6, 9 and 1, 2, 3), which are placeholders to confirm.")
    L.append("- No demographic or location feature exists. The salary amount is not a feature: only whether a salary is recognized, and its day.")
    (C.EXPORT_DIR / "model_card.md").write_text("\n".join(L) + "\n")
    print("  model_card.md written")
