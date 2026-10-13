"""Compounding scenario simulator that mirrors the SQL function apply_waterfall (migration 0004) in INTEGER math.

Mirrors, step by step:
  gross  = max(realized_net_quote, 0);  gross == 0 -> error 'no net realised profit to distribute'
  def    = min(existing deficit, gross)  (deficit recovered FIRST; consumed even when nothing is then distributed)
  elig   = gross - def
  elig < min_ticket or elig == 0 -> execution row with eligible 0 and all parts 0 (deficit still reduced)
  tax    = div(elig * tax_bps, 10000)
  vault  = div((elig - tax) * vault_bps, 10000);  cross likewise;  reserve likewise
  reinvest = elig - tax - vault - cross - reserve      (rounding remainder ALWAYS goes to reinvest)
  available < tax + vault + cross + reserve -> error 'insufficient available balance to distribute profit'
SQL `div()` truncates toward zero; all operands here are non-negative so it equals Python floor division.

TARGET TRACKING (compare against a user target) is deliberately separate from STATISTICAL FORECAST (resampled
distributions). A target never forces a trade.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

import numpy as np

from .provenance import DataProvenance, banner_for


class WaterfallError(Exception):
    pass


@dataclass(frozen=True)
class WaterfallPolicy:
    reinvest_bps: int
    vault_bps: int
    cross_bucket_bps: int
    reserve_bps: int
    tax_provision_bps: int = 0
    min_ticket: int = 0

    def __post_init__(self) -> None:
        for n in ("reinvest_bps", "vault_bps", "cross_bucket_bps", "reserve_bps", "tax_provision_bps"):
            v = getattr(self, n)
            if not isinstance(v, int) or isinstance(v, bool) or not 0 <= v <= 10000:
                raise ValueError(f"{n} must be an int in [0, 10000]")
        if self.reinvest_bps + self.vault_bps + self.cross_bucket_bps + self.reserve_bps != 10000:
            raise ValueError("waterfall_sums_to_100: reinvest+vault+cross+reserve must equal 10000 bps")
        if not isinstance(self.min_ticket, int) or self.min_ticket < 0:
            raise ValueError("min_ticket must be a non-negative int")


@dataclass(frozen=True)
class WaterfallResult:
    gross: int
    deficit_recovered: int
    eligible: int
    tax_provision: int
    to_reinvest: int
    to_vault: int
    to_cross: int
    to_reserve: int
    new_deficit: int

    def parts_tuple(self) -> tuple[int, ...]:
        return (self.gross, self.deficit_recovered, self.eligible, self.tax_provision, self.to_reinvest, self.to_vault, self.to_cross, self.to_reserve)


def apply_waterfall(realized_net_quote: int, deficit: int, policy: WaterfallPolicy, available: int | None = None) -> WaterfallResult:
    gross = max(realized_net_quote, 0)
    if gross == 0:
        raise WaterfallError("no net realised profit to distribute")
    d = min(max(deficit, 0), gross)
    new_deficit = max(deficit, 0) - d
    elig = gross - d
    if elig < policy.min_ticket or elig == 0:
        return WaterfallResult(gross, d, 0, 0, 0, 0, 0, 0, new_deficit)
    tax = elig * policy.tax_provision_bps // 10000
    base = elig - tax
    vt = base * policy.vault_bps // 10000
    cx = base * policy.cross_bucket_bps // 10000
    rs = base * policy.reserve_bps // 10000
    rv = elig - tax - vt - cx - rs
    if available is not None and available < tax + vt + cx + rs:
        raise WaterfallError("insufficient available balance to distribute profit")
    return WaterfallResult(gross, d, elig, tax, rv, vt, cx, rs, new_deficit)


@dataclass
class State:
    bucket_equity: int
    deficit: int = 0
    vault: int = 0
    cross: int = 0
    reserve: int = 0
    tax_provision: int = 0
    hwm: int = 0


def _record_loss(deficit: int, pnl: int) -> int:
    """mirrors record_realized_result: a loss GROWS the deficit by -pnl."""
    return deficit - pnl if pnl < 0 else deficit


@dataclass(frozen=True)
class TargetPlan:
    start_equity: int
    target_amount: int | None = None          # absolute, quote units
    target_pct_bps: int | None = None         # relative to start equity
    period: str = "month"
    monitoring_only: bool = True              # a target NEVER forces trades (matches target_plans CHECK)

    def target_value(self) -> int:
        if self.target_amount is not None:
            return self.target_amount
        if self.target_pct_bps is not None:
            return self.start_equity * self.target_pct_bps // 10000
        raise ValueError("target_amount or target_pct_bps required")


def simulate_compounding(initial_equity: int, realized_pnls: Sequence[int], policy: WaterfallPolicy, target: TargetPlan | None = None,
                         initial_deficit: int = 0) -> dict:
    """Deterministic scenario: apply a SEQUENCE of per-trade realised results through the waterfall.
    Output is labelled kind=TARGET_TRACKING_SCENARIO: it is arithmetic on supplied inputs, NOT a forecast."""
    st = State(initial_equity, initial_deficit, hwm=initial_equity)
    trace = []
    for i, pnl in enumerate(realized_pnls):
        row: dict = {"step": i, "realized_net": pnl}
        if pnl < 0:
            st.bucket_equity += pnl
            st.deficit = _record_loss(st.deficit, pnl)
            row.update(kind="loss", deficit_after=st.deficit)
        elif pnl == 0:
            row.update(kind="flat")
        else:
            st.bucket_equity += pnl                      # profit lands in the bucket first (available), then is distributed
            try:
                r = apply_waterfall(pnl, st.deficit, policy, available=st.bucket_equity)
            except WaterfallError as e:                  # SQL would raise and roll back: nothing is distributed
                row.update(kind="blocked", error=str(e))
                st.hwm = max(st.hwm, st.bucket_equity + st.vault + st.cross + st.reserve + st.tax_provision)
                row["bucket_equity"] = st.bucket_equity
                trace.append(row)
                continue
            st.deficit = r.new_deficit
            st.vault += r.to_vault; st.cross += r.to_cross; st.reserve += r.to_reserve; st.tax_provision += r.tax_provision
            st.bucket_equity -= r.to_vault + r.to_cross + r.to_reserve + r.tax_provision    # leaves available; reinvest stays
            row.update(kind="profit", **{k: v for k, v in r.__dict__.items()})
        st.hwm = max(st.hwm, st.bucket_equity + st.vault + st.cross + st.reserve + st.tax_provision)
        row["bucket_equity"] = st.bucket_equity
        trace.append(row)
    total_assets = st.bucket_equity + st.vault + st.cross + st.reserve + st.tax_provision
    out = {
        "kind": "TARGET_TRACKING_SCENARIO", "is_forecast": False, "data_provenance": DataProvenance.SYNTHETIC.value,
        "provenance_note": "Inputs are user/scenario supplied numbers, not market evidence.",
        "conservation": {"initial_equity": initial_equity, "sum_pnl": sum(realized_pnls), "final_total_assets": total_assets,
                         "holds": total_assets == initial_equity + sum(realized_pnls)},
        "final": {"bucket_equity": st.bucket_equity, "vault": st.vault, "cross": st.cross, "reserve": st.reserve,
                  "tax_provision": st.tax_provision, "deficit": st.deficit, "high_water_mark": st.hwm},
        "trace": trace,
    }
    if target is not None:
        tv = target.target_value()
        gained = total_assets - target.start_equity
        out["target_tracking"] = {"kind": "TARGET_TRACKING", "is_forecast": False, "monitoring_only": True, "target_value": tv,
                                  "achieved": gained, "progress_bps": (gained * 10000 // tv) if tv > 0 else None,
                                  "note": "Target is a user goal. It never forces trades and is not a prediction."}
    return out


def statistical_forecast(empirical_per_trade_returns: np.ndarray, horizon_trades: int, provenance: DataProvenance, start_equity: int,
                         n_paths: int = 1000, level: float = 0.90, seed: int = 3, min_obs: int = 200, validated_empirical: bool = False) -> dict:
    """Resampled-outcome range. SEPARATE from target tracking. Displayed as a forecast only when the distribution is
    validated empirical (real data, >= min_obs trades); otherwise returned with display_as_forecast False."""
    r = np.asarray(empirical_per_trade_returns, dtype=float)
    reasons = []
    if provenance is DataProvenance.SYNTHETIC:
        reasons.append("data is SYNTHETIC")
    if len(r) < min_obs:
        reasons.append(f"only {len(r)} observations (< {min_obs})")
    if not validated_empirical:
        reasons.append("distribution not marked validated against actual strategy results")
    base = {"kind": "STATISTICAL_FORECAST", "is_target": False, "data_provenance": provenance.value,
            "display_as_forecast": not reasons, "withheld_reasons": reasons, "provenance_banner": banner_for(provenance),
            "assumptions": "i.i.d. resampling of per-trade returns; no regime change; costs already inside returns; level=%s" % level}
    if len(r) < 2:
        return {**base, "status": "INSUFFICIENT_DATA"}
    rng = np.random.default_rng(seed)
    idx = rng.integers(len(r), size=(n_paths, horizon_trades))
    mult = np.prod(1.0 + np.maximum(r[idx], -0.999), axis=1)
    lo, hi = (1 - level) / 2, 1 - (1 - level) / 2
    return {**base, "status": "OK", "n_paths": n_paths, "horizon_trades": horizon_trades,
            "terminal_equity_median": int(start_equity * float(np.median(mult))),   # reporting-only float->int, not accounting
            "terminal_equity_ci": [int(start_equity * float(np.quantile(mult, lo))), int(start_equity * float(np.quantile(mult, hi)))],
            "prob_loss": float((mult < 1).mean())}
