"""Integer-only portfolio accounting. average-cost basis, fees and gas capitalised into basis / netted from proceeds.

Identity when flat:  cash == initial + sum(realized) - unattributed_costs      (asserted in tests)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from ..units import notional_units


@dataclass
class Position:
    qty: int = 0
    basis: int = 0          # quote units incl. buy fees + gas


@dataclass
class Account:
    initial_cash: int
    cash: int = 0
    realized: int = 0
    unattributed_costs: int = 0                  # gas burnt by failed transactions
    fees_paid: int = 0
    gas_paid: int = 0
    slippage_paid: int = 0
    positions: dict[str, Position] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.cash = self.initial_cash

    def pos(self, a: str) -> Position:
        return self.positions.setdefault(a, Position())

    def buy(self, a: str, qty: int, notional: int, fee: int, gas: int, slip: int) -> None:
        total = notional + fee + gas
        if total > self.cash:
            raise ValueError("insufficient cash (engine must size buys to cash)")
        p = self.pos(a)
        self.cash -= total
        p.qty += qty
        p.basis += total
        self.fees_paid += fee; self.gas_paid += gas; self.slippage_paid += slip

    def sell(self, a: str, qty: int, notional: int, fee: int, gas: int, slip: int) -> int:
        p = self.pos(a)
        if qty > p.qty or qty <= 0:
            raise ValueError("cannot sell more than held")
        proceeds = notional - fee - gas
        basis_part = p.basis if qty == p.qty else (p.basis * qty) // p.qty
        pnl = proceeds - basis_part
        self.cash += proceeds
        p.qty -= qty
        p.basis -= basis_part
        self.realized += pnl
        self.fees_paid += fee; self.gas_paid += gas; self.slippage_paid += slip
        return pnl

    def failed_tx(self, gas: int) -> None:
        g = min(gas, self.cash)
        self.cash -= g
        self.unattributed_costs += g
        self.gas_paid += g

    def write_off(self, a: str, recovered: int) -> int:
        """forced liquidation (delisting/rug): realise whatever is recovered, no fees."""
        p = self.pos(a)
        pnl = recovered - p.basis
        self.cash += recovered
        self.realized += pnl
        p.qty = 0
        p.basis = 0
        return pnl

    def equity(self, prices: dict[str, Decimal]) -> int:
        e = self.cash
        for a, p in self.positions.items():
            if p.qty:
                e += notional_units(p.qty, prices[a], round_up=False)
        return e
