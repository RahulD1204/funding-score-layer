"""Step 1: synthetic customers, loans, policies and 24 months of daily history (specs/05).

Each customer lives day by day. Income arrives by archetype, spending drains the balance,
and the EMI or premium is presented on its due date and on Razorpay's original retry days.
A payment is recorded only if the balance covers it. Noise: salary delays, bank downtime,
cancelled or paused mandates, closed accounts, catch-all reason codes with bank free text,
refunds and Re 1 test debits.

Ground truth (each cycle's true funded day and each failure's true cause) is kept apart from
the transactions. The model and the agents never see it.

Two populations: 5,000 training customers, and about 200 app customers that never enter
training. Ten of the app customers are the seeded demo cases of specs/05.
"""

from __future__ import annotations

import calendar
import pickle
import zlib
from dataclasses import dataclass, field
from datetime import date, timedelta
from multiprocessing import Pool

import numpy as np
import pandas as pd

from . import config as C
from . import rule

ARCHETYPES = [
    ("salaried_fixed", 0.45),
    ("salaried_month_end", 0.15),
    ("gig_weekly", 0.10),
    ("self_employed", 0.10),
    ("job_changer", 0.05),
    ("two_paydays", 0.05),
    ("new_thin", 0.10),
]
DUE_DAYS = [2, 5, 7, 10, 15]
PAYDAYS = [1, 5, 7, 10, 25]

CLEAR_TEXT = {
    "insufficient_funds": "INSUFFICIENT FUNDS",
    "mandate_cancelled": "MANDATE CANCELLED BY CUSTOMER",
    "mandate_paused": "MANDATE PAUSED BY CUSTOMER",
    "account_closed": "ACCOUNT CLOSED",
    "bank_technical_error": "ISSUER BANK TECHNICAL ERROR",
}
# Bank free text that comes with a catch-all code, by the true cause. Some lines hint at the cause, some say nothing.
CATCH_ALL_TEXT = {
    "balance": ["TXN DECLINED - REFER TO BANK", "DEBIT DECLINED BY REMITTER BANK", "INSUFFICIENT BAL / LIMIT EXCEEDED"],
    "mandate_cancelled": ["MANDATE NOT ACTIVE", "TXN DECLINED - REFER TO BANK", "NO VALID MANDATE FOUND"],
    "mandate_paused": ["MANDATE ON HOLD", "TXN DECLINED - REFER TO BANK"],
    "instrument_closed": ["ACCOUNT CLOSED OR TRANSFERRED", "INVALID ACCOUNT", "TXN DECLINED - REFER TO BANK"],
    "bank_downtime": ["ISSUER BANK NOT AVAILABLE", "REMITTER CBS OFFLINE", "TXN DECLINED - REFER TO BANK"],
}
CLEAR_CODE = {
    "balance": "insufficient_funds",
    "mandate_cancelled": "mandate_cancelled",
    "mandate_paused": "mandate_paused",
    "instrument_closed": "account_closed",
    "bank_downtime": "bank_technical_error",
}

TXN_COLUMNS = [
    "customer_id", "ord", "seq", "amount_paise", "direction", "kind", "merchant_id", "own_merchant",
    "status", "reason_code", "bank_text", "source", "obligation_id", "cycle_due_ord", "attempt_day",
]

ORD_START = C.HISTORY_START.toordinal()
ORD_END = C.SIM_END.toordinal()
DEMO_ORD = C.DEMO_DUE.toordinal()


# ---------------------------------------------------------------------------
# Profiles
# ---------------------------------------------------------------------------


@dataclass
class Obligation:
    oid: str
    segment: str  # lending or insurance
    amount: int  # paise
    due_day: int
    start: int  # ordinal of the first cycle's earliest due date


@dataclass
class Profile:
    cid: str
    population: str
    archetype: str
    bank: str
    start: int
    income: list  # (ord, amount_paise, source or None)
    visible: bool
    r: float
    buffer: int
    bills_share: float
    n_bills: int
    n_disc: int
    tau: float
    opening_balance: int
    obligations: list
    p_catch_all: float = 0.15
    p_cancel: float = 0.003
    p_pause: float = 0.002
    closed_on: int | None = None
    label: str = ""
    holdout: bool = False
    seeded: bool = False
    draw: int = 0
    aware: bool = False  # sets aside money for debits due before the next income
    forced_code: dict = field(default_factory=dict)  # ord -> (code, text, cause) for the due-date debit
    cancel_on: dict = field(default_factory=dict)  # oid -> ord of a forced cancellation
    plain_codes_on: set = field(default_factory=set)  # ords where no catch-all code is drawn


