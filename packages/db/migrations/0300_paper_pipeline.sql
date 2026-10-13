-- APEX 0300 (paper pipeline, Phase D): engine heartbeats, paper feed state, DB-backed deterministic paper venue records,
-- service-role signal intent creation, paper-only instant settlement, workspace paper status.
-- EVERYTHING in this migration is PAPER and SYNTHETIC. Nothing here can create or settle a live intent.
-- The only replaced existing function is advance_intent (identical to the 0140 version plus one extra guard, documented below).

-- 1) Engine heartbeats: written by `apex-execution serve` and `researcher.paper_feed`. The console uses them to show, truthfully,
--    whether an engine PROCESS is alive. paper_running=true with no fresh heartbeat means "wanted but NOT running".
create table engine_heartbeats (
  component text not null check (component in ('execution','paper_feed')),
  instance_id text not null,
  pid int,
  host text,
  started_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  stopped_at timestamptz,
  counters jsonb not null default '{}'::jsonb,
  info jsonb not null default '{}'::jsonb,
  primary key (component, instance_id)
);
alter table engine_heartbeats enable row level security;
create policy engine_heartbeats_sel on engine_heartbeats for select to authenticated using (true);   -- process liveness only; no tenant data
grant select on engine_heartbeats to authenticated;
grant all on engine_heartbeats to service_role;

create or replace function engine_heartbeat(p_component text, p_instance text, p_pid int, p_host text, p_started timestamptz, p_counters jsonb, p_info jsonb, p_stopped boolean default false)
returns void language plpgsql as $$
begin
  insert into engine_heartbeats(component, instance_id, pid, host, started_at, last_seen, stopped_at, counters, info)
    values (p_component, p_instance, p_pid, p_host, coalesce(p_started, now()), now(), case when p_stopped then now() end, coalesce(p_counters,'{}'), coalesce(p_info,'{}'))
    on conflict (component, instance_id) do update
      set last_seen = now(), pid = excluded.pid, host = excluded.host, counters = excluded.counters, info = excluded.info,
          stopped_at = case when p_stopped then now() else null end;
  delete from engine_heartbeats where last_seen < now() - interval '1 day';
end $$;

-- 2) Per-workspace synthetic feed cursor (deterministic: same seed => same bars; the cursor only says how far the stream has been consumed).
create table paper_feed_state (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  seed bigint not null,
  cursor int not null default 0,              -- index of the last bar whose close has been decided on
  last_bar_ts bigint,
  last_run_at timestamptz,
  counters jsonb not null default '{}'::jsonb,
  data_provenance text not null default 'SYNTHETIC' check (data_provenance = 'SYNTHETIC'),
  updated_at timestamptz not null default now()
);
alter table paper_feed_state enable row level security;
create policy paper_feed_state_sel on paper_feed_state for select to authenticated using (is_member(workspace_id));
grant select on paper_feed_state to authenticated;
grant all on paper_feed_state to service_role;

-- 3) Simulated venue records. The paper "exchange" is a deterministic function of (seed, client_order_id, order) whose records live
--    in the database, so it survives a process crash exactly like an external venue would (status() answers authoritatively).
create table paper_venue_orders (
  venue text not null default 'paper-sim',
  client_order_id text not null,
  workspace_id uuid,
  venue_order_id text not null,
  side text not null check (side in ('buy','sell')),
  price numeric(78,0) not null,
  qty numeric(78,0) not null,
  tif text not null,
  status text not null check (status in ('open','filled','expired','cancelled')),
  filled_qty numeric(78,0) not null default 0,
  fills jsonb not null default '[]'::jsonb,
  seed bigint not null,
  data_provenance text not null default 'SYNTHETIC',
  created_at timestamptz not null default now(),
  primary key (venue, client_order_id)
);
alter table paper_venue_orders enable row level security;
create policy paper_venue_orders_sel on paper_venue_orders for select to authenticated using (workspace_id is not null and is_member(workspace_id));
grant select on paper_venue_orders to authenticated;
grant all on paper_venue_orders to service_role;

