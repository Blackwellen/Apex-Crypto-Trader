-- APEX 0004: compounding policies, waterfall, targets, high-water marks, operations tables.

create table compounding_policies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  bucket_id uuid not null references buckets(id) on delete cascade,
  version int not null,
  mode text not null default 'proportional' check (mode in ('fixed','proportional','target_vol','anti_martingale','defensive_decompound','stair_step')),
  reinvest_bps int not null check (reinvest_bps between 0 and 10000),
  vault_bps int not null check (vault_bps between 0 and 10000),
  cross_bucket_bps int not null default 0 check (cross_bucket_bps between 0 and 10000),
  reserve_bps int not null check (reserve_bps between 0 and 10000),
  tax_provision_bps int not null default 0 check (tax_provision_bps between 0 and 10000),   -- accounting provision, not tax advice
  vault_bucket_id uuid references buckets(id),
  vault_wca uuid references wallet_chain_accounts(id),
  cross_bucket_id uuid references buckets(id),
  cross_wca uuid references wallet_chain_accounts(id),
  min_ticket numeric(78,0) not null default 0,
  cooloff_seconds int not null default 0,
  drawdown_limit_bps int not null default 1000 check (drawdown_limit_bps between 0 and 10000),
  max_reinvest_rate_bps int not null default 10000 check (max_reinvest_rate_bps between 0 and 10000),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (bucket_id, version),
  -- waterfall percentages across ELIGIBLE profit must total exactly 100%
  constraint waterfall_sums_to_100 check (reinvest_bps + vault_bps + cross_bucket_bps + reserve_bps = 10000),
  constraint cross_needs_dest check (cross_bucket_bps = 0 or (cross_bucket_id is not null and cross_wca is not null)),
  constraint vault_needs_dest check (vault_bps = 0 or (vault_bucket_id is not null and vault_wca is not null))
);
create trigger compounding_policies_immutable before update or delete on compounding_policies for each row execute function forbid_mutation();

create table target_plans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  bucket_id uuid references buckets(id),
  period text not null check (period in ('day','week','month','quarter','year')),
  target_amount numeric(78,0),                    -- absolute, base units of reporting asset
  target_pct_bps int check (target_pct_bps is null or target_pct_bps between 0 and 1000000),
  start_equity numeric(78,0) not null default 0,
  monitoring_only boolean not null default true check (monitoring_only),   -- a target NEVER forces trades
  created_at timestamptz not null default now(),
  check (target_amount is not null or target_pct_bps is not null)
);
create table high_water_marks (
  bucket_id uuid primary key references buckets(id) on delete cascade,
  hwm numeric(78,0) not null default 0,
  updated_at timestamptz not null default now()
);
create table bucket_deficits (
  bucket_id uuid not null references buckets(id) on delete cascade,
  quote_asset uuid not null references assets(id),
  amount numeric(78,0) not null default 0 check (amount >= 0),
  primary key (bucket_id, quote_asset)
);
create table waterfall_executions (
  id uuid primary key default gen_random_uuid(),
  profit_event_id uuid not null unique references profit_eligibility_events(id),   -- never compound the same profit twice
  workspace_id uuid not null,
  policy_id uuid not null references compounding_policies(id),
  gross numeric(78,0) not null, deficit_recovered numeric(78,0) not null, eligible numeric(78,0) not null,
  tax_provision numeric(78,0) not null, to_reinvest numeric(78,0) not null, to_vault numeric(78,0) not null,
  to_cross numeric(78,0) not null, to_reserve numeric(78,0) not null,
  vault_transfer uuid references internal_transfers(id), cross_transfer uuid references internal_transfers(id),
  created_at timestamptz not null default now(),
  constraint parts_sum check (tax_provision + to_reinvest + to_vault + to_cross + to_reserve = eligible)
);

create or replace function update_high_water_mark(p_bucket uuid, p_equity numeric) returns numeric language plpgsql as $$
declare h numeric;
begin
  insert into high_water_marks(bucket_id, hwm) values (p_bucket, greatest(p_equity,0))
  on conflict (bucket_id) do update set hwm = greatest(high_water_marks.hwm, excluded.hwm), updated_at = now()
  returning hwm into h;
  return h;
end $$;

-- Loss events grow the deficit that must be recovered before any profit is distributed.
create or replace function record_realized_result(p_event uuid) returns void language plpgsql as $$
declare e profit_eligibility_events%rowtype;
begin
  select * into e from profit_eligibility_events where id = p_event;
  if e.realized_net_quote < 0 then
    insert into bucket_deficits(bucket_id, quote_asset, amount) values (e.bucket_id, e.quote_asset, -e.realized_net_quote)
      on conflict (bucket_id, quote_asset) do update set amount = bucket_deficits.amount - e.realized_net_quote;
  end if;
end $$;

-- apply_waterfall: idempotent (one execution per profit event). Rejects unreconciled / unsettled profit.
create or replace function apply_waterfall(p_event uuid, p_policy uuid) returns uuid language plpgsql as $$
declare e profit_eligibility_events%rowtype; i trade_intents%rowtype; pol compounding_policies%rowtype; xid uuid;
  gross numeric; def numeric; elig numeric; tax numeric; rv numeric; vt numeric; cx numeric; rs numeric;
  av uuid; restricted uuid; feeres uuid; vtid uuid; ctid uuid; wca uuid; avail numeric;
