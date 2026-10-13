import json
import warnings

import psycopg
import pytest

warnings.filterwarnings("ignore", category=DeprecationWarning)
from fastapi.testclient import TestClient  # noqa: E402

from pgworld import drop_db, fresh_db, pg_available, seed_world  # noqa: E402
from researcher.api import create_app  # noqa: E402
from researcher.llm import DisabledProvider  # noqa: E402
from researcher.provenance import assert_labelled  # noqa: E402

client = TestClient(create_app(DisabledProvider()))
POLICY = dict(initial_equity=1_000_000, realized_pnls=[5000, -2000, 8000], reinvest_bps=4000, vault_bps=3500, cross_bucket_bps=1500, reserve_bps=1000, tax_provision_bps=1000)


def test_health():
    j = client.get("/health").json()
    assert j["status"] == "ok" and j["execution_endpoints"] is False and j["llm"] == {"provider": "disabled", "enabled": False}


def test_no_execution_or_signing_routes_exist():
    paths = {r.path for r in client.app.routes}
    assert not any(w in p for p in paths for w in ("order", "execute", "sign", "withdraw", "transfer", "trade"))


def test_backtest_is_labelled_synthetic_with_uncertainty_and_survivorship():
    r = client.post("/backtests", json={"n_bars": 700, "n_boot": 50, "n_paths": 50, "include_delisted": False})
    assert r.status_code == 200
    j = r.json()
    assert_labelled(j) and assert_labelled(j["report"])
    assert j["data_provenance"] == "SYNTHETIC" and j["report"]["edge_claim"].startswith("NONE")
    assert j["report"]["survivorship"]["bias_flag"] == "SURVIVORSHIP_BIAS_PRESENT"
    assert "metric_uncertainty" in j["report"] and j["recorded"] is False


def test_backtest_validation():
    assert client.post("/backtests", json={"sleeves": [{"name": "nope", "allocation": 0.1}]}).status_code == 422
    assert client.post("/backtests", json={"sleeves": [{"name": "trend_momentum", "allocation": 0.8}, {"name": "grid_range", "allocation": 0.8}]}).status_code == 422
    assert client.post("/backtests", json={"n_bars": 10**7}).status_code == 422


def test_backtest_workspace_without_database_is_reported_not_silently_dropped(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    j = client.post("/backtests", json={"n_bars": 400, "n_boot": 50, "n_paths": 50, "workspace_id": "00000000-0000-0000-0000-000000000001"}).json()
    assert j["recorded"] is False and "DATABASE_URL" in j["record_error"]


def test_compounding_endpoint_target_and_forecast_are_separate():
    j = client.post("/compounding/simulate", json={**POLICY, "target_pct_bps": 100}).json()
    assert_labelled(j)
    assert j["target_tracking_scenario"]["conservation"]["holds"] and j["target_tracking_scenario"]["target_tracking"]["is_forecast"] is False
    assert "statistical_forecast" not in j
    j2 = client.post("/compounding/simulate", json={**POLICY, "forecast_returns": [0.01, -0.02] * 150, "forecast_validated": True}).json()
    f = j2["statistical_forecast"]
    assert f["kind"] == "STATISTICAL_FORECAST" and f["display_as_forecast"] is False and any("SYNTHETIC" in x for x in f["withheld_reasons"])


def test_compounding_rejects_bad_policy():
    assert client.post("/compounding/simulate", json={**POLICY, "reserve_bps": 999}).status_code == 422


def test_token_safety_endpoint_rejects_mint_authority():
    f = dict(chain_family="solana", sell_simulation_ok=True, sell_simulation_slippage_bps=50, buy_tax_bps=0, sell_tax_bps=0, mint_authority_set=True,
             freeze_authority_set=False, permanent_delegate_set=False, transfer_hook_set=False, transfer_fee_bps=0, liquidity_usd=900000, exit_depth_usd=500000,
             lp_locked_pct=100, lp_lock_verified=True, lp_lock_remaining_days=400, lp_controlled_by_deployer=False, top1_holder_pct=3, top10_holder_pct=20)
    j = client.post("/token-safety/evaluate", json=f).json()
    assert j["stage1_passed"] is False and any(v["code"] == "MINT_AUTHORITY" for v in j["vetoes"]) and j["admitted_by_strategy"] is False


@pytest.mark.postgres
@pytest.mark.skipif(not pg_available(), reason="BLOCKED: Postgres not reachable")
def test_backtest_records_simulation_run_in_postgres(monkeypatch):
    url, name = fresh_db()
    try:
        w = seed_world(url, name, funds=1000)
        monkeypatch.setenv("DATABASE_URL", url)
        j = client.post("/backtests", json={"n_bars": 500, "n_boot": 50, "n_paths": 50, "workspace_id": w.ws}).json()
        assert j["recorded"] is True
        with psycopg.connect(url) as c:
            row = c.execute("select kind, data_provenance, status, params, metrics from simulation_runs where id=%s", (j["simulation_run_id"],)).fetchone()
        assert row[0] == "backtest" and row[1] == "SYNTHETIC" and row[2] == "done"
        assert row[3]["strategy_versions"] and "point" in row[4] and row[4]["survivorship"]["includes_delisted"] is True
        missing = client.post("/backtests", json={"n_bars": 400, "n_boot": 50, "n_paths": 50, "workspace_id": "11111111-1111-1111-1111-111111111111"})
        assert missing.status_code == 404
        assert client.post("/backtests", json={"n_bars": 400, "n_boot": 50, "n_paths": 50, "workspace_id": "not-a-uuid"}).status_code == 422
    finally:
        drop_db(name)
