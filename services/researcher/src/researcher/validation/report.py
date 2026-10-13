"""Research report builder. Refuses to hide survivorship; always carries provenance + uncertainty."""
from __future__ import annotations

import numpy as np

from ..backtest.engine import BacktestResult
from ..backtest.metrics import returns_from_equity
from ..data.dataset import Dataset, SurvivorshipUndeclared
from ..provenance import DataProvenance, banner_for, edge_claim_for
from .stats import bootstrap_metrics, deflated_sharpe, monte_carlo_stress


def build_report(ds: Dataset, res: BacktestResult, *, n_trials: int = 1, walk_forward: dict | None = None, holdout: dict | None = None,
                 n_boot: int = 400, n_paths: int = 300, seed: int = 11) -> dict:
    """Raises SurvivorshipUndeclared when the dataset did not declare whether delisted/rugged assets are included."""
    ds.survivorship.require()
    prov = ds.provenance
    r = returns_from_equity(res.equity)
    bpy = res.bars_per_year
    cost_per_bar = float(res.costs["total_explicit_and_slippage"]) / max(1, len(r)) / res.accounting["initial_cash"]
    boot = bootstrap_metrics(r, bpy, n_boot=n_boot, seed=seed)
    mc = monte_carlo_stress(r, bpy, cost_per_bar, n_paths=n_paths, seed=seed)
    surv = {**ds.label()["survivorship"], "refusal_rule": "report cannot be built when includes_delisted is undeclared",
            "interpretation": ("Dataset excludes delisted/rugged assets: results are optimistically biased (finding 28)."
                               if ds.survivorship.includes_delisted is False else
                               "Dataset declares delisted/rugged assets are included." +
                               (" None are actually present in this sample." if ds.survivorship.delisted_assets_in_dataset == 0 else ""))}
    rep = {
        "data_provenance": prov.value,
        "provenance_banner": banner_for(prov),
        "edge_claim": edge_claim_for(prov),
        "dataset": ds.label(),
        "survivorship": surv,
        "strategies": res.strategies,
        "no_lookahead": {"validated_feature_sets": res.lookahead_validated, "execution": "orders decided at close t, filled at open t+1",
                         "method": "truncation + future-perturbation invariance at sampled checkpoints (not a proof)"},
        "point_metrics": res.metrics,
        "metric_uncertainty": boot,
        "deflated_sharpe_prob": deflated_sharpe(r, n_trials, 0.0) if len(r) > 30 else None,
        "n_trials_assumed": n_trials,
        "costs": {k: v for k, v in res.costs.items() if k != "cost_model"},
        "cost_model": res.costs["cost_model"],
        "accounting": res.accounting,
        "netting": res.netting,
        "monte_carlo_stress": mc,
        "regime_counts": res.regime_counts,
        "warnings": list(res.warnings),
        "limitations": [
            "Single path of one dataset; intervals assume return stationarity within the sample.",
            "Fills use next-bar open plus a stylised book-depth model, not recorded order books or queue position.",
            "No claim about latency or HFT: bar data has no wire-to-fill measurement (finding 21).",
        ],
    }
    if prov is DataProvenance.SYNTHETIC:
        rep["limitations"].insert(0, "SYNTHETIC DATA: nothing here is evidence of edge on any real market.")
    if walk_forward is not None:
        pooled = walk_forward.get("pooled_oos_returns", np.array([]))
        rep["walk_forward"] = {**{k: v for k, v in walk_forward.items() if k != "pooled_oos_returns"},
                               "pooled_oos_uncertainty": bootstrap_metrics(np.asarray(pooled), bpy, n_boot=n_boot, seed=seed) if len(pooled) else None}
    if holdout is not None:
        rep["holdout"] = {k: v for k, v in holdout.items() if k not in ("holdout_equity", "holdout_result")}
    return rep


def _f(x, nd=3):
    return "n/a" if x is None else (f"{x:.{nd}f}" if isinstance(x, (int, float)) else str(x))