def _rupees(x: float) -> int:
    return int(round(x)) * 100


def _months(start: int, end: int):
    d = date.fromordinal(start).replace(day=1)
    while d.toordinal() <= end:
        yield d.year, d.month
        d = (d + timedelta(days=32)).replace(day=1)


def _working_day(y: int, m: int, day: int, forward: bool) -> date:
    d = date(y, m, min(day, calendar.monthrange(y, m)[1]))
    step = 1 if forward else -1
    while d.weekday() >= 5:
        d += timedelta(days=step)
    return d


def _salary_stream(rng, start, end, payday_of, amount, source, delay_p, weekend=True, overrides=None):
    out = []
    for y, m in _months(start, end):
        day = payday_of(y, m)
        d = _working_day(y, m, day, forward=(day == 1)) if weekend else date(y, m, min(day, calendar.monthrange(y, m)[1]))
        if rng.random() < delay_p:
            d += timedelta(days=int(rng.integers(1, 4)))
        if overrides and (y, m) in overrides:
            d = overrides[(y, m)]
        a = amount * (1 + rng.normal(0, 0.01))
        if rng.random() < 0.04:
            a *= 1.35  # a bonus month, which breaks salary recognition for a while
        o = d.toordinal()
        if start <= o <= end:
            out.append((o, _rupees(a / 100), source))
    return out


def _income(rng, archetype: str, start: int, payday: int, monthly: float, overrides=None, weekend=True, delay_p=0.12):
    """Returns (income events, source ids). Amounts in paise."""
    end = ORD_END
    if archetype in ("salaried_fixed", "new_thin"):
        src = f"payroll-{rng.integers(100, 999)}"
        return _salary_stream(rng, start, end, lambda y, m: payday, monthly, src, delay_p, weekend, overrides)
    if archetype == "salaried_month_end":
        src = f"payroll-{rng.integers(100, 999)}"
        return _salary_stream(rng, start, end, lambda y, m: 31, monthly, src, 0.08, True, overrides)
    if archetype == "job_changer":
        p2 = int(rng.choice([d for d in PAYDAYS + [3, 12, 20, 28] if rule.circ_dist(d, payday) >= 5]))
        change = date.fromordinal(start) + timedelta(days=int(rng.integers(240, 660)))
        cut = change.toordinal()
        first = _salary_stream(rng, start, cut - 1, lambda y, m: payday, monthly, f"payroll-{rng.integers(100, 999)}", delay_p)
        second = _salary_stream(rng, cut, end, lambda y, m: p2, monthly * rng.uniform(0.95, 1.3), f"payroll-{rng.integers(100, 999)}", delay_p)
        return first + second
    if archetype == "two_paydays":
        src = f"payroll-{rng.integers(100, 999)}"
        out = []
        for y, m in _months(start, end):
            for day, fwd in ((1, True), (15, False)):
                o = _working_day(y, m, day, fwd).toordinal()
                if start <= o <= end:
                    out.append((o, _rupees(monthly / 2 * (1 + rng.normal(0, 0.03)) / 100), src))
        return out
    if archetype == "gig_weekly":
        src = f"platform-{rng.integers(100, 999)}"
        weekly = monthly / 4.3
        out = []
        o = start + (1 - date.fromordinal(start).weekday()) % 7  # first Tuesday
        while o <= end:
            if rng.random() < 0.8:
                out.append((o, _rupees(weekly * rng.uniform(0.6, 1.4) / 100), src))
            o += 7
        return out
    if archetype == "self_employed":
        clients = [f"client-{rng.integers(1000, 9999)}" for _ in range(int(rng.integers(3, 7)))]
        out = []
        for y, m in _months(start, end):
            n = 2 + int(rng.poisson(3))
            dim = calendar.monthrange(y, m)[1]
            for _ in range(n):
                o = date(y, m, int(rng.integers(1, dim + 1))).toordinal()
                if start <= o <= end:
                    out.append((o, _rupees(monthly / n * rng.lognormal(0, 0.5) / 100), str(rng.choice(clients))))
        return sorted(out)
    raise ValueError(archetype)


def _cycle_len(archetype: str) -> int:
    return {"gig_weekly": 7, "two_paydays": 15, "self_employed": 7}.get(archetype, 30)


