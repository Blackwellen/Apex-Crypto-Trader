"""Compounding simulator: unit checks of the SQL mirror (no database). The bit-for-bit Postgres cross-check is in test_compounding_pg.py."""
import numpy as np
import pytest
from hypothesis import given
from hypothesis import strategies as st

from researcher.compounding import (TargetPlan, WaterfallError, WaterfallPolicy, apply_waterfall, simulate_compounding, statistical_forecast)
from researcher.provenance import DataProvenance

POL = WaterfallPolicy(4000, 3500, 1500, 1000, tax_provision_bps=1000)


def test_worked_example_matches_hand_calc():
    r = apply_waterfall(1001, 0, WaterfallPolicy(2500, 3333, 1667, 2500, 777))
    # tax=div(1001*777,10000)=77; base=924; vault=div(924*3333,1e4)=307; cross=154; reserve=231; reinvest=remainder
    assert r.parts_tuple() == (1001, 0, 1001, 77, 232, 307, 154, 231)


def test_deficit_recovered_first_and_consumed():
    r = apply_waterfall(1000, 300, POL)
    assert r.deficit_recovered == 300 and r.eligible == 700 and r.new_deficit == 0
    r2 = apply_waterfall(1000, 5000, POL)                       # deficit larger than profit: nothing eligible, deficit shrinks
    assert r2.eligible == 0 and r2.deficit_recovered == 1000 and r2.new_deficit == 4000 and r2.to_reinvest == 0


def test_below_min_ticket_distributes_nothing_but_still_recovers_deficit():
    r = apply_waterfall(500, 100, WaterfallPolicy(10000, 0, 0, 0, 0, min_ticket=1000))
    assert r.eligible == 0 and r.deficit_recovered == 100 and r.new_deficit == 0


def test_no_profit_and_insufficient_available_raise():
    with pytest.raises(WaterfallError, match="no net realised profit"):
        apply_waterfall(0, 0, POL)
    with pytest.raises(WaterfallError, match="no net realised profit"):
        apply_waterfall(-5, 0, POL)
    with pytest.raises(WaterfallError, match="insufficient available"):
        apply_waterfall(1000, 0, POL, available=100)


def test_policy_validation_mirrors_check_constraints():
    with pytest.raises(ValueError):
        WaterfallPolicy(5000, 3000, 1000, 500)                  # sums to 9500
    with pytest.raises(ValueError):
        WaterfallPolicy(10001, 0, 0, -1)


@given(st.integers(1, 10**24), st.integers(0, 10**24), st.integers(0, 10**6), st.lists(st.integers(0, 10000), min_size=3, max_size=3), st.integers(0, 10000))
def test_parts_sum_and_remainder_goes_to_reinvest(pnl, deficit, min_ticket, cuts, tax):
    c = sorted(cuts)
    pol = WaterfallPolicy(c[0], c[1] - c[0], c[2] - c[1], 10000 - c[2], tax, min_ticket)
    r = apply_waterfall(pnl, deficit, pol)
    assert r.deficit_recovered + (pnl - r.deficit_recovered) == r.gross == pnl
    assert r.new_deficit == deficit - r.deficit_recovered
    if r.eligible:                                              # distributed: parts sum to eligible, remainder in reinvest
        assert r.eligible == pnl - r.deficit_recovered
        assert r.tax_provision + r.to_reinvest + r.to_vault + r.to_cross + r.to_reserve == r.eligible
        assert min(r.to_reinvest, r.to_vault, r.to_cross, r.to_reserve, r.tax_provision) >= 0
    else:                                                       # nothing distributed: below min ticket or fully absorbed by deficit
        assert r.tax_provision == r.to_reinvest == r.to_vault == r.to_cross == r.to_reserve == 0
        assert pnl - r.deficit_recovered < max(min_ticket, 1)


def test_scenario_conserves_value_and_separates_target_from_forecast():
    sim = simulate_compounding(1_000_000, [5000, -2000, 8000, 300, -100, 12000], POL, TargetPlan(1_000_000, target_pct_bps=100))
    assert sim["conservation"]["holds"]
    assert sim["kind"] == "TARGET_TRACKING_SCENARIO" and sim["is_forecast"] is False
    tt = sim["target_tracking"]
    assert tt["monitoring_only"] and tt["is_forecast"] is False and tt["target_value"] == 10_000
    assert sim["final"]["deficit"] == 0                         # loss recovered by later profit


def test_deficit_blocks_distribution_after_loss():
    sim = simulate_compounding(1_000_000, [-10_000, 4_000], POL)
    assert sim["final"]["deficit"] == 6_000 and sim["final"]["vault"] == 0 and sim["final"]["reserve"] == 0


def test_forecast_is_withheld_for_synthetic_or_unvalidated():
    r = np.random.default_rng(0).normal(0.01, 0.05, 500)
    syn = statistical_forecast(r, 50, DataProvenance.SYNTHETIC, 10**9, validated_empirical=True)
    assert syn["display_as_forecast"] is False and any("SYNTHETIC" in x for x in syn["withheld_reasons"]) and syn["kind"] == "STATISTICAL_FORECAST"
    real_unvalidated = statistical_forecast(r, 50, DataProvenance.REAL_USER_SUPPLIED, 10**9, validated_empirical=False)
    assert real_unvalidated["display_as_forecast"] is False
    ok = statistical_forecast(r, 50, DataProvenance.REAL_USER_SUPPLIED, 10**9, validated_empirical=True)
    assert ok["display_as_forecast"] is True and ok["terminal_equity_ci"][0] < ok["terminal_equity_ci"][1]
    short = statistical_forecast(r[:20], 50, DataProvenance.REAL_USER_SUPPLIED, 10**9, validated_empirical=True)
    assert short["display_as_forecast"] is False
