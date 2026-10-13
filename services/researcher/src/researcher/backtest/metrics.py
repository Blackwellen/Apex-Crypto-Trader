"""Performance metrics from integer equity curves (floats only for ratios, never for money)."""
from __future__ import annotations

import math

import numpy as np


def returns_from_equity(equity: list[int] | np.ndarray) -> np.ndarray:
    e = np.asarray(equity, dtype=np.float64)       # ratio math only; the equity ints are the source of truth
    return e[1:] / e[:-1] - 1.0


def max_drawdown(equity: list[int] | np.ndarray) -> float:
    e = np.asarray(equity, dtype=np.float64)
    peak = np.maximum.accumulate(e)
    return float(np.min(e / peak - 1.0)) if len(e) else 0.0


def sharpe(r: np.ndarray, bars_per_year: float) -> float:
    sd = r.std(ddof=1) if len(r) > 2 else 0.0
    return float(r.mean() / sd * math.sqrt(bars_per_year)) if sd > 0 else 0.0


def sortino(r: np.ndarray, bars_per_year: float) -> float:
    d = r[r < 0]
    dd = math.sqrt((d ** 2).sum() / max(len(r), 1)) if len(d) else 0.0
    return float(r.mean() / dd * math.sqrt(bars_per_year)) if dd > 0 else 0.0


def cagr(equity, bars_per_year: float) -> float:
    e0, e1 = float(equity[0]), float(equity[-1])
    n = len(equity) - 1
    if n <= 0 or e0 <= 0 or e1 <= 0:
        return -1.0 if e1 <= 0 else 0.0
    return (e1 / e0) ** (bars_per_year / n) - 1.0


def summarize(equity, bars_per_year: float) -> dict:
    r = returns_from_equity(equity)
    mdd = max_drawdown(equity)
    c = cagr(equity, bars_per_year)
    return {
        "total_return": float(equity[-1] / equity[0] - 1.0),
        "cagr": c,
        "ann_vol": float(r.std(ddof=1) * math.sqrt(bars_per_year)) if len(r) > 2 else 0.0,
        "sharpe": sharpe(r, bars_per_year),
        "sortino": sortino(r, bars_per_year),
        "max_drawdown": mdd,
        "calmar": float(c / abs(mdd)) if mdd < 0 else 0.0,
        "n_bars": int(len(equity) - 1),
    }
