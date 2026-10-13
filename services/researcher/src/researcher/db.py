"""Recording into the `simulation_runs` table (migration 0004). Opt-in: needs DATABASE_URL + a workspace id.

Connects as the DATABASE_URL role; in production that must be the privileged service role (RLS on simulation_runs
applies to end-user roles). The researcher never receives a user's JWT.
"""
from __future__ import annotations

import json
import os
import uuid

import psycopg

from .jsonutil import json_safe


class WorkspaceNotFound(Exception):
    pass


def database_url() -> str | None:
    return os.environ.get("DATABASE_URL") or None


def record_simulation_run(url: str, workspace_id: str, kind: str, params: dict, data_provenance: str, metrics: dict, status: str = "done") -> str:
    uuid.UUID(workspace_id)                       # validates shape; raises ValueError
    with psycopg.connect(url, connect_timeout=5) as c:
        c.execute("select set_config('apex.service','on',true)")
        if c.execute("select 1 from workspaces where id = %s", (workspace_id,)).fetchone() is None:
            raise WorkspaceNotFound(workspace_id)
        rid = c.execute(
            "insert into simulation_runs(workspace_id, kind, params, data_provenance, metrics, status) values (%s,%s,%s::jsonb,%s,%s::jsonb,%s) returning id::text",
            (workspace_id, kind, json.dumps(json_safe(params), default=str), data_provenance, json.dumps(json_safe(metrics), default=str), status)).fetchone()[0]
        c.commit()
    return rid
