-- APEX 0003: strategies, trade intents, order state machine, risk decisions, fills, positions, live gates.

create table strategy_definitions (
  key text not null,
  version int not null,
  name text not null,
  stage text not null default 'research' check (stage in ('research','paper','live_candidate','retired')),
  spot_only boolean not null default true check (spot_only),     -- UK policy: no derivatives actionable
  allowed_families chain_family[] not null default '{}',
  evidence jsonb not null default '{}'::jsonb,
  primary key (key, version)
);

create table required_gates (gate_key text primary key, priority text not null default 'P0', description text not null);
insert into required_gates(gate_key, description) values
 ('ledger_conservation','Wallet/chain/bucket balance conservation with 100 competing spends'),
 ('protected_vault','Trading signer unable to move protected vault assets'),
 ('key_custody','No raw key entry; audited KMS/MPC or external signing'),
 ('wallet_authority','Scoped transaction/withdrawal policy and audited revocation'),
 ('duplicate_trade_prevention','Crash/replay yields one economic fill per intent'),
 ('exchange_unknown_outcomes','Timeout never retries before authoritative reconciliation'),
 ('onchain_finality','Reorg/blockhash/IBC timeout tests; pending funds unavailable'),
 ('portfolio_risk_veto','Parent limits cannot be weakened by strategy or AI'),
 ('emergency_stop','Stops new entries; retains settlement and risk-reducing supervision'),
 ('quote_economics','Fees/slippage/exit capacity invalidate unprofitable orders'),
 ('suspicious_token_checks','Contract and sell-path simulation reject known scam cases'),
 ('regulated_product_scope','UK-accessible spot venue/product checks'),
 ('environment_isolation','Paper fills can never affect a real wallet'),
 ('external_security_review','Independent security review complete'),
 ('incident_runbook','Incident runbook exists and drilled'),
 ('venue_chain_certification','Each execution-capable chain/venue certified');

create table deployment_gates (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  gate_key text not null references required_gates(gate_key),
  status text not null default 'NOT_RUN' check (status in ('PASS','FAIL','BLOCKED','NOT_RUN')),
  evidence_ref text,
  commit_sha text,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, gate_key),
  constraint pass_needs_evidence check (status <> 'PASS' or (evidence_ref is not null and commit_sha is not null))
);
create table workspace_settings (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  live_opt_in boolean not null default false,          -- explicit user opt-in
  live_feature_flag boolean not null default false,     -- operator flag
  global_state text not null default 'active' check (global_state in ('active','halt_new_entries','exit_only','emergency_stopped')),
  global_limits jsonb not null default '{"max_order_notional_bps_of_bucket":2500,"max_slippage_bps":100,"max_quote_age_ms":2000}',
  updated_at timestamptz not null default now()
);
create or replace function live_allowed(ws uuid) returns boolean language sql stable as $$
  select coalesce((select s.live_opt_in and s.live_feature_flag and s.global_state = 'active' from workspace_settings s where s.workspace_id = ws), false)
     and not exists (select 1 from required_gates g left join deployment_gates d on d.gate_key = g.gate_key and d.workspace_id = ws
                      where coalesce(d.status,'NOT_RUN') <> 'PASS')
$$;

create table trade_intents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  environment environment not null,
  bucket_id uuid not null references buckets(id),
  strategy_key text not null,
  strategy_version int not null default 1,
  wallet_chain_account_id uuid not null references wallet_chain_accounts(id),
  base_asset uuid not null references assets(id),
  quote_asset uuid not null references assets(id),
  side text not null check (side in ('buy','sell')),
  quantity numeric(78,0) not null check (quantity > 0),        -- base units of base asset
  limit_price numeric(40,18),                                    -- quote units per whole base (decimal, for display/checks only)
  notional numeric(78,0) not null check (notional > 0),          -- quote base units budgeted (buy) or base units sold (sell)
  state text not null default 'SIGNAL',
  reservation_id uuid references capital_reservations(id),
  idempotency_key text not null,
  venue text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);
create index on trade_intents (workspace_id, state);

-- live intents are impossible unless every gate passes (DB-level guard, independent of app flags)
create or replace function guard_live_intent() returns trigger language plpgsql as $$
begin
  if new.environment = 'live' and not live_allowed(new.workspace_id) then
    raise exception 'LIVE EXECUTION DISABLED: deployment gates not all PASS or opt-in/flag missing' using errcode='P0001';
  end if;
  return new;
end $$;
create trigger trade_intents_live_guard before insert on trade_intents for each row execute function guard_live_intent();

