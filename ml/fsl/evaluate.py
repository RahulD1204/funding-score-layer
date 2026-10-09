"""Step 4: likelihood by day, calibration and the report, all on the test months (22 to 24).

Every number is judged against the true funded day from the simulation, which no model saw.
Schedules and outcomes come from the real engine through the bridge, never from Python copies.
"""

from __future__ import annotations

import json
import pickle
from datetime import date

import numpy as np
import pandas as pd

from . import bridge
from . import config as C
from . import parity
from . import train as TR

FLOORS = [50, 60, 70, 80, 90]
SALARIED = {"salaried_fixed", "salaried_month_end", "job_changer", "new_thin"}


def model_confidence(cdf: np.ndarray, h: np.ndarray) -> np.ndarray:
    """Share of likelihood within 2 days of the predicted day: the model's version of the rule's confidence."""
    hi = cdf[np.arange(len(h)), np.minimum(h + C.WITHIN_DAYS, C.HORIZON)]
    lo_idx = h - C.WITHIN_DAYS - 1
    lo = np.where(lo_idx >= 0, cdf[np.arange(len(h)), np.maximum(lo_idx, 0)], 0.0)
    return np.floor(100 * (hi - lo) + 0.5).astype(int)


def model_u(cdf: np.ndarray, h: np.ndarray) -> np.ndarray:
    return np.maximum(np.minimum(TR.first_day(cdf, C.UPPER_SHARE), C.HORIZON), h + 1)


def curves(events: pd.DataFrame, models: dict) -> dict[str, np.ndarray]:
    rule = np.vstack(events.rule_likelihood.map(lambda x: x if x is not None else [np.nan] * (C.HORIZON + 1)))
    out = {"rule": rule, "aft": TR.aft_cdf(models["aft"], events), "quantile": TR.quantile_cdf(models["quantile"], events)}
    out["chosen_calibrated"] = TR.calibrate(models["calibration"], out[models["chosen"]])
    return out


def point_and_confidence(name: str, cdf: np.ndarray, ev: pd.DataFrame):
    """h, u and confidence after the engine's deductions, for one method."""
    if name == "rule":
        return ev.rule_h.fillna(0).astype(int).to_numpy(), ev.rule_u.fillna(1).astype(int).to_numpy(), ev.rule_confidence.to_numpy()
    h = TR.point_h(cdf)
    conf = model_confidence(cdf, h) - ev.rule_afford_ded.to_numpy() - ev.rule_drift_ded.to_numpy()
    return h, model_u(cdf, h), np.maximum(conf, 0)


def band_table(cdf: np.ndarray, ev: pd.DataFrame) -> list[dict]:
    """Calibration of each band on the days a schedule can use (first retry day to the last allowed day)."""
    p, y = [], []
    T = ev["T"].to_numpy()
    for seg in ("lending", "insurance"):
        m = (ev.segment == seg).to_numpy()
        lo = C.RESULT_DELAY[C.RAIL[seg]] + 1
        hi = C.LIMITS[seg]["lastAllowedDay"]
        days = np.arange(lo, hi + 1)
        p.append(cdf[m][:, days].ravel())
        y.append((T[m][:, None] <= days[None, :]).ravel())
    p, y = np.concatenate(p), np.concatenate(y)
    rows = []
    for band, lo, hi, stated in (("High", 0.8, 1.01, "80% or more"), ("Medium", 0.6, 0.8, "60% to under 80%"), ("Lower", 0.0, 0.6, "under 60%")):
        m = (p >= lo) & (p < hi)
        observed = float(y[m].mean()) if m.any() else None
        holds = observed is not None and lo <= observed < hi
        rows.append({"band": band, "stated": stated, "n": int(m.sum()), "mean_predicted": float(p[m].mean()) if m.any() else None,
                     "observed": observed, "holds": bool(holds)})
    return rows


