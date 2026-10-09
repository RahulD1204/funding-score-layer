"""The median-day baseline: a line-by-line Python copy of estimateFunding and the evidence gate
in lib/engine/estimate.ts and lib/engine/circular.ts.

It exists so the offline pipeline can score hundreds of thousands of historical debits quickly.
It must give the same answer as the engine; bridge.py and tests/ml-export.test.ts check that.
Dates are ordinals (date.toordinal()) for speed.
"""

from __future__ import annotations

import calendar
import math
from dataclasses import dataclass
from datetime import date

import numpy as np

from . import config as C

_O0 = date(2022, 1, 1).toordinal()
_O1 = date(2028, 12, 31).toordinal()
_DAYS = [date.fromordinal(o) for o in range(_O0, _O1 + 1)]
DOM = np.array([d.day for d in _DAYS], dtype=np.int64)
DIM = np.array([calendar.monthrange(d.year, d.month)[1] for d in _DAYS], dtype=np.int64)
YM = np.array([d.year * 12 + d.month - 1 for d in _DAYS], dtype=np.int64)


def dom(o):
    return DOM[np.asarray(o) - _O0]


def dim_of(o):
    return DIM[np.asarray(o) - _O0]


def ym(o):
    return YM[np.asarray(o) - _O0]


def days_in_month(y: int, m: int) -> int:
    return calendar.monthrange(y, m)[1]


def add_months(o: int, n: int) -> int:
    """Moves a date by whole months, clamping the day to the target month's length."""
    d = date.fromordinal(int(o))
    idx = d.year * 12 + (d.month - 1) + n
    y, m = divmod(idx, 12)
    m += 1
    return date(y, m, min(d.day, days_in_month(y, m))).toordinal()


def circ_dist(a, b, period: int = C.CIRCLE):
    d = np.abs(np.asarray(a) - np.asarray(b)) % period
    return np.minimum(d, period - d)


def js_median(values) -> float:
    v = np.sort(np.asarray(values, dtype=np.float64))
    n = len(v)
    if n == 0:
        raise ValueError("median of an empty list")
    mid = n // 2
    return float(v[mid]) if n % 2 == 1 else float((v[mid - 1] + v[mid]) / 2)


def circular_median(pos: np.ndarray) -> int:
    """The listed value with the smallest total circular distance to the others. Ties go to the smaller value."""
    cands = np.unique(pos)
    totals = circ_dist(cands[:, None], pos[None, :]).sum(axis=1)
    return int(cands[int(np.argmin(totals))])


@dataclass
class Fit:
    kind: str
    value: int
    mad: float
    positions: np.ndarray


def positions_of(ords: np.ndarray, kind: str) -> np.ndarray:
    return dom(ords) if kind == "start" else dim_of(ords) - dom(ords)


def fit_anchor(ords: np.ndarray, kind: str) -> Fit:
    pos = positions_of(ords, kind)
    value = circular_median(pos)
    return Fit(kind, value, js_median(circ_dist(pos, value)), pos)


def best_anchor(ords: np.ndarray) -> Fit:
    start = fit_anchor(ords, "start")
    end = fit_anchor(ords, "end")
    total_end = int(circ_dist(end.positions, end.value).sum())
    total_start = int(circ_dist(start.positions, start.value).sum())
    return end if total_end < total_start else start


def _occurrence(kind: str, value: int, y: int, m: int) -> int:
    n = days_in_month(y, m)
    day = min(value, n) if kind == "start" else max(1, n - value)
    return date(y, m, day).toordinal()


def next_occurrence(kind: str, value: int, on_or_after: int) -> int:
    d = date.fromordinal(int(on_or_after))
    occ = _occurrence(kind, int(value), d.year, d.month)
    if occ >= on_or_after:
        return occ
    ny, nm = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    return _occurrence(kind, int(value), ny, nm)


# ---------------------------------------------------------------------------
# Salary recognition
# ---------------------------------------------------------------------------


@dataclass
class Salary:
    source: str
    fit: Fit
    dates: np.ndarray
    months: int
    median_amount: float


def recognize_salary(cr_ord, cr_amt, cr_src, asof: int) -> Salary | None:
    frm = add_months(asof, -C.LOOKBACK_MONTHS)
    by_source: dict[str, list[tuple[int, int]]] = {}
    for o, a, s in zip(cr_ord, cr_amt, cr_src):
        if o >= asof or o < frm:
            continue
        by_source.setdefault(s, []).append((int(o), int(a)))

    best: Salary | None = None
    latest_allowed = int(ym(asof)) - 1
    for source, items in by_source.items():
        per_month: dict[int, tuple[int, int]] = {}
        for o, a in items:
            idx = int(ym(o))
            cur = per_month.get(idx)
            if cur is None or a > cur[1]:
                per_month[idx] = (o, a)
        months = sorted(per_month, reverse=True)
        if not months or months[0] < latest_allowed:
            continue
        run = [per_month[months[0]]]
        i = 1
        while i < len(months) and months[i] == months[i - 1] - 1:
            run.append(per_month[months[i]])
            i += 1
        if len(run) < C.SALARY_MIN_MONTHS:
            continue
        med = js_median([a for _, a in run])
        if not all(abs(a - med) <= med * C.SALARY_AMOUNT_TOL for _, a in run):
            continue
        dates = np.array(sorted(o for o, _ in run), dtype=np.int64)
        fit = best_anchor(dates)
        if not bool((circ_dist(fit.positions, fit.value) <= C.SALARY_DATE_TOL).all()):
            continue
        sig = Salary(source, fit, dates, len(run), med)
        if best is None or sig.months > best.months or (sig.months == best.months and med > best.median_amount):
            best = sig
    return best