create table allowed_transitions (from_state text not null, to_state text not null, primary key (from_state, to_state));
insert into allowed_transitions values
 ('SIGNAL','CANDIDATE'),('CANDIDATE','RISK_EVALUATING'),('RISK_EVALUATING','ADMITTED'),('RISK_EVALUATING','FAILED'),
 ('ADMITTED','CAPITAL_RESERVED'),('ADMITTED','FAILED'),('CAPITAL_RESERVED','QUOTED'),('CAPITAL_RESERVED','FAILED'),
 ('QUOTED','PREPARED'),('QUOTED','EXPIRED'),('QUOTED','FAILED'),('PREPARED','APPROVAL_WAIT'),('PREPARED','SUBMITTING'),('PREPARED','FAILED'),
 ('APPROVAL_WAIT','SUBMITTING'),('APPROVAL_WAIT','CANCELLED'),('APPROVAL_WAIT','EXPIRED'),
 ('SUBMITTING','ACKNOWLEDGED'),('SUBMITTING','UNKNOWN'),('SUBMITTING','FAILED'),
 ('UNKNOWN','ACKNOWLEDGED'),('UNKNOWN','FAILED'),('UNKNOWN','CANCELLED'),('UNKNOWN','FILLED'),('UNKNOWN','PARTIALLY_FILLED'),   -- only reached via reconciliation
 ('ACKNOWLEDGED','PARTIALLY_FILLED'),('ACKNOWLEDGED','FILLED'),('ACKNOWLEDGED','CANCELLED'),('ACKNOWLEDGED','EXPIRED'),('ACKNOWLEDGED','FAILED'),
 ('PARTIALLY_FILLED','PARTIALLY_FILLED'),('PARTIALLY_FILLED','FILLED'),('PARTIALLY_FILLED','CANCELLED'),
 ('FILLED','SETTLING'),('CANCELLED','SETTLING'),('EXPIRED','SETTLING'),('FAILED','SETTLING'),
 ('SETTLING','FINAL'),('SETTLING','REORGED'),('SETTLING','DISPUTED'),('REORGED','SETTLING'),('DISPUTED','SETTLING'),
 ('FINAL','RECONCILED'),('RECONCILED','LEDGER_APPLIED'),('LEDGER_APPLIED','COMPOUNDING_ELIGIBLE');

create table order_events (
  id bigint generated always as identity primary key,
  intent_id uuid not null references trade_intents(id),
  workspace_id uuid not null,
  event_key text not null,                   -- idempotency for at-least-once delivery
  from_state text not null,
  to_state text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (intent_id, event_key)
);
create trigger order_events_immutable before update or delete on order_events for each row execute function forbid_mutation();

create table risk_decisions (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid not null references trade_intents(id),
  workspace_id uuid not null,
  decision text not null check (decision in ('ADMIT','VETO')),
  reasons jsonb not null default '[]'::jsonb,
  policy_version int not null,
  evaluator text not null default 'risk-service',
  created_at timestamptz not null default now()
);

-- advance_intent: the ONLY way to change an intent's state. Typed, transactional, idempotent, replay-safe.
create or replace function advance_intent(p_intent uuid, p_to text, p_event_key text, p_detail jsonb default '{}') returns text
language plpgsql as $$
declare i trade_intents%rowtype; ss workspace_settings%rowtype;
begin
  select * into i from trade_intents where id = p_intent for update;
  if not found then raise exception 'intent not found' using errcode='P0001'; end if;
  if exists (select 1 from order_events where intent_id = p_intent and event_key = p_event_key) then return i.state; end if;   -- duplicate delivery
  if not exists (select 1 from allowed_transitions where from_state = i.state and to_state = p_to) then
    raise exception 'illegal transition % -> %', i.state, p_to using errcode='P0001';
  end if;
  -- independent risk veto: ADMITTED requires an ADMIT decision and no VETO for this intent
  if p_to = 'ADMITTED' then
    if not exists (select 1 from risk_decisions where intent_id = p_intent and decision = 'ADMIT')
       or exists (select 1 from risk_decisions where intent_id = p_intent and decision = 'VETO') then
      raise exception 'risk gate: no ADMIT decision (or VETO present)' using errcode='P0001';
    end if;
    select * into ss from workspace_settings where workspace_id = i.workspace_id;
    if ss.global_state <> 'active' then raise exception 'global state % refuses new entries', ss.global_state using errcode='P0001'; end if;
  end if;
  if p_to = 'CAPITAL_RESERVED' and i.reservation_id is null then raise exception 'reservation required' using errcode='P0001'; end if;
  -- unknown outcomes must be reconciled, never blindly resubmitted
  if i.state = 'UNKNOWN' and p_to = 'SUBMITTING' then raise exception 'UNKNOWN orders require reconciliation before resubmission' using errcode='P0001'; end if;
  insert into order_events(intent_id, workspace_id, event_key, from_state, to_state, detail) values (p_intent, i.workspace_id, p_event_key, i.state, p_to, p_detail);
  update trade_intents set state = p_to, updated_at = now() where id = p_intent;
  return p_to;