def reliability(cdf: np.ndarray, T: np.ndarray) -> list[dict]:
    days = np.arange(1, C.HORIZON + 1)
    p = cdf[:, days].ravel()
    y = (T[:, None] <= days[None, :]).ravel()
    edges = np.linspace(0, 1, 11)
    out = []
    for a, b in zip(edges[:-1], edges[1:]):
        m = (p >= a) & ((p < b) if b < 1 else (p <= b))
        if m.any():
            out.append({"bin": f"{a:.1f}-{b:.1f}", "n": int(m.sum()), "predicted": float(p[m].mean()), "observed": float(y[m].mean())})
    return out


def method_metrics(name: str, cdf: np.ndarray, ev: pd.DataFrame) -> dict:
    T = ev["T"].to_numpy()
    h, u, conf = point_and_confidence(name, cdf, ev)
    err = np.abs(h - T)
    tier_a = (ev.tier == "A").to_numpy()
    floors = {}
    for f in FLOORS:
        floors[str(f)] = float(np.mean(tier_a & (conf >= f)))
    eligible = tier_a & (conf >= ev.segment.map(C.FLOOR).to_numpy())
    p80_day = np.minimum(TR.first_day(cdf, 0.8), C.HORIZON + 1)
    return {
        "day_error": float(err.mean()),
        "day_error_median": float(np.median(err)),
        "within_1_day": float(np.mean(err <= 1)),
        "day_error_eligible": float(err[eligible].mean()) if eligible.any() else None,
        "coverage80": TR.coverage80(cdf, T),
        "funded_by_80th_percentile_day": float(np.mean(T <= p80_day)),
        "bands": band_table(cdf, ev),
        "reliability": reliability(cdf, T),
        "eligible_share_by_floor": floors,
        "eligible_share": float(eligible.mean()),
    }


def simulate(ev: pd.DataFrame, cdf: np.ndarray, name: str) -> dict:
    """Plays every test failure through the real engine with the standing default (Balanced)."""
    h, u, conf = point_and_confidence(name, cdf, ev)
    acts = ((ev.tier == "A").to_numpy()) & (conf >= ev.segment.map(C.FLOOR).to_numpy())
    items = []
    for i, r in enumerate(ev.itertuples()):
        seg = r.segment
        lik = cdf[i].tolist()
        items.append({
            "segment": seg, "merchantType": "lender" if seg == "lending" else "insurer", "layerActs": bool(acts[i]),
            "h": int(h[i]), "u": int(u[i]), "likelihoodByDay": [float(x) for x in lik],
            "salaryRecognized": bool(r.salary_recognized),
            "lastAllowedDay": C.LIMITS[seg]["lastAllowedDay"], "maxRepresentations": C.LIMITS[seg]["maxRepresentations"],
            "resultDelayDays": C.RESULT_DELAY[C.RAIL[seg]], "baselineRetryDays": C.BASELINE_RETRY_DAYS[seg],
            "fundedOnDay": int(r.T) if r.T <= C.HORIZON else None,
        })
    results = bridge.run("simulate", items)
    out = {}
    for seg in ("lending", "insurance"):
        idx = [i for i, it in enumerate(items) if it["segment"] == seg]
        layer = {"failed": 0, "collected_by_debit": 0, "paid_by_link": 0}
        orig = {"failed": 0, "collected_by_debit": 0}
        for i in idx:
            res = results[i]
            o = res["original"]
            orig["failed"] += o["failedAttempts"]
            orig["collected_by_debit"] += int(o["paidDay"] is not None)
            if res["layer"] is None:  # fail open: the original retries run
                layer["failed"] += o["failedAttempts"]
                layer["collected_by_debit"] += int(o["paidDay"] is not None)
            else:
                L = res["layer"]
                layer["failed"] += L["failedAttempts"]
                layer["collected_by_debit"] += int(L["paidVia"] == "debit")
                layer["paid_by_link"] += int(L["paidVia"] == "link")
        for d in (layer, orig):
            d["failed_per_collected"] = d["failed"] / d["collected_by_debit"] if d["collected_by_debit"] else None
        out[seg] = {"cases": len(idx), "layer_acts": int(sum(items[i]["layerActs"] for i in idx)), "with_layer": layer, "original_retries": orig}
    return out


