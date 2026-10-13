-- APEX 0244 (UI-trading range): order cancel wrapper, manual PAPER order ticket, optional per-fill economics columns.

-- 1) Optional per-fill telemetry. NULL means "not recorded" and the console renders an em dash. Nothing in this migration writes them;
--    the execution service may populate them when it measures them.
alter table fills
  add column expected_slippage_bps int,
  add column realised_slippage_bps int,
  add column gas_native numeric(78,0) check (gas_native is null or gas_native >= 0),
  add column priority_fee_native numeric(78,0) check (priority_fee_native is null or priority_fee_native >= 0);

-- 2) Cancelling an intent BEFORE it is submitted is a legal state-machine move. (0003 only allowed CANCELLED from APPROVAL_WAIT / UNKNOWN / ACKNOWLEDGED /
--    PARTIALLY_FILLED.) Nothing at or after SUBMITTING is added: an in-flight or UNKNOWN order can only be resolved by reconciliation.
insert into allowed_transitions values
 ('SIGNAL','CANCELLED'),('CANDIDATE','CANCELLED'),('RISK_EVALUATING','CANCELLED'),('ADMITTED','CANCELLED'),('CAPITAL_RESERVED','CANCELLED'),('QUOTED','CANCELLED'),('PREPARED','CANCELLED')
on conflict do nothing;

create or replace function api_cancel_intent(p_intent uuid, p_reason text default null) returns text
language plpgsql security definer set search_path = public as $$
declare i trade_intents%rowtype; r text;
begin
  select * into i from trade_intents where id = p_intent for update;           -- same lock advance_intent takes: a racing SUBMITTING wins or loses atomically
  if not found then raise exception 'intent not found' using errcode='P0001'; end if;
  perform assert_role(i.workspace_id, array['owner','admin','trader']::app_role[]);
  if i.state = 'CANCELLED' and exists (select 1 from order_events where intent_id = i.id and event_key = 'console:cancel') then return 'CANCELLED'; end if;
  if i.state not in ('SIGNAL','CANDIDATE','RISK_EVALUATING','ADMITTED','CAPITAL_RESERVED','QUOTED','PREPARED','APPROVAL_WAIT') then
    raise exception 'cannot cancel an intent in state % (only intents before SUBMITTING; UNKNOWN orders await reconciliation and are never retried or cancelled blindly)', i.state using errcode='P0001';
  end if;
  r := advance_intent(i.id, 'CANCELLED', 'console:cancel', jsonb_build_object('reason', left(coalesce(p_reason,'cancelled from console'),200), 'actor', auth.uid()));
  -- return any held reservation (idempotent; function ships with the execution service migration 0140)
  if i.reservation_id is not null and to_regproc('settle_intent_reservation(uuid)') is not null then
    execute 'select settle_intent_reservation($1)' using i.id;
  end if;
  perform audit(i.workspace_id, 'intent.cancel', 'trade_intents', i.id::text, i.environment, jsonb_build_object('from', i.state, 'reason', p_reason));
  return r;
end $$;

-- 3) Manual PAPER order ticket. Inserts the intent and moves it to RISK_EVALUATING ONLY. It never writes a risk decision, never reserves capital and never
--    advances past RISK_EVALUATING: the independent risk service must ADMIT (advance_intent enforces it) and the execution service reserves. If the risk
--    service is down the intent simply waits. Preconditions below only refuse tickets that could never be reserved.
create or replace function api_create_paper_intent(p_ws uuid, p_bucket uuid, p_wca uuid, p_base uuid, p_quote uuid, p_side text, p_qty numeric, p_notional numeric,
  p_limit_price numeric, p_strategy text, p_key text) returns uuid
