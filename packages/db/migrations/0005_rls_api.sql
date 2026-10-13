-- APEX 0005: Row-level security and the audited, role-checked mutation surface.
-- Model: `authenticated` (end users, and the API connecting as apex_app) get SELECT through RLS ONLY.
-- All writes go through SECURITY DEFINER api_* functions that verify membership/role and paper-vs-live scope.
-- Low-level ledger functions are not executable by clients.

-- 1) RLS on every workspace-scoped table
do $$
declare t text;
begin
  for t in select unnest(array['portfolios','buckets','baskets','wallets','strategy_capital_budgets','capital_reservations','ledger_accounts',
      'ledger_entries','internal_transfers','approval_requests','trade_intents','order_events','risk_decisions','fills','emergency_actions',
      'compounding_policies','target_plans','waterfall_executions','profit_eligibility_events','jobs','alerts','simulation_runs','audit_events',
      'deployment_gates','workspace_settings']) loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy %I on %I for select to authenticated using (is_member(workspace_id))', t || '_sel', t);
  end loop;
end $$;
alter table workspaces enable row level security; alter table workspaces force row level security;
create policy workspaces_sel on workspaces for select to authenticated using (is_member(id));
alter table memberships enable row level security; alter table memberships force row level security;
create policy memberships_sel on memberships for select to authenticated using (is_member(workspace_id));

-- tables scoped through a parent
do $$
declare r record;
begin
  for r in select * from (values
     ('bucket_policy_versions','bucket_id','buckets'),('basket_members','basket_id','baskets'),('wallet_chain_accounts','wallet_id','wallets'),
     ('wallet_bucket_allocations','wallet_id','wallets'),('high_water_marks','bucket_id','buckets'),('bucket_deficits','bucket_id','buckets')) v(t,fk,parent) loop
    execute format('alter table %I enable row level security', r.t);
    execute format('alter table %I force row level security', r.t);
    execute format('create policy %I on %I for select to authenticated using (exists (select 1 from %I p where p.id = %I.%I and is_member(p.workspace_id)))',
                   r.t || '_sel', r.t, r.parent, r.t, r.fk);
  end loop;
end $$;
alter table ledger_postings enable row level security; alter table ledger_postings force row level security;
create policy ledger_postings_sel on ledger_postings for select to authenticated
  using (exists (select 1 from ledger_entries e where e.id = entry_id and is_member(e.workspace_id)));
-- global reference data: readable by any authenticated user, writable by nobody via clients
alter table chain_registry enable row level security; alter table chain_registry force row level security;
create policy chain_registry_sel on chain_registry for select to authenticated using (true);
alter table chain_capabilities enable row level security; alter table chain_capabilities force row level security;
create policy chain_capabilities_sel on chain_capabilities for select to authenticated using (true);
alter table venue_registry enable row level security; alter table venue_registry force row level security;
create policy venue_registry_sel on venue_registry for select to authenticated using (true);
alter table assets enable row level security; alter table assets force row level security;
create policy assets_sel on assets for select to authenticated using (true);
alter table strategy_definitions enable row level security; alter table strategy_definitions force row level security;
create policy strategy_definitions_sel on strategy_definitions for select to authenticated using (true);
alter table required_gates enable row level security; alter table required_gates force row level security;
create policy required_gates_sel on required_gates for select to authenticated using (true);
alter table allowed_transitions enable row level security; alter table allowed_transitions force row level security;
create policy allowed_transitions_sel on allowed_transitions for select to authenticated using (true);

-- 2) lock down: clients cannot write tables or call low-level functions
revoke all on all tables in schema public from public, authenticated;
revoke execute on all functions in schema public from public;
grant usage on schema public to authenticated, service_role;
grant select on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant execute on function is_member(uuid), has_role(uuid, app_role[]), live_allowed(uuid) to authenticated, service_role;
revoke select on schema_migrations from authenticated;

-- 3) helpers
create or replace function assert_role(ws uuid, roles app_role[]) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not exists (select 1 from memberships where workspace_id = ws and user_id = auth.uid() and role = any(roles)) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
end $$;
-- live-environment ledger mutations (deposits/balances) are reconciler-only (service role), never a browser user
create or replace function assert_env_writable(env environment) returns void language plpgsql as $$
begin
  if env = 'live' and session_user not in ('service_role','postgres') and current_setting('apex.service', true) is distinct from 'on' then
    raise exception 'live ledger mutations are restricted to the reconciliation service' using errcode = '42501';
  end if;
