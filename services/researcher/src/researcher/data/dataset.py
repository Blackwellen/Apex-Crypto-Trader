"""Aligned multi-asset OHLCV panel + dataset metadata (provenance, survivorship declaration)."""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Mapping

import numpy as np

from ..provenance import DataProvenance


class SurvivorshipUndeclared(Exception):
    """A dataset must say whether delisted/rugged assets are included. Silence is refused."""


@dataclass(frozen=True)
class AssetMeta:
    symbol: str
    kind: str = "major"            # major | meme | other
    quote: str = "USDC"
    listed_at: int = 0             # first alive bar index
    delisted_at: int | None = None # first dead bar index (None = alive to the end)
    terminal_recovery_ppm: int = 0 # value recovered on forced liquidation at delisting, ppm of last close


@dataclass(frozen=True)
class SurvivorshipDeclaration:
    """includes_delisted: True  -> dataset contains delisted/rugged assets (their losses are in the results)
                          False -> survivors only: results are optimistically biased
                          None  -> unknown/undeclared: treated as biased and REFUSED by report builder."""
    includes_delisted: bool | None
    delisted_assets_in_dataset: int = 0
    universe_note: str = ""

    def require(self) -> "SurvivorshipDeclaration":
        if self.includes_delisted is None:
            raise SurvivorshipUndeclared("dataset did not declare whether delisted/rugged assets are included")
        return self

    @property
    def bias_flag(self) -> str:
        if self.includes_delisted is None:
            return "UNDECLARED"
        if self.includes_delisted:
            return "DELISTED_INCLUDED" if self.delisted_assets_in_dataset > 0 else "DECLARED_INCLUDED_BUT_NONE_PRESENT"
        return "SURVIVORSHIP_BIAS_PRESENT"


@dataclass(frozen=True)
class Panel:
    ts: np.ndarray                                  # int64 epoch seconds, strictly increasing
    assets: tuple[str, ...]
    open: np.ndarray                                # (T, N) float64
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    volume: np.ndarray                              # base volume per bar
    alive: np.ndarray                               # (T, N) bool: tradable at this bar
    meta: Mapping[str, AssetMeta] = field(default_factory=dict)
    bar_seconds: int = 3600

    def __post_init__(self) -> None:
        T, N = self.close.shape
        for name in ("open", "high", "low", "volume", "alive"):
            if getattr(self, name).shape != (T, N):
                raise ValueError(f"{name} shape mismatch")
        if self.ts.shape != (T,) or len(self.assets) != N:
            raise ValueError("ts/assets shape mismatch")
        if T > 1 and not np.all(np.diff(self.ts) > 0):
            raise ValueError("timestamps must be strictly increasing")
        for a in ("open", "high", "low", "close", "volume"):
            arr = getattr(self, a)
            if not np.all(np.isfinite(arr)):
                raise ValueError(f"{a} contains non-finite values (fill dead bars before building a Panel)")
        if np.any(self.close <= 0) or np.any(self.open <= 0):
            raise ValueError("prices must be positive")
        if np.any(self.high + 1e-12 < np.maximum(self.open, self.close)) or np.any(self.low - 1e-12 > np.minimum(self.open, self.close)):
            raise ValueError("OHLC inconsistency (high < max(o,c) or low > min(o,c))")
        for arr in (self.open, self.high, self.low, self.close, self.volume, self.alive, self.ts):
            arr.setflags(write=False)

    @property
    def T(self) -> int:
        return self.close.shape[0]

    @property
    def N(self) -> int:
        return len(self.assets)

    def slice(self, start: int, end: int) -> "Panel":
        """bars [start, end). Copies, so the original cannot be reached through the slice."""
        s = slice(start, end)
        meta = {a: replace(m, listed_at=max(0, m.listed_at - start),
                           delisted_at=None if m.delisted_at is None else m.delisted_at - start)
                for a, m in self.meta.items()}
        return Panel(self.ts[s].copy(), self.assets, self.open[s].copy(), self.high[s].copy(), self.low[s].copy(),
                     self.close[s].copy(), self.volume[s].copy(), self.alive[s].copy(), meta, self.bar_seconds)

    def select(self, symbols: list[str]) -> "Panel":
        idx = [self.assets.index(s) for s in symbols]
        return Panel(self.ts, tuple(symbols), self.open[:, idx], self.high[:, idx], self.low[:, idx],
                     self.close[:, idx], self.volume[:, idx], self.alive[:, idx],
                     {s: self.meta[s] for s in symbols if s in self.meta}, self.bar_seconds)

    @property
    def bars_per_year(self) -> float:
        return 365.25 * 24 * 3600 / self.bar_seconds


@dataclass(frozen=True)
class Dataset:
    panel: Panel
    provenance: DataProvenance
    survivorship: SurvivorshipDeclaration
    source: str                                     # human description, e.g. "synthetic seed=7"
    generator_params: Mapping[str, object] = field(default_factory=dict)

    def label(self) -> dict:
        return {"data_provenance": self.provenance.value, "source": self.source,
                "survivorship": {"includes_delisted": self.survivorship.includes_delisted,
                                 "delisted_assets_in_dataset": self.survivorship.delisted_assets_in_dataset,
                                 "bias_flag": self.survivorship.bias_flag,
                                 "note": self.survivorship.universe_note}}
