"""Paper feed: determinism, no lookahead, netting before intents, cost gate, idempotent intent creation (real Postgres).
Everything is SYNTHETIC; nothing here says anything about real profitability."""
from __future__ import annotations

import json
import uuid
from dataclasses import replace

import numpy as np
import psycopg
import pytest

from researcher import paper_feed as pf
from researcher.data.dataset import Dataset

SEED = 4
CFG = pf.FeedConfig(n_bars=3000)
INST = [(k, n, {}) for k, n in pf.DB_STRATEGY_MAP.items() if n in ("trend_momentum", "breakout_volatility", "grid_range", "mean_reversion", "spot_rotation")]
ALLOCS = {k: 0.18 for k, _, _ in INST}


@pytest.fixture(autouse=True)
def _fresh_cache():
    pf.make_dataset.cache_clear()
    yield


def _decisions(bars, k=1, restart_at=None, seed=SEED):
    """Decide on `bars` using k-bar batches; optionally throw the whole stream state away at `restart_at` (process restart)."""
    bs = pf.BucketStream(seed, CFG)
    out = {}
    for i, t in enumerate(bars):
        if restart_at is not None and t == restart_at:
            bs = pf.BucketStream(seed, CFG)          # brand-new process: all sleeve state is rebuilt by replay
        d = bs.decide(INST, ALLOCS, t)
        out[t] = (d.bar_ts, tuple(sorted((a, round(w, 12)) for a, w in d.weights.items())), d.risk_multiplier)
    return out


def test_workspace_seed_is_stable_and_distinct():
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    assert pf.workspace_seed(a) == pf.workspace_seed(a)
    assert pf.workspace_seed(a) != pf.workspace_seed(b)


def test_stream_is_deterministic_and_labelled_synthetic():
    d1, d2 = pf.make_dataset(SEED, 3000), pf.make_dataset(SEED, 3000)
    assert np.array_equal(d1.panel.close, d2.panel.close)
    assert d1.provenance.value == "SYNTHETIC" == pf.PROVENANCE
    assert not np.array_equal(pf.make_dataset(SEED + 1, 3000).panel.close, d1.panel.close)


def test_same_seed_same_decisions_regardless_of_batching_or_restart():
    bars = list(range(601, 681))
    straight = _decisions(bars)
    assert straight == _decisions(bars)                                   # replay
    # sampling every 5th bar (bars_per_tick=5) must agree with deciding on every bar, because stateful sleeves see every bar
    bs = pf.BucketStream(SEED, CFG)
    sampled = {t: bs.decide(INST, ALLOCS, t) for t in range(605, 681, 5)}
    for t, d in sampled.items():
        assert (d.bar_ts, tuple(sorted((a, round(w, 12)) for a, w in d.weights.items())), d.risk_multiplier) == straight[t]
    # kill the stream state in the middle: the restarted one reproduces the uninterrupted decisions
    assert _decisions(bars, restart_at=640) == straight
    assert any(v[1] for v in straight.values()), "the fixture seed must actually produce signals"
    assert _decisions(bars, seed=SEED + 1) != straight


def test_no_lookahead_future_bars_cannot_change_a_decision(monkeypatch):
    t = 700
    base = pf.BucketStream(SEED, CFG).decide(INST, ALLOCS, t)
    ds = pf.make_dataset(SEED, 3000)
    p = ds.panel
    rng = np.random.default_rng(1)

    def scrambled(seed, n):                                                # same past, garbage future
        junk = rng.uniform(0.2, 5.0, size=p.close.shape)
        c, o, h, l, v = p.close.copy(), p.open.copy(), p.high.copy(), p.low.copy(), p.volume.copy()
        c[t + 1:], o[t + 1:] = junk[t + 1:], junk[t + 1:]
        h[t + 1:], l[t + 1:] = junk[t + 1:] * 1.01, junk[t + 1:] * 0.99
        panel = replace(p, close=c, open=o, high=h, low=l, volume=v)
        return Dataset(panel, ds.provenance, ds.survivorship, ds.source, ds.generator_params)

    monkeypatch.setattr(pf, "make_dataset", scrambled)
    other = pf.BucketStream(SEED, CFG).decide(INST, ALLOCS, t)
    assert (base.bar_ts, base.weights, base.risk_multiplier) == (other.bar_ts, other.weights, other.risk_multiplier)


