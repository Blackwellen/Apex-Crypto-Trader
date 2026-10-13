"""Integer money units. No float ever holds money.

quote amounts: integer micro-units (6 decimals, like USDC). base quantities: integer 1e-8 units.
Prices are Decimal (quote per 1 whole base), quantised to 1e-8.
"""
from __future__ import annotations

from decimal import ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_EVEN, Decimal, getcontext

getcontext().prec = 50

QUOTE_DECIMALS = 6
BASE_DECIMALS = 8
QUOTE_ONE = 10**QUOTE_DECIMALS
BASE_ONE = 10**BASE_DECIMALS
PPM = 1_000_000
_PRICE_Q = Decimal("1e-8")


def price_dec(x: float) -> Decimal:
    """Deterministic float -> Decimal price (market data may be float; money never is)."""
    return Decimal(repr(float(x))).quantize(_PRICE_Q, rounding=ROUND_HALF_EVEN)


def notional_units(qty_units: int, price: Decimal, *, round_up: bool) -> int:
    """quote micro-units of qty_units (1e-8 base) at price."""
    v = Decimal(qty_units) * price * QUOTE_ONE / BASE_ONE
    return int(v.to_integral_value(rounding=ROUND_CEILING if round_up else ROUND_FLOOR))


def qty_for_value(value_units: int, price: Decimal) -> int:
    """largest base qty (1e-8 units) whose notional is <= value_units."""
    if price <= 0 or value_units <= 0:
        return 0
    return int((Decimal(value_units) * BASE_ONE / QUOTE_ONE / price).to_integral_value(rounding=ROUND_FLOOR))


def ceil_ppm(amount: int, ppm: int) -> int:
    """ceil(amount * ppm / 1e6) with pure integers (costs round against us)."""
    return -((-amount * ppm) // PPM)


def floor_ppm(amount: int, ppm: int) -> int:
    return (amount * ppm) // PPM


def bps_to_ppm(bps: float) -> int:
    return int(round(bps * 100))


def adverse_price(px: Decimal, ppm: int, *, buy: bool) -> Decimal:
    f = Decimal(PPM + ppm if buy else PPM - ppm) / PPM
    return (px * f).quantize(_PRICE_Q, rounding=ROUND_CEILING if buy else ROUND_FLOOR)
