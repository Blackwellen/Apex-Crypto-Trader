"""Metric uncertainty: stationary block bootstrap CIs, Monte Carlo with stress, probabilistic/deflated Sharpe."""
from __future__ import annotations

import math
from typing import Callable

import numpy as np

from ..backtest.metrics import max_drawdown, sharpe


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def stationary_bootstrap_indices(n: int, mean_block: float, rng: np.random.Generator, size: int | None = None) -> np.ndarray:
    """Politis-Romano stationary bootstrap: geometric block lengths with mean `mean_block`, circular wrap."""
    size = size or n
    p = 1.0 / max(mean_block, 1.0)
    idx = np.empty(size, dtype=np.int64)
    idx[0] = rng.integers(n)
    jumps = rng.random(size) < p
    starts = rng.integers(n, size=size)
    for i in range(1, size):
        idx[i] = starts[i] if jumps[i] else (idx[i - 1] + 1) % n
    return idx


def _curve(r: np.ndarray) -> np.ndarray:
    return np.concatenate([[1.0], np.cumprod(1.0 + r)])


def bootstrap_metrics(returns: np.ndarray, bars_per_year: float, n_boot: int = 500, mean_block: float | None = None,
                      level: float = 0.90, seed: int = 11) -> dict:
    """Confidence intervals for Sharpe, CAGR, max drawdown, total return by block bootstrap of per-bar returns.

    Caveats stated in the output: assumes stationarity within the sample; intervals widen with short samples; says
    nothing about regimes absent from the sample."""
    r = np.asarray(returns, dtype=float)
    n = len(r)
    if n < 30:
        return {"status": "INSUFFICIENT_DATA", "n_obs": n, "level": level}
    rng = np.random.default_rng(seed)
    mb = mean_block or max(2.0, round(n ** (1 / 3)) * 4)
    def stats(x: np.ndarray) -> tuple[float, float, float, float]:
        c = _curve(x)
        years = len(x) / bars_per_year
        cagr = c[-1] ** (1 / years) - 1 if c[-1] > 0 else -1.0
        return sharpe(x, bars_per_year), cagr, max_drawdown(c), float(c[-1] - 1)
    pt = stats(r)
    draws = np.array([stats(r[stationary_bootstrap_indices(n, mb, rng)]) for _ in range(n_boot)])
    lo, hi = (1 - level) / 2, 1 - (1 - level) / 2
    names = ("sharpe", "cagr", "max_drawdown", "total_return")
    out = {nme: {"point": float(pt[i]), "ci_low": float(np.quantile(draws[:, i], lo)), "ci_high": float(np.quantile(draws[:, i], hi))}
           for i, nme in enumerate(names)}
    out["prob_sharpe_leq_0_bootstrap"] = float((draws[:, 0] <= 0).mean())
    out["method"] = {"type": "stationary block bootstrap", "n_boot": n_boot, "mean_block_bars": mb, "level": level, "seed": seed, "n_obs": n}
    out["psr_sharpe_gt_0"] = probabilistic_sharpe(r, 0.0)
    out["status"] = "OK"
    return out


def probabilistic_sharpe(r: np.ndarray, benchmark_sr_per_bar: float = 0.0) -> float:
    """Bailey & Lopez de Prado PSR: P(true per-bar SR > benchmark) given skew/kurtosis."""
    n = len(r)
    if n < 10 or r.std(ddof=1) == 0:
        return float("nan")
    sr = r.mean() / r.std(ddof=1)
    z = (r - r.mean()) / r.std(ddof=1)
    skew, kurt = float((z ** 3).mean()), float((z ** 4).mean())
    denom = math.sqrt(max(1e-12, 1 - skew * sr + (kurt - 1) / 4 * sr * sr))
    return _norm_cdf((sr - benchmark_sr_per_bar) * math.sqrt(n - 1) / denom)