end $$;

-- 4) api_* surface
create or replace function api_create_workspace(p_name text) returns uuid language plpgsql security definer set search_path = public as $$
declare ws uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='42501'; end if;
  insert into workspaces(name, created_by) values (p_name, auth.uid()) returning id into ws;
  insert into memberships values (ws, auth.uid(), 'owner');
  insert into workspace_settings(workspace_id) values (ws);
  insert into deployment_gates(workspace_id, gate_key) select ws, gate_key from required_gates;
  perform audit(ws, 'workspace.create', 'workspaces', ws::text, null, '{}');
  return ws;
end $$;

create or replace function api_create_portfolio(ws uuid, p_name text, env environment default 'paper') returns uuid language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  perform assert_role(ws, array['owner','admin']::app_role[]);
  if env = 'live' and not live_allowed(ws) then raise exception 'live portfolios require all deployment gates PASS and explicit opt-in' using errcode='P0001'; end if;
  insert into portfolios(workspace_id, name, environment) values (ws, p_name, env) returning id into pid;
  perform audit(ws, 'portfolio.create', 'portfolios', pid::text, env, jsonb_build_object('name', p_name));
  return pid;
end $$;

create or replace function api_create_bucket(p_portfolio uuid, p_name text, p_kind text default 'trading', p_seg segregation_mode default 'physical', p_policy jsonb default '{}') returns uuid
language plpgsql security definer set search_path = public as $$
declare pf portfolios%rowtype; bid uuid;
begin
  select * into pf from portfolios where id = p_portfolio;
  if not found then raise exception 'portfolio not found' using errcode='P0001'; end if;
  perform assert_role(pf.workspace_id, array['owner','admin']::app_role[]);
  insert into buckets(workspace_id, portfolio_id, environment, name, kind, segregation, policy)
    values (pf.workspace_id, pf.id, pf.environment, p_name, p_kind,
            case when p_kind = 'protected_vault' then 'protected' else p_seg end, p_policy) returning id into bid;
  insert into bucket_policy_versions(bucket_id, version, policy, changed_by) values (bid, 1, p_policy, auth.uid());
  perform audit(pf.workspace_id, 'bucket.create', 'buckets', bid::text, pf.environment, jsonb_build_object('name', p_name, 'segregation', p_seg));
  return bid;
end $$;

