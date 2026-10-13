-- APEX 0260 (UI-markets range 0260-0279): research run lifecycle on simulation_runs, audited and idempotent.
-- A run moves queued -> running -> done|failed (or queued -> failed). Terminal rows are immutable.
-- Clients cannot write simulation_runs directly (no grants); the API calls these SECURITY DEFINER functions as the user.

alter table simulation_runs
  add column idempotency_key text,
  add column requested_by uuid,
  add column label text,
  add column error text,
  add column updated_at timestamptz not null default now(),
  add column finished_at timestamptz;

-- 'PENDING' = the researcher has not answered yet, so the provenance of the numbers is not yet known.
alter table simulation_runs add constraint simulation_runs_status_chk check (status in ('queued','running','done','failed'));
alter table simulation_runs add constraint simulation_runs_provenance_chk
  check (data_provenance in ('PENDING','SYNTHETIC','REAL_USER_SUPPLIED','REAL_PUBLIC_API'));
alter table simulation_runs add constraint simulation_runs_done_has_metrics_chk
  check (status <> 'done' or (metrics is not null and data_provenance <> 'PENDING'));
alter table simulation_runs add constraint simulation_runs_label_chk check (label is null or length(label) between 1 and 120);
create unique index simulation_runs_idem_uq on simulation_runs (workspace_id, idempotency_key) where idempotency_key is not null;
create index simulation_runs_ws_created_idx on simulation_runs (workspace_id, created_at desc);

create or replace function api_start_backtest(p_ws uuid, p_idem text, p_params jsonb, p_label text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ex simulation_runs%rowtype; rid uuid;
begin
  perform assert_role(p_ws, array['owner','admin','trader']::app_role[]);
  if p_idem is null or length(p_idem) < 8 then raise exception 'idempotency key required' using errcode='P0001'; end if;
  if pg_column_size(p_params) > 16384 then raise exception 'params too large' using errcode='P0001'; end if;
  select * into ex from simulation_runs where workspace_id = p_ws and idempotency_key = p_idem;
  if found then
    if ex.params is distinct from p_params then raise exception 'idempotency key reused with different parameters' using errcode='P0001'; end if;
    return jsonb_build_object('id', ex.id, 'created', false, 'status', ex.status);
  end if;
  insert into simulation_runs(workspace_id, kind, params, data_provenance, status, idempotency_key, requested_by, label)
    values (p_ws, 'backtest', p_params, 'PENDING', 'queued', p_idem, auth.uid(), p_label) returning id into rid;
  perform audit(p_ws, 'research.backtest.queued', 'simulation_runs', rid::text, 'paper', jsonb_build_object('label', p_label, 'strategies', p_params->'sleeves'));
  return jsonb_build_object('id', rid, 'created', true, 'status', 'queued');
end $$;

create or replace function api_advance_backtest(p_id uuid, p_status text, p_provenance text default null, p_metrics jsonb default null, p_error text default null) returns text
language plpgsql security definer set search_path = public as $$
declare r simulation_runs%rowtype;
begin
  select * into r from simulation_runs where id = p_id for update;
  if not found then raise exception 'run not found' using errcode='P0001'; end if;
  perform assert_role(r.workspace_id, array['owner','admin','trader']::app_role[]);
  if not ((r.status = 'queued' and p_status in ('running','failed')) or (r.status = 'running' and p_status in ('done','failed'))) then
    raise exception 'illegal run transition % -> %', r.status, p_status using errcode='P0001';
  end if;
  if p_status = 'done' and (p_metrics is null or p_provenance is null or p_provenance = 'PENDING') then
    raise exception 'a finished run must carry metrics and a data provenance label' using errcode='P0001'; end if;
  if pg_column_size(coalesce(p_metrics,'{}'::jsonb)) > 4000000 then raise exception 'metrics too large' using errcode='P0001'; end if;
  update simulation_runs set status = p_status, updated_at = now(),
      data_provenance = coalesce(p_provenance, data_provenance), metrics = coalesce(p_metrics, metrics), error = left(p_error, 500),
      finished_at = case when p_status in ('done','failed') then now() end
    where id = p_id;
  perform audit(r.workspace_id, 'research.backtest.' || p_status, 'simulation_runs', p_id::text, 'paper',
    jsonb_build_object('provenance', coalesce(p_provenance, r.data_provenance), 'error', left(p_error, 200)));
  return p_status;
end $$;

revoke execute on function api_start_backtest(uuid,text,jsonb,text), api_advance_backtest(uuid,text,text,jsonb,text) from public;
grant execute on function api_start_backtest(uuid,text,jsonb,text), api_advance_backtest(uuid,text,text,jsonb,text) to authenticated, service_role;
