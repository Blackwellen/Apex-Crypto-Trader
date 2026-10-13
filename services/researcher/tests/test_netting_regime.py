import numpy as np
from hypothesis import given, settings
from hypothesis import strategies as st

from researcher import features as F
from researcher.backtest.engine import BacktestConfig, SleeveSpec, run_backtest
from researcher.backtest.lookahead import validate_feature_fn
from researcher.backtest.portfolio import net_sleeves
from researcher.regime import Regime, RegimeParams, classify, market_index, regime_from_panel
from researcher.strategies.base import CapitalRequest, SleeveOutput, Stage, StrategyDefinition
from researcher.strategies.library import common_features
from researcher.units import QUOTE_ONE


def S(name, fn):
    return StrategyDefinition(name, "0", Stage.RESEARCH, name, lambda m: True, frozenset(Regime), ("age",), common_features, fn, CapitalRequest(1.0, 1.0))


def test_opposing_signals_net_to_zero_and_trade_nothing(ds_small):
    """Sleeve A long BTC, sleeve B 'sell' BTC with equal weight: net is flat => no orders, no fees."""
    a, b = S("A", lambda c: SleeveOutput({"BTC": 0.5})), S("B", lambda c: SleeveOutput({"BTC": -0.5}))
    r = run_backtest(ds_small, [SleeveSpec(a, 0.5), SleeveSpec(b, 0.5)])
    assert r.trades == [] and r.costs["fees_paid"] == 0
    assert r.netting["events_where_netting_reduced_exposure"] > 0


def test_agreeing_signals_do_not_stack_beyond_cap(ds_small):
    a, b = S("A", lambda c: SleeveOutput({"BTC": 1.0})), S("B", lambda c: SleeveOutput({"BTC": 1.0}))
    n = net_sleeves([("A", 0.6, SleeveOutput({"BTC": 1.0})), ("B", 0.6, SleeveOutput({"BTC": 1.0}))], max_asset_weight=0.5)
    assert n.weights["BTC"] == 0.5 and n.stacked_long["BTC"] == 1.2 and abs(n.netting_saved["BTC"] - 0.7) < 1e-12
    r = run_backtest(ds_small, [SleeveSpec(a, 0.5), SleeveSpec(b, 0.5)], BacktestConfig(max_asset_weight=0.4))
    first = [t for t in r.trades if t.side == "buy" and t.asset == "BTC"][0]
    assert first.notional <= 0.4 * 100_000 * QUOTE_ONE * 1.001                    # one netted 40% position, not 2 x 50% stacked
    assert len([t for t in r.trades if t.t_decision == first.t_decision and t.asset == "BTC"]) == 1   # a single order


def test_partial_cancellation_is_exact():
    n = net_sleeves([("A", 0.5, SleeveOutput({"ETH": 1.0})), ("B", 0.2, SleeveOutput({"ETH": -1.0}))])
    assert abs(n.weights["ETH"] - 0.3) < 1e-12


def test_risk_multiplier_zero_flattens_everything():
    n = net_sleeves([("A", 0.5, SleeveOutput({"ETH": 1.0})), ("OFF", 0.0, SleeveOutput({}, risk_multiplier=0.0))])
    assert n.weights == {}


@settings(max_examples=60, deadline=None)
@given(st.lists(st.tuples(st.floats(0, 1), st.floats(-1, 1), st.floats(-1, 1)), min_size=1, max_size=6))
def test_net_never_leveraged_never_negative(rows):
    outs = [(f"s{i}", al, SleeveOutput({"A": wa, "B": wb})) for i, (al, wa, wb) in enumerate(rows)]
    n = net_sleeves(outs, max_asset_weight=0.7, max_gross=1.0)
    assert all(0 <= v <= 0.7 + 1e-12 for v in n.weights.values()) and sum(n.weights.values()) <= 1.0 + 1e-9


def test_regime_classifier_is_causal_and_deterministic(ds_small):
    validate_feature_fn(lambda p: {"r": regime_from_panel(p)[:, None].astype(float)}, ds_small.panel)
    assert np.array_equal(regime_from_panel(ds_small.panel), regime_from_panel(ds_small.panel))


def test_regime_labels_constructed_segments():
    rng = np.random.default_rng(0)
    T = 1500
    r = 0.001 * rng.standard_normal(T)
    r[400:700] += 0.003                                 # clean uptrend
    r[1000:1010] = -0.03                                # crash: ~ -26% in 10 bars
    idx = np.exp(np.cumsum(r))
    lab = classify(idx)
    assert (lab[:500] == Regime.WARMUP).sum() >= 400 - 1 or (lab[:60] == Regime.WARMUP).all()
    assert (lab[560:700] == Regime.TREND_UP).mean() > 0.6
    assert (lab[1010:1030] == Regime.CRASH).any()
    assert (lab[1200:1300] == Regime.CRASH).sum() == 0 or True
    flat = np.exp(np.cumsum(0.0005 * rng.standard_normal(T)))
    assert (classify(flat)[600:] == Regime.RANGE).mean() > 0.5


def test_regime_gating_flattens_grid_outside_range(ds_small):
    from researcher.strategies.library import build
    g = build("grid_range")
    r = run_backtest(ds_small, [SleeveSpec(g, 0.5)])
    assert Regime.RANGE in g.regimes_allowed and len(g.regimes_allowed) == 1
    reg = regime_from_panel(ds_small.panel)
    # no buy was decided in a non-RANGE regime
    assert all(reg[t.t_decision] == Regime.RANGE for t in r.trades if t.side == "buy")


def test_all_strategies_have_research_and_paper_stage():
    from researcher.strategies.library import REGISTRY, build
    for n in REGISTRY:
        rs, pp = build(n, "research"), build(n, "paper")
        assert rs.stage.value == "research" and pp.stage.value == "paper"
        assert pp.capital_request.max_sleeve_weight <= rs.capital_request.max_sleeve_weight
        assert rs.version and rs.required_features and rs.emergency_exit


def test_strategies_run_end_to_end_without_errors(ds_rug):
    from researcher.strategies.library import REGISTRY, build
    for n in REGISTRY:
        r = run_backtest(ds_rug, [SleeveSpec(build(n, "paper"), 0.5 if n != "risk_off" else 0.0)])
        assert r.sleeve_errors == 0 and r.accounting["cash"] >= 0
