-- APEX 0006: further audited API functions (compounding policy versions, targets, budgets, baskets, paper engine flag).
alter table workspace_settings add column paper_running boolean not null default false;

create or replace function api_create_compounding_policy(p_bucket uuid, p_mode text, p_reinvest int, p_vault int, p_cross int, p_reserve int, p_tax int,
  p_vault_bucket uuid default null, p_vault_wca uuid default null, p_cross_bucket uuid default null, p_cross_wca uuid default null,
  p_min_ticket numeric default 0, p_drawdown_bps int default 1000) returns uuid language plpgsql security definer set search_path = public as $$
declare b buckets%rowtype; v int; pid uuid;
begin
  select * into b from buckets where id = p_bucket; if not found then raise exception 'bucket not found' using errcode='P0001'; end if;
  perform assert_role(b.workspace_id, array['owner','admin']::app_role[]);
  if b.kind in ('protected_vault','gas_reserve') then raise exception 'compounding policies do not apply to % buckets', b.kind using errcode='P0001'; end if;
  if p_vault_bucket is not null and not exists (select 1 from buckets where id = p_vault_bucket and workspace_id = b.workspace_id and kind = 'protected_vault' and environment = b.environment) then
    raise exception 'vault destination must be a protected_vault bucket in the same environment' using errcode='P0001'; end if;
  select coalesce(max(version),0)+1 into v from compounding_policies where bucket_id = p_bucket;
  insert into compounding_policies(workspace_id,bucket_id,version,mode,reinvest_bps,vault_bps,cross_bucket_bps,reserve_bps,tax_provision_bps,vault_bucket_id,vault_wca,cross_bucket_id,cross_wca,min_ticket,drawdown_limit_bps,created_by)
    values (b.workspace_id,p_bucket,v,p_mode,p_reinvest,p_vault,p_cross,p_reserve,p_tax,p_vault_bucket,p_vault_wca,p_cross_bucket,p_cross_wca,p_min_ticket,p_drawdown_bps,auth.uid()) returning id into pid;
  perform audit(b.workspace_id, 'compounding.policy', 'compounding_policies', pid::text, b.environment, jsonb_build_object('version', v, 'reinvest', p_reinvest, 'vault', p_vault, 'cross', p_cross, 'reserve', p_reserve));
  return pid;
end $$;

create or replace function api_create_target_plan(ws uuid, p_bucket uuid, p_period text, p_amount numeric, p_pct_bps int, p_start_equity numeric) returns uuid
language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  perform assert_role(ws, array['owner','admin']::app_role[]);
  insert into target_plans(workspace_id,bucket_id,period,target_amount,target_pct_bps,start_equity) values (ws,p_bucket,p_period,p_amount,p_pct_bps,coalesce(p_start_equity,0)) returning id into tid;
  perform audit(ws, 'target.create', 'target_plans', tid::text, null, jsonb_build_object('period', p_period));
  return tid;
end $$;

create or replace function api_set_strategy_budget(p_bucket uuid, p_strategy text, p_asset uuid, p_limit numeric) returns uuid language plpgsql security definer set search_path = public as $$
declare b buckets%rowtype; bid uuid;
begin
  select * into b from buckets where id = p_bucket; if not found then raise exception 'bucket not found' using errcode='P0001'; end if;
  perform assert_role(b.workspace_id, array['owner','admin']::app_role[]);
  insert into strategy_capital_budgets(workspace_id,bucket_id,strategy_key,asset_id,limit_amount) values (b.workspace_id,p_bucket,p_strategy,p_asset,p_limit)
    on conflict (bucket_id,strategy_key,asset_id) do update set limit_amount = excluded.limit_amount, version = strategy_capital_budgets.version + 1 returning id into bid;
  perform audit(b.workspace_id, 'budget.set', 'strategy_capital_budgets', bid::text, b.environment, jsonb_build_object('strategy', p_strategy, 'limit', p_limit::text));
  return bid;
