"""Step 3: train XGBoost AFT and XGBoost quantile on the time split, and keep the better one.

Train on failures due in months 13 to 18, tune on 19 to 21. The test months (22 to 24) are not
touched here. Both models output a likelihood by day: the chance the customer is funded by
day k after the due date, for k = 0 to 30.

  AFT       learns from the bounds: funded after the last failed attempt and by the first
            successful day, or "later than the window" when nothing was collected.
  Quantile  learns 19 quantiles (5% to 95%) of the first successful day. An uncollected cycle
            counts as day 31.

Choice (on the tune months, never the test months): the model with the lower day error and the
80% range coverage closer to 80%. When the two disagree, the lower day error wins.
The chosen model's likelihoods are then calibrated on the tune months with isotonic regression.
"""

from __future__ import annotations

import pickle

import numpy as np
import pandas as pd
import xgboost as xgb
from scipy.stats import norm
from sklearn.isotonic import IsotonicRegression

from . import config as C
from .features import feature_columns

DAYS = np.arange(C.HORIZON + 1)
ALPHAS = np.round(np.arange(0.05, 1.0, 0.05), 2)
BASE = dict(tree_method="hist", learning_rate=0.05, max_depth=5, min_child_weight=10, subsample=0.8,
            colsample_bytree=0.8, seed=C.SEED, nthread=8)


def split(events: pd.DataFrame):
    return (
        events[events.month.isin(C.TRAIN_MONTHS)],
        events[events.month.isin(C.TUNE_MONTHS)],
        events[events.month.isin(C.TEST_MONTHS)],
    )


# ---------------------------------------------------------------------------
# AFT
# ---------------------------------------------------------------------------


def _aft_matrix(df: pd.DataFrame, cols) -> xgb.DMatrix:
    d = xgb.DMatrix(df[cols].astype(float))
    # Funded day T is a whole day: lower < T <= upper. On a continuous clock, lower + 0.5 < t <= upper + 0.5.
    d.set_float_info("label_lower_bound", (df.lower + 0.5).to_numpy(float))
    d.set_float_info("label_upper_bound", (df.upper + 0.5).to_numpy(float))
    return d


def _aft_cdf_z(z: np.ndarray, dist: str) -> np.ndarray:
    if dist == "normal":
        return norm.cdf(z)
    if dist == "logistic":
        return 1 / (1 + np.exp(-z))
    return 1 - np.exp(-np.exp(np.clip(z, -50, 50)))  # extreme value, as in XGBoost


def aft_cdf(model: dict, df: pd.DataFrame) -> np.ndarray:
    mu = model["booster"].predict(xgb.DMatrix(df[model["cols"]].astype(float)), output_margin=True,
                                  iteration_range=(0, model["booster"].best_iteration + 1))
    z = (np.log(DAYS[None, :] + 0.5) - mu[:, None]) / model["scale"]
    return _aft_cdf_z(z, model["dist"])


def train_aft(tr, tu, cols):
    dtr, dtu = _aft_matrix(tr, cols), _aft_matrix(tu, cols)
    best = None
    for dist in ("normal", "logistic", "extreme"):
        for scale in (0.1, 0.2, 0.3, 0.5, 0.8):
            params = dict(BASE, objective="survival:aft", eval_metric="aft-nloglik",
                          aft_loss_distribution=dist, aft_loss_distribution_scale=scale)
            booster = xgb.train(params, dtr, 3000, evals=[(dtu, "tune")], early_stopping_rounds=100, verbose_eval=False)
            score = booster.best_score
            print(f"  AFT {dist:8s} scale {scale:.1f}: tune neg. log-likelihood {score:.4f} ({booster.best_iteration + 1} trees)")
            if best is None or score < best["score"]:
                best = {"booster": booster, "dist": dist, "scale": scale, "score": score, "cols": cols}
    print(f"  AFT chosen: {best['dist']}, scale {best['scale']}")
    return best


# ---------------------------------------------------------------------------
# Quantile
# ---------------------------------------------------------------------------


def _first_success(df: pd.DataFrame) -> np.ndarray:
    return np.where(np.isinf(df.upper), C.HORIZON + 1, df.upper).astype(float)


