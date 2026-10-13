# SYNTHETIC sample backtest report (7 strategies netted at portfolio level)

> **DATA PROVENANCE: SYNTHETIC. These numbers come from a seeded random generator, not from any market. They test the plumbing and the statistics code. They are NOT evidence that any strategy has an edge.**

**data_provenance: SYNTHETIC**  |  edge claim: NONE - synthetic data cannot demonstrate an edge

## Survivorship

- includes_delisted: `True` (delisted assets present: 1)
- bias flag: **DELISTED_INCLUDED**
- Dataset declares delisted/rugged assets are included.
- note: synthetic universe incl. rugged/delisted memes

## Setup

- dataset: synthetic generator seed=7 n_bars=4000
- strategies: trend_momentum@1.0.0:research, mean_reversion@1.0.0:research, breakout_volatility@1.0.0:research, statistical_pairs@1.0.0:research, grid_range@1.0.0:research, spot_rotation@1.0.0:research, risk_off@1.0.0:research
- no-lookahead: orders decided at close t, filled at open t+1; truncation + future-perturbation invariance at sampled checkpoints (not a proof)

## Point metrics (single in-sample path)

- total_return: -0.074
- cagr: -0.154
- ann_vol: 0.301
- sharpe: -0.405
- sortino: -0.534
- max_drawdown: -0.256
- calmar: -0.603
- n_closed_trades: 514.000
- win_rate_closed_trades: 0.471
- turnover_x_equity: 70.689

## Metric uncertainty

Stationary block bootstrap, 90% interval, 500 resamples, mean block 64 bars:

| metric | point | CI low | CI high |
|---|---|---|---|
| sharpe | -0.405 | -2.832 | 2.136 |
| cagr | -0.154 | -0.591 | 0.852 |
| max_drawdown | -0.256 | -0.385 | -0.122 |
| total_return | -0.074 | -0.335 | 0.325 |

- bootstrap P(Sharpe <= 0): 0.644; probabilistic Sharpe (P(SR>0)): 0.392; deflated Sharpe prob (n_trials=16): 0.392

## Costs (integer quote micro-units)

- fees: 12524733390, gas: 0, slippage+spread: 3388480197, total: 15913213587
- cost drag as fraction of initial equity: 0.159; failed tx: 0; partial fills: 0; cost-gated orders: 0
- accounting identity when flat (cash == initial + realized - unattributed): True
- netting: 1109 decisions where competing signals netted; 321.580 cumulative weight not stacked

## Monte Carlo with stress (resampling, not a forecast)

| scenario | terminal multiple median [CI] | max DD median [CI] | P(loss) | P(DD>30%) | P(DD>50%) |
|---|---|---|---|---|---|
| baseline | 0.909 [0.661, 1.325] | -0.232 [-0.385, -0.119] | 0.695 | 0.253 | 0.005 |
| vol_x2 | 0.833 [0.470, 1.695] | -0.404 [-0.625, -0.243] | 0.675 | 0.825 | 0.247 |
| edge_halved | 0.948 [0.679, 1.352] | -0.214 [-0.383, -0.121] | 0.610 | 0.212 | 0.000 |
| edge_gone | 0.988 [0.693, 1.338] | -0.205 [-0.376, -0.114] | 0.530 | 0.155 | 0.003 |
| costs_x2 | 0.782 [0.573, 1.177] | -0.299 [-0.467, -0.152] | 0.860 | 0.497 | 0.025 |
| crash_shock_-25pct | 0.688 [0.494, 0.959] | -0.410 [-0.553, -0.296] | 0.970 | 0.948 | 0.150 |
| combined_stress | 0.637 [0.382, 1.087] | -0.477 [-0.660, -0.297] | 0.920 | 0.945 | 0.420 |

Block-bootstrap resampling of in-sample returns under stated stresses. Not a forecast; it cannot represent regimes absent from the sample.

## Walk-forward (params chosen on train only)

- folds: 4, OOS bars: 2396, param combos: 4
- mean in-sample objective: -4.681 vs mean out-of-sample: -4.145
- pooled OOS Sharpe -4.181 CI [-7.753, -0.751]

| fold | train | test | chosen | IS | OOS |
|---|---|---|---|---|---|
| 0 | (0, 1200) | (1224, 1824) | {'fast': 12, 'slow': 96} | -6.400 | 0.697 |
| 1 | (600, 1800) | (1824, 2424) | {'fast': 12, 'slow': 96} | -4.627 | -4.593 |
| 2 | (1200, 2400) | (2424, 3024) | {'fast': 12, 'slow': 168} | -2.205 | -9.873 |
| 3 | (1800, 3000) | (3024, 3624) | {'fast': 12, 'slow': 96} | -5.492 | -2.811 |

## Frozen holdout

- holdout bars (3024, 4000), params {'fast': 24, 'slow': 120}
- holdout Sharpe 0.881, total return 0.024, max DD -0.111

## Limitations

- SYNTHETIC DATA: nothing here is evidence of edge on any real market.
- Single path of one dataset; intervals assume return stationarity within the sample.
- Fills use next-bar open plus a stylised book-depth model, not recorded order books or queue position.
- No claim about latency or HFT: bar data has no wire-to-fill measurement (finding 21).

## Survivorship demonstration (same seed)

The 7-strategy mix above trades liquid majors only, so it never touches the rugged meme assets and the full vs survivors-only runs are identical (as expected;
this is not evidence that survivorship does not matter). To show the mechanism, a naive probe that buys every live meme token (NOT a registered strategy) is run on both datasets.

| dataset / strategy | includes_delisted | delisted assets | final equity (quote units) | total return | max drawdown |
|---|---|---|---|---|---|
| full / 7-strategy mix | True | 1 | 92,636.46 | -0.074 | -0.256 |
| survivors-only / 7-strategy mix | False | 0 | 92,636.46 | -0.074 | -0.256 |
| full / buy-every-meme probe | True | 1 | 275,003.54 | 1.750 | -0.692 |
| survivors-only / buy-every-meme probe | False | 0 | 340,450.80 | 2.405 | -0.150 |

Delist write-offs in the full probe run: 1. Survivors-only warning carried by the run: ['SURVIVORSHIP BIAS: dataset excludes delisted/rugged assets; results are optimistically biased'].


## Reproduction

`cd services/researcher && .venv/bin/python scripts/make_sample_report.py <out.md>` (seed=7, n_bars=4000); generated in 25s, strategy config hash `4f03f02f7e2fc8b2`.
No strategy parameters were tuned to improve these numbers; with synthetic data tuning would be meaningless anyway.
