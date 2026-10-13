"""Records exactly which public OHLCV endpoints are reachable from this environment (no API keys)."""
import json
import sys
import time

import httpx

TARGETS = {
    "coinbase-exchange candles": "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600",
    "kraken OHLC": "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=60",
    "binance.com klines": "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=3",
    "binance data-api.binance.vision klines": "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=3",
    "coingecko ping": "https://api.coingecko.com/api/v3/ping",
}
rows = []
for name, url in TARGETS.items():
    t = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    try:
        r = httpx.get(url, timeout=15, headers={"User-Agent": "apex-researcher/0.1"})
        rows.append({"endpoint": name, "utc": t, "status": f"HTTP {r.status_code}", "bytes": len(r.content), "result": "WORKED" if r.status_code == 200 else "BLOCKED/REFUSED"})
    except Exception as e:
        rows.append({"endpoint": name, "utc": t, "status": f"{type(e).__name__}: {e}"[:120], "result": "BLOCKED"})
json.dump(rows, sys.stdout, indent=1)
