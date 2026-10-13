"""Walk-forward and out-of-sample splits. Parameters are chosen on TRAIN only and frozen before TEST is touched."""
from __future__ import annotations

import itertools
from dataclasses import dataclass
from typing import Callable, Iterable, Mapping

import numpy as np

from ..backtest.engine import BacktestConfig, BacktestResult, SleeveSpec, run_backtest
from ..backtest.metrics import returns_from_equity, summarize
from ..data.dataset import Dataset


@dataclass(frozen=True)
class Fold:
    train: tuple[int, int]
    test: tuple[int, int]


def make_folds(n: int, train_len: int, test_len: int, step: int | None = None, embargo: int = 24, anchored: bool = False) -> list[Fold]:
    """Rolling (or anchored) folds. `embargo` bars between train end and test start prevent label/feature leakage."""
    step = step or test_len
    folds, s = [], 0
    while True:
        tr0 = 0 if anchored else s
        tr1 = s + train_len
        te0 = tr1 + embargo
        te1 = te0 + test_len
        if te1 > n:
            break
        folds.append(Fold((tr0, tr1), (te0, te1)))
        s += step
    return folds


def holdout_split(n: int, holdout_frac: float = 0.25, embargo: int = 24) -> Fold:
    cut = int(n * (1 - holdout_frac))
    return Fold((0, cut), (cut + embargo, n))


def _run_segment(ds: Dataset, build: Callable[[Mapping], list[SleeveSpec]], params: Mapping, seg: tuple[int, int], cfg: BacktestConfig) -> BacktestResult:
    # features are computed on bars [0, seg_end) so warm-up uses earlier history; PnL counts from seg_start only.
    c = BacktestConfig(**{**cfg.__dict__, "start": seg[0], "end": seg[1]})
    return run_backtest(ds, build(params), c)


def walk_forward(ds: Dataset, build: Callable[[Mapping], list[SleeveSpec]], grid: Mapping[str, Iterable], folds: list[Fold],
                 cfg: BacktestConfig, objective: str = "sharpe", min_trades: int = 5) -> dict:
    keys = list(grid)
    combos = [dict(zip(keys, v)) for v in itertools.product(*[list(grid[k]) for k in keys])] or [{}]
    n_trials = len(combos) * len(folds)
    fold_rows, oos_returns = [], []
    for i, f in enumerate(folds):
        best, best_score, is_summary = None, -np.inf, None
        for pr in combos:
            res = _run_segment(ds, build, pr, f.train, cfg)
            if len(res.equity) < 50 or res.metrics.get("n_closed_trades", 0) < min_trades:
                continue
            sc = res.metrics.get(objective, -np.inf)
            if sc > best_score:
                best, best_score, is_summary = pr, sc, res.metrics
        if best is None:
            fold_rows.append({"fold": i, "train": f.train, "test": f.test, "status": "NO_ELIGIBLE_PARAMS_IN_TRAIN"})
            continue
        oos = _run_segment(ds, build, best, f.test, cfg)
        r = returns_from_equity(oos.equity)
        oos_returns.append(r)
        fold_rows.append({"fold": i, "train": f.train, "test": f.test, "chosen_params": best, f"in_sample_{objective}": best_score,
                          f"out_of_sample_{objective}": oos.metrics.get(objective), "oos_total_return": oos.metrics.get("total_return"),
                          "oos_max_drawdown": oos.metrics.get("max_drawdown"), "oos_trades": oos.metrics.get("n_closed_trades"), "status": "OK"})
    pooled = np.concatenate(oos_returns) if oos_returns else np.array([])
    ok = [r for r in fold_rows if r["status"] == "OK"]
    return {"data_provenance": ds.provenance.value, "folds": fold_rows, "n_param_combinations": len(combos), "n_trials_for_deflation": n_trials,
            "pooled_oos_returns": pooled, "n_oos_bars": int(len(pooled)),
            "mean_in_sample": float(np.mean([r[f"in_sample_{objective}"] for r in ok])) if ok else None,
            "mean_out_of_sample": float(np.mean([r[f"out_of_sample_{objective}"] for r in ok])) if ok else None,
            "note": "Parameters selected on train only. IS->OOS gap measures overfitting; selection among n_trials inflates in-sample results."}


def oos_holdout(ds: Dataset, build: Callable[[Mapping], list[SleeveSpec]], params: Mapping, cfg: BacktestConfig, holdout_frac: float = 0.25) -> dict:
    """Frozen-parameter evaluation on the final holdout (touch ONCE after all tuning)."""
    f = holdout_split(ds.panel.T, holdout_frac)
    tr = _run_segment(ds, build, params, f.train, cfg)
    te = _run_segment(ds, build, params, f.test, cfg)
    return {"data_provenance": ds.provenance.value, "train_bars": f.train, "holdout_bars": f.test, "frozen_params": dict(params),
            "train_metrics": tr.metrics, "holdout_metrics": te.metrics, "holdout_equity": te.equity, "holdout_result": te}