-- 4) advance_intent: identical to 0140 plus: a BUY may not enter SUBMITTING while global_state <> 'active'. This closes the window
--    between the risk decision and the venue call for a halt/emergency stop (exits stay allowed). Defence in depth behind the dispatcher.
create or replace function advance_intent(p_intent uuid, p_to text, p_event_key text, p_detail jsonb default '{}') returns text
language plpgsql as $$
declare i trade_intents%rowtype; ss workspace_settings%rowtype; pos_qty numeric;
begin
  select * into i from trade_intents where id = p_intent for update;
  if not found then raise exception 'intent not found' using errcode='P0001'; end if;
  if exists (select 1 from order_events where intent_id = p_intent and event_key = p_event_key) then return i.state; end if;   -- duplicate delivery
  if not exists (select 1 from allowed_transitions where from_state = i.state and to_state = p_to) then
    raise exception 'illegal transition % -> %', i.state, p_to using errcode='P0001';
  end if;
  if p_to = 'ADMITTED' then
    if not exists (select 1 from risk_decisions where intent_id = p_intent and decision = 'ADMIT')
       or exists (select 1 from risk_decisions where intent_id = p_intent and decision = 'VETO') then
      raise exception 'risk gate: no ADMIT decision (or VETO present)' using errcode='P0001';
    end if;
    select * into ss from workspace_settings where workspace_id = i.workspace_id;
    if ss.global_state <> 'active' then
      select coalesce(sum(qty),0) into pos_qty from positions
       where bucket_id = i.bucket_id and wallet_chain_account_id = i.wallet_chain_account_id
         and base_asset = i.base_asset and quote_asset = i.quote_asset;
      if not (i.side = 'sell' and pos_qty >= i.quantity) then
        raise exception 'global state % refuses new entries', ss.global_state using errcode='P0001';
      end if;
    end if;
  end if;
  if p_to = 'SUBMITTING' and i.side = 'buy' then
    select * into ss from workspace_settings where workspace_id = i.workspace_id;
    if ss.global_state <> 'active' then
      raise exception 'global state % refuses new entries (cannot submit)', ss.global_state using errcode='P0001';
    end if;
  end if;
  if p_to = 'CAPITAL_RESERVED' and i.reservation_id is null then raise exception 'reservation required' using errcode='P0001'; end if;
  if i.state = 'UNKNOWN' and p_to = 'SUBMITTING' then raise exception 'UNKNOWN orders require reconciliation before resubmission' using errcode='P0001'; end if;
  insert into order_events(intent_id, workspace_id, event_key, from_state, to_state, detail) values (p_intent, i.workspace_id, p_event_key, i.state, p_to, p_detail);
  update trade_intents set state = p_to, updated_at = now() where id = p_intent;
  return p_to;
end $$;

-- 5) create_signal_intent: the ONLY way the synthetic feed creates intents. Service role. Idempotent on (workspace, 'feed:' || p_key):
--    a replay returns the original intent and changes nothing. Creates the intent in state SIGNAL plus its immutable evaluation context
--    (the Rust IntentContext JSON). It does NOT advance the state: risk, reservation and execution belong to the execution service.
create or replace function create_signal_intent(p_ws uuid, p_bucket uuid, p_wca uuid, p_base uuid, p_quote uuid, p_side text,
  p_qty numeric, p_limit_price numeric, p_strategy text, p_key text, p_context jsonb) returns uuid
language plpgsql as $$
declare ikey text := 'feed:' || p_key; v_id uuid; b buckets%rowtype; ss workspace_settings%rowtype; si strategy_instances%rowtype;
  dec int; g numeric; fee numeric; notional numeric; chain_a text; ok boolean;
