"""Hard no-lookahead guarantees (spec QA: market data lookahead / time alignment)."""
import numpy as np
import pytest

from researcher import features as F
from researcher.backtest.engine import BacktestConfig, SleeveSpec, run_backtest
from researcher.backtest.lookahead import LookaheadError, validate_feature_fn
from researcher.data.dataset import Panel
from researcher.regime import Regime
from researcher.strategies.base import CapitalRequest, SleeveOutput, Stage, StrategyDefinition
from researcher.strategies.library import REGISTRY, build, common_features


def _strategy(feature_fn, signal_fn, name="probe"):
    return StrategyDefinition(name, "0.0.1", Stage.RESEARCH, "test probe", lambda m: True, frozenset(Regime), ("age", "regime"),
                              feature_fn, signal_fn, CapitalRequest(1.0, 1.0), min_warmup_bars=1)


def test_injected_future_close_feature_is_detected(ds_small):
    """Deliberately inject a lookahead feature (tomorrow's close) -> validator must raise."""
    def leaky(p: Panel):
        nxt = np.vstack([p.close[1:], p.close[-1:]])        # close[t+1] at row t  <- LOOKAHEAD
        return {"tomorrow": nxt}
    with pytest.raises(LookaheadError) as e:
        validate_feature_fn(leaky, ds_small.panel)
    assert e.value.feature == "tomorrow"


def test_whole_sample_normalisation_is_detected(ds_small):
    def leaky(p: Panel):
        return {"z": (p.close - p.close.mean(axis=0)) / p.close.std(axis=0)}   # uses full-sample mean/std
    with pytest.raises(LookaheadError):
        validate_feature_fn(leaky, ds_small.panel)


def test_centered_window_is_detected(ds_small):
    def leaky(p: Panel):
        k = 5
        x = p.close
        out = np.full(x.shape, np.nan)
        for t in range(k, len(x) - k):
            out[t] = x[t - k:t + k + 1].mean(axis=0)       # centred => peeks k bars ahead
        return {"smooth": out}
    with pytest.raises(LookaheadError):
        validate_feature_fn(leaky, ds_small.panel)


def test_engine_refuses_to_run_a_leaky_strategy(ds_small):
    def leaky(p: Panel):
        return {"tomorrow": np.vstack([p.close[1:], p.close[-1:]]), **common_features(p)}
    sig = lambda ctx: SleeveOutput({"BTC": 1.0})  # noqa: E731
    with pytest.raises(LookaheadError):
        run_backtest(ds_small, [SleeveSpec(_strategy(leaky, sig, "leaky"), 0.5)])


def test_lookahead_validation_cannot_be_disabled():
    with pytest.raises(ValueError):
        BacktestConfig(validate_lookahead=False)


@pytest.mark.parametrize("name", sorted(REGISTRY))
def test_every_library_strategy_feature_set_is_causal(name, ds_small):
    validate_feature_fn(build(name).feature_fn, ds_small.panel)


def test_causal_primitives_pass(ds_small):
    c = ds_small.panel.close
    def fn(p):
        return {"sma": F.rolling_mean(p.close, 20), "z": F.zscore(p.close, 30), "atr": F.atr(p.high, p.low, p.close, 14),
                "ph": F.prior_high(p.high, 20), "ema": F.ema(p.close, 10), "er": F.efficiency_ratio(p.close, 30)}
    validate_feature_fn(fn, ds_small.panel)
    with pytest.raises(ValueError):
        F.lag(c, -1)


def test_signal_sees_only_prefix_and_fills_at_next_open(ds_small):
    """Signal at close of bar 10 -> fill at OPEN of bar 11 (never bar 10's close); features are read-only prefix views."""
    seen = {}
    def feats(p):
        return {"close": p.close, **common_features(p)}
    def sig(ctx):
        seen[ctx.t] = ctx.features["close"].shape[0]
        assert ctx.features["close"].shape[0] == ctx.t + 1               # nothing beyond t
        with pytest.raises(ValueError):
            ctx.features["close"][0, 0] = 1.0                            # read-only
        return SleeveOutput({"BTC": 0.5} if ctx.t >= 10 else {})
    # use regime-agnostic (all) strategy; regime WARMUP is part of Regime enum so gating allows it
    res = run_backtest(ds_small, [SleeveSpec(_strategy(feats, sig), 1.0)], BacktestConfig(max_asset_weight=0.5))
    first = res.trades[0]
    assert first.t_decision == 10 and first.t_exec == 11 and first.side == "buy"
    j = ds_small.panel.assets.index("BTC")
    open11, close10 = ds_small.panel.open[11, j], ds_small.panel.close[10, j]
    px = float(first.price)
    assert px >= open11 * (1 - 1e-8)                                       # buy at/above open (spread+impact only add)
    assert px <= open11 * 1.01                                              # within 1% of open
    assert abs(px - open11) < abs(px - close10) or abs(open11 - close10) / close10 < 1e-4
    assert max(seen) == ds_small.panel.T - 2                                # no decision on the last bar (no next open)


def test_data_after_end_does_not_exist_for_the_engine(ds_small):
    """Changing prices after `end` must not change anything before it."""
    a = run_backtest(ds_small, [SleeveSpec(build("trend_momentum"), 0.5)], BacktestConfig(end=900))
    p = ds_small.panel
    O, H, L, C = (x.copy() for x in (p.open, p.high, p.low, p.close))
    C[901:] *= 3.0; O[901:] *= 3.0; H[901:] *= 3.0; L[901:] *= 3.0
    from dataclasses import replace
    from researcher.data.dataset import Dataset, Panel
    p2 = Panel(p.ts, p.assets, O, H, L, C, p.volume, p.alive, p.meta, p.bar_seconds)
    b = run_backtest(Dataset(p2, ds_small.provenance, ds_small.survivorship, "mutated future"), [SleeveSpec(build("trend_momentum"), 0.5)], BacktestConfig(end=900))
    assert a.equity == b.equity