def random_profile(population: str, idx: int) -> Profile:
    rng = np.random.default_rng([C.SEED, 1 if population == "train" else 2, idx])
    names, shares = zip(*ARCHETYPES)
    archetype = str(rng.choice(names, p=shares))
    cid = f"{'T' if population == 'train' else 'C'}-{idx:05d}"

    if archetype == "new_thin":
        if population == "train":
            start = (C.HISTORY_START + timedelta(days=int(rng.integers(330, 700)))).toordinal()
        else:
            start = DEMO_ORD - int(rng.integers(30, 80))
    else:
        start = ORD_START

    payday = int(rng.choice(PAYDAYS))
    if archetype == "gig_weekly":
        monthly = rng.uniform(14_000, 40_000)
    elif archetype == "self_employed":
        monthly = rng.uniform(30_000, 120_000)
    else:
        monthly = float(np.clip(rng.lognormal(np.log(50_000), 0.45), 22_000, 160_000))
    monthly *= 100  # paise
    income = _income(rng, archetype, start, payday, monthly)
    visible = rng.random() < {"gig_weekly": 0.5, "self_employed": 0.4}.get(archetype, 0.55)

    has_loan = rng.random() < 0.8
    has_policy = rng.random() < 0.4
    if not (has_loan or has_policy):
        has_loan = True
    obligations = []
    if has_loan:
        emi = float(np.clip(monthly * rng.uniform(0.12, 0.35), 5_000_00, 40_000_00))
        obligations.append(Obligation(f"{cid}-L", "lending", _rupees(emi / 10_000) * 100, int(rng.choice(DUE_DAYS)), start + 5))
    if has_policy:
        prem = float(np.clip(monthly * rng.uniform(0.02, 0.06), 1_000_00, 6_000_00))
        obligations.append(Obligation(f"{cid}-P", "insurance", int(round(prem / 5_000)) * 5_000, int(rng.choice(DUE_DAYS)), start + 5))

    biggest = max(o.amount for o in obligations)
    tight = rng.random() < 0.7
    buffer = int(biggest * (rng.uniform(0, 0.3) if tight else rng.uniform(1.0, 3.0)))
    cl = _cycle_len(archetype)
    scale = cl / 30
    return Profile(
        cid=cid,
        population=population,
        archetype=archetype,
        bank=str(rng.choice(C.BANKS)),
        start=start,
        income=income,
        visible=bool(visible),
        r=float(rng.uniform(0.9, 1.0)),
        buffer=buffer,
        bills_share=float(rng.uniform(0.3, 0.55)),
        n_bills=max(1, int(round(rng.integers(3, 6) * scale))),
        n_disc=max(1, int(round(rng.integers(6, 11) * scale))),
        tau=float(rng.uniform(1.5, 5.0) * max(scale, 0.3)),
        opening_balance=int(rng.uniform(0, 0.5) * monthly),
        obligations=obligations,
        closed_on=(start + int(rng.integers(60, max(61, ORD_END - start)))) if rng.random() < 0.012 else None,
        label=f"Customer {cid}",
        holdout=bool(population == "app" and rng.random() < 0.05),
        aware=bool(rng.random() < 0.7),
    )


# ---------------------------------------------------------------------------
# The day-by-day simulation
# ---------------------------------------------------------------------------


def downtimes() -> dict[str, set[int]]:
    """About eight one- or two-day windows per bank per year."""
    rng = np.random.default_rng([C.SEED, 99])
    out: dict[str, set[int]] = {}
    for bank in C.BANKS:
        days: set[int] = set()
        n = int(rng.poisson(8 * (ORD_END - ORD_START) / 365))
        for _ in range(n):
            o = int(rng.integers(ORD_START, ORD_END + 1))
            if o == DEMO_ORD:
                continue  # keeps the demo's catch-all case free of downtime
            days.add(o)
            if rng.random() < 0.3:
                days.add(o + 1)
        out[bank] = days
    return out


def _mandate_timeline(rng, p: Profile, ob: Obligation):
    """Status changes as (from ord, status), in order."""
    changes = [(ob.start, "active")]
    if ob.oid in p.cancel_on:
        changes.append((p.cancel_on[ob.oid], "cancelled"))
        return changes
    o = ob.start + 30
    while o <= ORD_END:
        if rng.random() < p.p_cancel:
            at = o + int(rng.integers(0, 30))
            changes.append((at, "cancelled"))
            if rng.random() < 0.7:
                back = at + int(rng.integers(15, 61))
                changes.append((back, "active"))
                o = back + 30
                continue
            break
        if rng.random() < p.p_pause:
            at = o + int(rng.integers(0, 30))
            changes.append((at, "paused"))
            back = at + int(rng.integers(10, 31))
            changes.append((back, "active"))
            o = back + 30
            continue
        o += 30
    return changes


