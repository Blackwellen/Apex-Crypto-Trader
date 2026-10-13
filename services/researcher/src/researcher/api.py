"""FastAPI research service. Research/paper only: there is no route that can place an order or sign anything."""
from __future__ import annotations

import os
from typing import Literal

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import __version__
from .backtest.costs import PRESETS
from .backtest.engine import BacktestConfig, SleeveSpec, run_backtest
from .compounding import TargetPlan, WaterfallError, WaterfallPolicy, apply_waterfall, simulate_compounding, statistical_forecast
from .data.synthetic import SyntheticParams, generate
from .db import WorkspaceNotFound, database_url, record_simulation_run
from .llm import DisabledProvider, ModelGateway, ModelProvider, provider_from_env
from .provenance import DataProvenance
from .strategies.library import REGISTRY, build
from .tokensafety import GateThresholds, StrategyAdmission, TokenFindings, VendorEvidence, admit, universal_gate
from .validation.report import build_report
from .validation.walkforward import holdout_split

MAX_BARS = 20_000
MAX_SLEEVES = 10


class SleeveReq(BaseModel):
    name: str
    allocation: float = Field(ge=0.0, le=1.0)
    stage: Literal["research", "paper"] = "research"


class BacktestReq(BaseModel):
    seed: int = 7
    n_bars: int = Field(2000, ge=300, le=MAX_BARS)
    include_delisted: bool = True
    venue: Literal["cex", "dex"] = "cex"
    initial_cash_quote: int = Field(100_000, ge=100, le=10**9, description="whole quote units (e.g. USDC)")
    sleeves: list[SleeveReq] = Field(default_factory=lambda: [SleeveReq(name="trend_momentum", allocation=0.5), SleeveReq(name="risk_off", allocation=0.0)])
    n_boot: int = Field(200, ge=50, le=1000)
    n_paths: int = Field(200, ge=50, le=1000)
    workspace_id: str | None = None


class CompoundingReq(BaseModel):
    initial_equity: int = Field(ge=0)
    realized_pnls: list[int] = Field(max_length=5000)
    initial_deficit: int = Field(0, ge=0)
    reinvest_bps: int
    vault_bps: int
    cross_bucket_bps: int
    reserve_bps: int
    tax_provision_bps: int = 0
    min_ticket: int = Field(0, ge=0)
    target_amount: int | None = None
    target_pct_bps: int | None = None
    forecast_returns: list[float] | None = Field(None, max_length=20000, description="empirical per-trade returns for the SEPARATE statistical forecast")
    forecast_provenance: Literal["SYNTHETIC", "REAL_USER_SUPPLIED", "REAL_PUBLIC_API"] = "SYNTHETIC"
    forecast_validated: bool = False
    forecast_horizon_trades: int = Field(50, ge=1, le=2000)
    workspace_id: str | None = None


