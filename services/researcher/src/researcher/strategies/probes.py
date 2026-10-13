"""Demonstration probes (NOT trading strategies, never registered): used to show survivorship effects in tests/reports."""
from __future__ import annotations

from ..regime import Regime
from .base import CapitalRequest, SleeveOutput, Stage, StrategyDefinition
from .library import common_features


def buy_every_live_meme(stage: Stage = Stage.RESEARCH) -> StrategyDefinition:
    """Equal-weight every meme asset that is alive (the classic naive 'buy new launches'). Exposes rug losses."""
    def sig(ctx):
        m = {a: 1.0 for i, a in enumerate(ctx.assets) if ctx.alive[i] and a.startswith("MEME") and ctx.features["age"][ctx.t, i] >= 1}
        return SleeveOutput(m, reason="probe: buy every live meme")
    return StrategyDefinition("probe_buy_every_meme", "0", stage, "survivorship demonstration probe", lambda m: True, frozenset(Regime), ("age",),
                              common_features, sig, CapitalRequest(1.0, 1.0))
