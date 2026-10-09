"""The parity check: the Python median-day rule must give the same answer as estimateFunding
in lib/engine/estimate.ts. Runs the real engine through the bridge on the same inputs."""

from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd

from . import bridge
from . import config as C
from . import rule
from .features import CustomerView


def iso(o: int) -> str:
    return date.fromordinal(int(o)).isoformat()


def engine_input(v: CustomerView, segment: str, amount: int, due: int, asof: int | None = None) -> dict:
    """The EstimateInput a server function would build: payments and credits dated before asOf."""
    asof = due if asof is None else asof
    merchant = C.LENDER_ID if segment == "lending" else C.INSURER_ID
    own = v.obs_own & (v.obs_merchant == merchant)
    m = v.obs_ord < asof
    c = v.cr_ord < asof
    return {
        "dueDate": iso(due),
        "asOf": iso(asof),
        "segment": segment,
        "debitAmountPaise": int(amount),
        "observations": [
            {"date": iso(o), "amountPaise": int(a), "ownMerchant": bool(w)}
            for o, a, w in zip(v.obs_ord[m], v.obs_amt[m], own[m])
        ],
        "credits": [
            {"date": iso(o), "amountPaise": int(a), "source": s}
            for o, a, s, keep in zip(v.cr_ord, v.cr_amt, v.cr_src, c)
            if keep
        ],
    }


def compare(rows: list[tuple]) -> dict:
    """Runs both on each (view, segment, amount, due[, asof]) and returns the mismatches."""
    rows = [r if len(r) == 5 else (*r, r[3]) for r in rows]
    inputs = [engine_input(*r) for r in rows]
    engine = bridge.run("estimate", inputs)
    mismatches = []
    for (v, seg, amount, due, asof), e in zip(rows, engine):
        m = v.obs_ord < asof
        merchant = C.LENDER_ID if seg == "lending" else C.INSURER_ID
        own = v.obs_own & (v.obs_merchant == merchant)
        c = v.cr_ord < asof
        py = rule.estimate(due, seg, amount, v.obs_ord[m], v.obs_amt[m], own[m],
                           v.cr_ord[c], v.cr_amt[c], [s for s, k in zip(v.cr_src, c) if k], asof=asof)
        if py is None:
            same = e["failReason"] == "no_observations"
        else:
            same = (
                e["h"] == py["h"] and e["u"] == py["u"] and e["ok"] == py["ok"]
                and e["confidence"] == py["confidence"]
                and e["confidenceBeforeDeductions"] == py["confidence_before"]
                and e["salaryRecognized"] == py["salary"]
                and e["driftApplied"] == py["drift"]
                and np.allclose(e["likelihoodByDay"], py["likelihood"], rtol=0, atol=1e-12)
            )
        if not same:
            mismatches.append({"due": iso(due), "segment": seg, "engine": {k: e[k] for k in ("h", "u", "confidence")},
                               "python": None if py is None else {k: py[k] for k in ("h", "u", "confidence")}})
    return {"checked": len(rows), "mismatches": mismatches}


def sample_rows(data: dict, events: pd.DataFrame, n: int, seed: int) -> list:
    pick = events.sample(n=min(n, len(events)), random_state=seed)
    by_cust = {cid: g for cid, g in data["tx"][data["tx"].customer_id.isin(pick.customer_id)].groupby("customer_id")}
    views = {cid: CustomerView(g) for cid, g in by_cust.items()}
    return [(views[r.customer_id], r.segment, int(r.amount), int(r.due)) for r in pick.itertuples()]
