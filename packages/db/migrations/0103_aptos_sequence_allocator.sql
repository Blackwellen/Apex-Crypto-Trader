-- 0103: Aptos per-(chain, account) sequence-number reservation (chains-A agent). Same pattern as EVM nonces (0101).
-- Aptos requires strictly sequential sequence numbers per account; a gap stalls all later transactions.
create table aptos_sequence_state (
  chain_id text not null,
  account text not null check (account ~ '^0x[0-9a-f]{64}$'),
  next_seq bigint not null check (next_seq >= 0),
  chain_floor bigint not null default 0 check (chain_floor >= 0),   -- on-chain account sequence_number (next expected)
  updated_at timestamptz not null default now(),
  primary key (chain_id, account)
);
create table aptos_sequence_reservations (
  id uuid primary key default gen_random_uuid(),
  chain_id text not null, account text not null,
  seq bigint not null check (seq >= 0),
  intent_id text not null check (length(intent_id) between 1 and 200),
  state text not null default 'reserved' check (state in ('reserved','broadcast','committed','released')),
  tx_hash text,
  gas_unit_price numeric(20,0) check (gas_unit_price is null or gas_unit_price >= 0),
  max_gas_amount numeric(20,0) check (max_gas_amount is null or max_gas_amount >= 0),
  expiration_timestamp_secs bigint,
  replacement_count int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (chain_id, account) references aptos_sequence_state(chain_id, account),
  constraint aptos_broadcast_complete check (state not in ('broadcast','committed') or (tx_hash is not null and gas_unit_price is not null and max_gas_amount is not null and expiration_timestamp_secs is not null))
);
create unique index aptos_seq_active_uq on aptos_sequence_reservations(chain_id, account, seq) where state <> 'released';
create unique index aptos_seq_intent_uq on aptos_sequence_reservations(chain_id, account, intent_id) where state <> 'released';
create table aptos_sequence_attempts (
  reservation_id uuid not null references aptos_sequence_reservations(id) on delete cascade,
  attempt_no int not null, tx_hash text not null, gas_unit_price numeric(20,0) not null, expiration_timestamp_secs bigint not null,
  created_at timestamptz not null default now(), primary key (reservation_id, attempt_no)
);

create or replace function aptos_reserve_sequence(p_chain text, p_account text, p_intent text, p_chain_seq bigint default null, p_max_inflight int default 16)
returns aptos_sequence_reservations language plpgsql as $$
declare st aptos_sequence_state; r aptos_sequence_reservations; n bigint; inflight int;
begin
  insert into aptos_sequence_state(chain_id, account, next_seq, chain_floor) values (p_chain, p_account, coalesce(p_chain_seq, 0), coalesce(p_chain_seq, 0)) on conflict (chain_id, account) do nothing;
  select * into st from aptos_sequence_state where chain_id = p_chain and account = p_account for update;   -- serialisation point
  select * into r from aptos_sequence_reservations where chain_id = p_chain and account = p_account and intent_id = p_intent and state <> 'released';
  if found then return r; end if;
  if p_chain_seq is not null and p_chain_seq > st.next_seq then
    update aptos_sequence_state set next_seq = p_chain_seq, updated_at = now() where chain_id = p_chain and account = p_account; st.next_seq := p_chain_seq;
  end if;
  select count(*) into inflight from aptos_sequence_reservations where chain_id = p_chain and account = p_account and state in ('reserved','broadcast');
  if inflight >= p_max_inflight then raise exception 'sequence_inflight_limit: % in flight', inflight using errcode = 'P0001'; end if;
  select * into r from aptos_sequence_reservations
    where chain_id = p_chain and account = p_account and state = 'released' and seq >= st.chain_floor and seq < st.next_seq
    order by seq limit 1 for update;
  if found then
    update aptos_sequence_reservations set state = 'reserved', intent_id = p_intent, tx_hash = null, gas_unit_price = null, max_gas_amount = null,
      expiration_timestamp_secs = null, replacement_count = 0, updated_at = now() where id = r.id returning * into r;
    return r;
  end if;
  n := st.next_seq;
  update aptos_sequence_state set next_seq = n + 1, updated_at = now() where chain_id = p_chain and account = p_account;
  insert into aptos_sequence_reservations(chain_id, account, seq, intent_id) values (p_chain, p_account, n, p_intent) returning * into r;
  return r;
end $$;

create or replace function aptos_sequence_mark_broadcast(p_id uuid, p_tx_hash text, p_gas_unit_price numeric, p_max_gas numeric, p_expiration bigint)
returns aptos_sequence_reservations language plpgsql as $$
declare r aptos_sequence_reservations;
begin
  select * into r from aptos_sequence_reservations where id = p_id for update;
  if not found then raise exception 'unknown reservation' using errcode = 'P0001'; end if;
  if r.state <> 'reserved' then raise exception 'mark_broadcast requires state reserved, got %', r.state using errcode = 'P0001'; end if;
  update aptos_sequence_reservations set state = 'broadcast', tx_hash = p_tx_hash, gas_unit_price = p_gas_unit_price, max_gas_amount = p_max_gas,
    expiration_timestamp_secs = p_expiration, updated_at = now() where id = p_id returning * into r;
  insert into aptos_sequence_attempts(reservation_id, attempt_no, tx_hash, gas_unit_price, expiration_timestamp_secs) values (p_id, 0, p_tx_hash, p_gas_unit_price, p_expiration);
  return r;
