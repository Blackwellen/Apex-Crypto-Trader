"""Typed StrategyDefinition plugin API (spec section 5).

A strategy is pure data + two pure functions:
  feature_fn(panel) -> {name: (T,N) array}   must be causal (validated by backtest.lookahead before every run)
  signal_fn(ctx)    -> SleeveOutput          sees ONLY feature rows <= t (prefix views), never the future
Strategies emit desired weights for their own sleeve; they never place orders. Orders are produced by the
portfolio netting + execution layer so competing signals on one asset are netted, not stacked.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Mapping

import numpy as np

from ..data.dataset import AssetMeta, Panel
from ..regime import Regime


class Stage(str, Enum):
    RESEARCH = "research"
    PAPER = "paper"


class FailPolicy(str, Enum):
    HOLD = "hold"                         # keep positions, no new entries
    FLATTEN = "flatten"                   # go to cash
    HALT_NEW_ENTRIES = "halt_new_entries"


@dataclass(frozen=True)
class CapitalRequest:
    max_sleeve_weight: float              # fraction of equity the sleeve may use at most
    max_per_asset_weight: float           # within the sleeve
    min_order_quote_units: int = 10 * 10**6


@dataclass(frozen=True)
class SleeveOutput:
    weights: Mapping[str, float] = field(default_factory=dict)      # asset -> desired weight in [-1, 1] of the sleeve
    risk_multiplier: float = 1.0                                    # overlay: <1 de-risks the whole portfolio
    expected_edge_bps: Mapping[str, float] | None = None            # optional gross edge claim per asset (cost gate)
    reason: str = ""


@dataclass
class SignalContext:
    t: int                                       # current bar index (decision made at close of bar t)
    assets: tuple[str, ...]
    features: Mapping[str, np.ndarray]           # read-only prefix views: shape (t+1, N)
    regime: int                                  # Regime value at t
    alive: np.ndarray                            # (N,) bool at t
    current_weights: np.ndarray                  # (N,) portfolio weights now (sleeve-agnostic, for hysteresis)
    state: dict                                  # mutable per-sleeve state (deterministic)
    meta: Mapping[str, AssetMeta]

    def f(self, name: str) -> np.ndarray:
        """feature values at the decision bar t, shape (N,)"""
        return self.features[name][self.t]


@dataclass(frozen=True)
class StrategyDefinition:
    name: str
    version: str
    stage: Stage
    description: str
    eligibility: Callable[[AssetMeta], bool]
    regimes_allowed: frozenset[Regime]
    required_features: tuple[str, ...]
    feature_fn: Callable[[Panel], dict[str, np.ndarray]]
    signal_fn: Callable[[SignalContext], SleeveOutput]
    capital_request: CapitalRequest
    fail_policy: FailPolicy = FailPolicy.FLATTEN
    expected_horizon_bars: int = 24
    max_adverse_excursion_pct: float = 0.15
    emergency_exit: bool = True               # can always go flat (long-only spot, no lock-ups)
    allowed_venues: tuple[str, ...] = ("cex", "dex")
    min_warmup_bars: int = 200
    params: Mapping[str, object] = field(default_factory=dict)
    research_evidence: tuple[str, ...] = ()  # references to validation artefacts; empty = none

    @property
    def key(self) -> str:
        return f"{self.name}@{self.version}:{self.stage.value}"


class DeploymentBlocked(Exception):
    pass


def deployment_blockers(d: StrategyDefinition, provenance_of_evidence: list[str]) -> list[str]:
    """Why this strategy may not advance beyond its current stage. Synthetic evidence never counts."""
    blockers = []
    real = [p for p in provenance_of_evidence if p != "SYNTHETIC"]
    if not real:
        blockers.append("no non-synthetic research evidence: synthetic results cannot promote a strategy")
    if not d.research_evidence:
        blockers.append("no research_evidence artefact referenced")
    if d.stage is Stage.PAPER:
        blockers.append("PAPER is the highest stage this service can assign; live is gated elsewhere (risk gateway + gates)")
    return blockers
