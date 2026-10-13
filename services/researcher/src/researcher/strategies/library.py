"""Research + paper implementations of the required strategies. Long-only spot. All causal.

Stage differences (same signal logic, different safety envelope): PAPER uses smaller capital requests, a stricter
cost-gate edge claim and FLATTEN fail policy; RESEARCH may run larger for sensitivity studies. Neither is live.
"""
from __future__ import annotations

from typing import Callable

import numpy as np

from .. import features as F
from ..data.dataset import AssetMeta, Panel
from ..regime import Regime, RegimeParams, regime_from_panel
from .base import CapitalRequest, FailPolicy, SignalContext, SleeveOutput, Stage, StrategyDefinition

R = Regime
MAJOR = lambda m: m.kind == "major"  # noqa: E731


def _cap(stage: Stage, research: float, paper: float, per_asset: float) -> CapitalRequest:
    return CapitalRequest(research if stage is Stage.RESEARCH else paper, per_asset)


def _fail(stage: Stage) -> FailPolicy:
    return FailPolicy.HOLD if stage is Stage.RESEARCH else FailPolicy.FLATTEN


def _eq_weight(mask: np.ndarray, assets: tuple[str, ...], per_asset_cap: float, scale: np.ndarray | None = None) -> dict[str, float]:
    n = int(mask.sum())
    if n == 0:
        return {}
    w = np.where(mask, 1.0 / n, 0.0)
    if scale is not None:
        w = w * scale
        s = w.sum()
        w = w / s if s > 0 else w
    w = np.minimum(w, per_asset_cap)
    return {a: float(x) for a, x in zip(assets, w) if x > 0}


def _elig_mask(ctx: SignalContext, ok: Callable[[AssetMeta], bool], warm: int) -> np.ndarray:
    age = ctx.features["age"][ctx.t]
    return np.array([ctx.alive[i] and age[i] >= warm and ok(ctx.meta[a]) if a in ctx.meta else bool(ctx.alive[i])
                     for i, a in enumerate(ctx.assets)])


def common_features(panel: Panel) -> dict[str, np.ndarray]:
    reg = regime_from_panel(panel)
    return {"age": F.age_since_listing(panel.alive).astype(float),
            "regime": np.repeat(reg[:, None].astype(float), panel.N, axis=1)}


# ---------------------------------------------------------------------------------------------------- 1 trend
def trend_momentum(stage: Stage = Stage.RESEARCH, fast: int = 24, slow: int = 120, mom: int = 72, vol_w: int = 72) -> StrategyDefinition:
    def feats(p: Panel):
        c = p.close
        return {"sma_fast": F.rolling_mean(c, fast), "sma_slow": F.rolling_mean(c, slow), "mom": F.roc(c, mom),
                "rv": F.realized_vol(c, vol_w), "close": c}

    def sig(ctx: SignalContext) -> SleeveOutput:
        m = _elig_mask(ctx, MAJOR, slow + 5)
        with np.errstate(invalid="ignore"):
            on = m & (ctx.f("close") > ctx.f("sma_slow")) & (ctx.f("sma_fast") > ctx.f("sma_slow")) & (ctx.f("mom") > 0)
        inv_vol = 1.0 / np.where(ctx.f("rv") > 0, ctx.f("rv"), np.nan)
        scale = np.nan_to_num(inv_vol, nan=0.0)
        return SleeveOutput(_eq_weight(on, ctx.assets, 0.6, scale), reason="close>SMA(slow), SMA(fast)>SMA(slow), momentum>0; inverse-vol weights")

    return StrategyDefinition("trend_momentum", "1.0.0", stage, "Liquid-major trend/momentum, inverse-vol weighted",
                              MAJOR, frozenset({R.TREND_UP, R.RANGE}), ("sma_fast", "sma_slow", "mom", "rv", "close", "age", "regime"),
                              lambda p: {**feats(p), **common_features(p)}, sig,
                              _cap(stage, 1.0, 0.5, 0.6), _fail(stage), expected_horizon_bars=mom, min_warmup_bars=slow + 5,
                              params={"fast": fast, "slow": slow, "mom": mom})


