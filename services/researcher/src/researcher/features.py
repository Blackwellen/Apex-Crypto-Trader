"""Causal feature primitives. Every function maps (T,N) -> (T,N) and value[t] depends ONLY on rows <= t.

Warm-up rows are NaN. Nothing here uses centred windows, negative shifts, or whole-array statistics.
"""
from __future__ import annotations

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view


def _nan_like(x: np.ndarray) -> np.ndarray:
    return np.full(x.shape, np.nan)


def lag(x: np.ndarray, k: int = 1) -> np.ndarray:
    if k < 0:
        raise ValueError("negative lag is lookahead")
    out = _nan_like(x)
    if k < len(x):
        out[k:] = x[:len(x) - k]
    return out


def rolling_mean(x: np.ndarray, w: int) -> np.ndarray:
    """NaN-safe: a window containing any NaN yields NaN (so warm-up NaNs never poison later rows)."""
    out = _nan_like(x)
    if len(x) >= w:
        ok = np.isfinite(x)
        z = np.where(ok, x, 0.0)
        zero = np.zeros((1,) + x.shape[1:])
        cs = np.cumsum(np.concatenate([zero, z], axis=0), axis=0)
        cn = np.cumsum(np.concatenate([zero, ok.astype(float)], axis=0), axis=0)
        full = (cn[w:] - cn[:-w]) > w - 0.5
        out[w - 1:] = np.where(full, (cs[w:] - cs[:-w]) / w, np.nan)
    return out


def rolling_std(x: np.ndarray, w: int, ddof: int = 1) -> np.ndarray:
    out = _nan_like(x)
    if len(x) >= w:
        win = sliding_window_view(x, w, axis=0)           # (T-w+1, ..., w)
        out[w - 1:] = win.std(axis=-1, ddof=ddof)
    return out


def rolling_max(x: np.ndarray, w: int) -> np.ndarray:
    out = _nan_like(x)
    if len(x) >= w:
        out[w - 1:] = sliding_window_view(x, w, axis=0).max(axis=-1)
    return out


def rolling_min(x: np.ndarray, w: int) -> np.ndarray:
    out = _nan_like(x)
    if len(x) >= w:
        out[w - 1:] = sliding_window_view(x, w, axis=0).min(axis=-1)
    return out


def rolling_median(x: np.ndarray, w: int) -> np.ndarray:
    out = _nan_like(x)
    if len(x) >= w:
        out[w - 1:] = np.nanmedian(sliding_window_view(x, w, axis=0), axis=-1)
    return out


def ema(x: np.ndarray, span: int) -> np.ndarray:
    a = 2.0 / (span + 1.0)
    out = np.empty_like(x, dtype=float)
    out[0] = x[0]
    for t in range(1, len(x)):
        out[t] = a * x[t] + (1 - a) * out[t - 1]
    out[: span - 1] = np.nan
    return out


def log_returns(close: np.ndarray) -> np.ndarray:
    r = np.zeros_like(close, dtype=float)
    r[1:] = np.log(close[1:] / close[:-1])
    return r


def roc(close: np.ndarray, k: int) -> np.ndarray:
    return close / lag(close, k) - 1.0


def true_range(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    pc = lag(close, 1)
    pc[0] = close[0]
    return np.maximum(high - low, np.maximum(np.abs(high - pc), np.abs(low - pc)))


def atr(high, low, close, w: int) -> np.ndarray:
    return rolling_mean(true_range(high, low, close), w)


def realized_vol(close: np.ndarray, w: int) -> np.ndarray:
    return rolling_std(log_returns(close), w)


def prior_high(high: np.ndarray, w: int) -> np.ndarray:
    """highest high of the PREVIOUS w bars (excludes the current bar)."""
    return lag(rolling_max(high, w), 1)


def prior_low(low: np.ndarray, w: int) -> np.ndarray:
    return lag(rolling_min(low, w), 1)


def zscore(x: np.ndarray, w: int) -> np.ndarray:
    sd = rolling_std(x, w)
    with np.errstate(divide="ignore", invalid="ignore"):
        return (x - rolling_mean(x, w)) / np.where(sd > 0, sd, np.nan)


def efficiency_ratio(close: np.ndarray, w: int) -> np.ndarray:
    net = np.abs(close - lag(close, w))
    path = rolling_mean(np.abs(np.diff(close, axis=0, prepend=close[:1])), w) * w
    with np.errstate(divide="ignore", invalid="ignore"):
        return net / np.where(path > 0, path, np.nan)


def rolling_beta(y: np.ndarray, x: np.ndarray, w: int) -> np.ndarray:
    """rolling OLS slope of y on x (1-D arrays), causal."""
    mx, my = rolling_mean(x, w), rolling_mean(y, w)
    cov = rolling_mean(x * y, w) - mx * my
    var = rolling_mean(x * x, w) - mx * mx
    with np.errstate(divide="ignore", invalid="ignore"):
        return cov / np.where(var > 1e-18, var, np.nan)


def age_since_listing(alive: np.ndarray) -> np.ndarray:
    """bars since the asset first became tradable (0 at the first alive bar), -1 while not alive.
    Causal: at bar t it uses only alive[:t+1] (the first alive index is <= t whenever alive[t] is True)."""
    T, N = alive.shape
    first = np.where(alive.any(axis=0), np.argmax(alive, axis=0), T)
    age = np.arange(T)[:, None] - first[None, :]
    return np.where(alive, age, -1).astype(np.int64)
