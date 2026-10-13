"""Postgres test harness: builds a FRESH database per run (auth shim + all migrations) and seeds a paper world.

Mirrors packages/db/tests/helpers.mjs (freshDb / seedWorld). Requires a Postgres at ADMIN_DATABASE_URL
(default postgres://postgres@localhost:54329/postgres, trust auth) and `psql` on PATH.
"""
from __future__ import annotations

import os
import secrets
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path

import psycopg

REPO = Path(__file__).resolve().parents[3]
ADMIN_URL = os.environ.get("ADMIN_DATABASE_URL", "postgres://postgres@localhost:54329/postgres")
EXTRA_MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "sql"


def pg_available() -> bool:
    try:
        with psycopg.connect(ADMIN_URL, connect_timeout=3) as c:
            c.execute("select 1")
        subprocess.run(["psql", "--version"], check=True, capture_output=True)
        return True
    except Exception:
        return False


@dataclass
class World:
    url: str
    name: str
    owner: str
    ws: str
    bucket: str
    vault: str
    wca: str
    wca2: str
    usdc: str
    eth: str


def fresh_db(apply_extra: list[Path] | None = None) -> tuple[str, str]:
    name = "apex_py_" + secrets.token_hex(3)
    with psycopg.connect(ADMIN_URL, autocommit=True) as a:
        a.execute(f"drop database if exists {name}")
        a.execute(f"create database {name}")
    url = ADMIN_URL.rsplit("/", 1)[0] + "/" + name
    subprocess.run(["psql", url, "-q", "-v", "ON_ERROR_STOP=1", "-f", str(REPO / "infra/local/auth_shim.sql")],
                   check=True, capture_output=True)
    last = None
    for attempt in range(3):                      # other workers may be editing migrations/*.sql concurrently; retry on a clean DB
        try:
            subprocess.run([str(REPO / "packages/db/migrate.sh")], check=True, capture_output=True, text=True, env={**os.environ, "DATABASE_URL": url})
            last = None
            break
        except subprocess.CalledProcessError as e:
            last = e
            with psycopg.connect(ADMIN_URL, autocommit=True) as a:
                a.execute(f"drop database {name} with (force)")
                a.execute(f"create database {name}")
            subprocess.run(["psql", url, "-q", "-v", "ON_ERROR_STOP=1", "-f", str(REPO / "infra/local/auth_shim.sql")], check=True, capture_output=True)
            import time; time.sleep(3)
    if last is not None:
        raise RuntimeError(f"migrate.sh failed 3x: {last.stderr[-600:]}")
    for extra in apply_extra or []:
        subprocess.run(["psql", url, "-q", "-v", "ON_ERROR_STOP=1", "-f", str(extra)], check=True, capture_output=True)
    return url, name


def drop_db(name: str) -> None:
    with psycopg.connect(ADMIN_URL, autocommit=True) as a:
        a.execute(f"drop database if exists {name} with (force)")


def seed_world(url: str, name: str, funds: int = 10**30) -> World:
    owner = str(uuid.uuid4())
    with psycopg.connect(url) as c:  # superuser "service" context
        c.execute("select set_config('apex.service','on',true)")
        c.execute("insert into auth.users(id,email) values (%s,%s)", (owner, owner + "@t.test"))
        c.execute("""insert into chain_registry(id,namespace,chain_ref,family,name,native_symbol,native_decimals,finality_model,address_format)
                     values ('eip155:1','eip155','1','evm','Ethereum','ETH',18,'probabilistic','0x-hex20') on conflict do nothing""")
        c.execute("""insert into assets(chain_id,contract,symbol,decimals) values ('eip155:1','native','ETH',18),('eip155:1','0xusdc','USDC',6)
                     on conflict do nothing""")
        rows = {sym: i for i, sym in c.execute("select id::text, symbol from assets where chain_id='eip155:1'").fetchall()}
        c.commit()
    usdc, eth = rows["USDC"], rows["ETH"]
    with psycopg.connect(url) as c:
        c.execute("set local role authenticated")
        c.execute("select set_config('request.jwt.claim.sub', %s, true)", (owner,))
        one = lambda q, *a: c.execute(q, a).fetchone()[0]  # noqa: E731
        ws = str(one("select api_create_workspace('PY WS')"))
        pf = str(one("select api_create_portfolio(%s,'Core','paper')", ws))
        bucket = str(one("select api_create_bucket(%s,'Trading','trading','physical','{}')", pf))
        vault = str(one("select api_create_bucket(%s,'Vault','protected_vault','protected','{}')", pf))
        w1 = str(one("select api_connect_wallet(%s,'W1','evm','0x9a4Fc2bC7897dd21305B92C0e5cb86DFFc984362','watch_only',array['eip155:1'])", ws))
        w2 = str(one("select api_connect_wallet(%s,'W2','evm','0x44f9830d8f779C62ba1C3B98ecbB17C260A69aC4','watch_only',array['eip155:1'])", ws))
        c.execute("select api_assign_wallet(%s,%s,true,10000,false)", (w1, bucket))
        c.execute("select api_assign_wallet(%s,%s,true,10000,false)", (w2, vault))
        wca = str(one("select id from wallet_chain_accounts where wallet_id=%s", w1))
        wca2 = str(one("select id from wallet_chain_accounts where wallet_id=%s", w2))
        c.execute("select api_paper_deposit(%s,%s,%s,%s,'dep1')", (ws, wca, usdc, str(funds)))
        c.execute("select api_allocate(%s,%s,%s,%s,%s,'alloc1')", (ws, bucket, wca, usdc, str(funds)))
        c.commit()
    return World(url, name, owner, ws, bucket, vault, wca, wca2, usdc, eth)
