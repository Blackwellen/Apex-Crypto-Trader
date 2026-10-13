"""Seeded synthetic market generator. EVERYTHING it produces is labelled SYNTHETIC.

Features: Markov regimes (bull/bear/range/crash), fat tails (Student-t), jumps, a common factor, a cointegrated
pair, volume that follows volatility, and meme assets that list late and may rug (collapse then delist).
This is a test fixture for engine/statistics code. It is NOT a model of real markets.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..provenance import DataProvenance
from .dataset import AssetMeta, Dataset, Panel, SurvivorshipDeclaration

REGIMES = ("bull", "bear", "range", "crash")
# per-bar (hourly) drift and vol by regime
_MU = np.array([0.00025, -0.00020, 0.0, -0.0030])
_SIG = np.array([0.0060, 0.0090, 0.0040, 0.0300])
_TRANS = np.array([
    [0.9930, 0.0020, 0.0045, 0.0005],
    [0.0030, 0.9910, 0.0050, 0.0010],
    [0.0030, 0.0030, 0.9935, 0.0005],
    [0.0000, 0.0600, 0.0600, 0.8800],
])
_TRANS = _TRANS / _TRANS.sum(axis=1, keepdims=True)


@dataclass(frozen=True)
class SyntheticParams:
    seed: int = 7
    n_bars: int = 4000
    bar_seconds: int = 3600
    majors: tuple[str, ...] = ("BTC", "ETH", "SOL")
    pair_asset: str | None = "LINK"        # log-cointegrated with ETH
    n_memes: int = 3
    meme_rug_prob: float = 0.67
    include_delisted: bool = True          # False => drop rugged assets to emulate a survivors-only vendor dataset
    t_df: float = 3.5
    jump_prob: float = 0.002
    start_ts: int = 1_600_000_000
    start_price: float = 100.0


def _t_noise(rng: np.random.Generator, df: float, size) -> np.ndarray:
    z = rng.standard_t(df, size=size)
    return z / np.sqrt(df / (df - 2.0))        # unit variance


def generate(p: SyntheticParams | None = None) -> Dataset:
    p = p or SyntheticParams()
    rng = np.random.default_rng(p.seed)
    T = p.n_bars
    # --- regime path -----------------------------------------------------------------------------------
    reg = np.empty(T, dtype=np.int64)
    s = 0
    for t in range(T):
        reg[t] = s
        s = rng.choice(4, p=_TRANS[s])
    mu, sig = _MU[reg], _SIG[reg]
    common = mu + sig * _t_noise(rng, p.t_df, T)
    jump_c = rng.random(T) < p.jump_prob
    common = common + jump_c * rng.normal(0, 5 * sig)

    symbols: list[str] = list(p.majors)
    logp: dict[str, np.ndarray] = {}
    kinds: dict[str, str] = {}
    beta = {"BTC": 1.0, "ETH": 1.15, "SOL": 1.5}
    for i, a in enumerate(p.majors):
        b = beta.get(a, 1.2)
        idio = 0.4 * sig * _t_noise(rng, p.t_df, T) + (rng.random(T) < p.jump_prob / 2) * rng.normal(0, 4 * sig)
        r = b * common + idio
        logp[a] = np.log(p.start_price * (1 + i)) + np.cumsum(r)
        kinds[a] = "major"
    if p.pair_asset:
        base = logp["ETH"] if "ETH" in logp else logp[p.majors[0]]
        spread = np.zeros(T)
        for t in range(1, T):                                      # OU spread: mean reverting
            spread[t] = 0.985 * spread[t - 1] + 0.006 * rng.standard_normal()
        logp[p.pair_asset] = 0.9 * base + 0.5 + spread
        symbols.append(p.pair_asset)
        kinds[p.pair_asset] = "major"

    listed: dict[str, int] = {a: 0 for a in symbols}
    delisted: dict[str, int | None] = {a: None for a in symbols}
    recovery: dict[str, int] = {a: 0 for a in symbols}
    n_rugged = 0
    for m in range(p.n_memes):
        a = f"MEME{m + 1}"
        t0 = int(rng.integers(T // 8, T // 2))
        life = int(rng.integers(T // 8, T // 3))
        r = np.zeros(T)
        n = T - t0
        r[t0:] = 0.012 * _t_noise(rng, p.t_df, n) + 0.3 * common[t0:]
        pump = np.zeros(T)
        k = min(60, life // 2)
        pump[t0 + 5: t0 + 5 + k] = rng.uniform(0.01, 0.04)         # launch pump
        r += pump
        path = np.cumsum(r)
        end = None
        if rng.random() < p.meme_rug_prob:                         # rug: -90..99% within a few bars, then delisted
            tr = min(T - 6, t0 + life)
            drop = np.log(rng.uniform(0.01, 0.10))
            base = path.copy()
            path[tr:] = base[tr:] + drop * 0.5
            path[tr + 1:] = base[tr + 1:] + drop * 0.8
            path[tr + 2:] = base[tr + 2:] + drop
            path[tr + 3:] = path[tr + 3] + np.cumsum(np.r_[0.0, 0.002 * rng.standard_normal(T - tr - 4)])
            end = tr + 4
            n_rugged += 1
            recovery[a] = int(rng.integers(0, 50_000))             # 0%..5% recovered at forced exit
        logp[a] = np.log(1.0) + path
        symbols.append(a)
        kinds[a] = "meme"
        listed[a] = t0
        delisted[a] = end

    if not p.include_delisted:
        symbols = [a for a in symbols if delisted[a] is None]
    N = len(symbols)
    C = np.empty((T, N)); O = np.empty((T, N)); H = np.empty((T, N)); L = np.empty((T, N)); V = np.empty((T, N))
    alive = np.zeros((T, N), dtype=bool)
    meta = {}
    for j, a in enumerate(symbols):
        close = np.exp(logp[a])
        gap = 1 + 0.0005 * rng.standard_normal(T)
        opn = np.empty(T); opn[0] = close[0]; opn[1:] = close[:-1] * gap[1:]
        vol_bar = np.abs(np.diff(np.log(close), prepend=np.log(close[0])))
        wick = np.abs(rng.standard_normal(T)) * (0.3 * vol_bar + 0.0008)
        hi = np.maximum(opn, close) * (1 + wick)
        lo = np.minimum(opn, close) * (1 - np.minimum(wick, 0.5))
        qv = np.exp(rng.normal(0, 0.4, T)) * (1 + 40 * vol_bar) * (2e6 if kinds[a] == "major" else 2e5)
        vol = qv / close
        t0, t1 = listed[a], delisted[a]
        al = np.zeros(T, dtype=bool); al[t0:(t1 if t1 is not None else T)] = True
        # fill dead bars with flat prices / zero volume (never NaN); engine + strategies gate on `alive`
        if t0 > 0:
            for arr in (opn, close, hi, lo): arr[:t0] = close[t0]
            vol[:t0] = 0.0
        if t1 is not None:
            for arr in (opn, close, hi, lo): arr[t1:] = close[t1 - 1]
            vol[t1:] = 0.0
        O[:, j], C[:, j], H[:, j], L[:, j], V[:, j], alive[:, j] = opn, close, hi, lo, vol, al
        meta[a] = AssetMeta(a, kinds[a], "USDC", t0, t1, recovery.get(a, 0))
    ts = p.start_ts + np.arange(T, dtype=np.int64) * p.bar_seconds
    panel = Panel(ts, tuple(symbols), O, H, L, C, V, alive, meta, p.bar_seconds)
    n_del_in = sum(1 for a in symbols if delisted[a] is not None)
    surv = SurvivorshipDeclaration(
        includes_delisted=bool(p.include_delisted),
        delisted_assets_in_dataset=n_del_in,
        universe_note=("synthetic universe incl. rugged/delisted memes" if p.include_delisted
                       else f"survivors only: {n_rugged} rugged meme asset(s) were DROPPED from the dataset"))
    ds = Dataset(panel, DataProvenance.SYNTHETIC, surv, f"synthetic generator seed={p.seed} n_bars={T}",
                 {"seed": p.seed, "n_bars": T, "regime_counts": {REGIMES[i]: int((reg == i).sum()) for i in range(4)},
                  "true_regime_path_for_tests_only": True})
    object.__setattr__(ds, "_true_regimes", reg)       # test-only ground truth; never used by engine/strategies
    return ds