# ---------------------------------------------------------------------------------------- 2 mean reversion
def mean_reversion(stage: Stage = Stage.RESEARCH, window: int = 48, z_in: float = 2.0, z_out: float = 0.0) -> StrategyDefinition:
    def feats(p: Panel):
        return {"z": F.zscore(p.close, window)}

    def sig(ctx: SignalContext) -> SleeveOutput:
        held = ctx.state.setdefault("held", np.zeros(len(ctx.assets), dtype=bool))
        m = _elig_mask(ctx, MAJOR, window + 5)
        z = ctx.f("z")
        with np.errstate(invalid="ignore"):
            enter = m & (z < -z_in)
            keep = held & m & (z < -z_out)
        held[:] = enter | keep
        return SleeveOutput(_eq_weight(held.copy(), ctx.assets, 0.5), reason=f"enter z<-{z_in}, exit z>-{z_out}; RANGE regime only")

    return StrategyDefinition("mean_reversion", "1.0.0", stage, "Rolling z-score mean reversion, range regime only",
                              MAJOR, frozenset({R.RANGE}), ("z", "age", "regime"),
                              lambda p: {**feats(p), **common_features(p)}, sig,
                              _cap(stage, 1.0, 0.4, 0.5), _fail(stage), expected_horizon_bars=window // 2, min_warmup_bars=window + 5,
                              params={"window": window, "z_in": z_in, "z_out": z_out})


# --------------------------------------------------------------------------------------- 3 breakout / vol
def breakout_volatility(stage: Stage = Stage.RESEARCH, entry_w: int = 96, exit_w: int = 48, short_vol: int = 24, long_vol: int = 240) -> StrategyDefinition:
    def feats(p: Panel):
        rv_s, rv_l = F.realized_vol(p.close, short_vol), F.realized_vol(p.close, long_vol)
        with np.errstate(invalid="ignore", divide="ignore"):
            ratio = rv_s / rv_l
        return {"hi": F.prior_high(p.high, entry_w), "lo": F.prior_low(p.low, exit_w), "close": p.close, "vol_ratio": ratio}

    def sig(ctx: SignalContext) -> SleeveOutput:
        held = ctx.state.setdefault("held", np.zeros(len(ctx.assets), dtype=bool))
        m = _elig_mask(ctx, MAJOR, long_vol + 5)
        c, hi, lo, vr = ctx.f("close"), ctx.f("hi"), ctx.f("lo"), ctx.f("vol_ratio")
        with np.errstate(invalid="ignore"):
            enter = m & (c > hi) & (vr > 1.1)                # breakout WITH volatility expansion
            keep = held & m & (c > lo)                       # trailing channel exit
        held[:] = enter | keep
        return SleeveOutput(_eq_weight(held.copy(), ctx.assets, 0.5), reason="Donchian breakout (prior highs only) + vol expansion")

    return StrategyDefinition("breakout_volatility", "1.0.0", stage, "Donchian breakout with volatility-expansion filter",
                              MAJOR, frozenset({R.TREND_UP, R.RANGE, R.HIGH_VOL}), ("hi", "lo", "close", "vol_ratio", "age", "regime"),
                              lambda p: {**feats(p), **common_features(p)}, sig,
                              _cap(stage, 1.0, 0.4, 0.5), _fail(stage), expected_horizon_bars=exit_w, min_warmup_bars=long_vol + 5,
                              params={"entry_w": entry_w, "exit_w": exit_w})


