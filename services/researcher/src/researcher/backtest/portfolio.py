"""Portfolio-level netting of competing sleeve signals (spec: competing signals for one asset must NET)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from ..strategies.base import SleeveOutput


@dataclass(frozen=True)
class NetResult:
    weights: dict[str, float]                  # final long-only target weights of equity
    stacked_long: dict[str, float]             # what naive stacking of long signals would have requested
    netting_saved: dict[str, float]            # stacked_long - final (risk NOT taken thanks to netting)
    risk_multiplier: float
    contributors: dict[str, list[tuple[str, float]]]   # asset -> [(sleeve, allocated weight)]


def net_sleeves(outputs: Sequence[tuple[str, float, SleeveOutput]], max_asset_weight: float = 1.0,
                max_gross: float = 1.0) -> NetResult:
    """outputs: (sleeve_name, capital_fraction, SleeveOutput). Weights are summed per asset in equity terms, so a long
    in one sleeve and a short/flat-down signal in another cancel; the result is clamped to long-only spot, a per-asset
    cap and a no-leverage gross cap. Overlay risk multipliers combine by min()."""
    raw: dict[str, float] = {}
    stacked: dict[str, float] = {}
    contrib: dict[str, list[tuple[str, float]]] = {}
    mult = 1.0
    for name, alloc, out in outputs:
        mult = min(mult, out.risk_multiplier)
        for a, w in out.weights.items():
            x = alloc * max(-1.0, min(1.0, w))
            raw[a] = raw.get(a, 0.0) + x
            if x > 0:
                stacked[a] = stacked.get(a, 0.0) + x
            contrib.setdefault(a, []).append((name, x))
    net = {a: min(max(v, 0.0) * mult, max_asset_weight) for a, v in raw.items()}
    net = {a: v for a, v in net.items() if v > 1e-12}
    gross = sum(net.values())
    if gross > max_gross:
        net = {a: v * max_gross / gross for a, v in net.items()}
    saved = {a: stacked.get(a, 0.0) - net.get(a, 0.0) for a in stacked if stacked[a] - net.get(a, 0.0) > 1e-12}
    return NetResult(net, stacked, saved, mult, contrib)
