"""Step 2: labels and features, with no leakage (specs/05).

One row per failed due-date debit whose reason code is insufficient_funds. Every feature is
computed from transactions dated before that debit's due date. Labels come from what happened
after it: the last failed attempt day (lower bound) and the first successful day (upper bound),
open when nothing was collected. The true funded day is kept for evaluation only.

For the app customers there is one row per obligation for its April 2026 due date, scored in one
batch on 2 April 2026 from data dated before that day.
"""

from __future__ import annotations

import math
import pickle
from multiprocessing import Pool

import numpy as np
import pandas as pd

from . import config as C
from . import rule

WINDOWS = {"3m": 3, "6m": 6, "12m": 12, "all": None}
DOM_BINS = [(1, 7), (8, 15), (16, 23), (24, 31)]


def _nan_ratio(a, b):
    return a / b if b else np.nan


def _start_median_mad(ords):
    if len(ords) == 0:
        return np.nan, np.nan
    f = rule.fit_anchor(ords, "start")
    return f.value, f.mad


class CustomerView:
    """One customer's transactions as arrays, sorted by date, for quick slicing."""

    def __init__(self, tx: pd.DataFrame):
        ok = tx[(tx.direction == "debit") & (tx.status == "success")]
        self.obs_ord = ok.ord.to_numpy(np.int64)
        self.obs_amt = ok.amount_paise.to_numpy(np.int64)
        self.obs_own = ok.own_merchant.astype(bool).to_numpy()
        self.obs_merchant = ok.merchant_id.fillna("").to_numpy()
        bad = tx[(tx.direction == "debit") & (tx.status == "failed")]
        self.fail_ord = bad.ord.to_numpy(np.int64)
        self.fail_if = (bad.reason_code == "insufficient_funds").to_numpy()
        cr = tx[tx.direction == "credit"]
        self.cr_ord = cr.ord.to_numpy(np.int64)
        self.cr_amt = cr.amount_paise.to_numpy(np.int64)
        self.cr_src = cr.source.tolist()
        rec = tx[tx.obligation_id.notna()]
        self.rec = rec[["ord", "obligation_id", "cycle_due_ord", "attempt_day", "status"]].copy()

    def own_cycles(self, oid: str, asof: int):
        """This lender's own history for the loan, using only rows dated before asof."""
        r = self.rec[(self.rec.obligation_id == oid) & (self.rec.ord < asof)]
        out = []
        for due, g in r.groupby("cycle_due_ord"):
            day0 = g[g.attempt_day == 0]
            paid = g[g.status == "success"]
            out.append({
                "due": int(due),
                "on_time": bool(len(day0) and (day0.status == "success").any()),
                "paid_day": int(paid.attempt_day.iloc[0]) if len(paid) else None,
            })
        return out


def has_failure_evidence(v: CustomerView, asof: int) -> bool:
    frm = rule.add_months(asof, -C.LOOKBACK_MONTHS)
    m = (v.fail_ord < asof) & (v.fail_ord >= frm) & v.fail_if
    return bool(m.any())


