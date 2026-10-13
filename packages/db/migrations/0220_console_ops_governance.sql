-- APEX 0220 (UI-ops range): console governance + operations surface.
--   * paper-only transfer lifecycle (confirm / fail) exposed through role-checked api_* wrappers
--   * job queue pause (non-essential only; DB-enforced) + idempotent retry
--   * alert acknowledge + manual incident log
--   * reconciliation_discrepancies (manual reconciliation exceptions) with RLS
--   * global limits: tighten-only from the UI; loosening goes through an approval request (permission_increase)
--   * scoped emergency controls (bucket; wallet scope reuses 0200)
--   * members listing, target plans with a reporting asset, stricter gate sign-off

-- ---------------------------------------------------------------- jobs: pause non-essential, retry
alter table jobs add column paused boolean not null default false;
alter table jobs add column paused_at timestamptz;
-- DB-level guarantee: an essential (safety/settlement) job can never be marked paused, by anyone.
alter table jobs add constraint essential_never_paused check (not (essential and paused));
alter table workspace_settings add column nonessential_jobs_paused boolean not null default false;

-- jobs enqueued while the workspace-wide pause is on start paused unless they are essential
create or replace function jobs_apply_pause() returns trigger language plpgsql as $$
begin
  if not new.essential and new.workspace_id is not null
     and coalesce((select nonessential_jobs_paused from workspace_settings where workspace_id = new.workspace_id), false) then
    new.paused := true; new.paused_at := now();
  end if;
  return new;
end $$;
create trigger jobs_apply_pause_ins before insert on jobs for each row execute function jobs_apply_pause();

create table job_retries (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  job_id uuid not null references jobs(id) on delete cascade,
  idempotency_key text not null,
  retried_by uuid,
  created_at timestamptz not null default now(),
  primary key (workspace_id, idempotency_key)
);
alter table job_retries enable row level security; alter table job_retries force row level security;
create policy job_retries_sel on job_retries for select to authenticated using (is_member(workspace_id));

create or replace function api_pause_nonessential_jobs(ws uuid, why text) returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform assert_role(ws, array['owner','admin','trader']::app_role[]);     -- pausing is fail-safe: traders may do it
  update workspace_settings set nonessential_jobs_paused = true, updated_at = now() where workspace_id = ws;
  -- `not essential` is the whole point: safety/settlement jobs are never touched
  update jobs set paused = true, paused_at = now() where workspace_id = ws and not essential and status in ('queued','running') and not paused;
  get diagnostics n = row_count;
  insert into emergency_actions(workspace_id, scope, action, actor, reason) values (ws, 'GLOBAL', 'ALL_NONESSENTIAL_PAUSE', auth.uid(), why);
  perform audit(ws, 'jobs.pause_nonessential', 'jobs', ws::text, null, jsonb_build_object('paused', n, 'reason', why));
  return n;
end $$;

create or replace function api_resume_nonessential_jobs(ws uuid) returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform assert_role(ws, array['owner','admin']::app_role[]);
  update workspace_settings set nonessential_jobs_paused = false, updated_at = now() where workspace_id = ws;
  update jobs set paused = false, paused_at = null where workspace_id = ws and paused;
  get diagnostics n = row_count;
  perform audit(ws, 'jobs.resume_nonessential', 'jobs', ws::text, null, jsonb_build_object('resumed', n));
  return n;
end $$;

-- retry a failed/dead job. Idempotent per (workspace, key): a replay is a no-op returning the same job; a second
-- retry of a job that is no longer failed/dead is refused rather than double-queued.
create or replace function api_retry_job(p_job uuid, p_key text) returns uuid language plpgsql security definer set search_path = public as $$
declare j jobs%rowtype;
begin
  select * into j from jobs where id = p_job for update;
  if not found or j.workspace_id is null then raise exception 'job not found' using errcode='P0001'; end if;
  perform assert_role(j.workspace_id, array['owner','admin']::app_role[]);
  if exists (select 1 from job_retries where workspace_id = j.workspace_id and idempotency_key = p_key) then return j.id; end if;
  if j.status not in ('failed','dead') then raise exception 'only failed or dead-lettered jobs can be retried (job is %)', j.status using errcode='P0001'; end if;
  insert into job_retries(workspace_id, job_id, idempotency_key, retried_by) values (j.workspace_id, j.id, p_key, auth.uid());
  update jobs set status = 'queued', locked_by = null, locked_until = null where id = j.id;
  perform audit(j.workspace_id, 'jobs.retry', 'jobs', j.id::text, null, jsonb_build_object('queue', j.queue, 'attempts', j.attempts));
  return j.id;
