import numpy as np
import polars as pl
import pytest

from researcher.backtest.engine import BacktestConfig, SleeveSpec, run_backtest
from researcher.data.dataset import Dataset, SurvivorshipDeclaration, SurvivorshipUndeclared
from researcher.data.loader import load_ohlcv, write_ohlcv
from researcher.data.synthetic import SyntheticParams, generate
from researcher.provenance import DataProvenance, assert_labelled
from researcher.strategies.library import build
from researcher.validation.report import build_report, render_markdown
from researcher.validation.stats import bootstrap_metrics, deflated_sharpe, monte_carlo_stress, probabilistic_sharpe
from researcher.validation.walkforward import make_folds, holdout_split, oos_holdout, walk_forward


# ---------------------------------------------------------------- synthetic generator
def test_synthetic_is_deterministic_and_always_labelled():
    a, b = generate(SyntheticParams(seed=11, n_bars=800)), generate(SyntheticParams(seed=11, n_bars=800))
    assert np.array_equal(a.panel.close, b.panel.close)
    assert not np.array_equal(a.panel.close, generate(SyntheticParams(seed=12, n_bars=800)).panel.close)
    assert a.provenance is DataProvenance.SYNTHETIC and a.label()["data_provenance"] == "SYNTHETIC"


def test_synthetic_has_fat_tails_jumps_regimes_and_rugs(ds_rug):
    r = np.diff(np.log(ds_rug.panel.close[:, 0]))
    z = (r - r.mean()) / r.std()
    assert (z ** 4).mean() > 4.0                                  # excess kurtosis (normal = 3)
    assert ds_rug.generator_params["regime_counts"]["crash"] > 0
    rugged = [m for m in ds_rug.panel.meta.values() if m.delisted_at is not None]
    assert rugged, "expected at least one rugged/delisted asset for this seed"
    m = rugged[0]; j = ds_rug.panel.assets.index(m.symbol)
    pre, post = ds_rug.panel.close[m.delisted_at - 8, j], ds_rug.panel.close[m.delisted_at - 1, j]
    assert post < 0.2 * pre                                       # collapse before delisting
    assert not ds_rug.panel.alive[m.delisted_at:, j].any() and ds_rug.panel.volume[m.delisted_at:, j].sum() == 0


def test_survivors_only_dataset_declares_itself():
    s = generate(SyntheticParams(seed=2, n_bars=3000, include_delisted=False))
    assert s.survivorship.includes_delisted is False and "DROPPED" in s.survivorship.universe_note
    assert s.survivorship.bias_flag == "SURVIVORSHIP_BIAS_PRESENT"


# ---------------------------------------------------------------- loader (small GENERATED file, not real data)
@pytest.mark.parametrize("ext", ["csv", "parquet"])
def test_loader_roundtrip_generated_file(tmp_path, ext):
    src = generate(SyntheticParams(seed=5, n_bars=400, n_memes=0, pair_asset=None))
    f = tmp_path / f"ohlcv.{ext}"
    write_ohlcv(src, f)
    ds = load_ohlcv(f, provenance=DataProvenance.SYNTHETIC, survivorship=SurvivorshipDeclaration(False, 0, "generated test file"), bar_seconds=3600)
    assert ds.panel.assets == tuple(sorted(src.panel.assets)) and ds.panel.T == 400
    j = ds.panel.assets.index("ETH"); k = src.panel.assets.index("ETH")
    assert np.allclose(ds.panel.close[:, j], src.panel.close[:, k], rtol=1e-12)
    assert ds.provenance is DataProvenance.SYNTHETIC
    res = run_backtest(ds, [SleeveSpec(build("trend_momentum"), 0.5)])
    assert res.data_provenance == "SYNTHETIC"


def test_loader_requires_provenance_and_survivorship_declaration(tmp_path):
    src = generate(SyntheticParams(seed=5, n_bars=300, n_memes=0, pair_asset=None))
    f = tmp_path / "x.csv"; write_ohlcv(src, f)
    with pytest.raises(TypeError):
        load_ohlcv(f, bar_seconds=3600)                                       # no defaults for provenance/survivorship
    with pytest.raises(SurvivorshipUndeclared):
        load_ohlcv(f, provenance=DataProvenance.REAL_USER_SUPPLIED, survivorship=SurvivorshipDeclaration(None), bar_seconds=3600)


def test_loader_rejects_bad_files(tmp_path):
    bad = tmp_path / "bad.csv"; pl.DataFrame({"timestamp": [0, 3600], "symbol": ["A", "A"], "open": [1.0, 1.0]}).write_csv(bad)
    with pytest.raises(ValueError):
        load_ohlcv(bad, provenance=DataProvenance.REAL_USER_SUPPLIED, survivorship=SurvivorshipDeclaration(True, 0), bar_seconds=3600)


def test_loader_data_ending_early_is_treated_as_delisted(tmp_path):
    rows = []
    for s, n in (("AAA", 300), ("BBB", 200)):
        for i in range(n):
            p = 10 + i * 0.01
            rows.append((1_600_000_000 + i * 3600, s, p, p * 1.01, p * 0.99, p, 1000.0))
    f = tmp_path / "y.csv"
    pl.DataFrame(rows, schema=["timestamp", "symbol", "open", "high", "low", "close", "volume"], orient="row").write_csv(f)
    ds = load_ohlcv(f, provenance=DataProvenance.REAL_USER_SUPPLIED, survivorship=SurvivorshipDeclaration(True, 1, "test"), bar_seconds=3600, terminal_recovery_ppm=0)
    assert ds.panel.meta["BBB"].delisted_at == 200 and ds.panel.meta["AAA"].delisted_at is None


