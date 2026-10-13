-- APEX 0243 (UI-trading range): audited strategy commands. All SECURITY DEFINER, role-checked, spot-only, evidence never written.

create or replace function validate_param_bounds(p jsonb) returns void language plpgsql immutable as $$
declare k text; v jsonb;
begin
  if jsonb_typeof(p) <> 'object' then raise exception 'param_bounds must be an object' using errcode='P0001'; end if;
  if (select count(*) from jsonb_object_keys(p)) > 40 then raise exception 'too many parameters' using errcode='P0001'; end if;
  for k, v in select * from jsonb_each(p) loop
    if k !~ '^[a-z][a-z0-9_]{1,40}$' then raise exception 'bad parameter name %', k using errcode='P0001'; end if;
    if jsonb_typeof(v) <> 'object' or jsonb_typeof(v->'min') <> 'number' or jsonb_typeof(v->'max') <> 'number' or jsonb_typeof(v->'default') <> 'number' then
      raise exception 'parameter % needs numeric min, max and default', k using errcode='P0001'; end if;
    if not ((v->>'min')::numeric <= (v->>'default')::numeric and (v->>'default')::numeric <= (v->>'max')::numeric) then
      raise exception 'parameter %: require min <= default <= max', k using errcode='P0001'; end if;
  end loop;
end $$;

-- S-01..S-06 create / clone. The new definition is ALWAYS research-stage with empty evidence.
create or replace function api_create_strategy(p_ws uuid, p_slug text, p_name text, p_category text, p_summary text, p_families chain_family[],
  p_data_sources text[], p_regimes text[], p_param_bounds jsonb, p_risk_budget jsonb, p_validation_plan jsonb, p_cloned_from text default null) returns text
language plpgsql security definer set search_path = public as $$
declare k text; mx numeric;
begin
  perform assert_role(p_ws, array['owner','admin']::app_role[]);
  if p_slug !~ '^[a-z][a-z0-9_]{2,39}$' then raise exception 'slug must be 3-40 chars: lowercase letters, digits, underscore' using errcode='P0001'; end if;
  if length(trim(p_name)) < 3 then raise exception 'name too short' using errcode='P0001'; end if;
  if coalesce(array_length(p_families,1),0) = 0 then raise exception 'choose at least one chain family / venue kind' using errcode='P0001'; end if;
  perform validate_param_bounds(coalesce(p_param_bounds,'{}'));
  mx := coalesce((p_risk_budget->>'max_order_bps_of_budget')::numeric, 0);
  if mx < 0 or mx > 10000 then raise exception 'max_order_bps_of_budget must be within 0..10000' using errcode='P0001'; end if;
  if p_cloned_from is not null and not exists (select 1 from strategy_definitions where key = p_cloned_from and (workspace_id is null or workspace_id = p_ws)) then
    raise exception 'clone source not found' using errcode='P0001'; end if;
  k := 'ws.' || substr(replace(p_ws::text,'-',''),1,8) || '.' || p_slug;
  if exists (select 1 from strategy_definitions where key = k) then raise exception 'a strategy with this slug already exists' using errcode='P0001'; end if;
  insert into strategy_definitions(key, version, name, stage, allowed_families, evidence, workspace_id, category, summary, data_sources, regimes, param_bounds, risk_budget, validation_plan, cloned_from, created_by)
    values (k, 1, trim(p_name), 'research', p_families, '{}'::jsonb, p_ws, left(coalesce(p_category,'custom'),40), left(coalesce(p_summary,''),600), coalesce(p_data_sources,'{}'), coalesce(p_regimes,'{}'),
            coalesce(p_param_bounds,'{}'), coalesce(p_risk_budget,'{}'), coalesce(p_validation_plan,'{}'), p_cloned_from, auth.uid());
  perform audit(p_ws, 'strategy.create', 'strategy_definitions', k, null, jsonb_build_object('name', p_name, 'cloned_from', p_cloned_from, 'stage', 'research'));
  return k;
end $$;