def _status_at(timeline, o: int) -> str:
    status = "active"
    for at, s in timeline:
        if at <= o:
            status = s
    return status


def simulate(p: Profile, down: dict[str, set[int]]):
    rng = np.random.default_rng([C.SEED, 3, zlib.crc32(p.cid.encode()), p.draw])
    tx = {c: [] for c in TXN_COLUMNS}
    seq = [0]

    def record(o, amount, direction, kind, merchant, own, status, reason=None, text=None, source=None, oid=None, cyc=None, k=None):
        seq[0] += 1
        for col, v in zip(TXN_COLUMNS, (p.cid, o, seq[0], amount, direction, kind, merchant, own, status, reason, text, source, oid, cyc, k)):
            tx[col].append(v)

    income_on: dict[int, list] = {}
    for o, a, s in p.income:
        income_on.setdefault(o, []).append((a, s))
    timelines = {ob.oid: _mandate_timeline(rng, p, ob) for ob in p.obligations}
    reregistrations = {ob.oid: [at for at, s in timelines[ob.oid][1:] if s == "active"] for ob in p.obligations}

    due_on: dict[int, list] = {}
    for ob in p.obligations:
        for y, m in _months(ob.start, ORD_END):
            o = date(y, m, min(ob.due_day, calendar.monthrange(y, m)[1])).toordinal()
            if o >= ob.start:
                due_on.setdefault(o, []).append(ob)
    test_debits: dict[int, list] = {}
    for ob in p.obligations:
        test_debits.setdefault(ob.start - int(rng.integers(1, 5)), []).append(ob)
        for at in reregistrations[ob.oid]:
            test_debits.setdefault(at, []).append(ob)

    planned: dict[int, list] = {}
    balance = p.opening_balance
    reserved = 0
    open_cycles: list[dict] = []
    cycles: list[dict] = []
    attempts: list[dict] = []
    cl = _cycle_len(p.archetype)

    due_ords = sorted(due_on)

    def plan_spending(o, amount):
        budget = p.r * (amount + max(0, balance - p.buffer)) * float(np.clip(rng.normal(1, 0.04), 0.9, 1.12))
        if p.aware:
            budget -= sum(ob.amount for d in due_ords if o <= d < o + cl for ob in due_on[d])
        budget = max(0.0, budget)
        bills = budget * p.bills_share
        for share in rng.dirichlet([2.0] * p.n_bills):
            planned.setdefault(o + int(rng.choice([0, 1, 2], p=[0.5, 0.35, 0.15])), []).append(_rupees(bills * share / 100))
        for share in rng.dirichlet([1.5] * p.n_disc):
            off = min(int(rng.exponential(p.tau)), cl - 1)
            planned.setdefault(o + off, []).append(_rupees((budget - bills) * share / 100))

    for o in range(p.start, ORD_END + 1):
        # 1. Income, then refunds.
        for a, s in income_on.get(o, []):
            plan_spending(o, a)
            balance += a
            if p.visible:
                record(o, a, "credit", "credit", None, False, "success", source=s)
        if rng.random() < 0.006:
            a = _rupees(rng.uniform(100, 1500))
            balance += a
            record(o, a, "credit", "refund", None, False, "success", source="refund")

        # 2. Recurring debits. A cycle is funded on the first day the balance covers it.
        for ob in due_on.get(o, []):
            cyc = {
                "oid": ob.oid, "segment": ob.segment, "amount": ob.amount, "due": o, "funded": None,
                "paid_day": None, "paid_via": None, "lag": int(rng.choice([0, 1, 2], p=[0.6, 0.25, 0.15])),
                "link_from": None, "fails": [], "day0": None, "retries": list(C.BASELINE_RETRY_DAYS[ob.segment]),
            }
            open_cycles.append(cyc)
            cycles.append(cyc)
        for cyc in open_cycles:
            if cyc["funded"] is None and balance - reserved >= cyc["amount"]:
                cyc["funded"] = o - cyc["due"]
                reserved += cyc["amount"]
        for cyc in list(open_cycles):
            k = o - cyc["due"]
            if k != 0 and k not in cyc["retries"]:
                continue
            seg = cyc["segment"]
            merchant = C.LENDER_ID if seg == "lending" else C.INSURER_ID
            kind = "emi" if seg == "lending" else "premium"
            mandate = _status_at(timelines[cyc["oid"]], o)
            downtime = o in down[p.bank]
            if p.closed_on is not None and o >= p.closed_on:
                cause = "instrument_closed"
            elif mandate in ("cancelled", "paused"):
                cause = f"mandate_{mandate}"
            elif downtime:
                cause = "bank_downtime"
            elif cyc["funded"] is not None:
                cause = None
            else:
                cause = "balance"
            info = {"oid": cyc["oid"], "segment": seg, "due": cyc["due"], "ord": o, "k": k, "mandate": mandate,
                    "downtime": downtime, "cause": cause, "customer_id": p.cid, "bank": p.bank}
            if cause is None:
                balance -= cyc["amount"]
                reserved -= cyc["amount"]
                cyc["paid_day"], cyc["paid_via"] = k, "debit"
                record(o, cyc["amount"], "debit", kind, merchant, True, "success", oid=cyc["oid"], cyc=cyc["due"], k=k)
                open_cycles.remove(cyc)
                info.update(code=None, text=None)
            else:
                if o in p.forced_code and k == 0:
                    code, text, _ = p.forced_code[o]
                elif o not in p.plain_codes_on and rng.random() < p.p_catch_all:
                    code, text = str(rng.choice(C.CATCH_ALL_CODES)), str(rng.choice(CATCH_ALL_TEXT[cause]))
                else:
                    code, text = CLEAR_CODE[cause], CLEAR_TEXT[CLEAR_CODE[cause]]
                record(o, cyc["amount"], "debit", kind, merchant, False, "failed", code, text, oid=cyc["oid"], cyc=cyc["due"], k=k)
                cyc["fails"].append((k, code, cause))
                info.update(code=code, text=text)
                if cause in ("instrument_closed", "mandate_cancelled"):
                    cyc["retries"] = []  # Razorpay stops retrying a dead mandate
                last = max(cyc["retries"], default=0)
                if k >= last:
                    cyc["link_from"] = k + C.RESULT_DELAY[C.RAIL[seg]] + 1
            if k == 0:
                cyc["day0"] = info
            attempts.append(info)

        # 3. A payment link, paid once the customer is funded (plus a short lag).
        for cyc in list(open_cycles):
            k = o - cyc["due"]
            if cyc["link_from"] is not None and cyc["funded"] is not None and k >= max(cyc["link_from"], cyc["funded"] + cyc["lag"]):
                seg = cyc["segment"]
                balance -= cyc["amount"]
                reserved -= cyc["amount"]
                cyc["paid_day"], cyc["paid_via"] = k, "link"
                record(o, cyc["amount"], "debit", "emi_link" if seg == "lending" else "premium_link",
                       C.LENDER_ID if seg == "lending" else C.INSURER_ID, True, "success", oid=cyc["oid"], cyc=cyc["due"], k=k)
                open_cycles.remove(cyc)
            elif k >= C.HORIZON:
                if cyc["funded"] is not None:
                    reserved -= cyc["amount"]
                open_cycles.remove(cyc)

        # 4. Re 1 mandate test debits, then everyday payments when the balance allows.
        for ob in test_debits.get(o, []):
            record(o, 100, "debit", "mandate_test", C.LENDER_ID if ob.segment == "lending" else C.INSURER_ID, False, "success")
            balance -= 100
        for amount in planned.pop(o, []):
            if amount <= 0:
                continue
            if amount <= balance - reserved:
                balance -= amount
                record(o, amount, "debit", "payment", None, False, "success")
            elif rng.random() < 0.3:
                record(o, amount, "debit", "payment", None, False, "failed", "insufficient_funds", CLEAR_TEXT["insufficient_funds"])

    for cyc in cycles:
        cyc["customer_id"] = p.cid
        cyc["mandate_timeline"] = timelines[cyc["oid"]]
    return pd.DataFrame(tx), cycles, attempts