end $$;

create or replace function api_create_basket(p_bucket uuid, p_name text, p_members jsonb) returns uuid language plpgsql security definer set search_path = public as $$
declare b buckets%rowtype; bid uuid; m jsonb; tot int := 0;
begin
  select * into b from buckets where id = p_bucket; if not found then raise exception 'bucket not found' using errcode='P0001'; end if;
  perform assert_role(b.workspace_id, array['owner','admin']::app_role[]);
  for m in select * from jsonb_array_elements(p_members) loop tot := tot + (m->>'weight_bps')::int; end loop;
  if tot <> 10000 then raise exception 'basket weights must total exactly 10000 bps (got %)', tot using errcode='P0001'; end if;
  insert into baskets(workspace_id,bucket_id,name) values (b.workspace_id,p_bucket,p_name) returning id into bid;
  insert into basket_members(basket_id,asset_id,target_weight_bps) select bid,(x->>'asset')::uuid,(x->>'weight_bps')::int from jsonb_array_elements(p_members) x;
  perform audit(b.workspace_id, 'basket.create', 'baskets', bid::text, b.environment, jsonb_build_object('name', p_name));
  return bid;
end $$;

-- paper engine flag: persisted desire to run; the execution service reads it. Refuses while halted.
create or replace function api_set_paper_running(ws uuid, p_on boolean) returns void language plpgsql security definer set search_path = public as $$
declare st text;
begin
  perform assert_role(ws, array['owner','admin','trader']::app_role[]);
  select global_state into st from workspace_settings where workspace_id = ws;
  if p_on and st <> 'active' then raise exception 'cannot start paper engine while global state is %', st using errcode='P0001'; end if;
  update workspace_settings set paper_running = p_on, updated_at = now() where workspace_id = ws;
  perform audit(ws, case when p_on then 'paper.start' else 'paper.stop' end, 'workspace_settings', ws::text, 'paper', '{}');
end $$;

-- emergency stop also stops the paper engine flag
create or replace function set_global_state(ws uuid, st text, why text) returns void language plpgsql as $$
begin
  if st not in ('active','halt_new_entries','exit_only','emergency_stopped') then raise exception 'bad state' using errcode = 'P0001'; end if;
  update workspace_settings set global_state = st, paper_running = case when st = 'active' then paper_running else false end, updated_at = now() where workspace_id = ws;
  insert into emergency_actions(workspace_id, scope, action, actor, reason)
    values (ws, 'GLOBAL', case st when 'halt_new_entries' then 'HALT_NEW_ENTRIES' when 'exit_only' then 'EXIT_ONLY' when 'emergency_stopped' then 'EMERGENCY_STOP' else 'MANUAL_ESCALATION' end, auth.uid(), why);
  perform audit(ws, 'global_state.' || st, 'workspace_settings', ws::text, null, jsonb_build_object('reason', why));
end $$;

revoke execute on function api_create_compounding_policy(uuid,text,int,int,int,int,int,uuid,uuid,uuid,uuid,numeric,int), api_create_target_plan(uuid,uuid,text,numeric,int,numeric),
  api_set_strategy_budget(uuid,text,uuid,numeric), api_create_basket(uuid,text,jsonb), api_set_paper_running(uuid,boolean), set_global_state(uuid,text,text) from public;
grant execute on function api_create_compounding_policy(uuid,text,int,int,int,int,int,uuid,uuid,uuid,uuid,numeric,int), api_create_target_plan(uuid,uuid,text,numeric,int,numeric),
  api_set_strategy_budget(uuid,text,uuid,numeric), api_create_basket(uuid,text,jsonb), api_set_paper_running(uuid,boolean) to authenticated, service_role;
grant execute on function set_global_state(uuid,text,text) to service_role;
-- fresh read access for new tables is inherited via "grant select on all tables" at 0005 only for existing tables; re-grant
grant select on all tables in schema public to authenticated;
revoke select on schema_migrations from authenticated;