def deflated_sharpe(r: np.ndarray, n_trials: int, sr_variance_across_trials: float = 0.0) -> float:
    """P(SR > expected max SR from n_trials of pure noise). Pass the number of configurations tried to avoid
    selection bias; n_trials=1 reduces to PSR vs 0."""
    if n_trials <= 1:
        return probabilistic_sharpe(r, 0.0)
    emc = 0.5772156649
    inv = lambda p: float(np.sqrt(2) * _erfinv(2 * p - 1))  # noqa: E731
    sd = math.sqrt(max(sr_variance_across_trials, 1e-12))
    exp_max = sd * ((1 - emc) * inv(1 - 1 / n_trials) + emc * inv(1 - 1 / (n_trials * math.e)))
    return probabilistic_sharpe(r, exp_max)


def _erfinv(y: float) -> float:
    a = 0.147
    ln = math.log(1 - y * y)
    t = 2 / (math.pi * a) + ln / 2
    return math.copysign(math.sqrt(math.sqrt(t * t - ln / a) - t), y)


SCENARIOS: dict[str, dict] = {
    "baseline": {},
    "vol_x2": {"vol_mult": 2.0},
    "edge_halved": {"edge_mult": 0.5},
    "edge_gone": {"edge_mult": 0.0},
    "costs_x2": {"extra_cost_per_bar_mult": 1.0},
    "crash_shock_-25pct": {"shock": -0.25},
    "combined_stress": {"vol_mult": 1.5, "edge_mult": 0.5, "extra_cost_per_bar_mult": 1.0, "shock": -0.20},
}


def monte_carlo_stress(returns: np.ndarray, bars_per_year: float, cost_per_bar: float, horizon_bars: int | None = None,
                       n_paths: int = 400, level: float = 0.90, seed: int = 5, mean_block: float | None = None) -> dict:
    """Resample (block bootstrap) strategy returns into forward paths and apply stress scenarios.
    cost_per_bar: average per-bar cost drag already INSIDE returns; costs_x2 deducts it once more.
    These are resampling outcomes of the SAMPLE, not a forecast of the future."""
    r = np.asarray(returns, dtype=float)
    n = len(r)
    if n < 30:
        return {"status": "INSUFFICIENT_DATA", "n_obs": n}
    H = horizon_bars or n
    rng = np.random.default_rng(seed)
    mb = mean_block or max(2.0, round(n ** (1 / 3)) * 4)
    mean = r.mean()
    out: dict[str, dict] = {}
    for name, sc in SCENARIOS.items():
        terms, dds = [], []
        for _ in range(n_paths):
            x = r[stationary_bootstrap_indices(n, mb, rng, H)].copy()
            x = mean * sc.get("edge_mult", 1.0) + (x - mean) * sc.get("vol_mult", 1.0) if ("edge_mult" in sc or "vol_mult" in sc) else x
            x = x - cost_per_bar * sc.get("extra_cost_per_bar_mult", 0.0)
            if "shock" in sc:
                x[rng.integers(H)] += sc["shock"]
            x = np.maximum(x, -0.999)
            c = _curve(x)
            terms.append(c[-1]); dds.append(max_drawdown(c))
        terms, dds = np.array(terms), np.array(dds)
        lo, hi = (1 - level) / 2, 1 - (1 - level) / 2
        out[name] = {"terminal_multiple_median": float(np.median(terms)), "terminal_multiple_ci": [float(np.quantile(terms, lo)), float(np.quantile(terms, hi))],
                     "max_drawdown_median": float(np.median(dds)), "max_drawdown_ci": [float(np.quantile(dds, lo)), float(np.quantile(dds, hi))],
                     "prob_loss": float((terms < 1).mean()), "prob_drawdown_gt_30pct": float((dds < -0.30).mean()),
                     "prob_drawdown_gt_50pct": float((dds < -0.50).mean())}
    return {"status": "OK", "level": level, "n_paths": n_paths, "horizon_bars": H, "scenarios": out,
            "disclaimer": "Block-bootstrap resampling of in-sample returns under stated stresses. Not a forecast; "
                          "it cannot represent regimes absent from the sample."}