end $$;

-- replacement keeps the SAME sequence number; policy: gas_unit_price must rise by >= p_min_bump_bps (ceil) and the new expiration must be later
create or replace function aptos_sequence_replace(p_id uuid, p_gas_unit_price numeric, p_max_gas numeric, p_tx_hash text, p_expiration bigint, p_min_bump_bps int default 1000)
returns aptos_sequence_reservations language plpgsql as $$
declare r aptos_sequence_reservations; need numeric; a int;
begin
  select * into r from aptos_sequence_reservations where id = p_id for update;
  if not found then raise exception 'unknown reservation' using errcode = 'P0001'; end if;
  if r.state <> 'broadcast' then raise exception 'replace requires state broadcast, got %', r.state using errcode = 'P0001'; end if;
  need := r.gas_unit_price + ceil(r.gas_unit_price * p_min_bump_bps / 10000.0);
  if p_gas_unit_price < need then raise exception 'replacement_underpriced: need gas_unit_price>=% (got %)', need, p_gas_unit_price using errcode = 'P0001'; end if;
  if p_expiration <= r.expiration_timestamp_secs then raise exception 'replacement_expiration_not_later' using errcode = 'P0001'; end if;
  if exists (select 1 from aptos_sequence_attempts where reservation_id = p_id and tx_hash = p_tx_hash) then raise exception 'replacement reuses an existing tx hash' using errcode = 'P0001'; end if;
  select coalesce(max(attempt_no), -1) + 1 into a from aptos_sequence_attempts where reservation_id = p_id;
  update aptos_sequence_reservations set tx_hash = p_tx_hash, gas_unit_price = p_gas_unit_price, max_gas_amount = p_max_gas, expiration_timestamp_secs = p_expiration,
    replacement_count = replacement_count + 1, updated_at = now() where id = p_id returning * into r;
  insert into aptos_sequence_attempts(reservation_id, attempt_no, tx_hash, gas_unit_price, expiration_timestamp_secs) values (p_id, a, p_tx_hash, p_gas_unit_price, p_expiration);
  return r;
end $$;

create or replace function aptos_sequence_commit(p_id uuid, p_tx_hash text)
returns aptos_sequence_reservations language plpgsql as $$
declare r aptos_sequence_reservations;
begin
  select * into r from aptos_sequence_reservations where id = p_id for update;
  if not found then raise exception 'unknown reservation' using errcode = 'P0001'; end if;
  if r.state = 'committed' and r.tx_hash = p_tx_hash then return r; end if;
  if r.state <> 'broadcast' then raise exception 'commit requires state broadcast, got %', r.state using errcode = 'P0001'; end if;
  if not exists (select 1 from aptos_sequence_attempts where reservation_id = p_id and tx_hash = p_tx_hash) then raise exception 'hash is not an attempt of this reservation' using errcode = 'P0001'; end if;
  update aptos_sequence_reservations set state = 'committed', tx_hash = p_tx_hash, updated_at = now() where id = p_id returning * into r;
  return r;
end $$;

create or replace function aptos_sequence_release(p_id uuid)
returns aptos_sequence_reservations language plpgsql as $$
declare r aptos_sequence_reservations;
begin
  select * into r from aptos_sequence_reservations where id = p_id for update;
  if not found then raise exception 'unknown reservation' using errcode = 'P0001'; end if;
  if r.state = 'released' then return r; end if;
  if r.state <> 'reserved' then raise exception 'cannot release a % sequence number (it may be in mempool); replace or let it expire first', r.state using errcode = 'P0001'; end if;
  update aptos_sequence_reservations set state = 'released', updated_at = now() where id = p_id returning * into r;
  return r;
end $$;

-- reconcile against the on-chain account sequence_number (= next expected). Lower reservations are consumed.
create or replace function aptos_sequence_reconcile(p_chain text, p_account text, p_chain_seq bigint)
returns int language plpgsql as $$
declare st aptos_sequence_state; n int;
begin
  select * into st from aptos_sequence_state where chain_id = p_chain and account = p_account for update;
  if not found then return 0; end if;
  update aptos_sequence_state set chain_floor = greatest(chain_floor, p_chain_seq), next_seq = greatest(next_seq, p_chain_seq), updated_at = now() where chain_id = p_chain and account = p_account;
  update aptos_sequence_reservations set state = 'released', updated_at = now() where chain_id = p_chain and account = p_account and state = 'reserved' and seq < p_chain_seq;
  update aptos_sequence_reservations set state = 'committed', updated_at = now() where chain_id = p_chain and account = p_account and state = 'broadcast' and seq < p_chain_seq;
  get diagnostics n = row_count; return n;
end $$;