# ---------------------------------------------------------------- walk-forward / OOS
def test_folds_never_overlap_and_respect_embargo():
    folds = make_folds(5000, 1000, 500, 500, embargo=24)
    assert len(folds) >= 5
    for f in folds:
        assert f.train[1] + 24 == f.test[0] and f.test[1] <= 5000 and f.train[0] < f.train[1]
    tests = [f.test for f in folds]
    assert all(a[1] <= b[0] for a, b in zip(tests, tests[1:]))                # OOS windows do not overlap each other
    h = holdout_split(1000, 0.25)
    assert h.train[1] < h.test[0] and h.test[1] == 1000


def test_walk_forward_selects_on_train_only(ds_small):
    mk = lambda p: [SleeveSpec(build("trend_momentum", slow=p["slow"], fast=24), 0.5)]    # noqa: E731
    wf = walk_forward(ds_small, mk, {"slow": [96, 168]}, make_folds(ds_small.panel.T, 500, 250, 250), BacktestConfig(), min_trades=1)
    assert wf["data_provenance"] == "SYNTHETIC" and wf["n_param_combinations"] == 2
    ok = [f for f in wf["folds"] if f["status"] == "OK"]
    assert ok and all(f["test"][0] >= f["train"][1] for f in ok)
    assert wf["n_oos_bars"] == sum(f["test"][1] - f["test"][0] - 1 for f in ok)          # one equity point per bar => bars-1 returns
    ho = oos_holdout(ds_small, mk, {"slow": 120}, BacktestConfig())
    assert ho["holdout_bars"][0] > ho["train_bars"][1]


# ---------------------------------------------------------------- uncertainty
def test_bootstrap_ci_brackets_point_and_widens_for_short_samples():
    rng = np.random.default_rng(1)
    long = rng.normal(0.0002, 0.01, 4000); short = long[:300]
    bl, bs = bootstrap_metrics(long, 8766, n_boot=200), bootstrap_metrics(short, 8766, n_boot=200)
    for b in (bl, bs):
        assert b["sharpe"]["ci_low"] <= b["sharpe"]["point"] <= b["sharpe"]["ci_high"]
    assert (bs["sharpe"]["ci_high"] - bs["sharpe"]["ci_low"]) > 1.5 * (bl["sharpe"]["ci_high"] - bl["sharpe"]["ci_low"])
    assert bootstrap_metrics(np.zeros(5), 8766)["status"] == "INSUFFICIENT_DATA"


def test_noise_has_no_significant_edge():
    r = np.random.default_rng(9).normal(0, 0.01, 3000)
    assert probabilistic_sharpe(r, 0.0) < 0.99
    assert deflated_sharpe(r, 50, 0.01 ** 2) < 0.95


def test_monte_carlo_stress_is_ordered():
    r = np.random.default_rng(2).normal(0.0, 0.01, 1500)
    r = r - r.mean() + 0.0004                       # exact sample mean so the ordering is deterministic
    mc = monte_carlo_stress(r, 8766, cost_per_bar=0.0002, n_paths=200)
    sc = mc["scenarios"]
    assert sc["combined_stress"]["terminal_multiple_median"] < sc["baseline"]["terminal_multiple_median"]
    assert sc["vol_x2"]["max_drawdown_median"] < sc["baseline"]["max_drawdown_median"]
    assert sc["edge_gone"]["terminal_multiple_median"] < sc["baseline"]["terminal_multiple_median"]
    assert "not a forecast" in mc["disclaimer"].lower() or "Not a forecast" in mc["disclaimer"]


# ---------------------------------------------------------------- report
def test_report_refuses_undeclared_survivorship(ds_small):
    undeclared = Dataset(ds_small.panel, DataProvenance.SYNTHETIC, SurvivorshipDeclaration(None), "x")
    with pytest.raises(SurvivorshipUndeclared):
        run_backtest(undeclared, [SleeveSpec(build("trend_momentum"), 0.5)])
    res = run_backtest(ds_small, [SleeveSpec(build("trend_momentum"), 0.5)])
    with pytest.raises(SurvivorshipUndeclared):
        build_report(undeclared, res)


def test_report_labels_synthetic_and_flags_survivorship():
    s = generate(SyntheticParams(seed=2, n_bars=1200, include_delisted=False))
    res = run_backtest(s, [SleeveSpec(build("trend_momentum"), 0.5)])
    rep = build_report(s, res, n_boot=60, n_paths=60)
    assert_labelled(rep)
    assert rep["data_provenance"] == "SYNTHETIC" and rep["edge_claim"].startswith("NONE")
    assert rep["survivorship"]["bias_flag"] == "SURVIVORSHIP_BIAS_PRESENT"
    md = render_markdown(rep)
    assert "SYNTHETIC" in md.splitlines()[2] and "SURVIVORSHIP_BIAS_PRESENT" in md and "NOT evidence" in md
    assert rep["metric_uncertainty"]["status"] in ("OK", "INSUFFICIENT_DATA") and "ci_low" in rep["metric_uncertainty"]["sharpe"]