# --------------------------------------------------------------------------------------- 4 statistical pairs
def statistical_pairs(stage: Stage = Stage.RESEARCH, a: str = "ETH", b: str = "LINK", window: int = 240, z_in: float = 2.0, z_out: float = 0.5) -> StrategyDefinition:
    """Long-only relative value: hold whichever leg is cheap vs the rolling hedge-ratio spread (spot cannot short)."""
    def feats(p: Panel):
        out = {"pair_z": np.full(p.close.shape, np.nan)}
        if a in p.assets and b in p.assets:
            ia, ib = p.assets.index(a), p.assets.index(b)
            ya, xb = np.log(p.close[:, ia]), np.log(p.close[:, ib])
            beta = F.rolling_beta(ya, xb, window)
            spread = ya - beta * xb
            z = F.zscore(spread.reshape(-1, 1), window)[:, 0]
            out["pair_z"][:, ia] = z
            out["pair_z"][:, ib] = z
        return out

    def sig(ctx: SignalContext) -> SleeveOutput:
        if a not in ctx.assets or b not in ctx.assets:
            return SleeveOutput({}, reason="pair assets missing")
        ia, ib = ctx.assets.index(a), ctx.assets.index(b)
        z = ctx.features["pair_z"][ctx.t, ia]
        ok = ctx.alive[ia] and ctx.alive[ib] and ctx.features["age"][ctx.t, ia] >= window + 5 and ctx.features["age"][ctx.t, ib] >= window + 5
        side = ctx.state.get("side", 0)
        if not ok or np.isnan(z):
            ctx.state["side"] = 0
            return SleeveOutput({}, reason="warmup/not alive")
        if side == 0:
            side = -1 if z > z_in else (1 if z < -z_in else 0)    # z>0: A rich vs B -> hold B (side -1); z<0: hold A
        elif abs(z) < z_out or (side == 1 and z > z_out) or (side == -1 and z < -z_out):
            side = 0
        ctx.state["side"] = side
        if side == 1:
            return SleeveOutput({a: 1.0}, reason="spread low: A cheap vs B")
        if side == -1:
            return SleeveOutput({b: 1.0}, reason="spread high: B cheap vs A")
        return SleeveOutput({}, reason="no dislocation")

    return StrategyDefinition("statistical_pairs", "1.0.0", stage, f"Long-only relative value {a}/{b}",
                              lambda m: m.symbol in (a, b), frozenset({R.TREND_UP, R.RANGE, R.TREND_DOWN, R.HIGH_VOL}),
                              ("pair_z", "age", "regime"), lambda p: {**feats(p), **common_features(p)}, sig,
                              _cap(stage, 1.0, 0.3, 1.0), _fail(stage), expected_horizon_bars=window // 4, min_warmup_bars=window + 5,
                              params={"a": a, "b": b, "window": window, "z_in": z_in, "z_out": z_out})


# ---------------------------------------------------------------------------------------- 5 grid / range
def grid_range(stage: Stage = Stage.RESEARCH, window: int = 120, n_levels: int = 6, width_sigma: float = 2.0) -> StrategyDefinition:
    """Inventory-targeting grid: higher inventory the lower price sits in the band. REGIME GATED: flat outside RANGE."""
    def feats(p: Panel):
        mid, sd = F.rolling_mean(p.close, window), F.rolling_std(p.close, window)
        return {"mid": mid, "sd": sd, "close": p.close}

    def sig(ctx: SignalContext) -> SleeveOutput:
        m = _elig_mask(ctx, MAJOR, window + 5)
        mid, sd, c = ctx.f("mid"), ctx.f("sd"), ctx.f("close")
        lo, hi = mid - width_sigma * sd, mid + width_sigma * sd
        with np.errstate(invalid="ignore", divide="ignore"):
            pos = (hi - c) / (hi - lo)                          # 1 at band bottom, 0 at top
        lvl = np.floor(np.clip(np.nan_to_num(pos, nan=0.0), 0, 1) * n_levels) / n_levels
        inside = m & (c > lo) & (c < hi)                        # price escaped the band -> flat (stop)
        w = np.where(inside, lvl, 0.0)
        tot = w.sum()
        if tot > 1:
            w = w / tot
        return SleeveOutput({a: float(min(x, 0.4)) for a, x in zip(ctx.assets, w) if x > 0}, reason="grid inventory by band position; RANGE only")

    return StrategyDefinition("grid_range", "1.0.0", stage, "Regime-gated grid/range inventory strategy",
                              MAJOR, frozenset({R.RANGE}), ("mid", "sd", "close", "age", "regime"),
                              lambda p: {**feats(p), **common_features(p)}, sig,
                              _cap(stage, 1.0, 0.3, 0.4), _fail(stage), expected_horizon_bars=window // 4, min_warmup_bars=window + 5,
                              params={"window": window, "n_levels": n_levels})