begin
  select id into v_id from trade_intents where workspace_id = p_ws and idempotency_key = ikey;
  if found then return v_id; end if;                                                                   -- replay: never a second intent
  select * into b from buckets where id = p_bucket and workspace_id = p_ws;
  if not found then raise exception 'bucket not found in this workspace' using errcode='P0001'; end if;
  if b.environment <> 'paper' then raise exception 'create_signal_intent creates PAPER intents only' using errcode='P0001'; end if;
  if b.kind <> 'trading' or b.state <> 'active' then raise exception 'bucket must be an active trading bucket' using errcode='P0001'; end if;
  select * into ss from workspace_settings where workspace_id = p_ws;
  if not found or not ss.paper_running then raise exception 'paper engine is not running for this workspace' using errcode='P0001'; end if;
  if p_side not in ('buy','sell') then raise exception 'side must be buy or sell' using errcode='P0001'; end if;
  if ss.global_state <> 'active' and p_side = 'buy' then raise exception 'global state % refuses new entries', ss.global_state using errcode='P0001'; end if;
  if p_qty is null or p_qty <= 0 or p_qty <> trunc(p_qty) then raise exception 'quantity must be a positive integer of base units' using errcode='P0001'; end if;
  if p_limit_price is null or p_limit_price <= 0 or p_limit_price <> trunc(p_limit_price) then raise exception 'limit price must be a positive integer (quote base units per whole base asset)' using errcode='P0001'; end if;
  if p_base = p_quote then raise exception 'base and quote asset must differ' using errcode='P0001'; end if;
  select * into si from strategy_instances where bucket_id = p_bucket and strategy_key = p_strategy and enabled and environment = 'paper';
  if not found then raise exception 'no enabled paper strategy instance % on this bucket', p_strategy using errcode='P0001'; end if;
  select x.chain_id into chain_a from wallet_chain_accounts x join wallets w on w.id = x.wallet_id
   where x.id = p_wca and w.workspace_id = p_ws and w.state = 'active'
     and exists (select 1 from wallet_bucket_allocations a where a.wallet_id = w.id and a.bucket_id = p_bucket);
  if chain_a is null then raise exception 'wallet account is not an active wallet allocated to this bucket' using errcode='P0001'; end if;
  select (select chain_id = chain_a from assets where id = p_base) and (select chain_id = chain_a from assets where id = p_quote) into ok;
  if not coalesce(ok, false) then raise exception 'both assets must live on the wallet account''s chain' using errcode='P0001'; end if;
  select decimals into dec from assets where id = p_base;
  -- same formula as the Rust IntentSpec::notional(): buy = ceil(qty*price/10^dec) + ceil(that * max_fee_bps / 10000); sell = qty
  if p_side = 'buy' then
    g := ceil(p_qty * p_limit_price / (10::numeric ^ dec));
    fee := ceil(g * coalesce((p_context->>'max_fee_bps')::numeric, 25) / 10000);
    notional := g + fee;
  else
    notional := p_qty;
  end if;
  insert into trade_intents(workspace_id, environment, bucket_id, strategy_key, strategy_version, wallet_chain_account_id, base_asset, quote_asset, side, quantity, limit_price, notional, idempotency_key, venue)
    values (p_ws, 'paper', p_bucket, p_strategy, si.strategy_version, p_wca, p_base, p_quote, p_side, p_qty, p_limit_price, notional, ikey, 'paper-sim')
    on conflict (workspace_id, idempotency_key) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from trade_intents where workspace_id = p_ws and idempotency_key = ikey;
    return v_id;
  end if;
  insert into intent_context(intent_id, workspace_id, context) values (v_id, p_ws, p_context);
  return v_id;
end $$;

-- 6) paper_settle_intent: PAPER-ONLY instant settlement. Paper has no chain finality, so FILLED/CANCELLED/EXPIRED (with >= 1 fill and the
--    reservation already settled) goes SETTLING -> FINAL -> RECONCILED in one transaction, a realised loss is added to the bucket deficit
--    once, and realised profit is run through apply_waterfall if (and only if) the bucket has a compounding policy. Idempotent.
--    Refuses any non-paper intent. Live settlement must come from chain finality + reconciliation, never from this function.
create or replace function paper_settle_intent(p_intent uuid) returns text language plpgsql as $$
declare i trade_intents%rowtype; ev profit_eligibility_events%rowtype; pol uuid; nfills int;
begin
  select * into i from trade_intents where id = p_intent for update;
  if not found then raise exception 'intent not found' using errcode='P0001'; end if;
  if i.environment <> 'paper' then raise exception 'paper_settle_intent: PAPER intents only' using errcode='P0001'; end if;
  if i.state in ('FILLED','CANCELLED','EXPIRED') then
    select count(*) into nfills from fills where intent_id = i.id;
    if nfills = 0 then return i.state; end if;
    if i.reservation_id is not null and exists (select 1 from capital_reservations where id = i.reservation_id and status = 'held') then return i.state; end if;
    perform advance_intent(i.id, 'SETTLING', 'paper:settling', jsonb_build_object('paper_settlement', 'instant; no chain finality in paper', 'data_provenance', 'SYNTHETIC'));
    i.state := 'SETTLING';
  end if;
  if i.state = 'SETTLING' then
    perform advance_intent(i.id, 'FINAL', 'paper:final', jsonb_build_object('paper_settlement', 'instant'));
    i.state := 'FINAL';
  end if;
  if i.state = 'FINAL' then
    perform advance_intent(i.id, 'RECONCILED', 'paper:reconciled', jsonb_build_object('paper_settlement', 'internal ledger is the only source in paper'));
    select * into ev from profit_eligibility_events where intent_id = i.id;
    if found and ev.realized_net_quote < 0 then perform record_realized_result(ev.id); end if;       -- once: only on the FINAL -> RECONCILED move
    i.state := 'RECONCILED';
  end if;
  if i.state = 'RECONCILED' then
    select * into ev from profit_eligibility_events where intent_id = i.id;
    if found and ev.realized_net_quote > 0 and not exists (select 1 from waterfall_executions where profit_event_id = ev.id) then
      select id into pol from compounding_policies where bucket_id = i.bucket_id order by version desc limit 1;
      if pol is not null then
        begin
          perform apply_waterfall(ev.id, pol);
        exception when others then
          raise warning 'paper waterfall for intent % deferred: %', i.id, sqlerrm;                    -- retried on the next scan
        end;
      end if;
    end if;
  end if;
  return i.state;
