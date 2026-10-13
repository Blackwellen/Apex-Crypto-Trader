"""Runs the engine on REAL public Coinbase candles (majors only => SURVIVORS-ONLY, flagged). Plumbing smoke, not evidence."""
import sys
from researcher.backtest.engine import BacktestConfig, SleeveSpec, run_backtest
from researcher.data.public import PublicDataBlocked, fetch_public_dataset
from researcher.strategies.library import build
from researcher.validation.report import build_report, render_markdown

try:
    ds = fetch_public_dataset(["BTC-USD", "ETH-USD", "SOL-USD"], granularity=3600, n_bars=1500)
except PublicDataBlocked as e:
    print("BLOCKED:", e); sys.exit(2)
sl = [SleeveSpec(build("trend_momentum"), 0.4), SleeveSpec(build("spot_rotation"), 0.3), SleeveSpec(build("risk_off"), 0.0)]
res = run_backtest(ds, sl, BacktestConfig())
rep = build_report(ds, res, n_trials=1, n_boot=300, n_paths=200)
print(render_markdown(rep, "REAL_PUBLIC_API smoke (survivors-only majors)"))