language plpgsql security definer set search_path = public as $$
declare b buckets%rowtype; v_id uuid; gs text; avail numeric; need numeric; chain_a text; chain_b text; chain_w text; ikey text := 'console:' || p_key;
begin
  perform assert_role(p_ws, array['owner','admin','trader']::app_role[]);
  select i.id into v_id from trade_intents i where i.workspace_id = p_ws and i.idempotency_key = ikey;
  if found then return v_id; end if;
  select * into b from buckets where id = p_bucket and workspace_id = p_ws;
  if not found then raise exception 'bucket not found in this workspace' using errcode='P0001'; end if;
  if b.environment <> 'paper' then raise exception 'the order ticket creates PAPER intents only' using errcode='P0001'; end if;
  if b.kind <> 'trading' or b.state <> 'active' then raise exception 'bucket must be an active trading bucket (is % / %)', b.kind, b.state using errcode='P0001'; end if;
  if p_side not in ('buy','sell') then raise exception 'side must be buy or sell' using errcode='P0001'; end if;
  if p_qty is null or p_qty <= 0 or p_notional is null or p_notional <= 0 then raise exception 'quantity and notional must be positive base-unit integers' using errcode='P0001'; end if;
  if p_qty <> trunc(p_qty) or p_notional <> trunc(p_notional) then raise exception 'amounts must be integer base units' using errcode='P0001'; end if;
  if p_base = p_quote then raise exception 'base and quote asset must differ' using errcode='P0001'; end if;
  if p_strategy !~ '^[a-z0-9_.]{3,80}$' then raise exception 'bad strategy key' using errcode='P0001'; end if;
  select global_state into gs from workspace_settings where workspace_id = p_ws;
  if gs <> 'active' and p_side = 'buy' then raise exception 'global state % refuses new entries', gs using errcode='P0001'; end if;
  select w.id::text, x.chain_id into chain_w, chain_a from wallet_chain_accounts x join wallets w on w.id = x.wallet_id
   where x.id = p_wca and w.workspace_id = p_ws and w.state = 'active'
     and exists (select 1 from wallet_bucket_allocations a where a.wallet_id = w.id and a.bucket_id = p_bucket);
  if chain_w is null then raise exception 'wallet account is not an active wallet allocated to this bucket' using errcode='P0001'; end if;
  select chain_id into chain_b from assets where id = p_base;
  if chain_b is distinct from chain_a or (select chain_id from assets where id = p_quote) is distinct from chain_a then
    raise exception 'both assets must live on the wallet account''s chain (%)', chain_a using errcode='P0001'; end if;
  select coalesce(sum(balance),0) into avail from ledger_accounts
   where workspace_id = p_ws and environment = 'paper' and bucket_id = p_bucket and wallet_chain_account_id = p_wca and state = 'available'
     and asset_id = case when p_side = 'buy' then p_quote else p_base end;
  need := (case when p_side = 'buy' then p_notional else p_qty end);
  if avail < need then
    raise exception 'insufficient available balance in the bucket to reserve for this ticket' using errcode='P0001'; end if;
  insert into trade_intents(workspace_id, environment, bucket_id, strategy_key, wallet_chain_account_id, base_asset, quote_asset, side, quantity, limit_price, notional, idempotency_key, venue)
    values (p_ws, 'paper', p_bucket, p_strategy, p_wca, p_base, p_quote, p_side, p_qty, p_limit_price, p_notional, ikey, 'paper-sim') returning trade_intents.id into v_id;
  perform advance_intent(v_id, 'CANDIDATE', 'console:candidate', jsonb_build_object('source', 'console_order_ticket', 'actor', auth.uid()));
  perform advance_intent(v_id, 'RISK_EVALUATING', 'console:risk_evaluating', jsonb_build_object('note', 'awaiting independent risk decision; this ticket cannot bypass risk'));
  perform audit(p_ws, 'intent.paper_create', 'trade_intents', v_id::text, 'paper', jsonb_build_object('side', p_side, 'bucket', p_bucket, 'strategy', p_strategy));
  return v_id;
end $$;

revoke execute on function api_cancel_intent(uuid,text), api_create_paper_intent(uuid,uuid,uuid,uuid,uuid,text,numeric,numeric,numeric,text,text) from public;
grant execute on function api_cancel_intent(uuid,text), api_create_paper_intent(uuid,uuid,uuid,uuid,uuid,text,numeric,numeric,numeric,text,text) to authenticated, service_role;
