"""Network-dependent: fetches real public candles. Skipped (BLOCKED) if the endpoint is unreachable."""
import pytest

from researcher.data.public import PublicDataBlocked, fetch_public_dataset
from researcher.provenance import DataProvenance


@pytest.mark.network
def test_public_fetch_or_blocked():
    try:
        ds = fetch_public_dataset(["BTC-USD", "ETH-USD"], granularity=3600, n_bars=320)
    except PublicDataBlocked as e:
        pytest.skip(f"BLOCKED: {e}")
    assert ds.provenance is DataProvenance.REAL_PUBLIC_API and ds.panel.N == 2 and ds.panel.T >= 300
    assert ds.survivorship.includes_delisted is False and ds.label()["survivorship"]["bias_flag"] == "SURVIVORSHIP_BIAS_PRESENT"
