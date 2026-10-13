"""Optional public OHLCV fetch (no API key). Network may be blocked: callers must handle PublicDataBlocked.

Only Coinbase Exchange / Kraken public candle endpoints are wired. Result provenance is REAL_PUBLIC_API and the
dataset is declared SURVIVORS-ONLY (we only request currently listed majors), so survivorship bias is flagged.
"""
from __future__ import annotations

import time

import httpx
import polars as pl

from ..provenance import DataProvenance
from .dataset import Dataset, SurvivorshipDeclaration
from .loader import frame_to_dataset


class PublicDataBlocked(Exception):
    pass


def fetch_coinbase_candles(product: str, granularity: int, n_bars: int, end_ts: int | None = None,
                           timeout: float = 20.0) -> pl.DataFrame:
    end = end_ts or int(time.time() // granularity * granularity)
    rows: list[list[float]] = []
    try:
        with httpx.Client(timeout=timeout, headers={"User-Agent": "apex-researcher/0.1"}) as c:
            while len(rows) < n_bars:
                start = end - 300 * granularity
                r = c.get(f"https://api.exchange.coinbase.com/products/{product}/candles",
                          params={"granularity": granularity, "start": start, "end": end})
                if r.status_code != 200:
                    raise PublicDataBlocked(f"coinbase {product}: HTTP {r.status_code}")
                chunk = r.json()
                if not chunk:
                    break
                rows.extend(chunk)
                end = start
                time.sleep(0.4)
    except httpx.HTTPError as e:
        raise PublicDataBlocked(f"coinbase {product}: {type(e).__name__}: {e}") from e
    # coinbase row: [time, low, high, open, close, volume]
    df = pl.DataFrame(rows, schema=["timestamp", "low", "high", "open", "close", "volume"], orient="row")
    return df.unique("timestamp").sort("timestamp").tail(n_bars).with_columns(pl.lit(product.split("-")[0]).alias("symbol"))


def fetch_public_dataset(products: list[str], granularity: int = 3600, n_bars: int = 1500) -> Dataset:
    df = pl.concat([fetch_coinbase_candles(p, granularity, n_bars) for p in products])
    return frame_to_dataset(
        df, provenance=DataProvenance.REAL_PUBLIC_API,
        survivorship=SurvivorshipDeclaration(False, 0, "currently-listed majors only; delisted/rugged assets NOT included"),
        source=f"coinbase-exchange public candles {','.join(products)} granularity={granularity}s", bar_seconds=granularity)