def features_for(v: CustomerView, oid: str, segment: str, amount: int, due: int, asof: int | None = None) -> tuple[dict, dict | None]:
    """Features for one debit. Only data dated before `asof` (by default the due date) is read."""
    asof = due if asof is None else asof
    merchant = C.LENDER_ID if segment == "lending" else C.INSURER_ID
    own = v.obs_own & (v.obs_merchant == merchant)
    before = v.obs_ord < asof
    est = rule.estimate(due, segment, amount, v.obs_ord[before], v.obs_amt[before], own[before],
                        v.cr_ord[v.cr_ord < asof], v.cr_amt[v.cr_ord < asof], [s for o, s in zip(v.cr_ord, v.cr_src) if o < asof],
                        asof=asof)
    cycles = [c for c in v.own_cycles(oid, asof) if c["due"] < asof]

    f: dict = {}
    for name, months in WINDOWS.items():
        frm = rule.add_months(asof, -months) if months else -1
        m = before & (v.obs_ord >= frm)
        ords, amts = v.obs_ord[m], v.obs_amt[m]
        n = len(ords)
        f[f"n_{name}"] = n
        f[f"log_total_{name}"] = math.log1p(amts.sum() / 100) if n else 0.0
        logs = np.log(amts / 100) if n else np.array([])
        f[f"med_logamt_{name}"] = float(np.median(logs)) if n else np.nan
        f[f"p90_logamt_{name}"] = float(np.percentile(logs, 90)) if n else np.nan
        doms = rule.dom(ords) if n else np.array([])
        for lo, hi in DOM_BINS:
            f[f"share_d{lo}_{hi}_{name}"] = float(((doms >= lo) & (doms <= hi)).mean()) if n else np.nan
        fm = (v.fail_ord < asof) & (v.fail_ord >= frm)
        f[f"n_fail_{name}"] = int(fm.sum())
        f[f"if_share_{name}"] = float(v.fail_if[fm].mean()) if fm.any() else np.nan
        f[f"late_rescue_{name}"] = sum(1 for c in cycles if c["due"] >= frm and not c["on_time"] and c["paid_day"] is not None)

    f["ratio_n_3_12"] = _nan_ratio(f["n_3m"], f["n_12m"])
    f["ratio_amt_3_12"] = _nan_ratio(math.expm1(f["log_total_3m"]), math.expm1(f["log_total_12m"]))
    f["delta_if_share"] = f["if_share_3m"] - f["if_share_12m"]
    m12 = before & (v.obs_ord >= rule.add_months(asof, -12))
    m3 = before & (v.obs_ord >= rule.add_months(asof, -3))
    s12, mad12 = _start_median_mad(v.obs_ord[m12])
    s3, _ = _start_median_mad(v.obs_ord[m3])
    f["drift_days"] = float(rule.circ_dist(s3, s12)) if not (np.isnan(s3) or np.isnan(s12)) else np.nan
    f["start_median_12m"], f["start_mad_12m"] = s12, mad12
    if m12.any():
        e = rule.fit_anchor(v.obs_ord[m12], "end")
        f["end_median_12m"], f["end_mad_12m"] = e.value, e.mad
    else:
        f["end_median_12m"] = f["end_mad_12m"] = np.nan

    if est is not None:
        f.update({
            "rule_h": est["h"], "rule_u": est["u"], "rule_conf": est["confidence_before"],
            "rule_lik_h": est["likelihood"][est["h"]], "rule_lik_h1": est["likelihood"][min(est["h"] + 1, C.HORIZON)],
            "rule_anchor_end": int(est["anchor_kind"] == "end"), "rule_anchor_value": est["anchor_value"],
            "rule_mad": est["mad"], "rule_drift": int(est["drift"]), "rule_n_used": est["n_used"],
            "salary_recognized": int(est["salary"]),
            "salary_h": est["h"] if est["salary"] else np.nan,
        })
    else:
        for k in ("rule_h", "rule_u", "rule_conf", "rule_lik_h", "rule_lik_h1", "rule_anchor_end", "rule_anchor_value",
                  "rule_mad", "rule_drift", "rule_n_used", "salary_h"):
            f[k] = np.nan
        f["salary_recognized"] = 0

    med_amt = np.median(v.obs_amt[m12]) if m12.any() else np.nan
    f["log_amount"] = math.log(amount / 100)
    f["amount_ratio"] = amount / med_amt if med_amt == med_amt else np.nan
    f["is_insurance"] = int(segment == "insurance")
    f["cycle_index"] = len(cycles)
    rescued = [c["paid_day"] for c in cycles if not c["on_time"] and c["paid_day"] is not None]
    f["own_on_time"] = sum(1 for c in cycles if c["on_time"])
    f["own_rescued"] = len(rescued)
    f["own_unpaid"] = sum(1 for c in cycles if not c["on_time"] and c["paid_day"] is None and c["due"] + C.HORIZON < asof)
    f["own_rescue_day_median"] = float(np.median(rescued)) if rescued else np.nan
    f["own_rescue_day_last"] = rescued[-1] if rescued else np.nan

    d = rule.date.fromordinal(due)
    dim = rule.days_in_month(d.year, d.month)
    f["due_dom"] = d.day
    f["month_len"] = dim
    f["month_end"] = int(d.day > dim - 3)
    f["due_weekday"] = d.weekday()

    timing = est["timing"] if est else int(m12.sum())
    months = est["months"] if est else 0
    meta = {
        "timing": timing, "months": months, "afford": est["afford"] if est else 0,
        "failure_evidence": has_failure_evidence(v, asof),
    }
    meta["tier"] = rule.gate(timing, months, meta["failure_evidence"])[0]
    return f, (est, meta)


