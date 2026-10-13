"""Data provenance labels. EVERY output of this service carries `data_provenance`."""
from __future__ import annotations

from enum import Enum


class DataProvenance(str, Enum):
    SYNTHETIC = "SYNTHETIC"                     # seeded generator; says nothing about real markets
    REAL_USER_SUPPLIED = "REAL_USER_SUPPLIED"   # CSV/parquet the user plugged in (quality unverified by us)
    REAL_PUBLIC_API = "REAL_PUBLIC_API"         # fetched from an exchange public endpoint


SYNTHETIC_BANNER = (
    "DATA PROVENANCE: SYNTHETIC. These numbers come from a seeded random generator, not from any market. "
    "They test the plumbing and the statistics code. They are NOT evidence that any strategy has an edge."
)


def banner_for(p: DataProvenance) -> str:
    if p is DataProvenance.SYNTHETIC:
        return SYNTHETIC_BANNER
    return (f"DATA PROVENANCE: {p.value}. Real data does not by itself demonstrate an edge: check survivorship, "
            "costs, sample length and out-of-sample results before drawing conclusions.")


def edge_claim_for(p: DataProvenance) -> str:
    return "NONE - synthetic data cannot demonstrate an edge" if p is DataProvenance.SYNTHETIC else \
        "UNPROVEN - see confidence intervals, out-of-sample and survivorship sections"


def assert_labelled(obj: object, path: str = "$") -> None:
    """Raise if a top-level result dict lacks a data_provenance label (used by API tests)."""
    if not isinstance(obj, dict) or "data_provenance" not in obj:
        raise AssertionError(f"unlabelled output at {path}")
    DataProvenance(obj["data_provenance"])