def train_quantile(tr, tu, cols):
    dtr = xgb.QuantileDMatrix(tr[cols].astype(float), _first_success(tr))
    dtu = xgb.QuantileDMatrix(tu[cols].astype(float), _first_success(tu), ref=dtr)
    params = dict(BASE, objective="reg:quantileerror", quantile_alpha=ALPHAS)
    booster = xgb.train(params, dtr, 3000, evals=[(dtu, "tune")], early_stopping_rounds=100, verbose_eval=False)
    print(f"  Quantile: tune quantile loss {booster.best_score:.4f} ({booster.best_iteration + 1} trees)")
    return {"booster": booster, "cols": cols}


def quantile_cdf(model: dict, df: pd.DataFrame) -> np.ndarray:
    q = model["booster"].predict(xgb.DMatrix(df[model["cols"]].astype(float)),
                                 iteration_range=(0, model["booster"].best_iteration + 1))
    q = np.sort(q, axis=1)  # quantiles can cross; sorting restores order
    return np.vstack([np.interp(DAYS + 0.5, row, ALPHAS, left=0.0, right=1.0) for row in q])


# ---------------------------------------------------------------------------
# Shared read-outs of a likelihood curve
# ---------------------------------------------------------------------------


def first_day(cdf: np.ndarray, share: float) -> np.ndarray:
    """First day with likelihood at least `share`, or 31 when the curve never gets there."""
    hit = cdf >= share
    return np.where(hit.any(axis=1), hit.argmax(axis=1), C.HORIZON + 1)


def point_h(cdf: np.ndarray) -> np.ndarray:
    return np.minimum(first_day(cdf, 0.5), C.HORIZON)


def day_error(h: np.ndarray, T: np.ndarray) -> float:
    return float(np.mean(np.abs(h - T)))


def coverage80(cdf: np.ndarray, T: np.ndarray) -> float:
    lo, hi = first_day(cdf, 0.1), first_day(cdf, 0.9)
    return float(np.mean((T >= lo) & (T <= hi)))


def fit_calibration(cdf: np.ndarray, T: np.ndarray) -> IsotonicRegression:
    y = (T[:, None] <= DAYS[None, :]).astype(float)
    iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip")
    iso.fit(cdf.ravel(), y.ravel())
    return iso


def calibrate(iso: IsotonicRegression, cdf: np.ndarray) -> np.ndarray:
    out = iso.predict(cdf.ravel()).reshape(cdf.shape)
    return np.maximum.accumulate(out, axis=1)  # a likelihood by day never falls


def main():
    events = pd.read_pickle(C.WORK_DIR / "events.pkl")
    cols = feature_columns(events)
    tr, tu, _ = split(events)
    print(f"Train rows {len(tr):,} (months 13-18), tune rows {len(tu):,} (months 19-21). Features: {len(cols)}")
    print(f"Open-ended (nothing collected within 30 days): train {np.isinf(tr.upper).mean():.0%}")

    aft = train_aft(tr, tu, cols)
    quant = train_quantile(tr, tu, cols)

    T = tu["T"].to_numpy()
    tune = {}
    for name, cdf in (("aft", aft_cdf(aft, tu)), ("quantile", quantile_cdf(quant, tu))):
        tune[name] = {"day_error": day_error(point_h(cdf), T), "coverage80": coverage80(cdf, T)}
        print(f"  tune {name:8s}: day error {tune[name]['day_error']:.2f}, 80% range coverage {tune[name]['coverage80']:.1%}")

    a, q = tune["aft"], tune["quantile"]
    lower_error = "aft" if a["day_error"] <= q["day_error"] else "quantile"
    closer = "aft" if abs(a["coverage80"] - 0.8) <= abs(q["coverage80"] - 0.8) else "quantile"
    chosen = lower_error
    note = "both measures agree" if lower_error == closer else f"day error favours {lower_error}, coverage favours {closer}; day error wins"
    print(f"  chosen: {chosen} ({note})")

    model = aft if chosen == "aft" else quant
    raw_tune = aft_cdf(aft, tu) if chosen == "aft" else quantile_cdf(quant, tu)
    iso = fit_calibration(raw_tune, T)

    with open(C.WORK_DIR / "models.pkl", "wb") as f:
        pickle.dump({"aft": aft, "quantile": quant, "chosen": chosen, "choice_note": note, "tune": tune,
                     "calibration": iso, "cols": cols, "model": model}, f)
