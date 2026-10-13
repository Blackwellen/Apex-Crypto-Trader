"""Bit-for-bit cross-validation of researcher.compounding.apply_waterfall against the REAL Postgres apply_waterfall().

A fresh database is built per run (auth shim + all migrations). Every hypothesis example runs inside a transaction that
is rolled back, so examples are independent. REAL DATABASE, REAL FUNCTION - not a mock.
"""
import itertools
import uuid

import psycopg
import pytest
from hypothesis import HealthCheck, event, given, settings
from hypothesis import strategies as st

from pgworld import drop_db, fresh_db, pg_available, seed_world
from researcher.compounding import WaterfallError, WaterfallPolicy, apply_waterfall

pytestmark = pytest.mark.postgres
if not pg_available():
    pytest.skip("BLOCKED: Postgres not reachable at ADMIN_DATABASE_URL", allow_module_level=True)

_k = itertools.count()


@pytest.fixture(scope="module")
def world():
    url, name = fresh_db()
    w = seed_world(url, name, funds=10**30)
    yield w
    drop_db(name)


def run_sql(w, realized, deficit, pol: WaterfallPolicy, cur):
    """seed one reconciled profit event + policy + deficit inside the open transaction `cur`, call apply_waterfall."""
    n = next(_k)
    iid = cur.execute("""insert into trade_intents(workspace_id,environment,bucket_id,strategy_key,wallet_chain_account_id,base_asset,quote_asset,side,quantity,notional,state,idempotency_key)
        values (%s,'paper',%s,'xval',%s,%s,%s,'sell',1,1,'RECONCILED',%s) returning id""", (w.ws, w.bucket, w.wca, w.eth, w.usdc, f"k{n}")).fetchone()[0]
    ev = cur.execute("insert into profit_eligibility_events(workspace_id,environment,bucket_id,intent_id,quote_asset,realized_net_quote) values (%s,'paper',%s,%s,%s,%s) returning id",
                     (w.ws, w.bucket, iid, w.usdc, realized)).fetchone()[0]
    pid = cur.execute("""insert into compounding_policies(workspace_id,bucket_id,version,reinvest_bps,vault_bps,cross_bucket_bps,reserve_bps,tax_provision_bps,min_ticket,vault_bucket_id,vault_wca,cross_bucket_id,cross_wca)
        values (%s,%s,1,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id""",
                      (w.ws, w.bucket, pol.reinvest_bps, pol.vault_bps, pol.cross_bucket_bps, pol.reserve_bps, pol.tax_provision_bps, pol.min_ticket,
                       w.vault, w.wca2, w.vault, w.wca2)).fetchone()[0]
    if deficit:
        cur.execute("insert into bucket_deficits(bucket_id,quote_asset,amount) values (%s,%s,%s)", (w.bucket, w.usdc, deficit))
    xid = cur.execute("select apply_waterfall(%s,%s)", (ev, pid)).fetchone()[0]
    row = cur.execute("select gross,deficit_recovered,eligible,tax_provision,to_reinvest,to_vault,to_cross,to_reserve from waterfall_executions where id=%s", (xid,)).fetchone()
    newdef = cur.execute("select coalesce(sum(amount),0) from bucket_deficits where bucket_id=%s and quote_asset=%s", (w.bucket, w.usdc)).fetchone()[0]
    bal = {s: cur.execute("select coalesce(sum(balance),0) from ledger_accounts where bucket_id=%s and asset_id=%s and state=%s", (w.bucket, w.usdc, s)).fetchone()[0]
           for s in ("restricted", "fee_reserve")}
    # idempotency: second call returns same execution, changes nothing
    assert cur.execute("select apply_waterfall(%s,%s)", (ev, pid)).fetchone()[0] == xid
    return tuple(int(x) for x in row), int(newdef), {k: int(v) for k, v in bal.items()}


@st.composite
def policies(draw):
    cuts = sorted(draw(st.lists(st.integers(0, 10000), min_size=3, max_size=3)))
    return WaterfallPolicy(cuts[0], cuts[1] - cuts[0], cuts[2] - cuts[1], 10000 - cuts[2], draw(st.integers(0, 10000)),
                           draw(st.one_of(st.just(0), st.integers(0, 10**6), st.integers(0, 10**20))))