def salary_recognition(ev: pd.DataFrame) -> dict:
    truth = ev.archetype.isin(SALARIED) & ev.visible_income
    rec = ev.salary_recognized == 1
    correct = rec & ((ev.rule_h - ev["T"]).abs() <= 1)
    return {
        "recognized": int(rec.sum()),
        "correct_day": int(correct.sum()),
        "recognized_without_true_salary": int((rec & ~truth).sum()),
        "precision": float(correct.sum() / rec.sum()) if rec.any() else None,
        "recall": float((correct & truth).sum() / truth.sum()) if truth.any() else None,
        "definition": "Precision: recognized salaries whose predicted day is within 1 day of the true funded day. "
                      "Recall: share of visible monthly salaries recognized with the right day.",
    }


def catch_all(attempts: list[dict]) -> dict:
    rows = [a for a in attempts if a["code"] in C.CATCH_ALL_CODES and 13 <= C.month_no(date.fromordinal(a["ord"])) <= 24]
    res = bridge.run("triage", [{"errorReason": a["code"], "mandateStatus": a["mandate"], "downtimeActive": bool(a["downtime"])} for a in rows])
    by_lookup = [(a, r) for a, r in zip(rows, res) if not r["needsAgent"]]
    left = [a for a, r in zip(rows, res) if r["needsAgent"]]
    correct = sum(1 for a, r in by_lookup if r["label"] == a["cause"])
    mix = pd.Series([a["cause"] for a in left]).value_counts(normalize=True).round(3).to_dict() if left else {}
    return {
        "catch_all_failures": len(rows),
        "resolved_by_rules_and_lookups": len(by_lookup),
        "resolved_share": len(by_lookup) / len(rows) if rows else None,
        "resolved_correct_share": correct / len(by_lookup) if by_lookup else None,
        "left_for_triage_agent": len(left),
        "true_cause_of_those_left": mix,
    }


def main():
    events = pd.read_pickle(C.WORK_DIR / "events.pkl")
    with open(C.WORK_DIR / "models.pkl", "rb") as f:
        models = pickle.load(f)
    _, _, te = TR.split(events)
    te = te.reset_index(drop=True)
    c = curves(te, models)
    has_rule = te.rule_likelihood.notna().to_numpy()

    report: dict = {"test_rows": len(te), "rule_available_share": float(has_rule.mean())}
    ev = te[has_rule].reset_index(drop=True)
    report["methods"] = {name: method_metrics(name, cdf[has_rule], ev) for name, cdf in c.items()}
    for name, m in report["methods"].items():
        print(f"  {name:18s} day error {m['day_error']:.2f}  coverage {m['coverage80']:.1%}  eligible {m['eligible_share']:.1%}")

    print("  playing every test failure through the engine ...")
    chosen_curve = c["chosen_calibrated"][has_rule]
    report["simulation"] = {"rule": simulate(ev, c["rule"][has_rule], "rule"), "model": simulate(ev, chosen_curve, "model")}
    report["salary"] = salary_recognition(te)

    with open(C.WORK_DIR / "train.pkl", "rb") as f:
        train = pickle.load(f)
    report["catch_all"] = catch_all(train["attempts"])

    print("  parity: Python rule against estimateFunding on 500 test failures ...")
    report["parity_sample"] = parity.compare(parity.sample_rows(train, te, 500, C.SEED))
    print(f"    {report['parity_sample']['checked']} checked, {len(report['parity_sample']['mismatches'])} mismatches")
    if report["parity_sample"]["mismatches"]:
        raise SystemExit("The Python rule disagrees with lib/engine. Fix ml/fsl/rule.py before going on.")

    report["chosen"] = models["chosen"]
    report["choice_note"] = models["choice_note"]
    report["tune"] = models["tune"]
    report["aft_settings"] = {"distribution": models["aft"]["dist"], "scale": models["aft"]["scale"]}
    with open(C.WORK_DIR / "evaluation.json", "w") as f:
        json.dump(report, f, indent=2, default=float)
