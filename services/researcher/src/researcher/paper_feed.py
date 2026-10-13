"""Paper signal producer ("feed"): runs the registered PAPER strategy versions on a seeded SYNTHETIC price stream and writes trade intents.

    python -m researcher.paper_feed run  [--ticks N] [--workspace UUID] [--bars-per-tick K]   # N ticks over every active workspace, then exit
    python -m researcher.paper_feed loop [--interval S] [--bars-per-tick K]                    # supervised forever-loop (SIGTERM = graceful)

What it does, per tick and per active workspace (paper_running = true AND global_state = 'active'):
  1. loads every enabled paper strategy instance that also has a capital budget, grouped by bucket (migrations 0241-0243, 0006);
  2. advances the workspace's deterministic synthetic stream by K bars (seed = hash of the workspace id unless a seed is stored in
     paper_feed_state). Strategies only ever see features computed on the PREFIX of the stream up to the decision bar (no lookahead);
  3. nets the competing sleeve signals at portfolio level (backtest.portfolio.net_sleeves) BEFORE any order exists;
  4. turns net target weights into orders (rebalance band, per-order and per-asset caps, budget cap), and drops entries whose ASSUMED
     edge does not clear 1.5x the round-trip cost-model estimate (exits are never gated);
  5. inserts the surviving orders as trade_intents in state SIGNAL through the service-role SQL function create_signal_intent
     (idempotency key = bucket + primary strategy + bar timestamp + asset + side, so replays never duplicate);
  6. writes engine heartbeats so the console can say honestly whether this process is alive.

EVERYTHING here is SYNTHETIC. The stream is a seeded random generator, the "edge" given to the cost gate is a fixed per-strategy
ASSUMPTION, and paper PnL says nothing about real profitability. Risk, reservation, execution and settlement belong to apex-execution.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import socket
import sys
import time
import uuid
from dataclasses import dataclass, field, replace
from decimal import Decimal
from functools import lru_cache

import numpy as np

from .backtest.costs import PRESETS
from .backtest.portfolio import net_sleeves
from .data.dataset import AssetMeta, Dataset, Panel
from .data.synthetic import SyntheticParams, generate
from .provenance import DataProvenance, banner_for
from .regime import Regime, regime_from_panel
from .strategies.base import SignalContext, SleeveOutput, Stage
from .strategies.library import REGISTRY, build

PROVENANCE = DataProvenance.SYNTHETIC.value

# platform-catalogue strategy keys (migration 0242) -> researcher implementations. Keys with no implementation are skipped and reported.
DB_STRATEGY_MAP = {
    "cex_trend_momentum": "trend_momentum",
    "mean_reversion_range": "mean_reversion",
    "breakout_vol_expansion": "breakout_volatility",
    "stat_pairs_relative_value": "statistical_pairs",
    "spot_rotation_btc_eth_sol": "spot_rotation",
    "grid_range_management": "grid_range",
    "risk_off_drawdown_hedge": "risk_off",
}
# ASSUMED gross edge (bps of notional) handed to the cost gate and the execution economics check. These are placeholders,
# NOT measurements: nothing in this repository has demonstrated an edge. grid_range is deliberately below the gate.
ASSUMED_EDGE_BPS = {"trend_momentum": 150, "mean_reversion": 100, "breakout_volatility": 180, "statistical_pairs": 110,
                    "spot_rotation": 140, "grid_range": 60, "risk_off": 0}
STABLES = ("USDC", "USDT", "DAI")
PANEL_SYMBOL = {"WBTC": "BTC"}          # chain asset symbol -> symbol used by the synthetic panel


@dataclass(frozen=True)
class FeedConfig:
    n_bars: int = 20_000                 # length of the synthetic stream (hourly bars)
    start_cursor: int = 600              # last "already seen" bar when a workspace starts (strategies need warm-up history)
    bars_per_tick: int = 1
    band: float = 0.03                   # rebalance band (fraction of equity)
    max_asset_weight: float = 0.25
    max_gross: float = 0.80
    max_order_frac: float = 0.08         # one order <= this share of bucket equity (the risk gate caps single orders at 25%)
    min_order_quote: int = 10            # whole quote units (e.g. 10 USDC)
    tolerance_bps: int = 20              # limit price sits this far through the synthetic close
    taker_fee_bps: int = 20
    max_fee_bps: int = 25
    cost_gate_multiple: float = 1.5
    max_inflight: int = 8                # do not queue more than this many unfinished intents per bucket


# ------------------------------------------------------------------------------------------------ deterministic stream
def workspace_seed(ws: str) -> int:
    return int.from_bytes(hashlib.sha256(f"apex-paper-feed:{ws}".encode()).digest()[:4], "big")


@lru_cache(maxsize=16)
def make_dataset(seed: int, n_bars: int) -> Dataset:
    return generate(SyntheticParams(seed=seed, n_bars=n_bars, include_delisted=True))


def prefix_panel(full: Panel, t_end: int) -> Panel:
    """bars [0, t_end]. Future listing/delisting facts are removed from the metadata: a prefix must not know the future."""
    p = full.slice(0, t_end + 1)
    meta = {a: replace(m, delisted_at=(m.delisted_at if (m.delisted_at is not None and m.delisted_at <= t_end) else None))
            for a, m in p.meta.items()}
    return Panel(p.ts, p.assets, p.open, p.high, p.low, p.close, p.volume, p.alive, meta, p.bar_seconds)


class SleeveRunner:
    """One strategy sleeve walking the stream bar by bar. State is a pure function of (seed, bar), because a fresh runner replays from
    the warm-up point; a restarted process therefore reproduces exactly what an uninterrupted one would have decided."""

    def __init__(self, name: str, params: dict | None = None, first_bar: int = 0):
        self.name = name
        self.d = build(name, Stage.PAPER, **(params or {}))
        self.state: dict = {}
        self.next_t = max(first_bar, 0)
        self.last: SleeveOutput = SleeveOutput()

    def advance(self, panel: Panel, regimes: np.ndarray, t_end: int) -> SleeveOutput:
        d = self.d
        feats = d.feature_fn(panel)                       # computed on the prefix only
        for k, arr in feats.items():
            arr.setflags(write=False)
        out = self.last
        for t in range(self.next_t, t_end + 1):
            reg = int(regimes[t])
            if reg not in {int(x) for x in d.regimes_allowed}:
                out = SleeveOutput({}, reason=f"regime {Regime(reg).name} not allowed")
            else:
                ctx = SignalContext(t, panel.assets, {k: v[: t + 1] for k, v in feats.items()}, reg, panel.alive[t],
                                    np.zeros(panel.N), self.state, panel.meta)
                try:
                    o = d.signal_fn(ctx)
                    if any(not np.isfinite(w) for w in o.weights.values()) or not np.isfinite(o.risk_multiplier):
                        raise ValueError("non-finite signal")
                    cap = d.capital_request.max_per_asset_weight
                    w: dict[str, float] = {}
                    for a_, x_ in o.weights.items():
                        m_ = panel.meta.get(a_)
                        if a_ not in panel.assets or (m_ is not None and not d.eligibility(m_)):
                            continue
                        w[a_] = float(min(max(x_, -1.0), cap))
                    out = SleeveOutput(w, float(min(max(o.risk_multiplier, 0.0), 1.0)), o.expected_edge_bps, o.reason)
                except Exception:
                    out = SleeveOutput({}, reason="signal error")
        self.next_t = t_end + 1
        self.last = out
        return out


@dataclass
class Decision:
    """The portfolio-level result for one bucket at one bar (pure data; what tests compare)."""
    bar: int
    bar_ts: int
    weights: dict[str, float]
    stacked_long: dict[str, float]
    contributors: dict[str, list[tuple[str, float]]]
    risk_multiplier: float
    edge_bps: dict[str, float]


class BucketStream:
    """All sleeves of one bucket on one workspace stream."""

    def __init__(self, seed: int, cfg: FeedConfig):
        self.seed, self.cfg = seed, cfg
        self.sleeves: dict[str, SleeveRunner] = {}
        self.allocs: dict[str, float] = {}

    def decide(self, instances: list[tuple[str, str, dict]], allocs: dict[str, float], t_end: int) -> Decision | None:
        """instances: (db_key, researcher_name, params). allocs: db_key -> fraction of equity. Decision at the CLOSE of bar t_end."""
        ds = make_dataset(self.seed, self.cfg.n_bars)
        panel = prefix_panel(ds.panel, t_end)
        regimes = regime_from_panel(panel)
        outs = []
        edges: dict[str, float] = {}
        for key, name, params in instances:
            r = self.sleeves.get(key)
            if r is None or r.name != name:
                r = self.sleeves[key] = SleeveRunner(name, params, first_bar=self.cfg.start_cursor)
            o = r.advance(panel, regimes, t_end)
            cap = r.d.capital_request.max_sleeve_weight
            outs.append((key, min(cap, allocs.get(key, 0.0)), o))
            claimed = (o.expected_edge_bps or {})
            for a in o.weights:
                edges[a] = max(edges.get(a, 0.0), float(claimed.get(a, ASSUMED_EDGE_BPS.get(name, 0))))
        if not outs:
            return None
        net = net_sleeves(outs, self.cfg.max_asset_weight, self.cfg.max_gross)
        return Decision(t_end, int(panel.ts[t_end]), dict(net.weights), dict(net.stacked_long), {a: list(v) for a, v in net.contributors.items()},
                        net.risk_multiplier, edges)


# ------------------------------------------------------------------------------------------------ order sizing (pure)
@dataclass
class AssetInfo:
    id: str
    symbol: str
    decimals: int


@dataclass
class Order:
    symbol: str
    side: str
    qty: int                      # base units
    limit_price: int              # quote base units per whole base
    notional_quote: int           # gross quote value (base units)
    strategy: str                 # DB strategy key that owns the intent (largest contributor)
    edge_bps: float
    reason: str


@dataclass
class SizingInput:
    equity_quote: int
    avail_quote: int
    qdec: int
    prices: dict[str, float]                  # symbol -> close at the decision bar
    pos_qty: dict[str, int]                   # symbol -> base units held
    pending_qty: dict[str, int]               # symbol -> signed base units of unfinished intents (+buy / -sell)
    decimals: dict[str, int]
    budget_left: dict[str, int]               # db strategy key -> quote base units still available under its budget
    bar_quote_volume: dict[str, int]          # symbol -> quote volume of the decision bar (cost model depth)


def build_orders(dec: Decision, inp: SizingInput, cfg: FeedConfig, tradable: set[str], primary_default: str,
                 counters: dict) -> list[Order]:
    orders: list[Order] = []
    cost = PRESETS["cex"]
    eq = inp.equity_quote
    if eq <= 0:
        return orders
    one_q = 10 ** inp.qdec
    avail = inp.avail_quote
    symbols = sorted(set(dec.weights) | {s for s, q in inp.pos_qty.items() if q > 0})
    for sym in symbols:
        if sym not in tradable or sym not in inp.prices:
            continue
        px = inp.prices[sym]
        bdec = inp.decimals[sym]
        price_q = int(Decimal(repr(px)) * one_q)                 # quote base units per whole base asset
        if price_q <= 0:
            continue
        held = inp.pos_qty.get(sym, 0)
        pend = inp.pending_qty.get(sym, 0)
        eff_qty = held + pend
        eff_val = eff_qty * price_q // 10 ** bdec
        tw = dec.weights.get(sym, 0.0)
        contrib = dec.contributors.get(sym, [])
        owner = max(contrib, key=lambda c: abs(c[1]))[0] if contrib else primary_default
        if tw <= 0.0:
            if held > 0 and pend >= 0:                          # exit: sell what is held, not gated by entry economics
                lim = int(price_q * (10_000 - cfg.tolerance_bps) // 10_000)
                orders.append(Order(sym, "sell", held, lim, held * price_q // 10 ** bdec, owner, 0.0, "exit: target weight 0"))
            continue
        tgt_val = int(tw * eq)
        dv = tgt_val - eff_val
        min_order = cfg.min_order_quote * one_q
        if abs(dv) < cfg.band * eq or abs(dv) < min_order:
            counters["skipped_band"] = counters.get("skipped_band", 0) + 1
            continue
        if dv > 0:
            val = min(dv, int(cfg.max_order_frac * eq), int(avail * 0.95), inp.budget_left.get(owner, 0) * 9 // 10)
            if val < min_order:
                counters["skipped_funds"] = counters.get("skipped_funds", 0) + 1
                continue
            lot = 10 ** max(bdec - 6, 0)
            qty = (val * 10 ** bdec // price_q) // lot * lot
            if qty <= 0:
                continue
            notional = qty * price_q // 10 ** bdec
            edge = dec.edge_bps.get(sym, 0.0)
            gate = cfg.cost_gate_multiple * cost.roundtrip_cost_bps(notional, inp.bar_quote_volume.get(sym, 0))
            if edge < gate:
                counters["rejected_cost_gate"] = counters.get("rejected_cost_gate", 0) + 1
                continue
            lim = int(price_q * (10_000 + cfg.tolerance_bps) // 10_000)
            orders.append(Order(sym, "buy", qty, lim, notional, owner, edge, f"rebalance up to {tw:.3f} of equity (claimed edge {edge:.0f}bps >= gate {gate:.0f}bps)"))
            avail -= notional
        else:
            q = min(-dv * 10 ** bdec // price_q, held)
            lot = 10 ** max(bdec - 6, 0)
            q = q // lot * lot
            if q <= 0 or q * price_q // 10 ** bdec < min_order:
                continue
            lim = int(price_q * (10_000 - cfg.tolerance_bps) // 10_000)
            orders.append(Order(sym, "sell", q, lim, q * price_q // 10 ** bdec, owner, 0.0, f"rebalance down to {tw:.3f} of equity"))
    return orders


def intent_context(o: Order, cfg: FeedConfig, bdec: int, notional: int, bar_qv: int, dec: Decision) -> dict:
    """The Rust `IntentContext` JSON (u128 values as decimal strings), plus provenance labels (ignored by Rust)."""
    cost = PRESETS["cex"]
    walk_bps = max(0.0, (cost.impact_ppm(max(notional, 1), max(bar_qv, 1)) / 100.0))
    slip = int(np.ceil(walk_bps))
    return {
        "asset_key": o.symbol, "tif": "Ioc", "base_decimals": bdec, "max_fee_bps": cfg.max_fee_bps,
        "market": {"slippage_bps": slip, "quote_age_ms": 0, "data_health": "Healthy", "expected_edge_bps": int(o.edge_bps),
                   "entry_fee_bps": cfg.taker_fee_bps, "exit_fee_bps": cfg.taker_fee_bps, "exit_slippage_bps": slip,
                   "gas_entry_quote": "0", "gas_exit_quote": "0", "failed_tx_prob_bps": 0, "failed_tx_cost_quote": "0",
                   "adverse_selection_bps": 5, "failed_tx_rate_bps": 0},
        "layers": [], "econ": {"min_net_ev_bps": 1, "max_fee_share_of_edge_bps": 5000},
        "data_provenance": PROVENANCE, "provenance_banner": banner_for(DataProvenance.SYNTHETIC),
        "edge_source": "paper_feed ASSUMPTION per strategy (not a measurement)",
        "feed": {"bar": dec.bar, "bar_ts": dec.bar_ts, "reason": o.reason,
                 "contributors": {a: [[s, round(x, 6)] for s, x in v] for a, v in dec.contributors.items() if a == o.symbol}},
    }


# ------------------------------------------------------------------------------------------------ database side
SERVICE = "select set_config('apex.service','on',true)"


def _q(c, sql, args=()):
    return c.execute(sql, args).fetchall()


@dataclass
class BucketWorld:
    bucket_id: str
    wca: str
    chain_id: str
    assets: dict[str, AssetInfo]
    quote: AssetInfo
    instances: list[tuple[str, str, dict]]
    budgets: dict[str, int]
    reserved_budget: dict[str, int]
    avail_quote: int
    reserved_quote: int
    pos_qty: dict[str, int]
    pending_qty: dict[str, int]
    inflight: int
    skipped_keys: list[str] = field(default_factory=list)


def active_workspaces(c, only: str | None = None) -> list[str]:
    rows = _q(c, "select workspace_id::text from workspace_settings where paper_running and global_state = 'active' order by workspace_id")
    ids = [r[0] for r in rows]
    return [i for i in ids if only is None or i == only]


def load_buckets(c, ws: str) -> list[BucketWorld]:
    out: list[BucketWorld] = []
    inst = _q(c, """select i.bucket_id::text, i.strategy_key, i.params, coalesce(d.cloned_from, '')
                      from strategy_instances i join buckets b on b.id = i.bucket_id join strategy_definitions d on d.key = i.strategy_key and d.version = i.strategy_version
                     where i.workspace_id = %s and i.enabled and i.environment = 'paper' and b.state = 'active' and b.kind = 'trading'
                       and exists (select 1 from strategy_capital_budgets g where g.bucket_id = i.bucket_id and g.strategy_key = i.strategy_key and g.limit_amount > 0)
                     order by i.bucket_id, i.strategy_key""", (ws,))
    by_bucket: dict[str, list] = {}
    for b, key, params, cloned in inst:
        by_bucket.setdefault(b, []).append((key, params or {}, cloned))
    for bucket, items in by_bucket.items():
        acct = _q(c, """select x.id::text, x.chain_id from wallet_bucket_allocations a join wallets w on w.id = a.wallet_id and w.state = 'active'
                          join wallet_chain_accounts x on x.wallet_id = w.id where a.bucket_id = %s order by w.created_at, x.chain_id""", (bucket,))
        if not acct:
            continue
        wca, chain = acct[0]
        rows = _q(c, "select id::text, symbol, decimals from assets where chain_id = %s order by symbol, id", (chain,))
        budgets = {(r[0], r[1]): int(r[2]) for r in _q(c, "select strategy_key, asset_id::text, limit_amount::text from strategy_capital_budgets where bucket_id = %s and limit_amount > 0", (bucket,))}
        reserved = {(r[0], r[1]): int(r[2]) for r in _q(c, "select strategy_key, asset_id::text, reserved_amount::text from strategy_capital_budgets where bucket_id = %s", (bucket,))}
        budget_assets = {k[1] for k in budgets}
        quote = next((AssetInfo(r[0], r[1], r[2]) for s_ in STABLES for r in rows if r[1] == s_ and r[0] in budget_assets), None)
        if quote is None:
            continue
        assets = {}
        for r in rows:
            sym = PANEL_SYMBOL.get(r[1], r[1])
            if r[0] != quote.id and sym not in STABLES and sym not in assets:
                assets[sym] = AssetInfo(r[0], sym, r[2])
        instances, skipped = [], []
        for key, params, cloned in items:
            name = DB_STRATEGY_MAP.get(key) or DB_STRATEGY_MAP.get(cloned)
            if name is None or name not in REGISTRY:
                skipped.append(key)
                continue
            instances.append((key, name, {}))        # DB params (stop-loss etc.) are risk settings, not researcher constructor args
        bal = {r[0]: int(r[1]) for r in _q(c, """select state::text, coalesce(sum(balance),0)::text from ledger_accounts where bucket_id = %s and wallet_chain_account_id = %s
                                                   and asset_id = %s and state in ('available','reserved') group by state""", (bucket, wca, quote.id))}
        id2sym = {a.id: a.symbol for a in assets.values()}
        pos = {id2sym[r[0]]: int(r[1]) for r in _q(c, "select base_asset::text, qty::text from positions where bucket_id = %s and wallet_chain_account_id = %s and quote_asset = %s", (bucket, wca, quote.id)) if r[0] in id2sym}
        pend: dict[str, int] = {}
        n_in = 0
        for base, side, qty in _q(c, """select base_asset::text, side, quantity::text from trade_intents where bucket_id = %s and environment = 'paper'
                                          and state in ('SIGNAL','CANDIDATE','RISK_EVALUATING','ADMITTED','CAPITAL_RESERVED','QUOTED','PREPARED','APPROVAL_WAIT','SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','UNKNOWN')""", (bucket,)):
            n_in += 1
            if base in id2sym:
                pend[id2sym[base]] = pend.get(id2sym[base], 0) + (int(qty) if side == "buy" else -int(qty))
        out.append(BucketWorld(bucket, wca, chain, assets, quote, instances,
                               {k[0]: v for k, v in budgets.items() if k[1] == quote.id},
                               {k[0]: v for k, v in reserved.items() if k[1] == quote.id},
                               bal.get("available", 0), bal.get("reserved", 0), pos, pend, n_in, skipped))
    return out


def get_feed_state(c, ws: str, cfg: FeedConfig) -> tuple[int, int]:
    """(seed, cursor). Creates the row on first use. A pre-existing row (e.g. a fixed seed set by an operator or a test) wins."""
    c.execute("""insert into paper_feed_state(workspace_id, seed, cursor) values (%s, %s, %s) on conflict (workspace_id) do nothing""",
              (ws, workspace_seed(ws), cfg.start_cursor))
    seed, cursor = c.execute("select seed, cursor from paper_feed_state where workspace_id = %s", (ws,)).fetchone()
    return int(seed), int(cursor)


def tick_workspace(c, ws: str, cfg: FeedConfig, streams: dict, counters: dict) -> dict:
    """One tick for one workspace. Returns a small report. Idempotent: replaying the same bars creates no new intents."""
    c.execute(SERVICE)
    seed, cursor = get_feed_state(c, ws, cfg)
    process_counters, counters = counters, {}          # `counters` below = this workspace, this tick; merged into both totals at the end
    if cursor >= cfg.n_bars - 1:
        process_counters["stream_exhausted"] = 1
        return {"workspace": ws, "status": "stream_exhausted", "cursor": cursor}
    t_end = min(cursor + cfg.bars_per_tick, cfg.n_bars - 1)
    ds = make_dataset(seed, cfg.n_bars)
    panel = ds.panel
    report = {"workspace": ws, "seed": seed, "from": cursor, "to": t_end, "created": 0, "replayed": 0, "buckets": 0, "provenance": PROVENANCE}
    for bw in load_buckets(c, ws):
        counters["skipped_unmapped_strategies"] = counters.get("skipped_unmapped_strategies", 0) + len(bw.skipped_keys)
        if not bw.instances:
            continue
        report["buckets"] += 1
        bs = streams.setdefault((ws, bw.bucket_id, seed), BucketStream(seed, cfg))
        tradable = {s for s in bw.assets if s in panel.assets and s != bw.quote.symbol}
        prices = {s: float(panel.close[t_end, panel.assets.index(s)]) for s in tradable}
        one_q = 10 ** bw.quote.decimals
        held_val = sum(bw.pos_qty.get(s, 0) * int(Decimal(repr(prices[s])) * one_q) // 10 ** bw.assets[s].decimals for s in tradable if s in bw.pos_qty)
        equity = bw.avail_quote + bw.reserved_quote + held_val
        allocs = {}
        for key, _, _ in bw.instances:
            allocs[key] = (bw.budgets.get(key, 0) / equity) if equity > 0 else 0.0
        tot = sum(min(a, 1.0) for a in allocs.values())
        if tot > 0.95:
            allocs = {k: v * 0.95 / tot for k, v in allocs.items()}
        # decisions are made on EVERY bar in the batch (stateful sleeves must see them all); orders are emitted for the last one
        dec = bs.decide(bw.instances, allocs, t_end)
        counters["bars_decided"] = counters.get("bars_decided", 0) + (t_end - cursor)
        if dec is None:
            continue
        if bw.inflight >= cfg.max_inflight:
            counters["skipped_inflight"] = counters.get("skipped_inflight", 0) + 1
            continue
        bqv = {s: int(panel.volume[t_end, panel.assets.index(s)] * panel.close[t_end, panel.assets.index(s)] * one_q) for s in tradable}
        left = {k: max(bw.budgets.get(k, 0) - bw.reserved_budget.get(k, 0), 0) for k in bw.budgets}
        inp = SizingInput(equity, bw.avail_quote, bw.quote.decimals, prices, bw.pos_qty, bw.pending_qty, {s: bw.assets[s].decimals for s in tradable}, left, bqv)
        orders = build_orders(dec, inp, cfg, tradable, bw.instances[0][0], counters)
        for o in orders:
            info = bw.assets[o.symbol]
            ctx = intent_context(o, cfg, info.decimals, o.notional_quote, bqv.get(o.symbol, 0), dec)
            key = f"{bw.bucket_id[:8]}:{o.strategy}:{dec.bar_ts}:{o.symbol}:{o.side}"
            exists = c.execute("select 1 from trade_intents where workspace_id = %s and idempotency_key = %s", (ws, "feed:" + key)).fetchone()
            try:
                c.execute("savepoint s1")
                iid = c.execute("select create_signal_intent(%s::uuid,%s::uuid,%s::uuid,%s::uuid,%s::uuid,%s,%s::numeric,%s::numeric,%s,%s,%s::jsonb)",
                                (ws, bw.bucket_id, bw.wca, info.id, bw.quote.id, o.side, str(o.qty), str(o.limit_price), o.strategy, key, json.dumps(ctx))).fetchone()[0]
                c.execute("release savepoint s1")
                if exists:
                    report["replayed"] += 1
                    counters["intents_replayed"] = counters.get("intents_replayed", 0) + 1
                else:
                    report["created"] += 1
                    counters["intents_created"] = counters.get("intents_created", 0) + 1
            except Exception as e:  # SQL refused (halt, no budget...): count it, never crash the loop
                c.execute("rollback to savepoint s1")
                counters["refused_by_sql"] = counters.get("refused_by_sql", 0) + 1
                report.setdefault("refused", []).append(str(e).splitlines()[0][:160])
    prev = c.execute("select counters from paper_feed_state where workspace_id = %s", (ws,)).fetchone()[0] or {}
    merged = {k: v for k, v in prev.items() if isinstance(v, int)}
    for k, v in counters.items():
        merged[k] = merged.get(k, 0) + v
        process_counters[k] = process_counters.get(k, 0) + v
    c.execute("""update paper_feed_state set cursor = %s, last_bar_ts = %s, last_run_at = now(), updated_at = now(),
                        counters = %s::jsonb where workspace_id = %s""",
              (t_end, int(panel.ts[t_end]), json.dumps({**merged, "data_provenance": PROVENANCE}), ws))
    return report


def heartbeat(c, instance: str, started: float, counters: dict, stopped: bool = False) -> None:
    c.execute(SERVICE)
    c.execute("select engine_heartbeat('paper_feed', %s, %s, %s, to_timestamp(%s), %s::jsonb, %s::jsonb, %s)",
              (instance, os.getpid(), socket.gethostname(), started, json.dumps(counters), json.dumps({"data_provenance": PROVENANCE, "mode": "paper"}), stopped))


def run_ticks(url: str, cfg: FeedConfig, ticks: int = 1, only: str | None = None, instance: str | None = None, interval: float = 0.0,
              stop: "Stop | None" = None, streams: dict | None = None, counters: dict | None = None) -> list[dict]:
    import psycopg
    streams = streams if streams is not None else {}
    counters = counters if counters is not None else {}
    instance = instance or f"feed-{os.getpid()}"
    started = time.time()
    reports: list[dict] = []
    n = 0
    while (ticks == 0 or n < ticks) and not (stop and stop.set):
        with psycopg.connect(url, connect_timeout=5) as c:
            heartbeat(c, instance, started, counters)
            c.commit()
            for ws in active_workspaces(c, only):
                reports.append(tick_workspace(c, ws, cfg, streams, counters))
                c.commit()
            counters["ticks"] = counters.get("ticks", 0) + 1
            heartbeat(c, instance, started, counters)
            c.commit()
        n += 1
        if interval and (ticks == 0 or n < ticks):
            end = time.time() + interval
            while time.time() < end and not (stop and stop.set):
                time.sleep(min(0.1, interval))
    return reports


class Stop:
    def __init__(self):
        self.set = False

    def trigger(self, *_):
        self.set = True


def supervised_loop(url: str, cfg: FeedConfig, interval: float, instance: str) -> int:
    """Forever-loop with crash isolation: a failing tick is logged, counted and retried with backoff; SIGTERM/SIGINT stop it gracefully."""
    import psycopg
    stop = Stop()
    signal.signal(signal.SIGTERM, stop.trigger)
    signal.signal(signal.SIGINT, stop.trigger)
    streams: dict = {}
    counters: dict = {"errors": 0}
    started = time.time()
    backoff = 1.0
    last_metrics = 0.0
    print(json.dumps({"event": "start", "component": "paper_feed", "instance": instance, "pid": os.getpid(), "data_provenance": PROVENANCE}), flush=True)
    while not stop.set:
        try:
            reps = run_ticks(url, cfg, ticks=1, instance=instance, streams=streams, counters=counters, stop=stop)
            backoff = 1.0
            if time.time() - last_metrics > 10:
                last_metrics = time.time()
                print(json.dumps({"event": "metrics", "component": "paper_feed", "instance": instance, "counters": counters, "last": reps[-1] if reps else None}, default=str), flush=True)
            end = time.time() + interval
            while time.time() < end and not stop.set:
                time.sleep(0.05)
        except Exception as e:  # noqa: BLE001 - supervision boundary
            counters["errors"] = counters.get("errors", 0) + 1
            print(json.dumps({"event": "error", "component": "paper_feed", "error": str(e)[:300], "backoff_s": backoff}), file=sys.stderr, flush=True)
            end = time.time() + backoff
            while time.time() < end and not stop.set:
                time.sleep(0.1)
            backoff = min(backoff * 2, 30.0)
    try:
        with psycopg.connect(url, connect_timeout=5) as c:
            heartbeat(c, instance, started, counters, stopped=True)
            c.commit()
    except Exception:  # noqa: BLE001
        pass
    print(json.dumps({"event": "stopped", "component": "paper_feed", "instance": instance, "counters": counters}), flush=True)
    return 0


def _cfg_from(args) -> FeedConfig:
    kw = {}
    if getattr(args, "bars_per_tick", None):
        kw["bars_per_tick"] = args.bars_per_tick
    if getattr(args, "start_cursor", None) is not None:
        kw["start_cursor"] = args.start_cursor
    if getattr(args, "n_bars", None):
        kw["n_bars"] = args.n_bars
    return FeedConfig(**kw)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="researcher.paper_feed", description="SYNTHETIC paper signal producer (never live)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("run", "loop"):
        p = sub.add_parser(name)
        p.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
        p.add_argument("--bars-per-tick", type=int, default=int(os.environ.get("APEX_FEED_BARS_PER_TICK", "1")))
        p.add_argument("--start-cursor", type=int, default=None)
        p.add_argument("--n-bars", type=int, default=None)
        p.add_argument("--instance", default=os.environ.get("APEX_FEED_INSTANCE"))
        if name == "run":
            p.add_argument("--ticks", type=int, default=1, help="0 = until interrupted")
            p.add_argument("--workspace", default=None)
            p.add_argument("--interval", type=float, default=0.0)
        else:
            p.add_argument("--interval", type=float, default=float(os.environ.get("APEX_FEED_INTERVAL", "1.0")))
    a = ap.parse_args(argv)
    if not a.database_url:
        print("DATABASE_URL (or --database-url) is required", file=sys.stderr)
        return 2
    cfg = _cfg_from(a)
    if a.cmd == "run":
        reps = run_ticks(a.database_url, cfg, ticks=a.ticks, only=a.workspace, instance=a.instance, interval=a.interval)
        print(json.dumps({"data_provenance": PROVENANCE, "provenance_banner": banner_for(DataProvenance.SYNTHETIC), "reports": reps}, default=str))
        return 0
    return supervised_loop(a.database_url, cfg, a.interval, a.instance or f"feed-{os.getpid()}")


if __name__ == "__main__":
    raise SystemExit(main())
