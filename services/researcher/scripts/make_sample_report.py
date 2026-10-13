"""Generates the SYNTHETIC sample backtest report (docs/evidence/python-sample-backtest-report-SYNTHETIC.md)."""
import sys
import time
from pathlib import Path

from researcher.backtest.engine import BacktestConfig, SleeveSpec, run_backtest
from researcher.data.synthetic import SyntheticParams, generate
from researcher.strategies.library import build
from researcher.strategies.probes import buy_every_live_meme
from researcher.validation.report import build_report, render_markdown
from researcher.validation.walkforward import make_folds, oos_holdout, walk_forward

out = Path(sys.argv[1])
SEED, N = 7, 4000
t0 = time.time()
cfg = BacktestConfig(seed=SEED)
mix = lambda: [SleeveSpec(build("trend_momentum"), 0.25), SleeveSpec(build("mean_reversion"), 0.15), SleeveSpec(build("breakout_volatility"), 0.15),
               SleeveSpec(build("statistical_pairs"), 0.10), SleeveSpec(build("grid_range"), 0.10), SleeveSpec(build("spot_rotation"), 0.15), SleeveSpec(build("risk_off"), 0.0)]
full = generate(SyntheticParams(seed=SEED, n_bars=N, include_delisted=True))
surv = generate(SyntheticParams(seed=SEED, n_bars=N, include_delisted=False))
res = run_backtest(full, mix(), cfg)
mk = lambda p: [SleeveSpec(build("trend_momentum", fast=p["fast"], slow=p["slow"]), 0.5), SleeveSpec(build("risk_off"), 0.0)]
grid = {"fast": [12, 24], "slow": [96, 168]}
wf = walk_forward(full, mk, grid, make_folds(N, 1200, 600, 600), cfg, min_trades=3)
ho = oos_holdout(full, mk, {"fast": 24, "slow": 120}, cfg)
rep = build_report(full, res, n_trials=wf["n_trials_for_deflation"], walk_forward=wf, holdout=ho, n_boot=500, n_paths=400)
md = render_markdown(rep, "SYNTHETIC sample backtest report (7 strategies netted at portfolio level)")
rs = run_backtest(surv, mix(), cfg)
pc = BacktestConfig(seed=SEED, max_asset_weight=0.3, max_gross=0.9)
pf, ps = run_backtest(full, [SleeveSpec(buy_every_live_meme(), 1.0)], pc), run_backtest(surv, [SleeveSpec(buy_every_live_meme(), 1.0)], pc)
row = lambda name, inc, n, r: f"| {name} | {inc} | {n} | {r.accounting['final_equity'] / 1e6:,.2f} | {r.metrics['total_return']:.3f} | {r.metrics['max_drawdown']:.3f} |"
md += f"""
## Survivorship demonstration (same seed)

The 7-strategy mix above trades liquid majors only, so it never touches the rugged meme assets and the full vs survivors-only runs are identical (as expected;
this is not evidence that survivorship does not matter). To show the mechanism, a naive probe that buys every live meme token (NOT a registered strategy) is run on both datasets.

| dataset / strategy | includes_delisted | delisted assets | final equity (quote units) | total return | max drawdown |
|---|---|---|---|---|---|
{row("full / 7-strategy mix", True, rep['survivorship']['delisted_assets_in_dataset'], res)}
{row("survivors-only / 7-strategy mix", False, 0, rs)}
{row("full / buy-every-meme probe", True, rep['survivorship']['delisted_assets_in_dataset'], pf)}
{row("survivors-only / buy-every-meme probe", False, 0, ps)}

Delist write-offs in the full probe run: {sum(1 for t in pf.trades if t.status == 'delist_writeoff')}. Survivors-only warning carried by the run: {rs.warnings}.

"""
md += f"""
## Reproduction

`cd services/researcher && .venv/bin/python scripts/make_sample_report.py <out.md>` (seed={SEED}, n_bars={N}); generated in {time.time() - t0:.0f}s, strategy config hash `{res.config_hash}`.
No strategy parameters were tuned to improve these numbers; with synthetic data tuning would be meaningless anyway.
"""
out.write_text(md)
print("wrote", out, f"{time.time() - t0:.0f}s")