# ---------------------------------------------------------------------------
# Evidence, gate and estimate
# ---------------------------------------------------------------------------


def summarize(obs_ord, obs_amt, asof: int, amount: int):
    frm = add_months(asof, -C.LOOKBACK_MONTHS)
    m = (obs_ord < asof) & (obs_ord >= frm)
    months = len(set(ym(obs_ord[m]).tolist())) if m.any() else 0
    afford = int((obs_amt[m] >= amount * C.AFFORD_SHARE).sum())
    return m, int(m.sum()), months, afford


def gate(timing: int, months: int, has_failure_evidence: bool, identity_linked: bool = True):
    failed = []
    if timing < C.GATE_MIN_OBS:
        failed.append("too_few_observations")
    if months < C.GATE_MIN_MONTHS:
        failed.append("too_few_months")
    if not has_failure_evidence:
        failed.append("no_failure_evidence")
    if not identity_linked:
        failed.append("identity_not_linked")
    return ("A" if not failed else "C"), failed


def estimate(due: int, segment: str, amount: int, obs_ord, obs_amt, obs_own, cr_ord=None, cr_amt=None, cr_src=None, asof=None):
    """The rule's estimate, or None when there is no observation at all (the engine's `no_observations`)."""
    asof = due if asof is None else asof
    obs_ord = np.asarray(obs_ord, dtype=np.int64)
    obs_amt = np.asarray(obs_amt, dtype=np.int64)
    obs_own = np.asarray(obs_own, dtype=bool)
    in_window, timing, months, afford = summarize(obs_ord, obs_amt, asof, amount)
    afford_ded = C.AFFORD_DEDUCTION if afford < C.AFFORD_MIN else 0

    salary = recognize_salary(cr_ord, cr_amt, cr_src, asof) if cr_ord is not None else None

    drift = False
    if salary is not None:
        fit = salary.fit
    else:
        w_ord = obs_ord[in_window]
        dates = np.repeat(w_ord, np.where(obs_own[in_window], 2, 1))
        if len(dates) == 0:
            return None
        fit = best_anchor(dates)
        recent = dates[dates >= add_months(asof, -C.DRIFT_RECENT_MONTHS)]
        if len(recent) >= C.DRIFT_MIN_RECENT:
            long_run = fit_anchor(dates, "start").value
            recent_day = fit_anchor(recent, "start").value
            if int(circ_dist(recent_day, long_run)) > C.DRIFT_MAX_DAYS:
                fit = best_anchor(recent)
                drift = True

    n = len(fit.positions)
    within = int((circ_dist(fit.positions, fit.value) <= C.WITHIN_DAYS).sum())
    before = math.floor(100 * within / n + 0.5)  # JavaScript's Math.round
    drift_ded = C.DRIFT_DEDUCTION if drift else 0
    confidence = max(0, before - afford_ded - drift_ded)

    h = next_occurrence(fit.kind, fit.value, due) - due
    offset_of = {int(p): next_occurrence(fit.kind, int(p), due) - due for p in np.unique(fit.positions)}
    offsets = np.array([offset_of[int(p)] for p in fit.positions])
    likelihood = [float(np.count_nonzero(offsets <= k)) / n for k in range(C.HORIZON + 1)]
    u = next((k for k, s in enumerate(likelihood) if s >= C.UPPER_SHARE), C.HORIZON)
    u = max(u, h + 1)

    return {
        "h": int(h),
        "u": int(u),
        "likelihood": likelihood,
        "confidence_before": int(before),
        "confidence": int(confidence),
        "afford_ded": afford_ded,
        "drift_ded": drift_ded,
        "drift": drift,
        "floor": C.FLOOR[segment],
        "ok": confidence >= C.FLOOR[segment],
        "salary": salary is not None,
        "salary_fit": salary.fit if salary is not None else None,
        "source": "salary" if salary is not None else "history",
        "anchor_kind": fit.kind,
        "anchor_value": int(fit.value),
        "mad": float(fit.mad),
        "n_used": int(n),
        "timing": timing,
        "months": months,
        "afford": afford,
    }