create or replace function strategy_stage_of(p_ws uuid, p_key text, p_version int) returns text language sql stable security definer set search_path = public as $$
  select coalesce((select stage from strategy_deployments where workspace_id = p_ws and strategy_key = p_key and strategy_version = p_version), 'research')
$$;

-- deployment-stage change = a request that a DIFFERENT owner must approve (existing decideApproval), then an explicit apply.
create or replace function api_request_strategy_stage(p_ws uuid, p_key text, p_version int, p_to text) returns uuid
language plpgsql security definer set search_path = public as $$
declare d strategy_definitions%rowtype; cur text; aid uuid;
begin
  perform assert_role(p_ws, array['owner','admin']::app_role[]);
  select * into d from strategy_definitions where key = p_key and version = p_version and (workspace_id is null or workspace_id = p_ws);
  if not found then raise exception 'strategy not found' using errcode='P0001'; end if;
  if not d.spot_only then raise exception 'only spot strategies can be deployed' using errcode='P0001'; end if;
  cur := strategy_stage_of(p_ws, p_key, p_version);
  if not ((cur = 'research' and p_to = 'paper') or (cur = 'paper' and p_to = 'live_candidate')) then
    raise exception 'stage change % -> % is not allowed (stages advance one step at a time; demotion is done by disabling)', cur, p_to using errcode='P0001'; end if;
  if p_to = 'live_candidate' and (d.evidence is null or d.evidence = '{}'::jsonb) then
    raise exception 'live_candidate requires recorded validation evidence; none exists for this strategy' using errcode='P0001'; end if;
  if exists (select 1 from approval_requests where workspace_id = p_ws and kind = 'strategy_stage' and status in ('pending','approved')
              and subject->>'strategy' = p_key and (subject->>'version')::int = p_version) then
    raise exception 'a stage change for this strategy is already pending' using errcode='P0001'; end if;
  insert into approval_requests(workspace_id, kind, subject, requested_by, not_before)
    values (p_ws, 'strategy_stage', jsonb_build_object('strategy', p_key, 'version', p_version, 'from', cur, 'to', p_to), auth.uid(), now()) returning id into aid;
  perform audit(p_ws, 'strategy.stage_requested', 'approval_requests', aid::text, null, jsonb_build_object('strategy', p_key, 'from', cur, 'to', p_to));
  return aid;
end $$;

create or replace function api_apply_strategy_stage(p_approval uuid) returns text language plpgsql security definer set search_path = public as $$
declare a approval_requests%rowtype; d strategy_definitions%rowtype; k text; v int; cur text; tgt text;
begin
  select * into a from approval_requests where id = p_approval for update;
  if not found or a.kind <> 'strategy_stage' then raise exception 'approval not found' using errcode='P0001'; end if;
  perform assert_role(a.workspace_id, array['owner','admin']::app_role[]);
  if a.status <> 'approved' then raise exception 'approval is % (an owner other than the requester must approve first)', a.status using errcode='P0001'; end if;
  k := a.subject->>'strategy'; v := (a.subject->>'version')::int; tgt := a.subject->>'to';
  select * into d from strategy_definitions where key = k and version = v;
  cur := strategy_stage_of(a.workspace_id, k, v);
  if cur <> a.subject->>'from' then raise exception 'strategy stage changed since the request (now %); request again', cur using errcode='P0001'; end if;
  if tgt = 'live_candidate' and (d.evidence is null or d.evidence = '{}'::jsonb) then raise exception 'live_candidate requires recorded validation evidence' using errcode='P0001'; end if;
  insert into strategy_deployments(workspace_id, strategy_key, strategy_version, stage, approval_id, updated_by, updated_at)
    values (a.workspace_id, k, v, tgt, a.id, auth.uid(), now())
    on conflict (workspace_id, strategy_key, strategy_version) do update set stage = excluded.stage, approval_id = excluded.approval_id, updated_by = excluded.updated_by, updated_at = now();
  update approval_requests set status = 'executed' where id = a.id;
  perform audit(a.workspace_id, 'strategy.stage_applied', 'strategy_deployments', k, null, jsonb_build_object('strategy', k, 'from', cur, 'to', tgt, 'approval', a.id));
  return tgt;