begin
  select id into xid from waterfall_executions where profit_event_id = p_event;
  if xid is not null then return xid; end if;
  select * into e from profit_eligibility_events where id = p_event for update;
  if not found then raise exception 'profit event not found' using errcode='P0001'; end if;
  select * into i from trade_intents where id = e.intent_id;
  if i.state not in ('RECONCILED','LEDGER_APPLIED') then
    raise exception 'profit not eligible: intent in state % (needs RECONCILED)', i.state using errcode='P0001';
  end if;
  select * into pol from compounding_policies where id = p_policy and bucket_id = e.bucket_id;
  if not found then raise exception 'policy does not belong to bucket' using errcode='P0001'; end if;
  gross := greatest(e.realized_net_quote, 0);
  if gross = 0 then raise exception 'no net realised profit to distribute' using errcode='P0001'; end if;
  -- step 2: recover deficit first
  select amount into def from bucket_deficits where bucket_id = e.bucket_id and quote_asset = e.quote_asset for update;
  def := least(coalesce(def,0), gross);
  if def > 0 then update bucket_deficits set amount = amount - def where bucket_id = e.bucket_id and quote_asset = e.quote_asset; end if;
  elig := gross - def;
  if elig < pol.min_ticket or elig = 0 then
    insert into waterfall_executions(profit_event_id, workspace_id, policy_id, gross, deficit_recovered, eligible, tax_provision, to_reinvest, to_vault, to_cross, to_reserve)
      values (p_event, e.workspace_id, p_policy, gross, def, 0, 0, 0, 0, 0, 0) returning id into xid;
    update profit_eligibility_events set eligible = true where id = p_event;
    return xid;
  end if;
  -- step 4/6: integer basis-point split; rounding remainder always goes to reinvest (stays in bucket)
  tax := elig * pol.tax_provision_bps / 10000;
  vt  := (elig - tax) * pol.vault_bps / 10000;
  cx  := (elig - tax) * pol.cross_bucket_bps / 10000;
  rs  := (elig - tax) * pol.reserve_bps / 10000;
  rv  := elig - tax - vt - cx - rs;
  wca := i.wallet_chain_account_id;
  av := ledger_account(e.workspace_id, e.environment, e.bucket_id, wca, e.quote_asset, 'available');
  select balance into avail from ledger_accounts where id = av for update;
  if avail < tax + vt + cx + rs then raise exception 'insufficient available balance to distribute profit' using errcode='P0001'; end if;
  if tax + rs > 0 then
    restricted := ledger_account(e.workspace_id, e.environment, e.bucket_id, wca, e.quote_asset, 'restricted');
    feeres := ledger_account(e.workspace_id, e.environment, e.bucket_id, wca, e.quote_asset, 'fee_reserve');
    perform post_entry(e.workspace_id, e.environment, 'waterfall_reserves', 'wf-res:' || p_event,
      jsonb_build_array(jsonb_build_object('account', av, 'amount', (-(tax + rs))::text))
      || case when tax > 0 then jsonb_build_array(jsonb_build_object('account', restricted, 'amount', tax::text)) else '[]'::jsonb end
      || case when rs  > 0 then jsonb_build_array(jsonb_build_object('account', feeres, 'amount', rs::text)) else '[]'::jsonb end);
  end if;
  -- vault / cross-bucket: genuine ledger movement; becomes a PENDING physical transfer when wallets differ
  if vt > 0 then vtid := request_transfer(e.workspace_id, e.environment, e.bucket_id, wca, pol.vault_bucket_id, pol.vault_wca, e.quote_asset, vt, 'wf-vault:' || p_event); end if;
  if cx > 0 then ctid := request_transfer(e.workspace_id, e.environment, e.bucket_id, wca, pol.cross_bucket_id, pol.cross_wca, e.quote_asset, cx, 'wf-cross:' || p_event); end if;
  insert into waterfall_executions(profit_event_id, workspace_id, policy_id, gross, deficit_recovered, eligible, tax_provision, to_reinvest, to_vault, to_cross, to_reserve, vault_transfer, cross_transfer)
    values (p_event, e.workspace_id, p_policy, gross, def, elig, tax, rv, vt, cx, rs, vtid, ctid) returning id into xid;
  update profit_eligibility_events set eligible = true where id = p_event;
  return xid;
end $$;

-- Operations ----------------------------------------------------------------------------------
create table jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  queue text not null, priority int not null default 5,
  essential boolean not null default false,             -- safety/settlement jobs are never paused by "pause research"
  payload jsonb not null default '{}', status text not null default 'queued' check (status in ('queued','running','done','failed','dead')),
  attempts int not null default 0, idempotency_key text, locked_by text, locked_until timestamptz, last_error text,
  created_at timestamptz not null default now(), unique (workspace_id, idempotency_key)
);
create index on jobs (queue, status, priority);
create table alerts (
  id bigint generated always as identity primary key, workspace_id uuid not null references workspaces(id) on delete cascade,
  class text not null, severity text not null check (severity in ('info','warn','critical')), message text not null,
  environment environment, acknowledged boolean not null default false, created_at timestamptz not null default now()
);
create table qa_evidence (
  id uuid primary key default gen_random_uuid(), suite text not null, test_name text not null,
  status text not null check (status in ('PASS','FAIL','BLOCKED','NOT_RUN')),
  command text not null, commit_sha text not null, detail text, assumptions text, run_at timestamptz not null default now()
);
create trigger qa_evidence_immutable before update or delete on qa_evidence for each row execute function forbid_mutation();
create table simulation_runs (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('backtest','paper_replay','monte_carlo')), params jsonb not null, data_provenance text not null,
  metrics jsonb, status text not null default 'queued', created_at timestamptz not null default now()
);
