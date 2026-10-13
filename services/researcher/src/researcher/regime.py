"""Causal market-regime classifier (rule based, deterministic).

Computed on a market index (equal-weight of alive MAJOR assets). Every threshold uses only rolling windows, so the
label at bar t depends on data <= t (checked by the no-lookahead validator in tests).
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum

import numpy as np

from . import features as F


class Regime(IntEnum):
    WARMUP = 0
    TREND_UP = 1
    TREND_DOWN = 2
    RANGE = 3
    HIGH_VOL = 4
    CRASH = 5


@dataclass(frozen=True)
class RegimeParams:
    er_window: int = 48
    er_trend: float = 0.28
    vol_window: int = 48
    vol_ref_window: int = 500
    high_vol_ratio: float = 1.9
    crash_window: int = 24
    crash_return: float = -0.12
    dd_window: int = 240
    crash_dd: float = -0.30


def market_index(close: np.ndarray, alive: np.ndarray, major_mask: np.ndarray) -> np.ndarray:
    """equal-weight log-return index over alive majors (cumulative, starts at 1.0). Causal."""
    r = F.log_returns(close)
    ok = (alive & np.roll(alive, 1, axis=0)) & major_mask[None, :]
    ok[0] = False
    n = ok.sum(axis=1)
    mr = np.where(n > 0, (r * ok).sum(axis=1) / np.maximum(n, 1), 0.0)
    return np.exp(np.cumsum(mr))


def classify(index: np.ndarray, p: RegimeParams | None = None) -> np.ndarray:
    """index: (T,) market index level. returns (T,) int Regime values."""
    p = p or RegimeParams()
    x = index.reshape(-1, 1)
    er = F.efficiency_ratio(x, p.er_window)[:, 0]
    rv = F.realized_vol(x, p.vol_window)[:, 0]
    ref = F.rolling_mean(rv.reshape(-1, 1), p.vol_ref_window)[:, 0]    # long-run average vol (causal)
    ret = F.roc(x, p.er_window)[:, 0]
    crash_ret = F.roc(x, p.crash_window)[:, 0]
    dd = (x / F.rolling_max(x, p.dd_window) - 1.0)[:, 0]
    out = np.full(len(index), int(Regime.WARMUP), dtype=np.int64)
    valid = ~(np.isnan(er) | np.isnan(rv) | np.isnan(ref) | np.isnan(dd) | np.isnan(crash_ret) | np.isnan(ret))
    with np.errstate(invalid="ignore"):
        crash = valid & ((crash_ret < p.crash_return) | (dd < p.crash_dd))
        hv = valid & ~crash & (rv > p.high_vol_ratio * ref)
        up = valid & ~crash & ~hv & (er > p.er_trend) & (ret > 0)
        dn = valid & ~crash & ~hv & (er > p.er_trend) & (ret <= 0)
        rg = valid & ~crash & ~hv & ~up & ~dn
    out[rg] = Regime.RANGE
    out[up] = Regime.TREND_UP
    out[dn] = Regime.TREND_DOWN
    out[hv] = Regime.HIGH_VOL
    out[crash] = Regime.CRASH
    return out


def regime_from_panel(panel, p: RegimeParams | None = None) -> np.ndarray:
    major = np.array([panel.meta.get(a).kind == "major" if a in panel.meta else True for a in panel.assets])
    return classify(market_index(panel.close, panel.alive, major), p)
