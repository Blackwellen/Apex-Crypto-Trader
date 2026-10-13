-- APEX 0140: execution-service support (owned by services/execution). Additive only; the one replaced function
-- (advance_intent) is a strict superset of 0003's behaviour EXCEPT for the exit-while-halted case documented below.

-- 1) Immutable per-intent evaluation context (market snapshot the risk gate / economics engine saw).
--    Persisting it makes crash-recovery replay deterministic: re-evaluation never depends on wall-clock or live feeds.
create table intent_context (
  intent_id uuid primary key references trade_intents(id),
  workspace_id uuid not null,
  context jsonb not null,
  created_at timestamptz not null default now()
);
create trigger intent_context_immutable before update or delete on intent_context for each row execute function forbid_mutation();

-- 2) advance_intent: identical to 0003 except that, when global_state is not 'active', the ADMITTED transition is
--    still allowed for a RISK-REDUCING EXIT (a sell fully covered by the recorded position). Spec section 8:
--    "emergency/halt stops new entries; settlement and risk-reducing exits remain available".
--    (0003 refused every ADMITTED while halted, which would have blocked exits.)
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
  if p_to = 'CAPITAL_RESERVED' and i.reservation_id is null then raise exception 'reservation required' using errcode='P0001'; end if;
  if i.state = 'UNKNOWN' and p_to = 'SUBMITTING' then raise exception 'UNKNOWN orders require reconciliation before resubmission' using errcode='P0001'; end if;
  insert into order_events(intent_id, workspace_id, event_key, from_state, to_state, detail) values (p_intent, i.workspace_id, p_event_key, i.state, p_to, p_detail);
  update trade_intents set state = p_to, updated_at = now() where id = p_intent;
  return p_to;
end $$;

-- 3) reserve_for_intent: atomically reserve capital for an ADMITTED intent and attach the reservation.
--    Buy reserves quote asset (notional = quote budget incl. max fee); sell reserves the base asset (notional = qty).
--    Idempotent (reservation intent_key = 'intent:<id>'); charges the strategy budget when one exists.
create or replace function reserve_for_intent(p_intent uuid) returns uuid language plpgsql as $$
declare i trade_intents%rowtype; ast uuid; bid uuid; rid uuid;
begin
  select * into i from trade_intents where id = p_intent for update;
  if not found then raise exception 'intent not found' using errcode='P0001'; end if;
  if i.reservation_id is not null then return i.reservation_id; end if;
  if i.state not in ('ADMITTED','CAPITAL_RESERVED') then raise exception 'cannot reserve in state %', i.state using errcode='P0001'; end if;
  ast := case when i.side = 'buy' then i.quote_asset else i.base_asset end;
  select id into bid from strategy_capital_budgets where bucket_id = i.bucket_id and strategy_key = i.strategy_key and asset_id = ast;
  rid := reserve_capital(i.workspace_id, i.environment, i.bucket_id, i.wallet_chain_account_id, ast, i.notional, 'intent:' || i.id::text, bid);
  update trade_intents set reservation_id = rid, updated_at = now() where id = i.id;
  return rid;
end $$;

-- 4) apply_fill_checked: bounds cumulative fills by the reservation and by the intent quantity, then delegates to
--    apply_fill (idempotent per (intent, venue_fill_id)). apply_fill itself draws on the shared reserved account and
--    would otherwise let one intent consume another intent's reservation.
create or replace function apply_fill_checked(p_intent uuid, p_venue_fill_id text, p_qty numeric, p_quote numeric, p_fee numeric default 0) returns uuid
language plpgsql as $$
declare i trade_intents%rowtype; fid uuid; r capital_reservations%rowtype; spent numeric; filled numeric; delta numeric;
begin
  select * into i from trade_intents where id = p_intent for update;
  if not found then raise exception 'intent not found' using errcode='P0001'; end if;
  select id into fid from fills where intent_id = p_intent and venue_fill_id = p_venue_fill_id;
  if fid is not null then return fid; end if;                                   -- duplicate delivery: one economic fill
  if i.reservation_id is null then raise exception 'fill without reservation' using errcode='P0001'; end if;
  select * into r from capital_reservations where id = i.reservation_id;
  if r.status <> 'held' then raise exception 'reservation not held' using errcode='P0001'; end if;
  select coalesce(sum(qty),0), coalesce(sum(case when i.side='buy' then quote_amount + fee_quote else qty end),0) into filled, spent from fills where intent_id = p_intent;
  if filled + p_qty > i.quantity then raise exception 'fill exceeds intent quantity' using errcode='P0001'; end if;
  delta := (select case when i.side='buy' then p_quote + p_fee else p_qty end);
  if spent + delta > r.amount then raise exception 'fill exceeds reservation' using errcode='P0001'; end if;
  return apply_fill(p_intent, p_venue_fill_id, p_qty, p_quote, p_fee);
end $$;

-- 5) settle_intent_reservation: when an intent reaches FILLED/CANCELLED/EXPIRED/FAILED, return the unspent part of
--    its reservation to available and close the reservation. (release_reservation() in 0002 assumes nothing was
--    consumed via apply_fill, so calling it after fills would double-count.) Idempotent.
create or replace function settle_intent_reservation(p_intent uuid) returns void language plpgsql as $$
declare i trade_intents%rowtype; r capital_reservations%rowtype; ast uuid; consumed numeric; remainder numeric; av uuid; rs uuid;
begin
  select * into i from trade_intents where id = p_intent for update;
  if not found then raise exception 'intent not found' using errcode='P0001'; end if;
  if i.reservation_id is null then return; end if;
  select * into r from capital_reservations where id = i.reservation_id for update;
  if r.status <> 'held' then return; end if;
  if i.state not in ('FILLED','CANCELLED','EXPIRED','FAILED') then
    raise exception 'cannot settle reservation while intent is %', i.state using errcode='P0001';
  end if;
  ast := r.asset_id;
  select coalesce(sum(case when i.side='buy' then quote_amount + fee_quote else qty end),0) into consumed from fills where intent_id = p_intent;
  remainder := r.amount - consumed;
  if remainder < 0 then raise exception 'consumed more than reserved' using errcode='P0001'; end if;
  if remainder > 0 then
    av := ledger_account(r.workspace_id, r.environment, r.bucket_id, r.wallet_chain_account_id, ast, 'available');
    rs := ledger_account(r.workspace_id, r.environment, r.bucket_id, r.wallet_chain_account_id, ast, 'reserved');
    perform post_entry(r.workspace_id, r.environment, 'release', 'settle_release:' || r.id::text, jsonb_build_array(
      jsonb_build_object('account', rs, 'amount', (-remainder)::text), jsonb_build_object('account', av, 'amount', remainder::text)));
  end if;
  if r.budget_id is not null then
    update strategy_capital_budgets set reserved_amount = reserved_amount - r.amount, version = version + 1 where id = r.budget_id;
  end if;
  update capital_reservations set status = case when consumed > 0 then 'consumed' else 'released' end, settled_at = now() where id = r.id;
end $$;