# ---------------------------------------------------------------------------
# Seeded demo cases (specs/05). Drawn from their archetype until the rule and the truth
# give the scripted days, so each case plays exactly as the spec says.
# ---------------------------------------------------------------------------

SEEDED = [
    # id, customer, segment, payday, April payday, visible source, salary, wanted rule h, wanted truth T
    dict(oid="L-1040", name="Arjun Pillai", segment="lending", payday=1, april=1, src=None, salary=70_000, h=None, T=0, comfortable=True),
    dict(oid="L-1041", name="Asha Verma", segment="lending", payday=7, april=7, src=None, salary=58_000, h=5, T=5),
    dict(oid="L-1042", name="Rohan Mehta", segment="lending", payday=8, april=9, src="payroll-source-17", salary=62_000, h=6, T=7),
    dict(oid="L-1043", name="Karan Joshi", segment="lending", payday=11, april=11, src=None, salary=55_000, h=9, T=9),
    dict(oid="L-1044", name="Imran Sheikh", segment="lending", payday=22, april=22, src=None, salary=52_000, h=20, T=20),
    dict(oid="L-1045", name="Neha Kulkarni", segment="lending", payday=6, april=6, src=None, salary=45_000, h=None, T=4, thin=True),
    dict(oid="L-1046", name="Vikram Nair", segment="lending", payday=7, april=7, src=None, salary=60_000, h=5, T=5, cancel=True),
    dict(oid="L-1047", name="Sunita Rao", segment="lending", payday=7, april=7, src=None, salary=57_000, h=5, T=5, catch_all=True),
    dict(oid="I-2011", name="Priya Raman", segment="insurance", payday=11, april=11, src=None, salary=40_000, h=9, T=9),
    dict(oid="I-2012", name="Dev Malhotra", segment="insurance", payday=11, april=11, src="payroll-source-08", salary=48_000, h=9, T=9),
]
SEEDED_AMOUNT = {"lending": 12_000_00, "insurance": 2_500_00}


