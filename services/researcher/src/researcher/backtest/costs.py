"""Execution cost model: fees, spread, book-depth slippage, gas/priority, failed-tx probability, round-trip estimate.

All money results are integers (quote micro-units). Floats appear only in bps parameters and ratios.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from decimal import Decimal

from ..units import (BASE_ONE, QUOTE_ONE, adverse_price, bps_to_ppm, ceil_ppm, notional_units)


@dataclass(frozen=True)
class CostModel:
    venue: str = "cex"                          # "cex" | "dex"
    maker_fee_bps: float = 10.0
    taker_fee_bps: float = 20.0                 # DEX: pool fee tier (e.g. 30 bps)
    half_spread_bps: float = 4.0
    depth_fraction_of_bar_volume: float = 0.04  # quote depth resting within depth_bps of mid, as fraction of bar quote volume
    depth_bps: float = 30.0                     # linear book: walking the whole depth costs depth_bps/2 on average
    impact_exponent: float = 1.0                # >1 makes impact convex past the displayed depth
    max_participation: float = 0.10             # never fill more than this share of bar quote volume
    # on-chain costs (only used when venue == "dex")
    gas_units: int = 180_000
    base_fee_gwei: float = 25.0
    priority_fee_gwei: float = 3.0
    native_price_quote: float = 2500.0          # quote per 1 native token
    fail_prob: float = 0.03                     # probability the tx fails but still burns gas
    gas_multiplier: float = 1.0                 # stress knob (fee spikes)
    cost_multiplier: float = 1.0                # stress knob applied to fees+spread+impact

    def stressed(self, cost_mult: float = 1.0, gas_mult: float = 1.0) -> "CostModel":
        return replace(self, cost_multiplier=self.cost_multiplier * cost_mult, gas_multiplier=self.gas_multiplier * gas_mult)

    # ------------------------------------------------------------------ pieces
    def gas_cost_units(self) -> int:
        if self.venue != "dex":
            return 0
        native = Decimal(self.gas_units) * Decimal(self.base_fee_gwei + self.priority_fee_gwei) * Decimal(self.gas_multiplier) / Decimal(10**9)
        return int((native * Decimal(self.native_price_quote) * QUOTE_ONE).to_integral_value())

    def fee_ppm(self, maker: bool = False) -> int:
        return int(round(bps_to_ppm(self.maker_fee_bps if maker else self.taker_fee_bps) * self.cost_multiplier))

    def impact_ppm(self, notional: int, bar_quote_volume: int) -> int:
        """adverse price move (ppm) = half spread + average walk of the book for this order size."""
        depth = max(1.0, self.depth_fraction_of_bar_volume * bar_quote_volume)
        ratio = notional / depth
        walk_bps = 0.5 * self.depth_bps * (ratio ** self.impact_exponent)
        return int(round((bps_to_ppm(self.half_spread_bps) + bps_to_ppm(walk_bps)) * self.cost_multiplier))

    def max_fillable_notional(self, bar_quote_volume: int) -> int:
        return int(self.max_participation * bar_quote_volume)

    def roundtrip_cost_bps(self, notional: int, bar_quote_volume: int) -> float:
        """expected entry+exit cost in bps of notional: fees + spread + impact both ways + gas + failed-tx drag."""
        if notional <= 0:
            return 0.0
        one_way_ppm = self.fee_ppm() + self.impact_ppm(notional, bar_quote_volume)
        gas = self.gas_cost_units()
        p = min(max(self.fail_prob, 0.0), 0.99)
        gas_expected = gas / (1.0 - p) if gas else 0.0           # geometric retries: each failure burns another gas
        return 2 * (one_way_ppm / 100.0) + 2 * gas_expected / notional * 1e4

    # ------------------------------------------------------------------ execution
    def execute(self, side: str, qty_units: int, open_px: Decimal, bar_quote_volume: int, u_fail: float) -> "ExecResult":
        """Simulate a market order at the next bar's open. u_fail in [0,1) is a seeded uniform draw."""
        buy = side == "buy"
        cap = self.max_fillable_notional(bar_quote_volume)
        if cap <= 0 or qty_units <= 0:
            return ExecResult("no_liquidity", 0, 0, open_px, 0, 0, 0)
        want = notional_units(qty_units, open_px, round_up=buy)
        partial = False
        if want > cap:                                        # participation cap -> partial fill
            qty_units = int(qty_units * cap // want)
            partial = True
            if qty_units <= 0:
                return ExecResult("no_liquidity", 0, 0, open_px, 0, 0, 0)
        gas = self.gas_cost_units()
        if gas and u_fail < self.fail_prob:
            return ExecResult("failed_tx", 0, 0, open_px, 0, gas, 0)
        ref_notional = notional_units(qty_units, open_px, round_up=buy)
        ppm = self.impact_ppm(ref_notional, bar_quote_volume)
        px = adverse_price(open_px, ppm, buy=buy)
        notional = notional_units(qty_units, px, round_up=buy)
        fee = ceil_ppm(notional, self.fee_ppm())
        slip_cost = abs(notional - notional_units(qty_units, open_px, round_up=buy))
        return ExecResult("partial" if partial else "filled", qty_units, notional, px, fee, gas, slip_cost)


@dataclass(frozen=True)
class ExecResult:
    status: str            # filled | partial | failed_tx | no_liquidity
    qty_units: int
    notional: int          # quote units at execution price (incl. spread+impact, excl. fee/gas)
    price: Decimal
    fee: int
    gas: int
    slippage_cost: int     # |notional - notional at open price| (spread + impact), informational


PRESETS = {
    "cex": CostModel(venue="cex"),
    "dex": CostModel(venue="dex", taker_fee_bps=30.0, half_spread_bps=2.0, depth_fraction_of_bar_volume=0.02, fail_prob=0.05),
}
