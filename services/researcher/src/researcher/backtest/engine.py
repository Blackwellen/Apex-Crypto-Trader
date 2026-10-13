"""Event-driven backtest engine with hard no-lookahead guarantees.

Timeline per bar t:  (1) execute orders decided at close t-1 at OPEN of bar t  (2) force-liquidate delisted assets
(3) mark to market at close t  (4) strategies see ONLY feature rows <= t, signals are netted, orders created for t+1.
Guarantees: features validated causal before running (LookaheadError otherwise); strategies receive read-only prefix
views; execution never uses a price from the decision bar; money is integers only.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from decimal import Decimal

import numpy as np

from ..data.dataset import Dataset, Panel, SurvivorshipDeclaration
from ..provenance import DataProvenance, banner_for, edge_claim_for
from ..regime import Regime, regime_from_panel
from ..strategies.base import SignalContext, SleeveOutput, StrategyDefinition
from ..units import QUOTE_ONE, floor_ppm, notional_units, price_dec, qty_for_value
from .accounting import Account
from .costs import PRESETS, CostModel
from .lookahead import validate_feature_fn
from .metrics import summarize
from .portfolio import net_sleeves


@dataclass(frozen=True)
class SleeveSpec:
    strategy: StrategyDefinition
    allocation: float                       # fraction of equity requested (capped by the strategy's capital request)


@dataclass(frozen=True)
class BacktestConfig:
    initial_cash: int = 100_000 * QUOTE_ONE
    cost: CostModel = field(default_factory=lambda: PRESETS["cex"])
    rebalance_band: float = 0.03
    max_asset_weight: float = 0.6
    max_gross: float = 0.98
    start: int = 0
    end: int | None = None
    liquidate_at_end: bool = True
    seed: int = 1
    cost_gate_multiple: float = 1.5
    validate_lookahead: bool = True        # must stay True; False is rejected unless explicitly allowed in unit tests
    _allow_unvalidated_for_tests: bool = False

    def __post_init__(self) -> None:
        if not self.validate_lookahead and not self._allow_unvalidated_for_tests:
            raise ValueError("lookahead validation cannot be disabled")


@dataclass
class Trade:
    t_decision: int
    t_exec: int
    ts_exec: int
    asset: str
    side: str
    status: str
    qty_units: int
    price: str
    notional: int
    fee: int
    gas: int
    realized_pnl: int | None = None
    note: str = ""


@dataclass
class BacktestResult:
    data_provenance: str
    equity: list[int]
    ts: list[int]
    trades: list[Trade]
    metrics: dict
    costs: dict
    accounting: dict
    netting: dict
    survivorship: dict
    strategies: list[str]
    config_hash: str
    lookahead_validated: list[str]
    warnings: list[str]
    bars_per_year: float
    regime_counts: dict
    sleeve_errors: int = 0

    def to_dict(self, max_trades: int = 50) -> dict:
        return {
            "data_provenance": self.data_provenance,
            "provenance_banner": banner_for(DataProvenance(self.data_provenance)),
            "edge_claim": edge_claim_for(DataProvenance(self.data_provenance)),
            "strategies": self.strategies, "config_hash": self.config_hash,
            "lookahead_validated_features_for": self.lookahead_validated,
            "metrics": self.metrics, "costs": self.costs, "accounting": self.accounting, "netting": self.netting,
            "survivorship": self.survivorship, "warnings": self.warnings, "regime_counts": self.regime_counts,
            "n_trades": len(self.trades), "sleeve_errors": self.sleeve_errors,
            "trades_sample": [t.__dict__ for t in self.trades[:max_trades]],
        }


def _px(a: float) -> Decimal:
    return price_dec(a)


def run_backtest(dataset: Dataset, sleeves: list[SleeveSpec], cfg: BacktestConfig | None = None) -> BacktestResult:
    cfg = cfg or BacktestConfig()
    dataset.survivorship.require()
    full = dataset.panel
    end = cfg.end if cfg.end is not None else full.T
    panel = full.slice(0, end)           # data after `end` does not exist for the engine
    T, N = panel.T, panel.N
    if sum(s.allocation for s in sleeves) > 1.0 + 1e-9:
        raise ValueError("sleeve allocations exceed 100% of equity (no leverage)")

    # ---- no-lookahead gate (mandatory) -------------------------------------------------------------------
    validated: list[str] = []
    if cfg.validate_lookahead:
        validate_feature_fn(lambda p: {"regime": regime_from_panel(p)[:, None].astype(float)}, panel, seed=cfg.seed)
        for s in sleeves:
            validate_feature_fn(s.strategy.feature_fn, panel, seed=cfg.seed)
            validated.append(s.strategy.key)
    feats = [s.strategy.feature_fn(panel) for s in sleeves]
    for f in feats:
        for arr in f.values():
            arr.setflags(write=False)
    for s, f in zip(sleeves, feats):
        miss = [k for k in s.strategy.required_features if k not in f]
        if miss:
            raise ValueError(f"{s.strategy.key} missing required features {miss}")
    reg = regime_from_panel(panel)
    regime_counts = {Regime(int(r)).name: int((reg == r).sum()) for r in np.unique(reg)}

    acct = Account(cfg.initial_cash)
    rng = np.random.default_rng(cfg.seed)
    states: list[dict] = [dict() for _ in sleeves]
    last_out: list[SleeveOutput] = [SleeveOutput() for _ in sleeves]
    pending: list[tuple[str, str, int, int, str]] = []         # (asset, side, qty_units, decision_t, note)
    trades: list[Trade] = []
    equity: list[int] = []
    ts_out: list[int] = []
    netting_saved_total = 0.0
    netting_events = 0
    gated = 0
    failed = 0
    partial = 0
    errors = 0
    start = max(0, cfg.start)
    delist_at = {a: panel.meta[a].delisted_at for a in panel.assets if a in panel.meta and panel.meta[a].delisted_at is not None}

    def qv(t: int, j: int) -> int:       # executing bar quote volume (liquidity actually available in that bar)
        return int(panel.volume[t, j] * panel.open[t, j] * QUOTE_ONE)

    def exec_order(t: int, order: tuple[str, str, int, int, str]) -> None:
        nonlocal failed, partial
        a, side, qty, t_dec, note = order
        j = panel.assets.index(a)
        if not panel.alive[t, j]:
            return                                            # asset not tradable at execution time: order lapses
        op = _px(panel.open[t, j])
        pos = acct.pos(a)
        if side == "sell":
            qty = min(qty, pos.qty)
        u = float(rng.random())
        r = cfg.cost.execute(side, qty, op, qv(t, j), u)
        if r.status == "failed_tx":
            acct.failed_tx(r.gas); failed += 1
            trades.append(Trade(t_dec, t, int(panel.ts[t]), a, side, "failed_tx", 0, str(op), 0, 0, r.gas, None, note))
            return
        if r.status == "no_liquidity" or r.qty_units <= 0:
            trades.append(Trade(t_dec, t, int(panel.ts[t]), a, side, "no_liquidity", 0, str(op), 0, 0, 0, None, note))
            return
        if side == "buy":
            guard = 0
            while r.notional + r.fee + r.gas > acct.cash and guard < 6 and r.qty_units > 0:   # size to cash
                scaled = int(r.qty_units * max(acct.cash - r.gas, 0) * 0.995 // max(r.notional + r.fee, 1))
                r = cfg.cost.execute(side, scaled, op, qv(t, j), 1.0)       # u=1.0: already passed the failure draw
                guard += 1
            if r.qty_units <= 0 or r.notional + r.fee + r.gas > acct.cash:
                return
            acct.buy(a, r.qty_units, r.notional, r.fee, r.gas, r.slippage_cost)
            pnl = None
        else:
            pnl = acct.sell(a, r.qty_units, r.notional, r.fee, r.gas, r.slippage_cost)
        if r.status == "partial":
            partial += 1
        trades.append(Trade(t_dec, t, int(panel.ts[t]), a, side, r.status, r.qty_units, str(r.price), r.notional, r.fee, r.gas, pnl, note))

    for t in range(T):
        # (1) execute yesterday's orders at today's OPEN: sells first, then buys
        if pending:
            for o in sorted(pending, key=lambda o: 0 if o[1] == "sell" else 1):
                exec_order(t, o)
            pending = []
        # (2) delistings: forced exit of what is left, at the last close times the recovery ratio, no fees
        for a, dl in delist_at.items():
            if dl == t and acct.pos(a).qty > 0:
                j = panel.assets.index(a)
                last = _px(panel.close[t - 1, j])
                val = notional_units(acct.pos(a).qty, last, round_up=False)
                rec = floor_ppm(val, panel.meta[a].terminal_recovery_ppm)
                q = acct.pos(a).qty
                pnl = acct.write_off(a, rec)
                trades.append(Trade(t - 1, t, int(panel.ts[t]), a, "sell", "delist_writeoff", q, str(last), rec, 0, 0, pnl,
                                    f"forced liquidation at {panel.meta[a].terminal_recovery_ppm} ppm of last close"))
        # (3) mark at close
        closes = {a: _px(panel.close[t, j]) for j, a in enumerate(panel.assets)}
        if t >= start:
            equity.append(acct.equity(closes)); ts_out.append(int(panel.ts[t]))
        # (4) decide (not on last bar: there is no next open)
        if t < start or t >= T - 1:
            continue
        eq = equity[-1]
        regime = int(reg[t])
        cur_w = np.array([notional_units(acct.pos(a).qty, closes[a], round_up=False) / eq if eq > 0 else 0.0 for a in panel.assets])
        outs: list[tuple[str, float, SleeveOutput]] = []
        for i, s in enumerate(sleeves):
            d = s.strategy
            if regime not in {int(x) for x in d.regimes_allowed}:
                o = SleeveOutput({}, reason=f"regime {Regime(regime).name} not allowed")
            else:
                ctx = SignalContext(t, panel.assets, {k: v[: t + 1] for k, v in feats[i].items()}, regime, panel.alive[t],
                                    cur_w, states[i], panel.meta)
                try:
                    o = d.signal_fn(ctx)
                    if any((not np.isfinite(w)) for w in o.weights.values()) or not np.isfinite(o.risk_multiplier):
                        raise ValueError("non-finite signal")
                    cap = d.capital_request.max_per_asset_weight
                    w: dict[str, float] = {}
                    for a_, x_ in o.weights.items():
                        m_ = panel.meta.get(a_)
                        if a_ not in panel.assets or (m_ is not None and not d.eligibility(m_)):
                            continue
                        w[a_] = float(min(max(x_, -1.0), cap))
                    o = SleeveOutput(w, float(min(max(o.risk_multiplier, 0.0), 1.0)), o.expected_edge_bps, o.reason)
                except Exception:
                    errors += 1
                    o = SleeveOutput({}, reason="signal error") if d.fail_policy.value != "hold" else last_out[i]
            last_out[i] = o
            outs.append((d.key, min(s.allocation, d.capital_request.max_sleeve_weight), o))
        net = net_sleeves(outs, cfg.max_asset_weight, cfg.max_gross)
        if net.netting_saved:
            netting_saved_total += sum(net.netting_saved.values()); netting_events += 1
        for j, a in enumerate(panel.assets):
            if not panel.alive[t, j]:
                continue
            tw = net.weights.get(a, 0.0)
            pos = acct.pos(a)
            cur_val = notional_units(pos.qty, closes[a], round_up=False)
            tgt_val = int(tw * eq)
            if tw == 0.0 and pos.qty > 0:
                pending.append((a, "sell", pos.qty, t, "exit: target weight 0"))
                continue
            dv = tgt_val - cur_val
            if eq <= 0 or abs(dv) / eq < cfg.rebalance_band or abs(dv) < 10 * QUOTE_ONE:
                continue
            if dv > 0:
                edges = [e for (_, _, o) in outs if o.expected_edge_bps and a in o.expected_edge_bps for e in [o.expected_edge_bps[a]]]
                if edges and max(edges) < cfg.cost_gate_multiple * cfg.cost.roundtrip_cost_bps(dv, int(panel.volume[t, j] * panel.close[t, j] * QUOTE_ONE)):
                    gated += 1
                    continue
                pending.append((a, "buy", qty_for_value(dv, closes[a]), t, "rebalance up"))
            else:
                q = min(qty_for_value(-dv, closes[a]), pos.qty)
                if q > 0:
                    pending.append((a, "sell", q, t, "rebalance down"))

    # ---- final liquidation at last close (documented: there is no next open) ---------------------------------
    warnings: list[str] = []
    if cfg.liquidate_at_end:
        t = T - 1
        for j, a in enumerate(panel.assets):
            pos = acct.pos(a)
            if pos.qty > 0 and panel.alive[t, j]:
                px = _px(panel.close[t, j])
                r = cfg.cost.execute("sell", pos.qty, px, max(qv(t, j), 1) * 1000, 1.0)   # end-of-test exit: not volume capped
                if r.qty_units > 0:
                    pnl = acct.sell(a, r.qty_units, r.notional, r.fee, r.gas, r.slippage_cost)
                    trades.append(Trade(t, t, int(panel.ts[t]), a, "sell", "final_liquidation_at_close", r.qty_units, str(r.price),
                                        r.notional, r.fee, r.gas, pnl, "end of test; priced at last close incl. exit costs"))
        closes = {a: _px(panel.close[t, j]) for j, a in enumerate(panel.assets)}
        if equity:
            equity[-1] = acct.equity(closes)
    if not trades:
        warnings.append("no trades were generated: strategy/regime/warm-up produced no entries")
    if len(equity) < 100:
        warnings.append("fewer than 100 bars: metrics are statistically meaningless")
    if not dataset.survivorship.includes_delisted:
        warnings.append("SURVIVORSHIP BIAS: dataset excludes delisted/rugged assets; results are optimistically biased")
    flat = all(p.qty == 0 for p in acct.positions.values())
    sells = [x for x in trades if x.side == "sell" and x.realized_pnl is not None]
    wins = sum(1 for x in sells if x.realized_pnl > 0)
    cfg_blob = json.dumps({"cfg": {k: str(v) for k, v in cfg.__dict__.items()}, "sleeves": [(s.strategy.key, s.allocation, str(s.strategy.params)) for s in sleeves]}, sort_keys=True)
    m = summarize(equity, panel.bars_per_year) if len(equity) > 2 else {}
    traded = sum(x.notional for x in trades if x.status in ("filled", "partial"))
    m.update({"win_rate_closed_trades": (wins / len(sells)) if sells else None, "n_closed_trades": len(sells),
              "turnover_x_equity": traded / max(1, int(np.mean(equity))) if equity else 0.0})
    costs = {"fees_paid": acct.fees_paid, "gas_paid": acct.gas_paid, "slippage_and_spread_paid": acct.slippage_paid,
             "total_explicit_and_slippage": acct.fees_paid + acct.gas_paid + acct.slippage_paid,
             "failed_tx_count": failed, "partial_fill_count": partial, "cost_gated_orders": gated,
             "cost_drag_pct_of_initial": (acct.fees_paid + acct.gas_paid + acct.slippage_paid) / cfg.initial_cash,
             "cost_model": {k: v for k, v in cfg.cost.__dict__.items()}}
    accounting = {"units": "integer quote micro-units (1e-6)", "initial_cash": cfg.initial_cash, "final_equity": equity[-1] if equity else cfg.initial_cash,
                  "cash": acct.cash, "realized_pnl_net": acct.realized, "unattributed_costs": acct.unattributed_costs,
                  "flat_at_end": flat, "identity_holds_when_flat": (acct.cash == cfg.initial_cash + acct.realized - acct.unattributed_costs) if flat else None}
    netting = {"events_where_netting_reduced_exposure": netting_events, "sum_exposure_avoided": netting_saved_total}
    return BacktestResult(dataset.provenance.value, equity, ts_out, trades, m, costs, accounting, netting, dataset.label()["survivorship"],
                          [s.strategy.key for s in sleeves], hashlib.sha256(cfg_blob.encode()).hexdigest()[:16], validated, warnings,
                          panel.bars_per_year, regime_counts, errors)