end $$;

-- ---------------------------------------------------------------- alerts / incidents
alter table alerts add column acknowledged_by uuid;
alter table alerts add column acknowledged_at timestamptz;
alter table alerts add column ack_note text;
alter table alerts add column source text not null default 'system';

create or replace function api_ack_alert(p_alert bigint, p_note text) returns void language plpgsql security definer set search_path = public as $$
declare a alerts%rowtype;
begin
  select * into a from alerts where id = p_alert for update;
  if not found then raise exception 'alert not found' using errcode='P0001'; end if;
  perform assert_role(a.workspace_id, array['owner','admin','trader']::app_role[]);
  if a.acknowledged then return; end if;
  update alerts set acknowledged = true, acknowledged_by = auth.uid(), acknowledged_at = now(), ack_note = nullif(p_note, '') where id = p_alert;
  perform audit(a.workspace_id, 'alert.acknowledge', 'alerts', p_alert::text, a.environment, jsonb_build_object('class', a.class, 'severity', a.severity));
end $$;

-- manual incident log (operator-reported); system alerts come from services
create or replace function api_record_incident(ws uuid, p_class text, p_severity text, p_message text) returns bigint language plpgsql security definer set search_path = public as $$
declare nid bigint;
begin
  perform assert_role(ws, array['owner','admin','trader']::app_role[]);
  if p_severity not in ('info','warn','critical') then raise exception 'bad severity' using errcode='P0001'; end if;
  insert into alerts(workspace_id, class, severity, message, source) values (ws, p_class, p_severity, p_message, 'operator') returning id into nid;
  perform audit(ws, 'incident.record', 'alerts', nid::text, null, jsonb_build_object('class', p_class, 'severity', p_severity));
  return nid;
end $$;

-- ---------------------------------------------------------------- reconciliation exceptions
create table reconciliation_discrepancies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  environment environment not null default 'paper',
  bucket_id uuid references buckets(id),
  asset_id uuid not null references assets(id),
  expected numeric(78,0) not null,                 -- what the internal ledger says
  observed numeric(78,0) not null,                 -- what an external source (statement/explorer) says
  source text not null check (length(source) between 1 and 200),   -- where `observed` came from
  note text check (note is null or length(note) <= 1000),
  status text not null default 'open' check (status in ('open','resolved')),
  created_by uuid not null, created_at timestamptz not null default now(),
  resolved_by uuid, resolved_at timestamptz, resolution text,
  constraint resolved_has_reason check (status = 'open' or (resolution is not null and resolved_by is not null))
);
alter table reconciliation_discrepancies enable row level security; alter table reconciliation_discrepancies force row level security;
create policy reconciliation_discrepancies_sel on reconciliation_discrepancies for select to authenticated using (is_member(workspace_id));