end $$;

-- immediate, always-allowed safety action: back to research, all instances off. No approval needed to REDUCE risk.
create or replace function api_disable_strategy(p_ws uuid, p_key text, p_reason text) returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform assert_role(p_ws, array['owner','admin']::app_role[]);
  if length(trim(coalesce(p_reason,''))) < 3 then raise exception 'a reason is required' using errcode='P0001'; end if;
  if not exists (select 1 from strategy_definitions where key = p_key and (workspace_id is null or workspace_id = p_ws)) then raise exception 'strategy not found' using errcode='P0001'; end if;
  update strategy_instances set enabled = false, version = version + 1, updated_by = auth.uid(), updated_at = now() where workspace_id = p_ws and strategy_key = p_key and enabled;
  get diagnostics n = row_count;
  update strategy_deployments set stage = 'research', updated_by = auth.uid(), updated_at = now() where workspace_id = p_ws and strategy_key = p_key and stage <> 'research';
  insert into emergency_actions(workspace_id, scope, scope_id, action, actor, reason) values (p_ws, 'STRATEGY', p_key, 'DISABLE_STRATEGY', auth.uid(), p_reason);
  perform audit(p_ws, 'strategy.disable', 'strategy_definitions', p_key, null, jsonb_build_object('reason', p_reason, 'instances_disabled', n));
  return n;
end $$;

