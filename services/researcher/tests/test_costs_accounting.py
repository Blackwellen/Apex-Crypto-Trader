from decimal import Decimal

import numpy as np
import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from researcher.backtest.accounting import Account
from researcher.backtest.costs import PRESETS, CostModel
from researcher.backtest.engine import BacktestConfig, SleeveSpec, run_backtest
from researcher.data.synthetic import SyntheticParams, generate
from researcher.regime import Regime
from researcher.strategies.base import CapitalRequest, SleeveOutput, Stage, StrategyDefinition
from researcher.strategies.library import build, common_features
from researcher.units import QUOTE_ONE, notional_units, price_dec, qty_for_value


def buy_hold(asset="BTC", w=0.5):
    def sig(ctx): return SleeveOutput({asset: w})
    return StrategyDefinition("buyhold", "0", Stage.RESEARCH, "x", lambda m: True, frozenset(Regime), ("age",), common_features, sig, CapitalRequest(1.0, 1.0))


def test_no_float_money_in_results(ds_small):
    r = run_backtest(ds_small, [SleeveSpec(build("trend_momentum"), 0.5)])
    assert all(type(x) is int for x in r.equity)
    assert all(type(t.notional) is int and type(t.fee) is int and type(t.gas) is int for t in r.trades)
    assert type(r.accounting["cash"]) is int and type(r.costs["fees_paid"]) is int


@settings(max_examples=12, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(seed=st.integers(1, 10_000), venue=st.sampled_from(["cex", "dex"]))
def test_accounting_identity_and_no_negative_cash(seed, venue):
    ds = generate(SyntheticParams(seed=seed, n_bars=700))
    r = run_backtest(ds, [SleeveSpec(build("trend_momentum"), 0.4), SleeveSpec(build("breakout_volatility"), 0.3), SleeveSpec(build("risk_off"), 0.0)],
                     BacktestConfig(cost=PRESETS[venue], seed=seed))
    a = r.accounting
    assert a["cash"] >= 0 and min(r.equity) > 0
    assert a["flat_at_end"] and a["identity_holds_when_flat"]       # cash == initial + realized - unattributed (exact integers)
    assert a["final_equity"] == a["cash"]


def test_failed_tx_burns_gas_and_never_fills(ds_small):
    cost = CostModel(venue="dex", fail_prob=1.0)
    r = run_backtest(ds_small, [SleeveSpec(buy_hold(), 1.0)], BacktestConfig(cost=cost))
    assert r.costs["failed_tx_count"] > 0
    assert all(t.status == "failed_tx" for t in r.trades)
    assert r.accounting["cash"] == r.accounting["initial_cash"] - r.accounting["unattributed_costs"]
    assert r.accounting["unattributed_costs"] == cost.gas_cost_units() * r.costs["failed_tx_count"]


def test_higher_costs_reduce_equity_same_signals(ds_small):
    base = run_backtest(ds_small, [SleeveSpec(build("trend_momentum"), 0.5)], BacktestConfig(cost=CostModel()))
    dear = run_backtest(ds_small, [SleeveSpec(build("trend_momentum"), 0.5)], BacktestConfig(cost=CostModel().stressed(cost_mult=3.0)))
    assert dear.costs["total_explicit_and_slippage"] > base.costs["total_explicit_and_slippage"]
    assert dear.accounting["final_equity"] < base.accounting["final_equity"]


def test_gas_spike_hits_dex_only(ds_small):
    d1 = CostModel(venue="dex"); d2 = d1.stressed(gas_mult=10)
    assert d2.gas_cost_units() == pytest.approx(10 * d1.gas_cost_units(), rel=1e-6)
    assert CostModel(venue="cex").gas_cost_units() == 0


def test_roundtrip_estimate_components():
    cex, dex = PRESETS["cex"], PRESETS["dex"]
    qv = 5_000_000 * QUOTE_ONE
    small, big = 1_000 * QUOTE_ONE, 100_000 * QUOTE_ONE
    assert cex.roundtrip_cost_bps(big, qv) > cex.roundtrip_cost_bps(small, qv)          # depth-based impact grows with size
    assert dex.roundtrip_cost_bps(small, qv) > cex.roundtrip_cost_bps(small, qv)         # gas + failed-tx drag on small tickets
    # gas drag is ~ 2*gas/notional (with retry inflation)
    g = dex.gas_cost_units()
    assert dex.roundtrip_cost_bps(small, qv) >= 2 * g / small * 1e4


def test_participation_cap_gives_partial_fill():
    c = CostModel(max_participation=0.01)
    r = c.execute("buy", 10_000 * 10**8, Decimal("100"), 1_000_000 * QUOTE_ONE, 0.5)
    assert r.status == "partial" and 0 < r.qty_units < 10_000 * 10**8
    assert notional_units(r.qty_units, Decimal("100"), round_up=True) <= 0.0101 * 1_000_000 * QUOTE_ONE


def test_zero_volume_bar_means_no_fill():
    assert CostModel().execute("buy", 10**8, Decimal("100"), 0, 0.5).status == "no_liquidity"


def test_cost_gate_blocks_thin_edge(ds_small):
    thin = lambda ctx: SleeveOutput({"BTC": 0.5}, expected_edge_bps={"BTC": 5.0})
    s = StrategyDefinition("thin", "0", Stage.RESEARCH, "x", lambda m: True, frozenset(Regime), ("age",), common_features, thin, CapitalRequest(1.0, 1.0))
    r = run_backtest(ds_small, [SleeveSpec(s, 1.0)])
    assert r.costs["cost_gated_orders"] > 0 and not [t for t in r.trades if t.side == "buy"]


@given(qty=st.integers(1, 10**13), px=st.floats(0.0001, 1e6, allow_nan=False), fee=st.integers(0, 10_000))
def test_account_buy_sell_conserves(qty, px, fee):
    p = price_dec(px)
    n = notional_units(qty, p, round_up=True)
    a = Account(10**30)
    a.buy("X", qty, n, fee, 7, 0)
    q1 = qty // 3
    if q1 > 0:
        a.sell("X", q1, notional_units(q1, p, round_up=False), fee, 3, 0)
    a.sell("X", a.pos("X").qty, notional_units(a.pos("X").qty, p, round_up=False), fee, 3, 0) if a.pos("X").qty else None
    assert a.pos("X").qty == 0 and a.pos("X").basis == 0
    assert a.cash == a.initial_cash + a.realized


def test_delisted_asset_forced_writeoff_and_survivorship_effect(ds_rug):
    """Holding rugged memes loses money when delisted assets are in the dataset; dropping them hides that loss."""
    from researcher.data.synthetic import SyntheticParams, generate
    from researcher.strategies.probes import buy_every_live_meme
    s = buy_every_live_meme()
    full = ds_rug
    surv = generate(SyntheticParams(seed=2, n_bars=3000, include_delisted=False))
    assert full.survivorship.includes_delisted and full.survivorship.delisted_assets_in_dataset > 0
    assert surv.survivorship.includes_delisted is False
    cfg = BacktestConfig(max_asset_weight=0.3, max_gross=0.9)
    rf, rs = run_backtest(full, [SleeveSpec(s, 1.0)], cfg), run_backtest(surv, [SleeveSpec(s, 1.0)], cfg)
    assert any(t.status == "delist_writeoff" for t in rf.trades)
    assert any("SURVIVORSHIP" in w for w in rs.warnings) and not any("SURVIVORSHIP" in w for w in rf.warnings)
    assert rs.accounting["final_equity"] > rf.accounting["final_equity"]       # survivors-only looks better (bias)