def create_app(provider: ModelProvider | None = None) -> FastAPI:
    app = FastAPI(title="APEX researcher", version=__version__, description="Research and paper only. No execution endpoints.")
    gateway = ModelGateway(provider or provider_from_env())

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "service": "researcher", "version": __version__, "mode": "research_paper_only",
                "execution_endpoints": False, "database_configured": bool(database_url()),
                "llm": {"provider": gateway.provider.name, "enabled": gateway.provider.enabled},
                "strategies": sorted(REGISTRY), "data_provenance_policy": "every result is labelled; synthetic results are never evidence of edge"}

    @app.post("/backtests")
    def backtests(req: BacktestReq) -> dict:
        for s in req.sleeves[:MAX_SLEEVES + 1]:
            if s.name not in REGISTRY:
                raise HTTPException(422, f"unknown strategy {s.name}")
        if len(req.sleeves) > MAX_SLEEVES or sum(s.allocation for s in req.sleeves) > 1.0 + 1e-9:
            raise HTTPException(422, "too many sleeves or allocations exceed 100%")
        ds = generate(SyntheticParams(seed=req.seed, n_bars=req.n_bars, include_delisted=req.include_delisted))
        sleeves = [SleeveSpec(build(s.name, s.stage), s.allocation) for s in req.sleeves]
        cfg = BacktestConfig(initial_cash=req.initial_cash_quote * 10**6, cost=PRESETS[req.venue], seed=req.seed)
        res = run_backtest(ds, sleeves, cfg)
        rep = build_report(ds, res, n_boot=req.n_boot, n_paths=req.n_paths)
        out = {"data_provenance": rep["data_provenance"], "report": rep, "recorded": False, "simulation_run_id": None}
        if req.workspace_id:
            url = database_url()
            if not url:
                out["record_error"] = "workspace_id supplied but DATABASE_URL is not configured; result not recorded"
            else:
                try:
                    params = {"seed": req.seed, "n_bars": req.n_bars, "include_delisted": req.include_delisted, "venue": req.venue,
                              "sleeves": [s.model_dump() for s in req.sleeves], "strategy_versions": res.strategies, "config_hash": res.config_hash}
                    metrics = {"point": rep["point_metrics"], "uncertainty": rep["metric_uncertainty"], "survivorship": rep["survivorship"],
                               "costs": rep["costs"], "provenance_banner": rep["provenance_banner"]}
                    out["simulation_run_id"] = record_simulation_run(url, req.workspace_id, "backtest", params, rep["data_provenance"], metrics)
                    out["recorded"] = True
                except WorkspaceNotFound:
                    raise HTTPException(404, "workspace not found")
                except ValueError:
                    raise HTTPException(422, "workspace_id is not a UUID")
        return out

    @app.post("/compounding/simulate")
    def compounding(req: CompoundingReq) -> dict:
        try:
            pol = WaterfallPolicy(req.reinvest_bps, req.vault_bps, req.cross_bucket_bps, req.reserve_bps, req.tax_provision_bps, req.min_ticket)
        except ValueError as e:
            raise HTTPException(422, str(e))
        target = None
        if req.target_amount is not None or req.target_pct_bps is not None:
            target = TargetPlan(req.initial_equity, req.target_amount, req.target_pct_bps)
        try:
            sim = simulate_compounding(req.initial_equity, req.realized_pnls, pol, target, req.initial_deficit)
        except WaterfallError as e:
            raise HTTPException(422, str(e))
        out = {"data_provenance": DataProvenance.SYNTHETIC.value, "target_tracking_scenario": sim,
               "separation_notice": "target tracking and statistical forecast are separate objects; a target never forces a trade"}
        if req.forecast_returns is not None:
            out["statistical_forecast"] = statistical_forecast(np.array(req.forecast_returns), req.forecast_horizon_trades,
                                                               DataProvenance(req.forecast_provenance), max(req.initial_equity, 1),
                                                               validated_empirical=req.forecast_validated)
        return out

    @app.post("/token-safety/evaluate")
    def token_safety(findings: dict, strategy: str = "default", position_usd: float = 1000.0, expected_gross_edge_bps: float = 0.0,
                     est_slippage_bps: float = 30.0) -> dict:
        try:
            vendors = tuple(VendorEvidence(**v) for v in findings.pop("vendors", []))
            f = TokenFindings(**findings, vendors=vendors)
        except TypeError as e:
            raise HTTPException(422, f"bad findings: {e}")
        gate = universal_gate(f)
        adm = admit(f, StrategyAdmission(strategy), position_usd, expected_gross_edge_bps, est_slippage_bps, gate)
        return {"data_provenance": "N/A_STRUCTURED_FINDINGS_INPUT", "stage1_passed": gate.passed, "vetoes": [x.__dict__ | {"severity": x.severity.value} for x in gate.vetoes],
                "warnings": [x.__dict__ | {"severity": x.severity.value} for x in gate.warnings], "score_informational": gate.score,
                "confidence": gate.confidence, "vendor_notes": list(gate.vendor_notes), "admitted_by_strategy": adm.admitted,
                "admission_reasons": list(adm.reasons)}

    app.state.gateway = gateway
    return app


app = create_app()
