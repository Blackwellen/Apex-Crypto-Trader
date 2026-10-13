-- APEX 0241 (UI-trading range): strategy catalogue extensions, per-workspace deployment stage, per-bucket instances, approval kind.
-- Strategy definitions stay spot-only (CHECK from 0003). Evidence is NEVER written by the console: only validated research runs may set it.

alter table strategy_definitions
  add column workspace_id uuid references workspaces(id) on delete cascade,      -- null = platform catalogue; set = workspace-defined or cloned
  add column category text not null default 'custom',
  add column summary text not null default '',
  add column data_sources text[] not null default '{}',
  add column regimes text[] not null default '{}',
  add column param_bounds jsonb not null default '{}'::jsonb,
  add column risk_budget jsonb not null default '{}'::jsonb,
  add column validation_plan jsonb not null default '{}'::jsonb,                  -- PLAN only; not evidence
  add column cloned_from text,
  add column created_by uuid,
  add column created_at timestamptz not null default now();
drop policy strategy_definitions_sel on strategy_definitions;
create policy strategy_definitions_sel on strategy_definitions for select to authenticated using (workspace_id is null or is_member(workspace_id));

-- effective deployment stage per workspace (absence of a row == research). 'live' is intentionally not representable here:
-- live is governed by live_allowed() gates, never by a stage flag.
create table strategy_deployments (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  strategy_key text not null,
  strategy_version int not null,
  stage text not null default 'research' check (stage in ('research','paper','live_candidate')),
  approval_id uuid references approval_requests(id),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, strategy_key, strategy_version),
  foreign key (strategy_key, strategy_version) references strategy_definitions(key, version)
);
create table strategy_instances (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  bucket_id uuid not null references buckets(id) on delete cascade,
  environment environment not null,
  strategy_key text not null,
  strategy_version int not null,
  enabled boolean not null default false,
  params jsonb not null default '{}'::jsonb,
  version int not null default 1,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bucket_id, strategy_key),
  foreign key (strategy_key, strategy_version) references strategy_definitions(key, version)
);
create index on strategy_instances (workspace_id, strategy_key);
do $$ declare t text; begin
  foreach t in array array['strategy_deployments','strategy_instances'] loop
    execute format('alter table %I enable row level security', t); execute format('alter table %I force row level security', t);
    execute format('create policy %I on %I for select to authenticated using (is_member(workspace_id))', t || '_sel', t);
    execute format('grant select on %I to authenticated', t); execute format('grant all on %I to service_role', t);
  end loop;
end $$;

alter table approval_requests drop constraint approval_requests_kind_check;
alter table approval_requests add constraint approval_requests_kind_check check (kind in ('vault_release','permission_increase','deployment_gate','capital_transfer','strategy_stage'));