def render_markdown(rep: dict, title: str = "Backtest report") -> str:
    m, u = rep["point_metrics"], rep["metric_uncertainty"]
    L = [f"# {title}", "", f"> **{rep['provenance_banner']}**", "", f"**data_provenance: {rep['data_provenance']}**  |  edge claim: {rep['edge_claim']}", "",
         "## Survivorship", "", f"- includes_delisted: `{rep['survivorship']['includes_delisted']}` (delisted assets present: {rep['survivorship']['delisted_assets_in_dataset']})",
         f"- bias flag: **{rep['survivorship']['bias_flag']}**", f"- {rep['survivorship']['interpretation']}", f"- note: {rep['survivorship']['note']}", "",
         "## Setup", "", f"- dataset: {rep['dataset']['source']}", f"- strategies: {', '.join(rep['strategies'])}",
         f"- no-lookahead: {rep['no_lookahead']['execution']}; {rep['no_lookahead']['method']}", "",
         "## Point metrics (single in-sample path)", ""]
    for k in ("total_return", "cagr", "ann_vol", "sharpe", "sortino", "max_drawdown", "calmar", "n_closed_trades", "win_rate_closed_trades", "turnover_x_equity"):
        L.append(f"- {k}: {_f(m.get(k))}")
    L += ["", "## Metric uncertainty", ""]
    if u.get("status") == "OK":
        L.append(f"Stationary block bootstrap, {int(u['method']['level'] * 100)}% interval, {u['method']['n_boot']} resamples, mean block {u['method']['mean_block_bars']} bars:")
        L.append("")
        L.append("| metric | point | CI low | CI high |")
        L.append("|---|---|---|---|")
        for k in ("sharpe", "cagr", "max_drawdown", "total_return"):
            L.append(f"| {k} | {_f(u[k]['point'])} | {_f(u[k]['ci_low'])} | {_f(u[k]['ci_high'])} |")
        L.append("")
        L.append(f"- bootstrap P(Sharpe <= 0): {_f(u['prob_sharpe_leq_0_bootstrap'])}; probabilistic Sharpe (P(SR>0)): {_f(u['psr_sharpe_gt_0'])}; "
                 f"deflated Sharpe prob (n_trials={rep['n_trials_assumed']}): {_f(rep['deflated_sharpe_prob'])}")
    else:
        L.append(f"INSUFFICIENT DATA ({u.get('n_obs')} obs): no intervals produced.")
    c = rep["costs"]
    L += ["", "## Costs (integer quote micro-units)", "",
          f"- fees: {c['fees_paid']}, gas: {c['gas_paid']}, slippage+spread: {c['slippage_and_spread_paid']}, total: {c['total_explicit_and_slippage']}",
          f"- cost drag as fraction of initial equity: {_f(c['cost_drag_pct_of_initial'])}; failed tx: {c['failed_tx_count']}; partial fills: {c['partial_fill_count']}; cost-gated orders: {c['cost_gated_orders']}",
          f"- accounting identity when flat (cash == initial + realized - unattributed): {rep['accounting']['identity_holds_when_flat']}",
          f"- netting: {rep['netting']['events_where_netting_reduced_exposure']} decisions where competing signals netted; "
          f"{_f(rep['netting']['sum_exposure_avoided'])} cumulative weight not stacked"]
    mc = rep["monte_carlo_stress"]
    L += ["", "## Monte Carlo with stress (resampling, not a forecast)", ""]
    if mc.get("status") == "OK":
        L.append("| scenario | terminal multiple median [CI] | max DD median [CI] | P(loss) | P(DD>30%) | P(DD>50%) |")
        L.append("|---|---|---|---|---|---|")
        for n, s in mc["scenarios"].items():
            L.append(f"| {n} | {_f(s['terminal_multiple_median'])} [{_f(s['terminal_multiple_ci'][0])}, {_f(s['terminal_multiple_ci'][1])}] | "
                     f"{_f(s['max_drawdown_median'])} [{_f(s['max_drawdown_ci'][0])}, {_f(s['max_drawdown_ci'][1])}] | {_f(s['prob_loss'])} | "
                     f"{_f(s['prob_drawdown_gt_30pct'])} | {_f(s['prob_drawdown_gt_50pct'])} |")
        L += ["", mc["disclaimer"]]
    if "walk_forward" in rep:
        w = rep["walk_forward"]
        L += ["", "## Walk-forward (params chosen on train only)", "", f"- folds: {len(w['folds'])}, OOS bars: {w['n_oos_bars']}, param combos: {w['n_param_combinations']}",
              f"- mean in-sample objective: {_f(w['mean_in_sample'])} vs mean out-of-sample: {_f(w['mean_out_of_sample'])}"]
        pu = w.get("pooled_oos_uncertainty")
        if pu and pu.get("status") == "OK":
            L.append(f"- pooled OOS Sharpe {_f(pu['sharpe']['point'])} CI [{_f(pu['sharpe']['ci_low'])}, {_f(pu['sharpe']['ci_high'])}]")
        L.append("")
        L.append("| fold | train | test | chosen | IS | OOS |")
        L.append("|---|---|---|---|---|---|")
        for r in w["folds"]:
            if r["status"] == "OK":
                isk = [k for k in r if k.startswith("in_sample_")][0]; osk = [k for k in r if k.startswith("out_of_sample_")][0]
                L.append(f"| {r['fold']} | {r['train']} | {r['test']} | {r['chosen_params']} | {_f(r[isk])} | {_f(r[osk])} |")
            else:
                L.append(f"| {r['fold']} | {r['train']} | {r['test']} | - | {r['status']} | - |")
    if "holdout" in rep:
        h = rep["holdout"]
        L += ["", "## Frozen holdout", "", f"- holdout bars {h['holdout_bars']}, params {h['frozen_params']}",
              f"- holdout Sharpe {_f(h['holdout_metrics'].get('sharpe'))}, total return {_f(h['holdout_metrics'].get('total_return'))}, "
              f"max DD {_f(h['holdout_metrics'].get('max_drawdown'))}"]
    if rep["warnings"]:
        L += ["", "## Warnings", ""] + [f"- {w}" for w in rep["warnings"]]
    L += ["", "## Limitations", ""] + [f"- {x}" for x in rep["limitations"]]
    return "\n".join(L) + "\n"