def seeded_profile(spec: dict, attempt: int, index: int) -> Profile:
    rng = np.random.default_rng([C.SEED, 4, index, attempt])
    cid = f"C-S{index + 1:02d}"
    thin = spec.get("thin", False)
    start = date(2026, 2, 1).toordinal() if thin else ORD_START
    monthly = spec["salary"] * 100
    overrides = {(2026, 4): date(2026, 4, spec["april"])}
    income = _income(rng, "salaried_fixed", start, spec["payday"], monthly, overrides=overrides, weekend=False, delay_p=0.08)
    if spec["src"]:
        income = [(o, a, spec["src"]) for o, a, _ in income]
    amount = SEEDED_AMOUNT[spec["segment"]]
    ob = Obligation(spec["oid"], spec["segment"], amount, 2, start + 5)
    p = Profile(
        cid=cid, population="app", archetype="new_thin" if thin else "salaried_fixed", bank=str(rng.choice(C.BANKS)),
        start=start, income=income, visible=spec["src"] is not None,
        r=float(rng.uniform(0.95, 1.0)), buffer=int(amount * (2.5 if spec.get("comfortable") else 0.05)),
        bills_share=float(rng.uniform(0.45, 0.55)), n_bills=4, n_disc=int(rng.integers(5, 8)), tau=float(rng.uniform(1.0, 1.6)),
        opening_balance=0, obligations=[ob], p_catch_all=0.0, p_cancel=0.0, p_pause=0.0, closed_on=None,
        label=spec["name"], holdout=False, seeded=True, plain_codes_on={DEMO_ORD}, draw=attempt,
    )
    if spec.get("cancel"):
        p.cancel_on = {ob.oid: date(2026, 3, 24).toordinal()}
    if spec.get("catch_all"):
        p.forced_code = {DEMO_ORD: ("payment_failed", "TXN DECLINED - REFER TO BANK", "balance")}
    return p


def rule_inputs(tx: pd.DataFrame, merchant_id: str):
    """The engine inputs a server function would build from the transactions table."""
    ok = tx[(tx.direction == "debit") & (tx.status == "success")]
    own = ok.own_merchant.astype(bool).to_numpy() & (ok.merchant_id == merchant_id).to_numpy()
    cr = tx[tx.direction == "credit"]
    return (
        ok.ord.to_numpy(np.int64), ok.amount_paise.to_numpy(np.int64), own,
        cr.ord.to_numpy(np.int64), cr.amount_paise.to_numpy(np.int64), cr.source.tolist(),
    )