end $$;

create table fills (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid not null references trade_intents(id),
  workspace_id uuid not null,
  environment environment not null,
  venue_fill_id text not null,
  qty numeric(78,0) not null check (qty > 0),         -- base asset units
  quote_amount numeric(78,0) not null check (quote_amount > 0),
  fee_quote numeric(78,0) not null default 0 check (fee_quote >= 0),
  created_at timestamptz not null default now(),
  unique (intent_id, venue_fill_id)                    -- duplicate fill delivery is a no-op: one economic fill per exchange fill
);

create table positions (
  bucket_id uuid not null references buckets(id),
  wallet_chain_account_id uuid not null references wallet_chain_accounts(id),
  base_asset uuid not null references assets(id),
  quote_asset uuid not null references assets(id),
  environment environment not null,
  qty numeric(78,0) not null default 0 check (qty >= 0),
  cost_basis_quote numeric(78,0) not null default 0 check (cost_basis_quote >= 0),
  realized_pnl_quote numeric(78,0) not null default 0,
  primary key (bucket_id, wallet_chain_account_id, base_asset, quote_asset)
);

create table profit_eligibility_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  environment environment not null,
  bucket_id uuid not null references buckets(id),
  intent_id uuid not null references trade_intents(id) unique,
  quote_asset uuid not null references assets(id),
  realized_net_quote numeric(78,0) not null,
  eligible boolean not null default false,             -- true only when intent is at/after RECONCILED
  created_at timestamptz not null default now()
);

-- apply_fill: idempotent per (intent, venue_fill_id). Consumes the reservation proportionally and credits the
-- acquired asset (buy) or quote proceeds (sell); updates position average cost and realised PnL.
create or replace function apply_fill(p_intent uuid, p_venue_fill_id text, p_qty numeric, p_quote numeric, p_fee numeric default 0) returns uuid
language plpgsql as $$
declare i trade_intents%rowtype; fid uuid; wca uuid; res capital_reservations%rowtype;
  q_res uuid; q_ext uuid; q_fee uuid; b_ext uuid; b_av uuid; q_av uuid; pos positions%rowtype; cost_part numeric; pnl numeric;