create or replace function api_add_discrepancy(ws uuid, p_bucket uuid, p_asset uuid, p_expected numeric, p_observed numeric, p_source text, p_note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare nid uuid; env environment := 'paper';
begin
  perform assert_role(ws, array['owner','admin']::app_role[]);
  if p_bucket is not null then
    select environment into env from buckets where id = p_bucket and workspace_id = ws;
    if env is null then raise exception 'bucket not in workspace' using errcode='P0001'; end if;
  end if;
  if p_expected = p_observed then raise exception 'expected and observed are equal: nothing to reconcile' using errcode='P0001'; end if;
  insert into reconciliation_discrepancies(workspace_id, environment, bucket_id, asset_id, expected, observed, source, note, created_by)
    values (ws, env, p_bucket, p_asset, p_expected, p_observed, p_source, p_note, auth.uid()) returning id into nid;
  perform audit(ws, 'reconciliation.exception.add', 'reconciliation_discrepancies', nid::text, env, jsonb_build_object('expected', p_expected::text, 'observed', p_observed::text));
  return nid;
end $$;

create or replace function api_resolve_discrepancy(p_id uuid, p_resolution text) returns void language plpgsql security definer set search_path = public as $$
declare d reconciliation_discrepancies%rowtype;
begin
  select * into d from reconciliation_discrepancies where id = p_id for update;
  if not found then raise exception 'exception not found' using errcode='P0001'; end if;
  perform assert_role(d.workspace_id, array['owner','admin']::app_role[]);
  if d.status = 'resolved' then return; end if;
  if length(coalesce(p_resolution, '')) < 3 then raise exception 'a resolution note is required' using errcode='P0001'; end if;
  update reconciliation_discrepancies set status = 'resolved', resolved_by = auth.uid(), resolved_at = now(), resolution = p_resolution where id = p_id;
  perform audit(d.workspace_id, 'reconciliation.exception.resolve', 'reconciliation_discrepancies', p_id::text, d.environment, jsonb_build_object('resolution', p_resolution));
end $$;

-- ---------------------------------------------------------------- transfers: paper lifecycle only
create or replace function api_confirm_paper_transfer(p_transfer uuid, p_ref text) returns void language plpgsql security definer set search_path = public as $$
declare t internal_transfers%rowtype;
begin
  select * into t from internal_transfers where id = p_transfer;
  if not found then raise exception 'transfer not found' using errcode='P0001'; end if;
  perform assert_role(t.workspace_id, array['owner','admin']::app_role[]);
  if t.environment <> 'paper' then raise exception 'live transfers are confirmed only by the settlement service after on-chain finality' using errcode='42501'; end if;
  perform confirm_transfer(p_transfer, coalesce(nullif(p_ref, ''), 'paper-sim:' || p_transfer));
  perform audit(t.workspace_id, 'transfer.paper_confirm', 'internal_transfers', p_transfer::text, 'paper', '{}');
end $$;

create or replace function api_fail_paper_transfer(p_transfer uuid) returns void language plpgsql security definer set search_path = public as $$
declare t internal_transfers%rowtype;
begin
  select * into t from internal_transfers where id = p_transfer;
  if not found then raise exception 'transfer not found' using errcode='P0001'; end if;
  perform assert_role(t.workspace_id, array['owner','admin']::app_role[]);
  if t.environment <> 'paper' then raise exception 'live transfers are failed only by the settlement service' using errcode='42501'; end if;
  perform fail_transfer(p_transfer);
  perform audit(t.workspace_id, 'transfer.paper_fail', 'internal_transfers', p_transfer::text, 'paper', '{}');
end $$;

-- ---------------------------------------------------------------- global limits: tighten only; loosening = approval
create or replace function limits_valid(p jsonb) returns boolean language plpgsql immutable as $$
declare e record; k text;
begin
  if p is null or jsonb_typeof(p) <> 'object' or p = '{}'::jsonb then return false; end if;
  for e in select key, value from jsonb_each(p) loop
    if e.key not in ('max_order_notional_bps_of_bucket','max_slippage_bps','max_quote_age_ms') then return false; end if;
    if jsonb_typeof(e.value) <> 'number' then return false; end if;
    if (e.value #>> '{}')::numeric < 0 or (e.value #>> '{}')::numeric <> floor((e.value #>> '{}')::numeric) then return false; end if;
    if e.key in ('max_order_notional_bps_of_bucket','max_slippage_bps') and (e.value #>> '{}')::numeric > 10000 then return false; end if;
  end loop;
  return true;
end $$;

create or replace function api_tighten_global_limits(ws uuid, p_limits jsonb, why text) returns jsonb language plpgsql security definer set search_path = public as $$
declare cur jsonb; k text; merged jsonb;
begin
  perform assert_role(ws, array['owner']::app_role[]);
  if not limits_valid(p_limits) then raise exception 'invalid limits: allowed keys are max_order_notional_bps_of_bucket, max_slippage_bps, max_quote_age_ms (non-negative integers)' using errcode='P0001'; end if;
  select global_limits into cur from workspace_settings where workspace_id = ws for update;
  for k in select jsonb_object_keys(p_limits) loop
    if (p_limits->>k)::numeric > (cur->>k)::numeric then
      raise exception 'limit % can only be tightened here (current %, requested %); raising it needs an approval request', k, cur->>k, p_limits->>k using errcode='P0001';
    end if;
  end loop;
  merged := cur || p_limits;
  update workspace_settings set global_limits = merged, updated_at = now() where workspace_id = ws;
  perform audit(ws, 'limits.tighten', 'workspace_settings', ws::text, null, jsonb_build_object('from', cur, 'to', merged, 'reason', why));
  return merged;
end $$;

create or replace function api_request_limit_increase(ws uuid, p_limits jsonb, why text) returns uuid language plpgsql security definer set search_path = public as $$
declare aid uuid;
begin
  perform assert_role(ws, array['owner']::app_role[]);
  if not limits_valid(p_limits) then raise exception 'invalid limits' using errcode='P0001'; end if;
  insert into approval_requests(workspace_id, kind, subject, requested_by)
    values (ws, 'permission_increase', jsonb_build_object('limits', p_limits, 'reason', why), auth.uid()) returning id into aid;
  perform audit(ws, 'limits.increase.requested', 'approval_requests', aid::text, null, jsonb_build_object('limits', p_limits));
  return aid;
end $$;

-- executes an APPROVED (second owner, four-eyes) and delay-elapsed limit increase exactly once
create or replace function api_apply_limit_increase(p_approval uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare a approval_requests%rowtype; cur jsonb; merged jsonb;
begin
  select * into a from approval_requests where id = p_approval for update;
  if not found or a.kind <> 'permission_increase' then raise exception 'approval not found' using errcode='P0001'; end if;
  perform assert_role(a.workspace_id, array['owner']::app_role[]);
  if a.status = 'executed' then raise exception 'already applied' using errcode='P0001'; end if;
  if a.status <> 'approved' then raise exception 'approval is %', a.status using errcode='P0001'; end if;
  if now() < a.not_before then raise exception 'permission-increase delay has not elapsed (not before %)', a.not_before using errcode='P0001'; end if;
  select global_limits into cur from workspace_settings where workspace_id = a.workspace_id for update;
  merged := cur || (a.subject->'limits');
  update workspace_settings set global_limits = merged, updated_at = now() where workspace_id = a.workspace_id;
  update approval_requests set status = 'executed' where id = a.id;
  perform audit(a.workspace_id, 'limits.increase.applied', 'approval_requests', a.id::text, null, jsonb_build_object('from', cur, 'to', merged));
  return merged;
end $$;

-- ---------------------------------------------------------------- scoped emergency controls (bucket; wallet scope reuses 0200)
create or replace function api_set_bucket_state(p_bucket uuid, p_state text, why text) returns void language plpgsql security definer set search_path = public as $$
declare b buckets%rowtype;
begin
  select * into b from buckets where id = p_bucket for update;
  if not found then raise exception 'bucket not found' using errcode='P0001'; end if;
  if p_state not in ('active','halt_new_entries','exit_only','disabled') then raise exception 'bad bucket state' using errcode='P0001'; end if;
  -- halting is fail-safe (traders may); resuming needs owner/admin
  if p_state = 'active' then perform assert_role(b.workspace_id, array['owner','admin']::app_role[]);
  else perform assert_role(b.workspace_id, array['owner','admin','trader']::app_role[]); end if;
  update buckets set state = p_state where id = p_bucket;
  insert into emergency_actions(workspace_id, scope, scope_id, action, actor, reason)
    values (b.workspace_id, 'BUCKET', p_bucket::text,
            case p_state when 'halt_new_entries' then 'HALT_NEW_ENTRIES' when 'exit_only' then 'EXIT_ONLY' when 'disabled' then 'EMERGENCY_STOP' else 'MANUAL_ESCALATION' end, auth.uid(), why);
  perform audit(b.workspace_id, 'bucket.state.' || p_state, 'buckets', p_bucket::text, b.environment, jsonb_build_object('reason', why, 'from', b.state));
end $$;

-- wallet-scope pause/resume reuses api_set_wallet_state from 0200 (pauseWallet / resumeWallet commands)

-- ---------------------------------------------------------------- members (emails visible to owner/admin only)
create or replace function api_list_members(ws uuid) returns table(user_id uuid, role app_role, email text, joined_at timestamptz, is_you boolean)
language plpgsql security definer set search_path = public as $$
declare priv boolean;
begin
  if not is_member(ws) then raise exception 'permission denied' using errcode='42501'; end if;
  priv := has_role(ws, array['owner','admin']::app_role[]);
  return query select m.user_id, m.role, case when priv or m.user_id = auth.uid() then u.email::text else null end, m.created_at, (m.user_id = auth.uid())
    from memberships m left join auth.users u on u.id = m.user_id where m.workspace_id = ws order by m.created_at;
end $$;

-- ---------------------------------------------------------------- targets with a reporting asset (so progress is computable)
alter table target_plans add column target_asset uuid references assets(id);
create or replace function api_set_compounding_target(ws uuid, p_bucket uuid, p_period text, p_asset uuid, p_amount numeric, p_pct_bps int, p_start_equity numeric) returns uuid
language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  perform assert_role(ws, array['owner','admin']::app_role[]);
  if p_bucket is not null and not exists (select 1 from buckets where id = p_bucket and workspace_id = ws) then raise exception 'bucket not in workspace' using errcode='P0001'; end if;
  if p_amount is null and p_pct_bps is null then raise exception 'provide an absolute amount and/or a percentage' using errcode='P0001'; end if;
  if p_pct_bps is not null and coalesce(p_start_equity, 0) = 0 and p_amount is null then raise exception 'a percentage target needs a non-zero start equity' using errcode='P0001'; end if;
  insert into target_plans(workspace_id, bucket_id, period, target_amount, target_pct_bps, start_equity, target_asset)
    values (ws, p_bucket, p_period, p_amount, p_pct_bps, coalesce(p_start_equity, 0), p_asset) returning id into tid;
  perform audit(ws, 'target.create', 'target_plans', tid::text, null, jsonb_build_object('period', p_period, 'monitoring_only', true));
  return tid;
end $$;

-- ---------------------------------------------------------------- gate sign-off: evidence + commit SHA are mandatory for every recorded result
create or replace function api_set_gate(ws uuid, p_gate text, p_status text, p_evidence text, p_sha text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform assert_role(ws, array['owner']::app_role[]);
  if p_status not in ('PASS','FAIL','BLOCKED','NOT_RUN') then raise exception 'bad status' using errcode='P0001'; end if;
  if p_status <> 'NOT_RUN' then
    if length(coalesce(trim(p_evidence), '')) < 3 then raise exception 'an evidence reference is required to record a gate result' using errcode='P0001'; end if;
    if coalesce(p_sha, '') !~ '^[0-9a-fA-F]{7,64}$' then raise exception 'a git commit SHA (7-64 hex characters) is required to record a gate result' using errcode='P0001'; end if;
  end if;
  update deployment_gates set status = p_status, evidence_ref = nullif(trim(p_evidence), ''), commit_sha = nullif(p_sha, ''), updated_by = auth.uid(), updated_at = now()
   where workspace_id = ws and gate_key = p_gate;
  if not found then raise exception 'unknown gate' using errcode='P0001'; end if;
  perform audit(ws, 'gate.set', 'deployment_gates', p_gate, null, jsonb_build_object('status', p_status, 'evidence', p_evidence, 'commit', p_sha));
end $$;

-- ---------------------------------------------------------------- grants
revoke execute on function api_pause_nonessential_jobs(uuid,text), api_resume_nonessential_jobs(uuid), api_retry_job(uuid,text), api_ack_alert(bigint,text),
  api_record_incident(uuid,text,text,text), api_add_discrepancy(uuid,uuid,uuid,numeric,numeric,text,text), api_resolve_discrepancy(uuid,text),
  api_confirm_paper_transfer(uuid,text), api_fail_paper_transfer(uuid), api_tighten_global_limits(uuid,jsonb,text), api_request_limit_increase(uuid,jsonb,text),
  api_apply_limit_increase(uuid), api_set_bucket_state(uuid,text,text), api_list_members(uuid),
  api_set_compounding_target(uuid,uuid,text,uuid,numeric,int,numeric), limits_valid(jsonb), jobs_apply_pause() from public;
grant execute on function api_pause_nonessential_jobs(uuid,text), api_resume_nonessential_jobs(uuid), api_retry_job(uuid,text), api_ack_alert(bigint,text),
  api_record_incident(uuid,text,text,text), api_add_discrepancy(uuid,uuid,uuid,numeric,numeric,text,text), api_resolve_discrepancy(uuid,text),
  api_confirm_paper_transfer(uuid,text), api_fail_paper_transfer(uuid), api_tighten_global_limits(uuid,jsonb,text), api_request_limit_increase(uuid,jsonb,text),
  api_apply_limit_increase(uuid), api_set_bucket_state(uuid,text,text), api_list_members(uuid),
  api_set_compounding_target(uuid,uuid,text,uuid,numeric,int,numeric), api_set_gate(uuid,text,text,text,text) to authenticated, service_role;
grant execute on function limits_valid(jsonb), jobs_apply_pause() to service_role;
grant select on all tables in schema public to authenticated;
revoke select on schema_migrations from authenticated;
