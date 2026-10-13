"""No-lookahead validator.

A causal feature satisfies: value[k] computed on the FULL data == value[k] computed on data truncated at bar k, and
is also unchanged when everything after bar k is replaced by garbage. The engine runs this on every feature function
before every backtest and refuses to run if it fails. Detection is by sampled checkpoints (not a proof): documented
in docs/evidence/python-tests.md.
"""
from __future__ import annotations

from typing import Callable

import numpy as np

from ..data.dataset import Panel

FeatureFn = Callable[[Panel], dict[str, np.ndarray]]


class LookaheadError(Exception):
    def __init__(self, feature: str, bar: int, kind: str):
        super().__init__(f"LOOKAHEAD detected in feature {feature!r} at bar {bar} ({kind})")
        self.feature, self.bar, self.kind = feature, bar, kind


def _garbage_after(panel: Panel, k: int, seed: int) -> Panel:
    rng = np.random.default_rng(seed + k)
    n = panel.T - (k + 1)
    if n <= 0:
        return panel
    def junk(a): return a[k + 1:] * np.exp(rng.normal(0, 0.5, a[k + 1:].shape))
    o, c = junk(panel.open), junk(panel.close)
    hi = np.maximum(o, c) * (1 + np.abs(rng.normal(0, 0.01, o.shape)))
    lo = np.minimum(o, c) * (1 - np.minimum(np.abs(rng.normal(0, 0.01, o.shape)), 0.5))
    def cat(a, b): return np.concatenate([a[: k + 1], b], axis=0)
    return Panel(panel.ts, panel.assets, cat(panel.open, o), cat(panel.high, hi), cat(panel.low, lo),
                 cat(panel.close, c), cat(panel.volume, junk(panel.volume)), panel.alive, panel.meta, panel.bar_seconds)


def validate_feature_fn(fn: FeatureFn, panel: Panel, n_checkpoints: int = 8, min_bar: int = 50, seed: int = 0,
                        rtol: float = 1e-9, atol: float = 1e-12) -> None:
    """Raise LookaheadError if fn(panel) at any sampled bar k depends on bars > k."""
    full = fn(panel)
    lo = min(min_bar, panel.T - 3)
    ks = np.unique(np.linspace(lo, panel.T - 2, n_checkpoints).astype(int))
    for k in ks:
        trunc = fn(panel.slice(0, int(k) + 1))
        junk = fn(_garbage_after(panel, int(k), seed))
        for name, arr in full.items():
            a = arr[k]
            for kind, other in (("truncation", trunc[name][k]), ("future-perturbation", junk[name][k])):
                if not np.allclose(a, other, rtol=rtol, atol=atol, equal_nan=True):
                    raise LookaheadError(name, int(k), kind)
