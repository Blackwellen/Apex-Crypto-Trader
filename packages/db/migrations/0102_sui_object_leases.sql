-- 0102: Sui owned-object (coin) leases so two concurrent orders can never select the same object (chains-A agent).
-- Hard guarantee: a partial UNIQUE index allows at most ONE live (held|expired) lease per (chain, object).
-- 'expired' leases keep blocking the object until reconciled against the chain (the tx may still have executed) -> fail closed.
-- sui_object_versions records the highest consumed version per object; candidates at or below it are STALE (version-lock awareness).
create table sui_object_versions (
  chain_id text not null, object_id text not null check (object_id ~ '^0x[0-9a-f]{64}$'),
  min_version bigint not null,                       -- versions <= min_version have been consumed
  updated_at timestamptz not null default now(),
  primary key (chain_id, object_id)
);
create table sui_object_leases (
  id uuid primary key default gen_random_uuid(),
  chain_id text not null,
  owner text not null check (owner ~ '^0x[0-9a-f]{64}$'),
  object_id text not null check (object_id ~ '^0x[0-9a-f]{64}$'),
  coin_type text not null,
  purpose text not null check (purpose in ('gas','input')),
  intent_id text not null check (length(intent_id) between 1 and 200),
  object_version bigint not null check (object_version >= 0),
  balance numeric(40,0) not null check (balance >= 0),
  state text not null default 'held' check (state in ('held','released','consumed','expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index sui_lease_live_uq on sui_object_leases(chain_id, object_id) where state in ('held','expired');
create index sui_lease_intent on sui_object_leases(chain_id, intent_id);

-- Lease a gas coin and/or input coins from a candidate list supplied by the caller (fresh RPC read).
-- p_candidates: [{"objectId":"0x..","version":"123","balance":"456","coinType":"0x2::sui::SUI"}, ...]
create or replace function sui_lease_coins(
  p_chain text, p_owner text, p_intent text, p_input_coin_type text, p_gas_need numeric, p_input_need numeric,
  p_candidates jsonb, p_ttl_seconds int default 120, p_max_input_objects int default 50
) returns setof sui_object_leases language plpgsql as $$
declare
  c record; gas_pick record; acc numeric := 0; n int := 0; picked uuid[] := '{}'; l sui_object_leases; existing int;
  gas_type constant text := '0x2::sui::SUI';
begin
  if p_gas_need is null or p_gas_need < 0 or p_input_need is null or p_input_need < 0 then raise exception 'bad_amount' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_chain || ':' || p_owner, 0));    -- serialise selection per (chain, owner)
  -- idempotent per intent
  select count(*) into existing from sui_object_leases where chain_id = p_chain and intent_id = p_intent and state = 'held';
  if existing > 0 then return query select * from sui_object_leases where chain_id = p_chain and intent_id = p_intent and state = 'held' order by purpose, object_id; return; end if;

  create temporary table if not exists _sui_avail (object_id text, version bigint, balance numeric, coin_type text) on commit drop;
  truncate _sui_avail;
  insert into _sui_avail
  select lower(x->>'objectId'), (x->>'version')::bigint, (x->>'balance')::numeric, x->>'coinType'
    from jsonb_array_elements(p_candidates) x
   where not exists (select 1 from sui_object_leases l2 where l2.chain_id = p_chain and l2.object_id = lower(x->>'objectId') and l2.state in ('held','expired'))
     and not exists (select 1 from sui_object_versions v where v.chain_id = p_chain and v.object_id = lower(x->>'objectId') and v.min_version >= (x->>'version')::bigint);

  if p_gas_need > 0 then
    select * into gas_pick from _sui_avail where coin_type = gas_type and balance >= p_gas_need order by balance asc, object_id asc limit 1;   -- best fit: keep large coins free
    if not found then raise exception 'insufficient_unleased_balance: gas coin >= % not available', p_gas_need using errcode = 'P0001'; end if;
    insert into sui_object_leases(chain_id, owner, object_id, coin_type, purpose, intent_id, object_version, balance, expires_at)
      values (p_chain, p_owner, gas_pick.object_id, gas_pick.coin_type, 'gas', p_intent, gas_pick.version, gas_pick.balance, now() + make_interval(secs => p_ttl_seconds))
      returning * into l;
    delete from _sui_avail where object_id = gas_pick.object_id;     -- a gas coin is never also an input
  end if;

  if p_input_need > 0 then
    -- single best-fit coin if one covers it, else largest-first accumulation (bounded)
    select * into c from _sui_avail where coin_type = p_input_coin_type and balance >= p_input_need order by balance asc, object_id asc limit 1;
    if found then
      insert into sui_object_leases(chain_id, owner, object_id, coin_type, purpose, intent_id, object_version, balance, expires_at)
        values (p_chain, p_owner, c.object_id, c.coin_type, 'input', p_intent, c.version, c.balance, now() + make_interval(secs => p_ttl_seconds));
      acc := c.balance;
    else
      for c in select * from _sui_avail where coin_type = p_input_coin_type order by balance desc, object_id asc loop
        exit when acc >= p_input_need or n >= p_max_input_objects;
        insert into sui_object_leases(chain_id, owner, object_id, coin_type, purpose, intent_id, object_version, balance, expires_at)
          values (p_chain, p_owner, c.object_id, c.coin_type, 'input', p_intent, c.version, c.balance, now() + make_interval(secs => p_ttl_seconds));
        acc := acc + c.balance; n := n + 1;
      end loop;
      if acc < p_input_need then raise exception 'insufficient_unleased_balance: input % needs % but only % available unleased', p_input_coin_type, p_input_need, acc using errcode = 'P0001'; end if;
    end if;
  end if;
  return query select * from sui_object_leases where chain_id = p_chain and intent_id = p_intent and state = 'held' order by purpose, object_id;
end $$;

-- the tx was never submitted: free the objects
create or replace function sui_lease_release(p_chain text, p_intent text) returns int language plpgsql as $$
declare n int;
begin
  update sui_object_leases set state = 'released', updated_at = now() where chain_id = p_chain and intent_id = p_intent and state = 'held';
  get diagnostics n = row_count; return n;
end $$;

-- the tx executed: the leased object VERSIONS are spent; later candidates at those versions are stale
create or replace function sui_lease_consume(p_chain text, p_intent text) returns int language plpgsql as $$
declare n int; r record;
begin
  for r in select * from sui_object_leases where chain_id = p_chain and intent_id = p_intent and state in ('held','expired') loop
    insert into sui_object_versions(chain_id, object_id, min_version) values (p_chain, r.object_id, r.object_version)
      on conflict (chain_id, object_id) do update set min_version = greatest(sui_object_versions.min_version, excluded.min_version), updated_at = now();
  end loop;
  update sui_object_leases set state = 'consumed', updated_at = now() where chain_id = p_chain and intent_id = p_intent and state in ('held','expired');
  get diagnostics n = row_count; return n;
end $$;

-- ttl passed without a known outcome: keep BLOCKING (the tx may have been executed) until resolved
create or replace function sui_lease_expire_due(p_chain text) returns int language plpgsql as $$
declare n int;
begin
  update sui_object_leases set state = 'expired', updated_at = now() where chain_id = p_chain and state = 'held' and expires_at < now();
  get diagnostics n = row_count; return n;
end $$;

-- reconciliation of an expired lease against the chain: 'unused' (object still at the leased version) frees it; 'consumed' burns the version
create or replace function sui_lease_resolve(p_lease uuid, p_outcome text) returns sui_object_leases language plpgsql as $$
declare r sui_object_leases;
begin
  select * into r from sui_object_leases where id = p_lease for update;
  if not found then raise exception 'unknown lease' using errcode = 'P0001'; end if;
  if r.state <> 'expired' then raise exception 'only expired leases are resolved, got %', r.state using errcode = 'P0001'; end if;
  if p_outcome = 'unused' then
    update sui_object_leases set state = 'released', updated_at = now() where id = p_lease returning * into r;
  elsif p_outcome = 'consumed' then
    insert into sui_object_versions(chain_id, object_id, min_version) values (r.chain_id, r.object_id, r.object_version)
      on conflict (chain_id, object_id) do update set min_version = greatest(sui_object_versions.min_version, excluded.min_version), updated_at = now();
    update sui_object_leases set state = 'consumed', updated_at = now() where id = p_lease returning * into r;
  else raise exception 'outcome must be unused|consumed' using errcode = 'P0001'; end if;
  return r;
end $$;