# ---------------------------------------------------------------------------------------- 6 spot rotation
def spot_rotation(stage: Stage = Stage.RESEARCH, universe: tuple[str, ...] = ("BTC", "ETH", "SOL"), lookback: int = 168, rebalance_every: int = 72) -> StrategyDefinition:
    def feats(p: Panel):
        return {"mom": F.roc(p.close, lookback)}

    def sig(ctx: SignalContext) -> SleeveOutput:
        t = ctx.t
        if t % rebalance_every != 0 and "choice" in ctx.state:
            ch = ctx.state["choice"]
        else:
            idx = [i for i, a in enumerate(ctx.assets) if a in universe and ctx.alive[i] and ctx.features["age"][t, i] >= lookback + 2]
            mom = ctx.f("mom")
            best = None
            for i in idx:
                if np.isfinite(mom[i]) and mom[i] > 0 and (best is None or mom[i] > mom[best]):    # absolute + relative momentum
                    best = i
            ch = ctx.assets[best] if best is not None else None
            ctx.state["choice"] = ch
        return SleeveOutput({ch: 1.0} if ch else {}, reason=f"rotate to strongest positive {lookback}-bar momentum in {universe}")

    return StrategyDefinition("spot_rotation", "1.0.0", stage, "BTC/ETH/SOL spot rotation (absolute+relative momentum)",
                              lambda m: m.symbol in universe, frozenset({R.TREND_UP, R.RANGE, R.TREND_DOWN, R.HIGH_VOL}),
                              ("mom", "age", "regime"), lambda p: {**feats(p), **common_features(p)}, sig,
                              _cap(stage, 1.0, 0.5, 1.0), _fail(stage), expected_horizon_bars=rebalance_every, min_warmup_bars=lookback + 5,
                              params={"universe": list(universe), "lookback": lookback, "rebalance_every": rebalance_every})


# ---------------------------------------------------------------------------------------- 7 risk-off overlay
def risk_off(stage: Stage = Stage.RESEARCH, dd_trigger: float = -0.12, dd_window: int = 240, resume_dd: float = -0.05) -> StrategyDefinition:
    """Overlay sleeve: emits no positions, only a risk multiplier (0 = go to cash) when regime/drawdown say stand down."""
    def feats(p: Panel):
        return {}

    def sig(ctx: SignalContext) -> SleeveOutput:
        bad = ctx.regime in (int(R.CRASH), int(R.HIGH_VOL)) or (ctx.regime == int(R.TREND_DOWN))
        idx = ctx.features["mkt_dd"][ctx.t, 0]
        off = ctx.state.get("off", False)
        if not off and (bad or idx < dd_trigger):
            off = True
        elif off and not bad and idx > resume_dd:
            off = False
        ctx.state["off"] = off
        return SleeveOutput({}, risk_multiplier=0.0 if off else 1.0, reason="risk-off" if off else "risk-on")

    def feats2(p: Panel):
        from ..regime import market_index
        major = np.array([p.meta[a].kind == "major" if a in p.meta else True for a in p.assets])
        mi = market_index(p.close, p.alive, major).reshape(-1, 1)
        dd = mi / F.rolling_max(mi, dd_window) - 1.0
        return {"mkt_dd": np.repeat(np.nan_to_num(dd, nan=0.0), p.N, axis=1), **common_features(p)}

    return StrategyDefinition("risk_off", "1.0.0", stage, "Drawdown/regime risk-off overlay (spot only: de-risk to cash)",
                              lambda m: True, frozenset(R), ("mkt_dd", "age", "regime"), feats2, sig,
                              CapitalRequest(0.0, 0.0), FailPolicy.FLATTEN, expected_horizon_bars=dd_window, min_warmup_bars=dd_window,
                              params={"dd_trigger": dd_trigger, "resume_dd": resume_dd})


REGISTRY: dict[str, Callable[..., StrategyDefinition]] = {
    "trend_momentum": trend_momentum, "mean_reversion": mean_reversion, "breakout_volatility": breakout_volatility,
    "statistical_pairs": statistical_pairs, "grid_range": grid_range, "spot_rotation": spot_rotation, "risk_off": risk_off,
}


def build(name: str, stage: str | Stage = Stage.RESEARCH, **params) -> StrategyDefinition:
    if name not in REGISTRY:
        raise KeyError(f"unknown strategy {name!r}; known: {sorted(REGISTRY)}")
    return REGISTRY[name](stage=Stage(stage), **params)