create or replace function api_set_strategy_enabled(p_bucket uuid, p_key text, p_enabled boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare b buckets%rowtype; d strategy_definitions%rowtype; st text; gs text; ver int;
begin
  select * into b from buckets where id = p_bucket; if not found then raise exception 'bucket not found' using errcode='P0001'; end if;
  perform assert_role(b.workspace_id, array['owner','admin']::app_role[]);
  select * into d from strategy_definitions where key = p_key and (workspace_id is null or workspace_id = b.workspace_id) order by version desc limit 1;
  if not found then raise exception 'strategy not found' using errcode='P0001'; end if;
  ver := d.version;
  if p_enabled then
    st := strategy_stage_of(b.workspace_id, p_key, ver);
    if st = 'research' then raise exception 'strategy is in research stage; promote it to paper (approval required) before enabling it on a bucket' using errcode='P0001'; end if;
    if not d.spot_only then raise exception 'only spot strategies can run' using errcode='P0001'; end if;
    if b.kind <> 'trading' then raise exception 'strategies can only run on trading buckets' using errcode='P0001'; end if;
    if b.state <> 'active' then raise exception 'bucket is %', b.state using errcode='P0001'; end if;
    select global_state into gs from workspace_settings where workspace_id = b.workspace_id;
    if gs <> 'active' then raise exception 'global state % refuses enabling strategies', gs using errcode='P0001'; end if;
    if b.environment = 'live' and not live_allowed(b.workspace_id) then raise exception 'LIVE EXECUTION DISABLED: deployment gates not all PASS' using errcode='P0001'; end if;
    if not exists (select 1 from strategy_capital_budgets where bucket_id = p_bucket and strategy_key = p_key and limit_amount > 0) then
      raise exception 'set a capital budget (> 0) for this strategy on this bucket first' using errcode='P0001'; end if;
  end if;
  insert into strategy_instances(workspace_id, bucket_id, environment, strategy_key, strategy_version, enabled, updated_by)
    values (b.workspace_id, p_bucket, b.environment, p_key, ver, p_enabled, auth.uid())
    on conflict (bucket_id, strategy_key) do update set enabled = excluded.enabled, strategy_version = excluded.strategy_version, version = strategy_instances.version + 1, updated_by = auth.uid(), updated_at = now();
  perform audit(b.workspace_id, case when p_enabled then 'strategy.enable' else 'strategy.disable_instance' end, 'strategy_instances', p_key, b.environment, jsonb_build_object('bucket', p_bucket, 'strategy', p_key));
  return p_enabled;
end $$;

create or replace function api_configure_strategy_instance(p_bucket uuid, p_key text, p_params jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare b buckets%rowtype; d strategy_definitions%rowtype; k text; v jsonb; tk text; tv jsonb; out jsonb := '{}'; nv int;
begin
  select * into b from buckets where id = p_bucket; if not found then raise exception 'bucket not found' using errcode='P0001'; end if;
  perform assert_role(b.workspace_id, array['owner','admin']::app_role[]);
  select * into d from strategy_definitions where key = p_key and (workspace_id is null or workspace_id = b.workspace_id) order by version desc limit 1;
  if not found then raise exception 'strategy not found' using errcode='P0001'; end if;
  for k, v in select * from jsonb_each(p_params) loop
    if k = 'order_type' then if v #>> '{}' not in ('limit','market') then raise exception 'order_type must be limit or market' using errcode='P0001'; end if;
    elsif k in ('stop_loss_bps','max_order_bps_of_budget','max_slippage_bps') then
      if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 10000 or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) then raise exception '% must be an integer within 0..10000', k using errcode='P0001'; end if;
    elsif k = 'tuned' then
      if jsonb_typeof(v) <> 'object' then raise exception 'tuned must be an object' using errcode='P0001'; end if;
      begin
        for tk, tv in select * from jsonb_each(v) loop
          if not (d.param_bounds ? tk) then raise exception 'unknown parameter %', tk using errcode='P0001'; end if;
          if jsonb_typeof(tv) <> 'number' or (tv #>> '{}')::numeric < (d.param_bounds->tk->>'min')::numeric or (tv #>> '{}')::numeric > (d.param_bounds->tk->>'max')::numeric then
            raise exception 'parameter % is outside its declared bounds', tk using errcode='P0001'; end if;
        end loop;
      end;
    else raise exception 'unsupported setting %', k using errcode='P0001'; end if;
    out := out || jsonb_build_object(k, v);
  end loop;
  if (out ? 'max_order_bps_of_budget') and (out->>'max_order_bps_of_budget')::numeric > coalesce((d.risk_budget->>'max_order_bps_of_budget')::numeric, 10000) then
    raise exception 'max_order_bps_of_budget cannot exceed the strategy definition cap (%)', d.risk_budget->>'max_order_bps_of_budget' using errcode='P0001'; end if;
  insert into strategy_instances(workspace_id, bucket_id, environment, strategy_key, strategy_version, enabled, params, updated_by)
    values (b.workspace_id, p_bucket, b.environment, p_key, d.version, false, out, auth.uid())
    on conflict (bucket_id, strategy_key) do update set params = excluded.params, version = strategy_instances.version + 1, updated_by = auth.uid(), updated_at = now()
    returning version into nv;
  perform audit(b.workspace_id, 'strategy.configure', 'strategy_instances', p_key, b.environment, jsonb_build_object('bucket', p_bucket, 'params', out));
  return nv;
end $$;

revoke execute on function validate_param_bounds(jsonb), strategy_stage_of(uuid,text,int), api_create_strategy(uuid,text,text,text,text,chain_family[],text[],text[],jsonb,jsonb,jsonb,text),
  api_request_strategy_stage(uuid,text,int,text), api_apply_strategy_stage(uuid), api_disable_strategy(uuid,text,text), api_set_strategy_enabled(uuid,text,boolean), api_configure_strategy_instance(uuid,text,jsonb) from public;
grant execute on function validate_param_bounds(jsonb), strategy_stage_of(uuid,text,int) to service_role;
grant execute on function api_create_strategy(uuid,text,text,text,text,chain_family[],text[],text[],jsonb,jsonb,jsonb,text),
  api_request_strategy_stage(uuid,text,int,text), api_apply_strategy_stage(uuid), api_disable_strategy(uuid,text,text), api_set_strategy_enabled(uuid,text,boolean), api_configure_strategy_instance(uuid,text,jsonb) to authenticated, service_role;