def has_failure_evidence(tx: pd.DataFrame, asof: int) -> bool:
    frm = rule.add_months(asof, -C.LOOKBACK_MONTHS)
    f = tx[(tx.status == "failed") & (tx.reason_code == "insufficient_funds") & (tx.ord < asof) & (tx.ord >= frm)]
    return len(f) > 0


def _seeded_ok(spec, p, tx, cycles) -> bool:
    cyc = next(c for c in cycles if c["due"] == DEMO_ORD)
    if cyc["funded"] != spec["T"]:
        return False
    if spec["T"] == 0:
        return cyc["paid_day"] == 0
    seg = spec["segment"]
    merchant = C.LENDER_ID if seg == "lending" else C.INSURER_ID
    hist = tx[tx.ord < DEMO_ORD]
    est = rule.estimate(DEMO_ORD, seg, p.obligations[0].amount, *rule_inputs(hist, merchant))
    if spec.get("thin"):
        return est is None or rule.gate(est["timing"], est["months"], has_failure_evidence(hist, DEMO_ORD))[0] == "C"
    if est is None or not est["ok"] or est["h"] != spec["h"]:
        return False
    if est["salary"] != (spec["src"] is not None):
        return False
    if rule.gate(est["timing"], est["months"], has_failure_evidence(hist, DEMO_ORD))[0] != "A":
        return False
    return True


def build_seeded(down):
    out = []
    for i, spec in enumerate(SEEDED):
        for attempt in range(500):
            p = seeded_profile(spec, attempt, i)
            tx, cycles, attempts = simulate(p, down)
            if _seeded_ok(spec, p, tx, cycles):
                out.append((p, tx, cycles, attempts, attempt))
                break
        else:
            raise RuntimeError(f"no draw gives the scripted days for {spec['oid']}")
    return out


# ---------------------------------------------------------------------------


def _run_chunk(args):
    population, indices = args
    down = downtimes()
    frames, cycles, attempts, profiles = [], [], [], []
    for i in indices:
        p = random_profile(population, i)
        tx, cy, at = simulate(p, down)
        frames.append(tx)
        cycles += cy
        attempts += at
        profiles.append(p)
    return pd.concat(frames, ignore_index=True), cycles, attempts, profiles


def _population(population: str, n: int, start_index: int = 0):
    idx = list(range(start_index, start_index + n))
    chunks = [(population, idx[i::16]) for i in range(16)]
    with Pool(8) as pool:
        parts = pool.map(_run_chunk, chunks)
    tx = pd.concat([p[0] for p in parts], ignore_index=True)
    cycles = [c for p in parts for c in p[1]]
    attempts = [a for p in parts for a in p[2]]
    profiles = sorted([pr for p in parts for pr in p[3]], key=lambda pr: pr.cid)
    return tx, cycles, attempts, profiles


def _finish(tx: pd.DataFrame) -> pd.DataFrame:
    return tx.sort_values(["customer_id", "ord", "seq"], kind="stable").reset_index(drop=True)


def main():
    C.WORK_DIR.mkdir(exist_ok=True)
    down = downtimes()

    print(f"Generating {C.TRAIN_CUSTOMERS} training customers ...")
    tx, cycles, attempts, profiles = _population("train", C.TRAIN_CUSTOMERS)
    with open(C.WORK_DIR / "train.pkl", "wb") as f:
        pickle.dump({"tx": _finish(tx), "cycles": cycles, "attempts": attempts, "profiles": profiles}, f)
    print(f"  {len(tx):,} transactions, {len(cycles):,} debit cycles")

    n_random = C.APP_CUSTOMERS - len(SEEDED)
    print(f"Generating {n_random} app customers and the {len(SEEDED)} seeded cases ...")
    tx, cycles, attempts, profiles = _population("app", n_random)
    seeded = build_seeded(down)
    for p, stx, scy, sat, attempt in seeded:
        print(f"  {p.obligations[0].oid}: scripted days on draw {attempt}")
    tx = pd.concat([tx] + [s[1] for s in seeded], ignore_index=True)
    cycles += [c for s in seeded for c in s[2]]
    attempts += [a for s in seeded for a in s[3]]
    profiles += [s[0] for s in seeded]
    with open(C.WORK_DIR / "app.pkl", "wb") as f:
        pickle.dump({"tx": _finish(tx), "cycles": cycles, "attempts": attempts, "profiles": profiles}, f)
    with open(C.WORK_DIR / "downtimes.pkl", "wb") as f:
        pickle.dump(down, f)
    print(f"  {len(tx):,} transactions")
