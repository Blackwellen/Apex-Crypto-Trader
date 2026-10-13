-- 0101: EVM per-(chain, signer) nonce reservation with row-lock serialisation (chains-A agent).
-- Invariants: (a) at most one non-released reservation per (chain, signer, nonce); (b) nonces are handed out contiguously
-- (released, never-broadcast nonces >= the chain floor are reused first); (c) reservations are idempotent per intent;
-- (d) replacement keeps the SAME nonce and requires both fee fields to rise by >= min bump (default 10%).
create table evm_nonce_state (
  chain_id   text not null,
  signer     text not null check (signer = lower(signer) and signer ~ '^0x[0-9a-f]{40}$'),
  next_nonce bigint not null check (next_nonce >= 0),
  chain_floor bigint not null default 0 check (chain_floor >= 0),   -- highest known on-chain (latest) nonce
  updated_at timestamptz not null default now(),
  primary key (chain_id, signer)
);

create table evm_nonce_reservations (
  id uuid primary key default gen_random_uuid(),
  chain_id text not null,
  signer text not null,
  nonce bigint not null check (nonce >= 0),
  intent_id text not null check (length(intent_id) between 1 and 200),
  state text not null default 'reserved' check (state in ('reserved','broadcast','confirmed','released')),
  tx_hash text,
  max_fee_per_gas numeric(78,0) check (max_fee_per_gas is null or max_fee_per_gas >= 0),
  max_priority_fee_per_gas numeric(78,0) check (max_priority_fee_per_gas is null or max_priority_fee_per_gas >= 0),
  replacement_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (chain_id, signer) references evm_nonce_state(chain_id, signer),
  constraint broadcast_has_fees check (state not in ('broadcast','confirmed') or (tx_hash is not null and max_fee_per_gas is not null and max_priority_fee_per_gas is not null)),
  constraint priority_le_max check (max_priority_fee_per_gas is null or max_fee_per_gas is null or max_priority_fee_per_gas <= max_fee_per_gas)
);
-- the hard guarantees (independent of the function): no duplicate nonce, no duplicate intent
create unique index evm_nonce_active_uq on evm_nonce_reservations(chain_id, signer, nonce) where state <> 'released';
create unique index evm_nonce_intent_uq on evm_nonce_reservations(chain_id, signer, intent_id) where state <> 'released';
create index evm_nonce_res_lookup on evm_nonce_reservations(chain_id, signer, state, nonce);

create table evm_nonce_attempts (   -- every tx hash ever broadcast for a reservation (replacements keep history)
  reservation_id uuid not null references evm_nonce_reservations(id) on delete cascade,
  attempt_no int not null,
  tx_hash text not null,
  max_fee_per_gas numeric(78,0) not null,
  max_priority_fee_per_gas numeric(78,0) not null,
  created_at timestamptz not null default now(),
  primary key (reservation_id, attempt_no)
);

-- Reserve the next nonce. p_chain_nonce = the node's pending/latest transaction count (lower bound / external-tx sync).
create or replace function evm_reserve_nonce(p_chain text, p_signer text, p_intent text, p_chain_nonce bigint default null, p_max_inflight int default 16)
returns evm_nonce_reservations language plpgsql as $$
declare st evm_nonce_state; r evm_nonce_reservations; n bigint; inflight int;
begin
  if p_signer <> lower(p_signer) then raise exception 'signer must be lowercase' using errcode = 'P0001'; end if;
  insert into evm_nonce_state(chain_id, signer, next_nonce, chain_floor) values (p_chain, p_signer, coalesce(p_chain_nonce, 0), coalesce(p_chain_nonce, 0))
    on conflict (chain_id, signer) do nothing;
  select * into st from evm_nonce_state where chain_id = p_chain and signer = p_signer for update;   -- serialisation point
  select * into r from evm_nonce_reservations where chain_id = p_chain and signer = p_signer and intent_id = p_intent and state <> 'released';
  if found then return r; end if;                                                                  -- idempotent
  if p_chain_nonce is not null and p_chain_nonce > st.next_nonce then
    update evm_nonce_state set next_nonce = p_chain_nonce, updated_at = now() where chain_id = p_chain and signer = p_signer;
    st.next_nonce := p_chain_nonce;
  end if;
  select count(*) into inflight from evm_nonce_reservations where chain_id = p_chain and signer = p_signer and state in ('reserved','broadcast');
  if inflight >= p_max_inflight then raise exception 'nonce_inflight_limit: % in flight for % %', inflight, p_chain, p_signer using errcode = 'P0001'; end if;
  -- gap fill: lowest released (never broadcast) nonce that is still >= the chain floor
  select * into r from evm_nonce_reservations
    where chain_id = p_chain and signer = p_signer and state = 'released' and nonce >= st.chain_floor and nonce < st.next_nonce
      and not exists (select 1 from evm_nonce_reservations x where x.chain_id = p_chain and x.signer = p_signer and x.nonce = evm_nonce_reservations.nonce and x.state <> 'released')
    order by nonce limit 1 for update;
  if found then
    update evm_nonce_reservations set state = 'reserved', intent_id = p_intent, tx_hash = null, max_fee_per_gas = null, max_priority_fee_per_gas = null,
      replacement_count = 0, updated_at = now() where id = r.id returning * into r;
    return r;
  end if;
  n := st.next_nonce;
  update evm_nonce_state set next_nonce = n + 1, updated_at = now() where chain_id = p_chain and signer = p_signer;
  insert into evm_nonce_reservations(chain_id, signer, nonce, intent_id) values (p_chain, p_signer, n, p_intent) returning * into r;
  return r;
end $$;