def test_competing_signals_net_before_any_order_exists():
    # two sleeves want the same asset: the portfolio gets ONE net weight (capped), never two stacked orders
    dec = pf.Decision(700, 1, {"ETH": 0.25}, {"ETH": 0.5}, {"ETH": [("a", 0.2), ("b", 0.3)]}, 1.0, {"ETH": 150.0})
    inp = pf.SizingInput(1_000_000_000, 900_000_000, 6, {"ETH": 2000.0}, {}, {}, {"ETH": 18}, {"a": 10**9, "b": 10**9}, {"ETH": 10**12})
    orders = pf.build_orders(dec, inp, CFG, {"ETH"}, "a", {})
    assert len(orders) == 1 and orders[0].side == "buy" and orders[0].strategy == "b"        # biggest contributor owns the intent
    assert orders[0].notional_quote <= CFG.max_order_frac * 1_000_000_000 + 1
    # opposing exposure nets to nothing: the netting function itself is covered by test_netting_regime
    from researcher.backtest.portfolio import net_sleeves
    from researcher.strategies.base import SleeveOutput
    n = net_sleeves([("a", 0.2, SleeveOutput({"ETH": 1.0})), ("b", 0.2, SleeveOutput({"ETH": -1.0}))])
    assert n.weights == {}


def test_cost_gate_rejects_unprofitable_entries_but_never_blocks_exits():
    cnt: dict = {}
    dec = pf.Decision(700, 1, {"ETH": 0.2}, {}, {"ETH": [("grid", 0.2)]}, 1.0, {"ETH": float(pf.ASSUMED_EDGE_BPS["grid_range"])})
    inp = pf.SizingInput(1_000_000_000, 1_000_000_000, 6, {"ETH": 2000.0}, {}, {}, {"ETH": 18}, {"grid": 10**9}, {"ETH": 10**12})
    assert pf.build_orders(dec, inp, CFG, {"ETH"}, "grid", cnt) == [] and cnt["rejected_cost_gate"] == 1
    # same asset, held, target weight 0 -> exit sell goes through regardless of any edge
    held = pf.SizingInput(1_000_000_000, 500_000_000, 6, {"ETH": 2000.0}, {"ETH": 10**17}, {}, {"ETH": 18}, {"grid": 10**9}, {"ETH": 10**12})
    exits = pf.build_orders(pf.Decision(701, 2, {}, {}, {}, 1.0, {}), held, CFG, {"ETH"}, "grid", {})
    assert len(exits) == 1 and exits[0].side == "sell" and exits[0].qty == 10**17
    # the claimed edge must clear 1.5x the round trip cost estimate: a 150bps claim passes for a small order, fails for a huge one
    big = pf.SizingInput(10**15, 10**15, 6, {"ETH": 2000.0}, {}, {}, {"ETH": 18}, {"x": 10**15}, {"ETH": 10**9})
    decx = pf.Decision(700, 1, {"ETH": 0.25}, {}, {"ETH": [("x", 0.25)]}, 1.0, {"ETH": 150.0})
    assert pf.build_orders(decx, big, replace(CFG, max_order_frac=0.5), {"ETH"}, "x", {}) == []


def test_intent_context_matches_the_rust_serde_shape():
    o = pf.Order("ETH", "buy", 10**16, 2_004_000_000, 20_000_000, "k", 150.0, "r")
    dec = pf.Decision(700, 123, {"ETH": 0.1}, {}, {"ETH": [("k", 0.1)]}, 1.0, {"ETH": 150.0})
    ctx = pf.intent_context(o, CFG, 18, 20_000_000, 10**12, dec)
    assert ctx["tif"] == "Ioc" and ctx["market"]["data_health"] == "Healthy" and ctx["market"]["gas_entry_quote"] == "0"
    assert ctx["data_provenance"] == "SYNTHETIC" and "NOT evidence" in ctx["provenance_banner"]
    assert ctx["max_fee_bps"] >= ctx["market"]["entry_fee_bps"]
    json.dumps(ctx)


# ---------------------------------------------------------------------------------------------- real Postgres
from pgworld import World, drop_db, fresh_db, pg_available, seed_world  # noqa: E402

pytestmark_pg = pytest.mark.skipif(not pg_available(), reason="local Postgres not available")


@pytest.fixture(scope="module")
def pg():
    url, name = fresh_db()
    yield url, name
    drop_db(name)


def _world(pg) -> World:
    url, name = pg
    w = seed_world(url, name, funds=1_000_000_000)
    with psycopg.connect(url) as c:
        c.execute("update workspace_settings set paper_running = true where workspace_id = %s", (w.ws,))
        for key in ("cex_trend_momentum", "breakout_vol_expansion", "grid_range_management", "mean_reversion_range"):
            c.execute("insert into strategy_instances(workspace_id,bucket_id,environment,strategy_key,strategy_version,enabled) values (%s,%s,'paper',%s,1,true)", (w.ws, w.bucket, key))
            c.execute("insert into strategy_capital_budgets(workspace_id,bucket_id,strategy_key,asset_id,limit_amount) values (%s,%s,%s,%s,300000000)", (w.ws, w.bucket, key, w.usdc))
        c.execute("insert into paper_feed_state(workspace_id, seed, cursor) values (%s,%s,600)", (w.ws, SEED))
        c.commit()
    return w