-- optimistic concurrency: caller must pass the version it read; child policy may not weaken global hard limits
create or replace function api_update_bucket_policy(p_bucket uuid, p_expected_version int, p_policy jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare b buckets%rowtype; gl jsonb; nv int;
begin
  select * into b from buckets where id = p_bucket for update;
  if not found then raise exception 'bucket not found' using errcode='P0001'; end if;
  perform assert_role(b.workspace_id, array['owner','admin']::app_role[]);
  if b.policy_version <> p_expected_version then raise exception 'stale policy version (have %, got %)', b.policy_version, p_expected_version using errcode='40001'; end if;
  select global_limits into gl from workspace_settings where workspace_id = b.workspace_id;
  if (p_policy ? 'max_slippage_bps') and (p_policy->>'max_slippage_bps')::numeric > (gl->>'max_slippage_bps')::numeric then
    raise exception 'bucket max_slippage_bps cannot exceed the global hard limit' using errcode='P0001';
  end if;
  if (p_policy ? 'max_order_notional_bps_of_bucket') and (p_policy->>'max_order_notional_bps_of_bucket')::numeric > (gl->>'max_order_notional_bps_of_bucket')::numeric then
    raise exception 'bucket order-size limit cannot exceed the global hard limit' using errcode='P0001';
  end if;
  nv := b.policy_version + 1;
  update buckets set policy = p_policy, policy_version = nv where id = b.id;
  insert into bucket_policy_versions(bucket_id, version, policy, changed_by) values (b.id, nv, p_policy, auth.uid());
  perform audit(b.workspace_id, 'bucket.policy', 'buckets', b.id::text, b.environment, jsonb_build_object('version', nv));
  return nv;
end $$;

-- Wallet registration: PUBLIC address + capability only. There is deliberately no parameter that could carry a secret.
create or replace function api_connect_wallet(ws uuid, p_nick text, p_family chain_family, p_address text, p_capability wallet_capability default 'watch_only', p_chains text[] default '{}')
returns uuid language plpgsql security definer set search_path = public as $$
declare wid uuid; c text;
begin
  perform assert_role(ws, array['owner','admin']::app_role[]);
  if p_capability = 'managed_signer' then raise exception 'managed signers are registered by the signer service with a KMS reference' using errcode='42501'; end if;
  if p_address ~* '(seed|mnemonic|private|secret)' or (p_family = 'evm' and p_address !~ '^0x[0-9a-fA-F]{40}$') or length(p_address) < 20 or length(p_address) > 120 then
    raise exception 'invalid public address' using errcode='P0001';
  end if;
  insert into wallets(workspace_id, nickname, family, address, capability) values (ws, p_nick, p_family, p_address, p_capability) returning id into wid;
  foreach c in array p_chains loop
    insert into wallet_chain_accounts(wallet_id, chain_id) select wid, id from chain_registry where id = c and family = p_family;
    if not found then raise exception 'chain % not in registry for family %', c, p_family using errcode='P0001'; end if;
  end loop;
  perform audit(ws, 'wallet.connect', 'wallets', wid::text, null, jsonb_build_object('family', p_family, 'capability', p_capability));
  return wid;
end $$;

create or replace function api_assign_wallet(p_wallet uuid, p_bucket uuid, p_exclusive boolean default true, p_bps int default 10000, p_ack boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare w wallets%rowtype; b buckets%rowtype;
begin
  select * into w from wallets where id = p_wallet; select * into b from buckets where id = p_bucket;
  if w.id is null or b.id is null or w.workspace_id <> b.workspace_id then raise exception 'wallet/bucket mismatch' using errcode='P0001'; end if;
  perform assert_role(w.workspace_id, array['owner','admin']::app_role[]);
  insert into wallet_bucket_allocations(wallet_id, bucket_id, exclusive, max_allocation_bps, logical_ack) values (p_wallet, p_bucket, p_exclusive, p_bps, p_ack);
  perform audit(w.workspace_id, 'wallet.assign', 'wallets', p_wallet::text, b.environment, jsonb_build_object('bucket', p_bucket, 'exclusive', p_exclusive));
end $$;

create or replace function api_paper_deposit(ws uuid, p_wca uuid, p_asset uuid, p_amount numeric, p_key text) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  perform assert_role(ws, array['owner','admin']::app_role[]);
  -- users can only fund the PAPER environment; live balances come from the reconciler only
  return ledger_deposit(ws, 'paper', p_wca, p_asset, p_amount, 'api:' || p_key);
end $$;

create or replace function api_allocate(ws uuid, p_bucket uuid, p_wca uuid, p_asset uuid, p_amount numeric, p_key text) returns uuid
language plpgsql security definer set search_path = public as $$
declare env environment;
begin
  perform assert_role(ws, array['owner','admin']::app_role[]);
  select environment into env from buckets where id = p_bucket and workspace_id = ws;
  perform assert_env_writable(env);
  return ledger_allocate(ws, env, p_bucket, p_wca, p_asset, p_amount, 'api:' || p_key);
end $$;

create or replace function api_reserve_capital(ws uuid, p_bucket uuid, p_wca uuid, p_asset uuid, p_amount numeric, p_intent text, p_budget uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare env environment;
begin
  perform assert_role(ws, array['owner','admin','trader']::app_role[]);
  select environment into env from buckets where id = p_bucket and workspace_id = ws;
  perform assert_env_writable(env);
  if env = 'live' and not live_allowed(ws) then raise exception 'live disabled' using errcode='P0001'; end if;
  return reserve_capital(ws, env, p_bucket, p_wca, p_asset, p_amount, p_intent, p_budget);
end $$;

create or replace function api_request_transfer(ws uuid, sb uuid, sw uuid, db uuid, dw uuid, ast uuid, amt numeric, p_key text) returns uuid
language plpgsql security definer set search_path = public as $$
declare env environment;
begin
  perform assert_role(ws, array['owner','admin']::app_role[]);
  select environment into env from buckets where id = sb and workspace_id = ws;
  perform assert_env_writable(env);
  return request_transfer(ws, env, sb, sw, db, dw, ast, amt, 'api:' || p_key);
end $$;

create or replace function api_set_global_state(ws uuid, st text, why text) returns void language plpgsql security definer set search_path = public as $$
begin
  -- halting is allowed for traders too (fail safe); resuming requires owner/admin
  if st = 'active' then perform assert_role(ws, array['owner','admin']::app_role[]);
  else perform assert_role(ws, array['owner','admin','trader']::app_role[]); end if;
  perform set_global_state(ws, st, why);
end $$;

create or replace function api_request_vault_release(ws uuid, p_vault_bucket uuid, p_wca uuid, p_asset uuid, p_amount numeric) returns uuid
language plpgsql security definer set search_path = public as $$
declare aid uuid; env environment;
begin
  perform assert_role(ws, array['owner']::app_role[]);
  select environment into env from buckets where id = p_vault_bucket and workspace_id = ws and kind = 'protected_vault';
  if env is null then raise exception 'not a vault bucket' using errcode='P0001'; end if;
  insert into approval_requests(workspace_id, kind, subject, requested_by) values (ws, 'vault_release',
    jsonb_build_object('environment', env, 'vault_bucket', p_vault_bucket, 'wca', p_wca, 'asset', p_asset, 'amount', p_amount::text), auth.uid()) returning id into aid;
  perform audit(ws, 'vault.release.requested', 'approval_requests', aid::text, env, '{}');
  return aid;
end $$;

create or replace function api_decide_approval(p_approval uuid, p_approve boolean) returns void language plpgsql security definer set search_path = public as $$
declare a approval_requests%rowtype;
begin
  select * into a from approval_requests where id = p_approval for update;
  perform assert_role(a.workspace_id, array['owner']::app_role[]);
  if a.requested_by = auth.uid() then raise exception 'requester cannot approve their own request' using errcode='42501'; end if;
  update approval_requests set status = case when p_approve then 'approved' else 'rejected' end, approved_by = auth.uid(), decided_at = now() where id = p_approval and status = 'pending';
  perform audit(a.workspace_id, 'approval.decided', 'approval_requests', p_approval::text, null, jsonb_build_object('approve', p_approve));
end $$;

create or replace function api_release_vault(p_approval uuid, p_key text) returns uuid language plpgsql security definer set search_path = public as $$
begin return release_vault(p_approval, 'api:' || p_key); end $$;

create or replace function api_set_gate(ws uuid, p_gate text, p_status text, p_evidence text, p_sha text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform assert_role(ws, array['owner']::app_role[]);
  update deployment_gates set status = p_status, evidence_ref = p_evidence, commit_sha = p_sha, updated_by = auth.uid(), updated_at = now() where workspace_id = ws and gate_key = p_gate;
  perform audit(ws, 'gate.set', 'deployment_gates', p_gate, null, jsonb_build_object('status', p_status, 'evidence', p_evidence));
end $$;

create or replace function api_set_live_opt_in(ws uuid, p_on boolean) returns void language plpgsql security definer set search_path = public as $$
begin
  perform assert_role(ws, array['owner']::app_role[]);
  update workspace_settings set live_opt_in = p_on, updated_at = now() where workspace_id = ws;
  perform audit(ws, 'live.opt_in', 'workspace_settings', ws::text, null, jsonb_build_object('on', p_on));
end $$;

grant execute on function api_create_workspace(text), api_create_portfolio(uuid,text,environment), api_create_bucket(uuid,text,text,segregation_mode,jsonb),
  api_update_bucket_policy(uuid,int,jsonb), api_connect_wallet(uuid,text,chain_family,text,wallet_capability,text[]), api_assign_wallet(uuid,uuid,boolean,int,boolean),
  api_paper_deposit(uuid,uuid,uuid,numeric,text), api_allocate(uuid,uuid,uuid,uuid,numeric,text), api_reserve_capital(uuid,uuid,uuid,uuid,numeric,text,uuid),
  api_request_transfer(uuid,uuid,uuid,uuid,uuid,uuid,numeric,text), api_set_global_state(uuid,text,text), api_request_vault_release(uuid,uuid,uuid,uuid,numeric),
  api_decide_approval(uuid,boolean), api_release_vault(uuid,text), api_set_gate(uuid,text,text,text,text), api_set_live_opt_in(uuid,boolean)
  to authenticated, service_role;
-- internal engine functions: service role only (execution/risk/settlement services), never browser users
grant execute on all functions in schema public to service_role;