begin
  select * into i from trade_intents where id = p_intent for update;
  if not found then raise exception 'intent not found' using errcode='P0001'; end if;
  select id into fid from fills where intent_id = p_intent and venue_fill_id = p_venue_fill_id;
  if fid is not null then return fid; end if;
  if i.state not in ('ACKNOWLEDGED','PARTIALLY_FILLED','UNKNOWN') then raise exception 'cannot fill intent in state %', i.state using errcode='P0001'; end if;
  insert into fills(intent_id, workspace_id, environment, venue_fill_id, qty, quote_amount, fee_quote) values (p_intent, i.workspace_id, i.environment, p_venue_fill_id, p_qty, p_quote, p_fee) returning id into fid;
  wca := i.wallet_chain_account_id;
  q_ext := ledger_account(i.workspace_id, i.environment, i.bucket_id, null, i.quote_asset, 'external');
  b_ext := ledger_account(i.workspace_id, i.environment, i.bucket_id, null, i.base_asset, 'external');
  b_av  := ledger_account(i.workspace_id, i.environment, i.bucket_id, wca, i.base_asset, 'available');
  q_av  := ledger_account(i.workspace_id, i.environment, i.bucket_id, wca, i.quote_asset, 'available');
  q_fee := ledger_account(i.workspace_id, i.environment, i.bucket_id, null, i.quote_asset, 'fees_expense');
  insert into positions(bucket_id, wallet_chain_account_id, base_asset, quote_asset, environment) values (i.bucket_id, wca, i.base_asset, i.quote_asset, i.environment) on conflict do nothing;
  select * into pos from positions where bucket_id=i.bucket_id and wallet_chain_account_id=wca and base_asset=i.base_asset and quote_asset=i.quote_asset for update;
  select * into res from capital_reservations where id = i.reservation_id for update;
  if i.side = 'buy' then
    -- spend (quote + fee) out of the reserved account; acquired base lands in available
    q_res := ledger_account(i.workspace_id, i.environment, i.bucket_id, wca, i.quote_asset, 'reserved');
    perform post_entry(i.workspace_id, i.environment, 'fill_buy', 'fill:' || fid, jsonb_build_array(
      jsonb_build_object('account', q_res, 'amount', (-(p_quote + p_fee))::text),
      jsonb_build_object('account', q_ext, 'amount', p_quote::text),
      jsonb_build_object('account', q_fee, 'amount', p_fee::text),
      jsonb_build_object('account', b_ext, 'amount', (-p_qty)::text),
      jsonb_build_object('account', b_av, 'amount', p_qty::text)), null, jsonb_build_object('fill', fid));
    update positions set qty = qty + p_qty, cost_basis_quote = cost_basis_quote + p_quote + p_fee
     where bucket_id=i.bucket_id and wallet_chain_account_id=wca and base_asset=i.base_asset and quote_asset=i.quote_asset;
  else
    if pos.qty < p_qty then raise exception 'sell exceeds position' using errcode='P0001'; end if;
    q_res := ledger_account(i.workspace_id, i.environment, i.bucket_id, wca, i.base_asset, 'reserved');
    perform post_entry(i.workspace_id, i.environment, 'fill_sell', 'fill:' || fid, jsonb_build_array(
      jsonb_build_object('account', q_res, 'amount', (-p_qty)::text),
      jsonb_build_object('account', b_ext, 'amount', p_qty::text),
      jsonb_build_object('account', q_ext, 'amount', (-p_quote)::text),
      jsonb_build_object('account', q_av, 'amount', (p_quote - p_fee)::text),
      jsonb_build_object('account', q_fee, 'amount', p_fee::text)), null, jsonb_build_object('fill', fid));
    cost_part := div(pos.cost_basis_quote * p_qty, pos.qty);                      -- exact: truncation favours conservative (lower) cost removal
    pnl := (p_quote - p_fee) - cost_part;
    update positions set qty = qty - p_qty, cost_basis_quote = cost_basis_quote - cost_part, realized_pnl_quote = realized_pnl_quote + pnl
     where bucket_id=i.bucket_id and wallet_chain_account_id=wca and base_asset=i.base_asset and quote_asset=i.quote_asset;
    insert into profit_eligibility_events(workspace_id, environment, bucket_id, intent_id, quote_asset, realized_net_quote)
      values (i.workspace_id, i.environment, i.bucket_id, i.id, i.quote_asset, pnl)
      on conflict (intent_id) do update set realized_net_quote = profit_eligibility_events.realized_net_quote + excluded.realized_net_quote;
  end if;
  return fid;
end $$;

create table emergency_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  scope text not null check (scope in ('GLOBAL','BUCKET','WALLET','CHAIN','STRATEGY','VENUE')),
  scope_id text,
  action text not null check (action in ('HALT_NEW_ENTRIES','EXIT_ONLY','CANCEL_SAFE_ORDERS','REDUCE_POSITION','DISABLE_WALLET','DISABLE_CHAIN','DISABLE_STRATEGY','DISABLE_VENUE','ALL_NONESSENTIAL_PAUSE','MANUAL_ESCALATION','EMERGENCY_STOP')),
  actor uuid,
  reason text,
  created_at timestamptz not null default now()
);
-- Emergency/halt: stops NEW entries only; settlement + exit paths (advance to SETTLING/FINAL..., sells) remain available.
create or replace function set_global_state(ws uuid, st text, why text) returns void language plpgsql as $$
begin
  if st not in ('active','halt_new_entries','exit_only','emergency_stopped') then raise exception 'bad state' using errcode='P0001'; end if;
  update workspace_settings set global_state = st, updated_at = now() where workspace_id = ws;
  insert into emergency_actions(workspace_id, scope, action, actor, reason)
    values (ws, 'GLOBAL', case st when 'halt_new_entries' then 'HALT_NEW_ENTRIES' when 'exit_only' then 'EXIT_ONLY' when 'emergency_stopped' then 'EMERGENCY_STOP' else 'MANUAL_ESCALATION' end, auth.uid(), why);
  perform audit(ws, 'global_state.' || st, 'workspace_settings', ws::text, null, jsonb_build_object('reason', why));
end $$;