def _intents(url, ws):
    with psycopg.connect(url) as c:
        return c.execute("select id::text, idempotency_key, side, quantity::text, limit_price::text, state, strategy_key from trade_intents where workspace_id=%s order by idempotency_key", (ws,)).fetchall()


@pytest.mark.postgres
def test_feed_creates_signal_intents_and_replays_never_duplicate(pg):
    if not pg_available():
        pytest.skip("no postgres")
    url, _ = pg
    w = _world(pg)
    cfg = replace(CFG, bars_per_tick=1)
    streams, counters = {}, {}
    reps = pf.run_ticks(url, cfg, ticks=40, only=w.ws, streams=streams, counters=counters)
    first = _intents(url, w.ws)
    assert reps and first, f"expected intents from 40 ticks, counters={counters}"
    assert all(r[5] == "SIGNAL" for r in first), "the feed only ever creates SIGNAL intents; execution belongs to apex-execution"
    assert {r[2] for r in first} == {"buy"}, "no position yet, so only entries"
    with psycopg.connect(url) as c:
        ctx = c.execute("select context from intent_context where intent_id = %s::uuid", (first[0][0],)).fetchone()[0]
        st = c.execute("select cursor, data_provenance, counters from paper_feed_state where workspace_id=%s", (w.ws,)).fetchone()
        hb = c.execute("select count(*) from engine_heartbeats where component='paper_feed'").fetchone()[0]
    assert ctx["data_provenance"] == "SYNTHETIC" and st[0] == 640 and st[1] == "SYNTHETIC" and hb >= 1
    assert counters.get("intents_created") == len(first)

    # REPLAY: rewind the cursor, throw away every in-memory stream, run the same 40 bars again, once with big batches
    with psycopg.connect(url) as c:
        c.execute("update paper_feed_state set cursor = 600 where workspace_id = %s", (w.ws,))
        c.commit()
    counters2: dict = {}
    pf.run_ticks(url, cfg, ticks=40, only=w.ws, streams={}, counters=counters2)
    second = _intents(url, w.ws)
    assert second == first, "replaying the same bars must create no new intent and change none"
    # two independent layers: sizing sees the unfinished intents as pending exposure (so nothing is re-emitted), and even a forced
    # re-emission is absorbed by the idempotency key (checked directly below)
    assert counters2.get("intents_created", 0) == 0

    # direct SQL replay returns the same id and does nothing else
    with psycopg.connect(url) as c:
        c.execute("select set_config('apex.service','on',true)")
        key = first[0][1].removeprefix("feed:")
        ctx_row = json.dumps(ctx)
        again = c.execute("select create_signal_intent(%s::uuid,%s::uuid,%s::uuid,%s::uuid,%s::uuid,'buy',1::numeric,1::numeric,'cex_trend_momentum',%s,%s::jsonb)",
                          (w.ws, w.bucket, w.wca, w.eth, w.usdc, key, ctx_row)).fetchone()[0]
        assert str(again) == first[0][0]


@pytest.mark.postgres
def test_feed_does_nothing_when_stopped_or_halted_and_sql_refuses_direct_calls(pg):
    if not pg_available():
        pytest.skip("no postgres")
    url, _ = pg
    w = _world(pg)
    cfg = CFG
    with psycopg.connect(url) as c:
        c.execute("update workspace_settings set paper_running = false where workspace_id = %s", (w.ws,))
        c.commit()
    c1: dict = {}
    pf.run_ticks(url, cfg, ticks=5, only=w.ws, counters=c1)
    assert _intents(url, w.ws) == [] and not c1.get("intents_created")
    with psycopg.connect(url) as c:
        c.execute("update workspace_settings set paper_running = true, global_state = 'halt_new_entries' where workspace_id = %s", (w.ws,))
        c.commit()
    pf.run_ticks(url, cfg, ticks=5, only=w.ws, counters=c1)
    assert _intents(url, w.ws) == []                                     # active_workspaces() requires global_state = 'active'
    # defence in depth: calling the SQL function directly while halted refuses a BUY
    with psycopg.connect(url) as c:
        c.execute("select set_config('apex.service','on',true)")
        with pytest.raises(psycopg.errors.RaiseException, match="refuses new entries"):
            c.execute("select create_signal_intent(%s::uuid,%s::uuid,%s::uuid,%s::uuid,%s::uuid,'buy',1000000000000000::numeric,2000000000::numeric,'cex_trend_momentum','x1',%s::jsonb)",
                      (w.ws, w.bucket, w.wca, w.eth, w.usdc, json.dumps({"max_fee_bps": 25})))