@settings(max_examples=150, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow])
@given(realized=st.one_of(st.integers(1, 10**6), st.integers(1, 10**22), st.integers(-10**6, 0)),
       deficit=st.one_of(st.just(0), st.integers(0, 10**6), st.integers(0, 10**22)), pol=policies())
def test_python_mirror_equals_postgres_bit_for_bit(world, realized, deficit, pol):
    py_err, py = None, None
    try:
        py = apply_waterfall(realized, deficit, pol)
    except WaterfallError as e:
        py_err = str(e)
    with psycopg.connect(world.url) as c:
        c.execute("select set_config('apex.service','on',true)")
        try:
            sql_row, sql_def, bal = run_sql(world, realized, deficit, pol, c)
            sql_err = None
        except psycopg.errors.RaiseException as e:
            sql_row, sql_def, bal, sql_err = None, None, None, str(e).splitlines()[0]
        c.rollback()
    event(f"outcome={'error:' + py_err if py_err else ('distributed' if py.eligible else 'nothing_eligible')}")
    if py_err or sql_err:
        assert py_err is not None and sql_err is not None, f"error mismatch: python={py_err!r} sql={sql_err!r}"
        assert py_err in sql_err, f"different errors: python={py_err!r} sql={sql_err!r}"
        return
    assert sql_row == py.parts_tuple(), f"row mismatch\n sql={sql_row}\n py ={py.parts_tuple()}"
    assert sql_def == py.new_deficit
    assert bal["restricted"] == py.tax_provision and bal["fee_reserve"] == py.to_reserve    # ledger side effects mirror the split


def test_insufficient_available_balance_matches_sql():
    url, name = fresh_db()
    try:
        w = seed_world(url, name, funds=100)               # only 100 units available in the bucket
        pol = WaterfallPolicy(4000, 3500, 1500, 1000, 1000)
        with pytest.raises(WaterfallError, match="insufficient available"):
            apply_waterfall(1000, 0, pol, available=100)
        with psycopg.connect(url) as c:
            c.execute("select set_config('apex.service','on',true)")
            with pytest.raises(psycopg.errors.RaiseException, match="insufficient available balance"):
                run_sql(w, 1000, 0, pol, c)
            c.rollback()
    finally:
        drop_db(name)


def test_sql_rejects_unreconciled_profit_python_has_no_such_state():
    """Documented boundary: the RECONCILED-state gate lives only in SQL (the simulator takes already-eligible profit)."""
    url, name = fresh_db()
    try:
        w = seed_world(url, name, funds=10**9)
        with psycopg.connect(url) as c:
            c.execute("select set_config('apex.service','on',true)")
            iid = c.execute("""insert into trade_intents(workspace_id,environment,bucket_id,strategy_key,wallet_chain_account_id,base_asset,quote_asset,side,quantity,notional,state,idempotency_key)
                values (%s,'paper',%s,'x',%s,%s,%s,'sell',1,1,'FILLED','kk') returning id""", (w.ws, w.bucket, w.wca, w.eth, w.usdc)).fetchone()[0]
            ev = c.execute("insert into profit_eligibility_events(workspace_id,environment,bucket_id,intent_id,quote_asset,realized_net_quote) values (%s,'paper',%s,%s,%s,500) returning id",
                           (w.ws, w.bucket, iid, w.usdc)).fetchone()[0]
            pid = c.execute("""insert into compounding_policies(workspace_id,bucket_id,version,reinvest_bps,vault_bps,cross_bucket_bps,reserve_bps,vault_bucket_id,vault_wca)
                values (%s,%s,1,5000,5000,0,0,%s,%s) returning id""", (w.ws, w.bucket, w.vault, w.wca2)).fetchone()[0]
            with pytest.raises(psycopg.errors.RaiseException, match="profit not eligible"):
                c.execute("select apply_waterfall(%s,%s)", (ev, pid))
            c.rollback()
    finally:
        drop_db(name)