def _customer_events(args):
    tx, cycles, profile, mode = args
    v = CustomerView(tx)
    rows = []
    for cyc in cycles:
        if mode == "train":
            d0 = cyc["day0"]
            if d0 is None or d0["code"] != "insufficient_funds" or C.month_no(rule.date.fromordinal(cyc["due"])) < 13:
                continue
            if C.month_no(rule.date.fromordinal(cyc["due"])) > 24:
                continue
        elif cyc["due"] < C.DEMO_DUE.toordinal() or C.month_no(rule.date.fromordinal(cyc["due"])) != 25:
            continue
        # App obligations are scored in one batch on 2 April 2026, from data dated before it.
        asof = None if mode == "train" else C.DEMO_DUE.toordinal()
        f, (est, meta) = features_for(v, cyc["oid"], cyc["segment"], cyc["amount"], cyc["due"], asof)
        if_fails = [k for k, code, _ in cyc["fails"] if code == "insufficient_funds" and (cyc["paid_day"] is None or k < cyc["paid_day"])]
        row = {
            "customer_id": profile.cid, "obligation_id": cyc["oid"], "segment": cyc["segment"], "amount": cyc["amount"],
            "due": cyc["due"], "month": C.month_no(rule.date.fromordinal(cyc["due"])), "archetype": profile.archetype,
            "visible_income": profile.visible,
            "lower": max(if_fails) if if_fails else 0,
            "upper": cyc["paid_day"] if cyc["paid_day"] is not None else np.inf,
            "T": cyc["funded"] if cyc["funded"] is not None else C.HORIZON + 1,
            **meta,
            "rule_ok": bool(est and est["ok"]), "rule_confidence": est["confidence"] if est else 0,
            "rule_afford_ded": est["afford_ded"] if est else 0, "rule_drift_ded": est["drift_ded"] if est else 0,
            "rule_likelihood": est["likelihood"] if est else None, "rule_source": est["source"] if est else None,
            "rule_confidence_before": est["confidence_before"] if est else None, "rule_estimate": est,
            **f,
        }
        rows.append(row)
    return rows


def _jobs(data, mode):
    by_cust = {cid: g for cid, g in data["tx"].groupby("customer_id", sort=False)}
    cyc_by: dict[str, list] = {}
    for c in data["cycles"]:
        cyc_by.setdefault(c["customer_id"], []).append(c)
    empty = data["tx"].iloc[0:0]
    return [(by_cust.get(p.cid, empty), cyc_by.get(p.cid, []), p, mode) for p in data["profiles"]]


def build(data, mode):
    with Pool(8) as pool:
        parts = pool.map(_customer_events, _jobs(data, mode), chunksize=20)
    return pd.DataFrame([r for part in parts for r in part])


def feature_columns(df: pd.DataFrame) -> list[str]:
    meta = {"customer_id", "obligation_id", "segment", "amount", "due", "month", "archetype", "visible_income", "lower",
            "upper", "T", "timing", "months", "afford", "failure_evidence", "tier", "rule_ok", "rule_confidence",
            "rule_afford_ded", "rule_drift_ded", "rule_likelihood", "rule_source",
            "rule_confidence_before", "rule_estimate"}
    return [c for c in df.columns if c not in meta]


def main():
    with open(C.WORK_DIR / "train.pkl", "rb") as f:
        train = pickle.load(f)
    events = build(train, "train")
    events.to_pickle(C.WORK_DIR / "events.pkl")
    print(f"Training-population events (failed due-date debits, months 13 to 24): {len(events):,}")
    print(events.groupby(["segment", pd.cut(events.month, [12, 18, 21, 24], labels=["train", "tune", "test"])],
                         observed=True).size().unstack())

    with open(C.WORK_DIR / "app.pkl", "rb") as f:
        app = pickle.load(f)
    app_events = build(app, "app")
    app_events.to_pickle(C.WORK_DIR / "app_events.pkl")
    print(f"App obligations scored for the April 2026 cycle: {len(app_events)}")
    print(f"Features per row: {len(feature_columns(events))}")