end $$;

-- 7) api_paper_status: what the console needs to be honest about the paper pipeline. Members only.
create or replace function api_paper_status(p_ws uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare ss workspace_settings%rowtype; res jsonb; engines jsonb; feed jsonb; byst jsonb; led jsonb; ex_ok boolean; fd_ok boolean;
begin
  if auth.uid() is null or not is_member(p_ws) then raise exception 'permission denied' using errcode = '42501'; end if;
  select * into ss from workspace_settings where workspace_id = p_ws;
  if not found then raise exception 'workspace not found' using errcode='P0001'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('component', component, 'instance_id', instance_id, 'pid', pid, 'host', host,
           'started_at', started_at, 'last_seen', last_seen, 'age_seconds', round(extract(epoch from (now() - last_seen))::numeric, 1),
           'stopped', stopped_at is not null, 'running', stopped_at is null and last_seen > now() - interval '20 seconds', 'counters', counters) order by component, last_seen desc), '[]')
    into engines from engine_heartbeats where last_seen > now() - interval '1 hour';
  select exists (select 1 from engine_heartbeats where component = 'execution' and stopped_at is null and last_seen > now() - interval '20 seconds') into ex_ok;
  select exists (select 1 from engine_heartbeats where component = 'paper_feed' and stopped_at is null and last_seen > now() - interval '20 seconds') into fd_ok;
  select to_jsonb(f) - 'workspace_id' || jsonb_build_object('last_run_age_seconds', round(extract(epoch from (now() - f.last_run_at))::numeric, 1)) into feed from paper_feed_state f where f.workspace_id = p_ws;
  select coalesce(jsonb_object_agg(state, n), '{}') into byst from (select state, count(*) n from trade_intents where workspace_id = p_ws and environment = 'paper' group by state) s;
  select coalesce(jsonb_agg(jsonb_build_object('asset_id', a.id, 'symbol', a.symbol, 'decimals', a.decimals, 'sum_all_accounts', t.sum_all::text,
           'available', t.av::text, 'reserved', t.rs::text, 'external', t.ext::text) order by a.symbol), '[]') into led
    from (select asset_id, sum(balance) sum_all, coalesce(sum(balance) filter (where state = 'available'), 0) av,
                 coalesce(sum(balance) filter (where state = 'reserved'), 0) rs, coalesce(sum(balance) filter (where state = 'external'), 0) ext
            from ledger_accounts where workspace_id = p_ws and environment = 'paper' group by asset_id) t join assets a on a.id = t.asset_id;
  res := jsonb_build_object(
    'data_provenance', 'SYNTHETIC',
    'provenance_note', 'SYNTHETIC market data (seeded random generator). Paper PnL is meaningless as evidence of any edge.',
    'paper_running', ss.paper_running, 'global_state', ss.global_state,
    'execution_engine_running', ex_ok, 'feed_running', fd_ok,
    'verdict', case when ss.global_state <> 'active' then 'halted'
                    when not ss.paper_running then 'stopped'
                    when ex_ok and fd_ok then 'running'
                    when ex_ok then 'partial_feed_not_running'
                    else 'engine_not_running' end,
    'engines', engines, 'feed', feed, 'intents_by_state', byst,
    'intents_total', (select count(*) from trade_intents where workspace_id = p_ws and environment = 'paper'),
    'fills_total', (select count(*) from fills where workspace_id = p_ws and environment = 'paper'),
    'last_fill_at', (select max(created_at) from fills where workspace_id = p_ws and environment = 'paper'),
    'last_intent_at', (select max(created_at) from trade_intents where workspace_id = p_ws and environment = 'paper'),
    'settled_total', (select count(*) from trade_intents where workspace_id = p_ws and environment = 'paper' and state in ('RECONCILED','LEDGER_APPLIED','COMPOUNDING_ELIGIBLE')),
    'ledger', led,
    'conservation_ok', not exists (select 1 from ledger_accounts where workspace_id = p_ws and environment = 'paper' group by asset_id having sum(balance) <> 0));
  return res;
end $$;

revoke execute on function engine_heartbeat(text,text,int,text,timestamptz,jsonb,jsonb,boolean), create_signal_intent(uuid,uuid,uuid,uuid,uuid,text,numeric,numeric,text,text,jsonb),
  paper_settle_intent(uuid), api_paper_status(uuid) from public;
grant execute on function engine_heartbeat(text,text,int,text,timestamptz,jsonb,jsonb,boolean), create_signal_intent(uuid,uuid,uuid,uuid,uuid,text,numeric,numeric,text,text,jsonb),
  paper_settle_intent(uuid) to service_role;
grant execute on function api_paper_status(uuid) to authenticated, service_role;
