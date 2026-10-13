# REAL_PUBLIC_API smoke (survivors-only majors)

> **DATA PROVENANCE: REAL_PUBLIC_API. Real data does not by itself demonstrate an edge: check survivorship, costs, sample length and out-of-sample results before drawing conclusions.**

**data_provenance: REAL_PUBLIC_API**  |  edge claim: UNPROVEN - see confidence intervals, out-of-sample and survivorship sections

## Survivorship

- includes_delisted: `False` (delisted assets present: 0)
- bias flag: **SURVIVORSHIP_BIAS_PRESENT**
- Dataset excludes delisted/rugged assets: results are optimistically biased (finding 28).
- note: currently-listed majors only; delisted/rugged assets NOT included

## Setup

- dataset: coinbase-exchange public candles BTC-USD,ETH-USD,SOL-USD granularity=3600s
- strategies: trend_momentum@1.0.0:research, spot_rotation@1.0.0:research, risk_off@1.0.0:research
- no-lookahead: orders decided at close t, filled at open t+1; truncation + future-perturbation invariance at sampled checkpoints (not a proof)

## Point metrics (single in-sample path)

- total_return: -0.095
- cagr: -0.443
- ann_vol: 0.165
- sharpe: -3.478
- sortino: -4.698
- max_drawdown: -0.096
- calmar: -4.633
- n_closed_trades: 103.000
- win_rate_closed_trades: 0.214
- turnover_x_equity: 31.377

## Metric uncertainty

Stationary block bootstrap, 90% interval, 300 resamples, mean block 44 bars:

| metric | point | CI low | CI high |
|---|---|---|---|
| sharpe | -3.478 | -8.256 | 1.125 |
| cagr | -0.443 | -0.740 | 0.180 |
| max_drawdown | -0.096 | -0.221 | -0.053 |
| total_return | -0.095 | -0.206 | 0.029 |

- bootstrap P(Sharpe <= 0): 0.870; probabilistic Sharpe (P(SR>0)): 0.076; deflated Sharpe prob (n_trials=1): 0.076

## Costs (integer quote micro-units)

- fees: 6041838402, gas: 0, slippage+spread: 1613777654, total: 7655616056
- cost drag as fraction of initial equity: 0.077; failed tx: 0; partial fills: 0; cost-gated orders: 0
- accounting identity when flat (cash == initial + realized - unattributed): True
- netting: 80 decisions where competing signals netted; 24.200 cumulative weight not stacked

## Monte Carlo with stress (resampling, not a forecast)

| scenario | terminal multiple median [CI] | max DD median [CI] | P(loss) | P(DD>30%) | P(DD>50%) |
|---|---|---|---|---|---|
| baseline | 0.908 [0.791, 1.022] | -0.130 [-0.221, -0.058] | 0.880 | 0.000 | 0.000 |
| vol_x2 | 0.876 [0.694, 1.162] | -0.208 [-0.336, -0.091] | 0.765 | 0.140 | 0.000 |
| edge_halved | 0.944 [0.833, 1.053] | -0.109 [-0.188, -0.056] | 0.795 | 0.000 | 0.000 |
| edge_gone | 0.997 [0.889, 1.137] | -0.085 [-0.159, -0.046] | 0.525 | 0.000 | 0.000 |
| costs_x2 | 0.828 [0.742, 0.945] | -0.191 [-0.272, -0.107] | 0.985 | 0.015 | 0.000 |
| crash_shock_-25pct | 0.676 [0.595, 0.777] | -0.342 [-0.412, -0.286] | 1.000 | 0.905 | 0.000 |
| combined_stress | 0.708 [0.587, 0.854] | -0.327 [-0.430, -0.245] | 0.995 | 0.690 | 0.000 |

Block-bootstrap resampling of in-sample returns under stated stresses. Not a forecast; it cannot represent regimes absent from the sample.

## Warnings

- SURVIVORSHIP BIAS: dataset excludes delisted/rugged assets; results are optimistically biased

## Limitations

- Single path of one dataset; intervals assume return stationarity within the sample.
- Fills use next-bar open plus a stylised book-depth model, not recorded order books or queue position.
- No claim about latency or HFT: bar data has no wire-to-fill measurement (finding 21).

