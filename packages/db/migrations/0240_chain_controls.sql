-- APEX 0240 (UI-trading range): per-workspace chain policy (enable/disable, audited) and read-only RPC health samples.
-- Enabling a chain grants MONITORING ONLY. Trading additionally requires CERTIFIED capabilities in chain_capabilities;
-- nothing here can mark a capability certified.

create table workspace_chain_policy (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  chain_id text not null references chain_registry(id),
  enabled boolean not null default false,
  reason text,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, chain_id)
);
alter table workspace_chain_policy enable row level security; alter table workspace_chain_policy force row level security;
create policy workspace_chain_policy_sel on workspace_chain_policy for select to authenticated using (is_member(workspace_id));
grant select on workspace_chain_policy to authenticated;
grant all on workspace_chain_policy to service_role;

create or replace function api_set_chain_enabled(p_ws uuid, p_chain text, p_enabled boolean, p_reason text default null) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform assert_role(p_ws, array['owner','admin']::app_role[]);
  if not exists (select 1 from chain_registry where id = p_chain) then raise exception 'unknown chain %', p_chain using errcode='P0001'; end if;
  if not p_enabled and (p_reason is null or length(trim(p_reason)) < 3) then raise exception 'a reason is required to disable a chain' using errcode='P0001'; end if;
  insert into workspace_chain_policy(workspace_id, chain_id, enabled, reason, updated_by, updated_at)
    values (p_ws, p_chain, p_enabled, p_reason, auth.uid(), now())
    on conflict (workspace_id, chain_id) do update set enabled = excluded.enabled, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = now();
  if not p_enabled then
    insert into emergency_actions(workspace_id, scope, scope_id, action, actor, reason) values (p_ws, 'CHAIN', p_chain, 'DISABLE_CHAIN', auth.uid(), p_reason);
  end if;
  perform audit(p_ws, case when p_enabled then 'chain.enable' else 'chain.disable' end, 'workspace_chain_policy', p_chain, null,
    jsonb_build_object('reason', p_reason, 'note', case when p_enabled then 'monitoring only; trading requires CERTIFIED capabilities' else 'new entries on this chain must be refused' end));
  return p_enabled;
end $$;

-- Read-only RPC probe results. Written ONLY by the optional prober (services/api/src/probes, APEX_PROBES=1) via the service role.
create table rpc_health_samples (
  id bigint generated always as identity primary key,
  chain_id text not null references chain_registry(id) on delete cascade,
  endpoint text not null check (endpoint ~ '^https?://[^/?#@]+$'),   -- sanitized origin only: public RPC URLs can embed API keys
  observed_at timestamptz not null default now(),
  ok boolean not null,
  latency_ms int check (latency_ms is null or latency_ms >= 0),
  reported_chain_id text,
  chain_id_match boolean,                                              -- null = identity could not be verified
  block_height numeric(40,0),
  block_time timestamptz,
  error text check (error is null or length(error) <= 300),
  constraint failed_has_error check (ok or error is not null)
);
create index on rpc_health_samples (chain_id, observed_at desc);
create index on rpc_health_samples (chain_id, endpoint, observed_at desc);
alter table rpc_health_samples enable row level security; alter table rpc_health_samples force row level security;
create policy rpc_health_samples_sel on rpc_health_samples for select to authenticated using (true);   -- global reference telemetry
grant select on rpc_health_samples to authenticated;
grant all on rpc_health_samples to service_role;

create or replace function record_rpc_health_sample(p_chain text, p_endpoint text, p_ok boolean, p_latency_ms int, p_reported_chain_id text,
  p_chain_id_match boolean, p_block_height numeric, p_block_time timestamptz, p_error text) returns bigint
language plpgsql as $$
declare sid bigint;
begin
  insert into rpc_health_samples(chain_id, endpoint, ok, latency_ms, reported_chain_id, chain_id_match, block_height, block_time, error)
    values (p_chain, p_endpoint, p_ok, p_latency_ms, left(p_reported_chain_id, 80), p_chain_id_match, p_block_height, p_block_time, left(p_error, 300)) returning id into sid;
  return sid;
end $$;
create or replace function prune_rpc_health_samples(p_keep interval default interval '14 days') returns int language plpgsql as $$
declare n int;
begin delete from rpc_health_samples where observed_at < now() - p_keep; get diagnostics n = row_count; return n; end $$;

revoke execute on function api_set_chain_enabled(uuid,text,boolean,text), record_rpc_health_sample(text,text,boolean,int,text,boolean,numeric,timestamptz,text), prune_rpc_health_samples(interval) from public;
grant execute on function api_set_chain_enabled(uuid,text,boolean,text) to authenticated, service_role;
grant execute on function record_rpc_health_sample(text,text,boolean,int,text,boolean,numeric,timestamptz,text), prune_rpc_health_samples(interval) to service_role;
