"""Shared settings for the offline pipeline. Every number is a placeholder on synthetic data.

The policy numbers mirror lib/engine/policy.ts. The parity check (bridge.py and
tests/ml-export.test.ts) fails if the Python rule and the engine ever disagree.
"""

from __future__ import annotations

import re
from datetime import date
from pathlib import Path

SEED = 20260402

ML_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = ML_DIR.parent
WORK_DIR = ML_DIR / "work"
EXPORT_DIR = ML_DIR / "export"

# Month 1 is April 2024 and month 24 is March 2026. The demo cycle is April 2026 (month 25).
HISTORY_START = date(2024, 4, 1)
DEMO_DUE = date(2026, 4, 2)
SIM_END = date(2026, 5, 20)

TRAIN_CUSTOMERS = 5000
APP_CUSTOMERS = 200  # including the ten seeded cases

# Time split by the month of the due date.
TRAIN_MONTHS = range(13, 19)
TUNE_MONTHS = range(19, 22)
TEST_MONTHS = range(22, 25)
HISTORY_MONTHS = (23, 24)  # February and March 2026: the app's replayed history (specs/00 "Replayed history")

HORIZON = 30  # likelihood by day covers days 0 to 30

# --- mirrors lib/engine/policy.ts ---------------------------------------------
CIRCLE = 31
GATE_MIN_OBS = 25
GATE_MIN_MONTHS = 3
LOOKBACK_MONTHS = 12
AFFORD_SHARE = 0.5
AFFORD_MIN = 3
AFFORD_DEDUCTION = 10
DRIFT_RECENT_MONTHS = 3
DRIFT_MIN_RECENT = 6
DRIFT_MAX_DAYS = 3
DRIFT_DEDUCTION = 10
WITHIN_DAYS = 2
FLOOR = {"lending": 80, "insurance": 70}
UPPER_SHARE = 0.85
BANDS = {"high": 0.8, "medium": 0.6}
RESULT_DELAY = {"bank_mandate": 2, "upi_autopay": 0}
BASELINE_RETRY_DAYS = {"lending": [3, 6, 9], "insurance": [1, 2, 3]}
LIMITS = {
    "lending": {"lastAllowedDay": 10, "maxRepresentations": 2},
    "insurance": {"lastAllowedDay": 12, "maxRepresentations": 3},
}
SALARY_MIN_MONTHS = 3
SALARY_AMOUNT_TOL = 0.1
SALARY_DATE_TOL = 3

RAIL = {"lending": "bank_mandate", "insurance": "upi_autopay"}

# --- merchants and products (synthetic) ---------------------------------------
LENDER_ID = "m-northfield"
INSURER_ID = "m-harbour"
LOAN_PRODUCT_ID = "p-northfield-personal-loan"
POLICY_PRODUCT_ID = "p-harbour-term-plan"
GRACE_DAYS = 15

BANKS = ["BANK-01", "BANK-02", "BANK-03", "BANK-04", "BANK-05", "BANK-06"]

CATCH_ALL_CODES = ["payment_failed", "bank_declined", "transaction_declined"]


def policy_version() -> str:
    text = (REPO_DIR / "lib" / "engine" / "policy.ts").read_text()
    m = re.search(r'POLICY_VERSION\s*=\s*"([^"]+)"', text)
    return m.group(1) if m else "unknown"


def month_no(d: date) -> int:
    """1 for April 2024, 24 for March 2026, 25 for April 2026."""
    return (d.year - 2024) * 12 + d.month - 4 + 1
