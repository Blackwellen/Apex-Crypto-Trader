"""Plug-in loaders for REAL OHLCV (CSV / parquet) and an optional public-API fetcher.

Long format required columns: timestamp (epoch seconds, epoch ms, or ISO-8601), symbol, open, high, low, close, volume.
The caller MUST pass provenance and a survivorship declaration: nothing is assumed.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import polars as pl

from ..provenance import DataProvenance
from .dataset import AssetMeta, Dataset, Panel, SurvivorshipDeclaration

REQUIRED = ("timestamp", "symbol", "open", "high", "low", "close", "volume")


def _to_epoch_seconds(col: pl.Series) -> np.ndarray:
    if col.dtype in (pl.Datetime, pl.Date):
        return col.cast(pl.Datetime("ms")).dt.epoch("s").to_numpy().astype(np.int64)
    if col.dtype == pl.String:
        return col.str.to_datetime(time_zone="UTC").dt.epoch("s").to_numpy().astype(np.int64)
    v = col.cast(pl.Float64).to_numpy()
    v = np.where(v > 1e11, v / 1000.0, v)                       # ms -> s
    return v.astype(np.int64)


def read_frame(path: str | Path) -> pl.DataFrame:
    path = Path(path)
    if path.suffix.lower() == ".csv":
        return pl.read_csv(path)
    if path.suffix.lower() in (".parquet", ".pq"):
        return pl.read_parquet(path)
    raise ValueError(f"unsupported file type {path.suffix}")


def frame_to_dataset(df: pl.DataFrame, *, provenance: DataProvenance, survivorship: SurvivorshipDeclaration,
                     source: str, bar_seconds: int, kinds: dict[str, str] | None = None,
                     terminal_recovery_ppm: int = 0, max_gap_bars: int = 5) -> Dataset:
    missing = [c for c in REQUIRED if c not in df.columns]
    if missing:
        raise ValueError(f"missing columns: {missing}")
    survivorship.require()
    ts_all = _to_epoch_seconds(df["timestamp"])
    df = df.with_columns(pl.Series("_ts", ts_all)).drop_nulls(["_ts", "open", "high", "low", "close", "volume"])
    df = df.unique(subset=["_ts", "symbol"], keep="last", maintain_order=False)
    if (df["_ts"] % bar_seconds != 0).any():
        raise ValueError(f"timestamps are not aligned to bar_seconds={bar_seconds}")
    ts = np.arange(df["_ts"].min(), df["_ts"].max() + bar_seconds, bar_seconds, dtype=np.int64)
    T = len(ts)
    symbols = sorted(df["symbol"].unique().to_list())
    N = len(symbols)
    O = np.zeros((T, N)); H = O.copy(); L = O.copy(); C = O.copy(); V = O.copy()
    alive = np.zeros((T, N), dtype=bool)
    meta: dict[str, AssetMeta] = {}
    n_delisted = 0
    for j, s in enumerate(symbols):
        d = df.filter(pl.col("symbol") == s).sort("_ts")
        idx = ((d["_ts"].to_numpy() - ts[0]) // bar_seconds).astype(int)
        first, last = int(idx.min()), int(idx.max())
        gaps = np.diff(idx)
        if gaps.size and gaps.max() > max_gap_bars:
            raise ValueError(f"{s}: gap of {int(gaps.max())} bars exceeds max_gap_bars={max_gap_bars}")
        o, h, l, c, v = (d[k].cast(pl.Float64).to_numpy() for k in ("open", "high", "low", "close", "volume"))
        # forward-fill short gaps with the previous close (zero volume); dead bars are flat
        rng_idx = np.arange(first, last + 1)
        pos = np.searchsorted(idx, rng_idx, side="right") - 1
        have = np.isin(rng_idx, idx)
        cc = c[pos]
        O[first:last + 1, j] = np.where(have, o[pos], cc)
        H[first:last + 1, j] = np.where(have, h[pos], cc)
        L[first:last + 1, j] = np.where(have, l[pos], cc)
        C[first:last + 1, j] = cc
        V[first:last + 1, j] = np.where(have, v[pos], 0.0)
        for arr in (O, H, L, C):
            arr[:first, j] = arr[first, j]
            arr[last + 1:, j] = arr[last, j]
        alive[first:last + 1, j] = True
        dl = last + 1 if last + 1 < T else None
        if dl is not None:
            n_delisted += 1
        meta[s] = AssetMeta(s, (kinds or {}).get(s, "major"), "USD", first, dl, terminal_recovery_ppm if dl is not None else 0)
    panel = Panel(ts, tuple(symbols), O, H, L, C, V, alive, meta, bar_seconds)
    return Dataset(panel, provenance, survivorship, source, {"rows": df.height, "assets_whose_data_ends_early": n_delisted})


def load_ohlcv(path: str | Path, *, provenance: DataProvenance, survivorship: SurvivorshipDeclaration,
               bar_seconds: int, kinds: dict[str, str] | None = None, terminal_recovery_ppm: int = 0) -> Dataset:
    """provenance and survivorship have NO defaults on purpose."""
    return frame_to_dataset(read_frame(path), provenance=provenance, survivorship=survivorship,
                            source=f"file:{Path(path).name}", bar_seconds=bar_seconds, kinds=kinds,
                            terminal_recovery_ppm=terminal_recovery_ppm)


def write_ohlcv(ds: Dataset, path: str | Path) -> None:
    """Helper to export a panel to long CSV/parquet (used to test the loader with a generated file)."""
    pn = ds.panel
    rows = []
    for j, a in enumerate(pn.assets):
        m = pn.alive[:, j]
        rows.append(pl.DataFrame({"timestamp": pn.ts[m], "symbol": a, "open": pn.open[m, j], "high": pn.high[m, j],
                                  "low": pn.low[m, j], "close": pn.close[m, j], "volume": pn.volume[m, j]}))
    out = pl.concat(rows)
    path = Path(path)
    if path.suffix == ".csv":
        out.write_csv(path)
    else:
        out.write_parquet(path)