create or replace function evm_nonce_mark_broadcast(p_id uuid, p_tx_hash text, p_max_fee numeric, p_priority numeric)
returns evm_nonce_reservations language plpgsql as $$
declare r evm_nonce_reservations;
begin
  select * into r from evm_nonce_reservations where id = p_id for update;
  if not found then raise exception 'unknown reservation' using errcode = 'P0001'; end if;
  if r.state <> 'reserved' then raise exception 'mark_broadcast requires state reserved, got %', r.state using errcode = 'P0001'; end if;
  update evm_nonce_reservations set state = 'broadcast', tx_hash = p_tx_hash, max_fee_per_gas = p_max_fee, max_priority_fee_per_gas = p_priority, updated_at = now()
    where id = p_id returning * into r;
  insert into evm_nonce_attempts(reservation_id, attempt_no, tx_hash, max_fee_per_gas, max_priority_fee_per_gas) values (p_id, 0, p_tx_hash, p_max_fee, p_priority);
  return r;
end $$;

-- Replacement: same nonce, both fee fields must rise by >= p_min_bump_bps (ceil). Underpriced replacements are rejected.
create or replace function evm_nonce_replace(p_id uuid, p_max_fee numeric, p_priority numeric, p_tx_hash text, p_min_bump_bps int default 1000)
returns evm_nonce_reservations language plpgsql as $$
declare r evm_nonce_reservations; need_fee numeric; need_prio numeric; a int;
begin
  select * into r from evm_nonce_reservations where id = p_id for update;
  if not found then raise exception 'unknown reservation' using errcode = 'P0001'; end if;
  if r.state <> 'broadcast' then raise exception 'replace requires state broadcast, got %', r.state using errcode = 'P0001'; end if;
  need_fee  := r.max_fee_per_gas + ceil(r.max_fee_per_gas * p_min_bump_bps / 10000.0);
  need_prio := r.max_priority_fee_per_gas + ceil(r.max_priority_fee_per_gas * p_min_bump_bps / 10000.0);
  if p_max_fee < need_fee or p_priority < need_prio then
    raise exception 'replacement_underpriced: need maxFee>=% priority>=% (got % / %)', need_fee, need_prio, p_max_fee, p_priority using errcode = 'P0001';
  end if;
  if exists (select 1 from evm_nonce_attempts where reservation_id = p_id and tx_hash = p_tx_hash) then raise exception 'replacement reuses an existing tx hash' using errcode = 'P0001'; end if;
  select coalesce(max(attempt_no), -1) + 1 into a from evm_nonce_attempts where reservation_id = p_id;
  update evm_nonce_reservations set tx_hash = p_tx_hash, max_fee_per_gas = p_max_fee, max_priority_fee_per_gas = p_priority,
    replacement_count = replacement_count + 1, updated_at = now() where id = p_id returning * into r;
  insert into evm_nonce_attempts(reservation_id, attempt_no, tx_hash, max_fee_per_gas, max_priority_fee_per_gas) values (p_id, a, p_tx_hash, p_max_fee, p_priority);
  return r;
end $$;

-- confirm: the winning hash must be one of the attempts (a replaced-out hash may be the one that mined)
create or replace function evm_nonce_confirm(p_id uuid, p_tx_hash text)
returns evm_nonce_reservations language plpgsql as $$
declare r evm_nonce_reservations;
begin
  select * into r from evm_nonce_reservations where id = p_id for update;
  if not found then raise exception 'unknown reservation' using errcode = 'P0001'; end if;
  if r.state = 'confirmed' and r.tx_hash = p_tx_hash then return r; end if;
  if r.state <> 'broadcast' then raise exception 'confirm requires state broadcast, got %', r.state using errcode = 'P0001'; end if;
  if not exists (select 1 from evm_nonce_attempts where reservation_id = p_id and tx_hash = p_tx_hash) then raise exception 'hash is not an attempt of this reservation' using errcode = 'P0001'; end if;
  update evm_nonce_reservations set state = 'confirmed', tx_hash = p_tx_hash, updated_at = now() where id = p_id returning * into r;
  return r;
end $$;

-- release is ONLY legal for a never-broadcast reservation; a broadcast nonce must be replaced/cancelled on-chain instead
create or replace function evm_nonce_release(p_id uuid)
returns evm_nonce_reservations language plpgsql as $$
declare r evm_nonce_reservations;
begin
  select * into r from evm_nonce_reservations where id = p_id for update;
  if not found then raise exception 'unknown reservation' using errcode = 'P0001'; end if;
  if r.state = 'released' then return r; end if;
  if r.state <> 'reserved' then raise exception 'cannot release a % nonce (it may be in the mempool); replace or cancel on-chain', r.state using errcode = 'P0001'; end if;
  update evm_nonce_reservations set state = 'released', updated_at = now() where id = p_id returning * into r;
  return r;
end $$;

-- reconcile with the chain's confirmed (latest) transaction count: everything below it is consumed
create or replace function evm_nonce_reconcile(p_chain text, p_signer text, p_chain_nonce bigint)
returns int language plpgsql as $$
declare st evm_nonce_state; n int;
begin
  select * into st from evm_nonce_state where chain_id = p_chain and signer = p_signer for update;
  if not found then return 0; end if;
  update evm_nonce_state set chain_floor = greatest(chain_floor, p_chain_nonce), next_nonce = greatest(next_nonce, p_chain_nonce), updated_at = now()
    where chain_id = p_chain and signer = p_signer;
  update evm_nonce_reservations set state = 'released', updated_at = now()
    where chain_id = p_chain and signer = p_signer and state = 'reserved' and nonce < p_chain_nonce;
  update evm_nonce_reservations set state = 'confirmed', updated_at = now()
    where chain_id = p_chain and signer = p_signer and state = 'broadcast' and nonce < p_chain_nonce;
  get diagnostics n = row_count;
  return n;
end $$;
