-- APEX 0200 (UI-capital): wallet lifecycle (pause/resume/archive/revoke/move bucket), family-specific address validation,
-- physical-segregation honesty. Every function is SECURITY DEFINER, role-checked (owner/admin) and audited.
-- Key material still has no column and no parameter anywhere: addresses are PUBLIC identifiers only.

-- 1) Structural address validation per chain family (checksum-level validation belongs to the chain packages).
create or replace function wallet_address_ok(p_family chain_family, p_addr text) returns boolean language sql immutable as $$
  select case
    when p_addr ~ '\s' or p_addr is null then false                                   -- a seed phrase contains whitespace; no family allows it
    when p_family = 'evm'     then p_addr ~ '^0x[0-9a-fA-F]{40}$'
    when p_family = 'svm'     then p_addr ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    when p_family = 'sui'     then p_addr ~ '^0x[0-9a-fA-F]{64}$'
    when p_family = 'aptos'   then p_addr ~ '^0x[0-9a-fA-F]{1,64}$'
    when p_family = 'tron'    then p_addr ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'
    when p_family = 'bitcoin' then p_addr ~ '^(bc1|tb1|BC1|TB1)[02-9ac-hj-np-zAC-HJ-NP-Z]{11,87}$' or p_addr ~ '^[13mn2][1-9A-HJ-NP-Za-km-z]{25,34}$'
    when p_family = 'cosmos'  then p_addr ~ '^[a-z]{2,20}1[02-9ac-hj-np-z]{38,58}$'
    when p_family = 'ton'     then p_addr ~ '^[EU][Qf][A-Za-z0-9_-]{46}$' or p_addr ~ '^-?[0-9]:[0-9a-fA-F]{64}$'
    when p_family = 'near'    then p_addr ~ '^[0-9a-f]{64}$' or p_addr ~ '^([a-z0-9]+[-_])*[a-z0-9]+(\.([a-z0-9]+[-_])*[a-z0-9]+)*$'
    when p_family = 'cex'     then p_addr ~ '^[A-Za-z0-9._:/@+-]{3,120}$'            -- opaque exchange sub-account reference, not a key
    else false end
$$;

create or replace function api_connect_wallet(ws uuid, p_nick text, p_family chain_family, p_address text, p_capability wallet_capability default 'watch_only', p_chains text[] default '{}')
returns uuid language plpgsql security definer set search_path = public as $$
declare wid uuid; c text; addr text := btrim(p_address);
begin
  perform assert_role(ws, array['owner','admin']::app_role[]);
  if p_capability = 'managed_signer' then raise exception 'managed signers are registered by the signer service with a KMS reference' using errcode='42501'; end if;
  if (p_family = 'cex') <> (p_capability in ('cex_view_only','cex_trade_only')) then
    raise exception 'capability % is not valid for family %', p_capability, p_family using errcode='P0001'; end if;
  if addr ~* '(seed|mnemonic|private|secret|passphrase)' or length(addr) > 120 or not wallet_address_ok(p_family, addr) then
    raise exception 'invalid public address for family % (or it looks like secret material; APEX never accepts keys or seed phrases)', p_family using errcode='P0001';
  end if;
  if p_family = 'evm' then addr := lower(addr); end if;                              -- one canonical form so the same EVM address cannot be registered twice
  insert into wallets(workspace_id, nickname, family, address, capability) values (ws, p_nick, p_family, addr, p_capability) returning id into wid;
  foreach c in array p_chains loop
    insert into wallet_chain_accounts(wallet_id, chain_id) select wid, id from chain_registry where id = c and family = p_family;
    if not found then raise exception 'chain % not in registry for family %', c, p_family using errcode='P0001'; end if;
  end loop;
  perform audit(ws, 'wallet.connect', 'wallets', wid::text, null, jsonb_build_object('family', p_family, 'capability', p_capability, 'chains', to_jsonb(p_chains)));
  return wid;
end $$;

-- 2) Only ACTIVE wallets can be assigned, allocated to or funded. Physical/protected buckets accept exclusive allocations only.
create or replace function wba_guard() returns trigger language plpgsql as $$
declare w wallets%rowtype; b buckets%rowtype;
begin
  select * into w from wallets where id = new.wallet_id; select * into b from buckets where id = new.bucket_id;
  if w.state <> 'active' then raise exception 'wallet is % and cannot be assigned to a bucket', w.state using errcode='P0001'; end if;
  if b.segregation in ('physical','protected') and not new.exclusive then
    raise exception 'a % bucket needs a dedicated (exclusive) wallet; shared wallets are logical separation only', b.segregation using errcode='P0001'; end if;
  return new;
end $$;
drop trigger if exists wba_guard_t on wallet_bucket_allocations;
create trigger wba_guard_t before insert on wallet_bucket_allocations for each row execute function wba_guard();

create or replace function api_allocate(ws uuid, p_bucket uuid, p_wca uuid, p_asset uuid, p_amount numeric, p_key text) returns uuid
language plpgsql security definer set search_path = public as $$
declare env environment; st text;
begin
  perform assert_role(ws, array['owner','admin']::app_role[]);
  select environment into env from buckets where id = p_bucket and workspace_id = ws;
  perform assert_env_writable(env);
  select w.state into st from wallet_chain_accounts x join wallets w on w.id = x.wallet_id where x.id = p_wca and w.workspace_id = ws;
  if st is distinct from 'active' then raise exception 'wallet is % ; allocations refused', coalesce(st, 'unknown') using errcode='P0001'; end if;
  return ledger_allocate(ws, env, p_bucket, p_wca, p_asset, p_amount, 'api:' || p_key);
end $$;

create or replace function api_paper_deposit(ws uuid, p_wca uuid, p_asset uuid, p_amount numeric, p_key text) returns uuid
language plpgsql security definer set search_path = public as $$
declare st text;
begin
  perform assert_role(ws, array['owner','admin']::app_role[]);
  select w.state into st from wallet_chain_accounts x join wallets w on w.id = x.wallet_id where x.id = p_wca and w.workspace_id = ws;
  if st is distinct from 'active' then raise exception 'wallet is % ; PAPER deposits refused', coalesce(st, 'unknown') using errcode='P0001'; end if;
  return ledger_deposit(ws, 'paper', p_wca, p_asset, p_amount, 'api:' || p_key);      -- users can only fund the PAPER environment
end $$;

-- 3) Lifecycle. revoke/archive refuse while the wallet has open reservations, in-flight funds or unconfirmed transfers.
create or replace function wallet_open_obligations(p_wallet uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'reservations', (select count(*) from capital_reservations r join wallet_chain_accounts x on x.id = r.wallet_chain_account_id where x.wallet_id = p_wallet and r.status = 'held'),
    'in_flight_accounts', (select count(*) from ledger_accounts a join wallet_chain_accounts x on x.id = a.wallet_chain_account_id
                            where x.wallet_id = p_wallet and a.state in ('reserved','pending_out','pending_bridge') and a.balance <> 0),
    'pending_transfers', (select count(*) from internal_transfers t join wallet_chain_accounts x on x.id in (t.src_wca, t.dst_wca)
                           where x.wallet_id = p_wallet and t.status in ('requested','pending_finality')))
$$;

create or replace function api_set_wallet_state(p_wallet uuid, p_state text, p_reason text) returns text
language plpgsql security definer set search_path = public as $$
declare w wallets%rowtype; o jsonb;
begin
  select * into w from wallets where id = p_wallet for update;
  if not found then raise exception 'wallet not found' using errcode='P0001'; end if;
  perform assert_role(w.workspace_id, array['owner','admin']::app_role[]);
  if p_state not in ('active','paused','archived','revoked') then raise exception 'bad wallet state' using errcode='P0001'; end if;
  if length(coalesce(btrim(p_reason),'')) < 3 then raise exception 'a reason (3+ characters) is required' using errcode='P0001'; end if;
  if w.state = p_state then return w.state; end if;
  if w.state in ('archived','revoked') then raise exception 'wallet is % (terminal); register a new wallet instead', w.state using errcode='P0001'; end if;
  if p_state in ('archived','revoked') then
    o := wallet_open_obligations(p_wallet);
    if (o->>'reservations')::int > 0 or (o->>'in_flight_accounts')::int > 0 or (o->>'pending_transfers')::int > 0 then
      raise exception 'wallet % refused: % open reservation(s), % in-flight balance(s), % unconfirmed transfer(s). Release or settle them first.',
        p_state, o->>'reservations', o->>'in_flight_accounts', o->>'pending_transfers' using errcode='P0001';
    end if;
  end if;
  update wallets set state = p_state where id = p_wallet;
  perform audit(w.workspace_id, 'wallet.' || case p_state when 'active' then 'resume' when 'paused' then 'pause' else p_state end, 'wallets', p_wallet::text, null,
                jsonb_build_object('from', w.state, 'to', p_state, 'reason', p_reason));
  return p_state;
end $$;

-- Move a wallet from one bucket to another. Refused while the wallet holds ledger balance / reservations for the OLD bucket:
-- funds must first be transferred (requestCapitalTransfer) so the ledger, not the UI, is the source of truth.
create or replace function api_move_wallet_bucket(p_wallet uuid, p_from uuid, p_to uuid, p_exclusive boolean default true, p_bps int default 10000, p_ack boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare w wallets%rowtype; bf buckets%rowtype; bt buckets%rowtype; n int;
begin
  select * into w from wallets where id = p_wallet for update; select * into bf from buckets where id = p_from; select * into bt from buckets where id = p_to;
  if w.id is null or bf.id is null or bt.id is null or w.workspace_id <> bf.workspace_id or w.workspace_id <> bt.workspace_id then raise exception 'wallet/bucket mismatch' using errcode='P0001'; end if;
  perform assert_role(w.workspace_id, array['owner','admin']::app_role[]);
  if bf.environment <> bt.environment then raise exception 'cannot move a wallet between paper and live buckets' using errcode='P0001'; end if;
  if p_from = p_to then raise exception 'source and destination are the same bucket' using errcode='P0001'; end if;
  if not exists (select 1 from wallet_bucket_allocations where wallet_id = p_wallet and bucket_id = p_from) then raise exception 'wallet is not assigned to the source bucket' using errcode='P0001'; end if;
  select count(*) into n from ledger_accounts a join wallet_chain_accounts x on x.id = a.wallet_chain_account_id
    where x.wallet_id = p_wallet and a.bucket_id = p_from and a.balance <> 0 and a.state not in ('external','equity','fees_expense');
  if n > 0 then raise exception 'wallet still holds ledger balance for the old bucket (% account(s)); transfer the funds out first', n using errcode='P0001'; end if;
  select count(*) into n from capital_reservations r join wallet_chain_accounts x on x.id = r.wallet_chain_account_id where x.wallet_id = p_wallet and r.bucket_id = p_from and r.status = 'held';
  if n > 0 then raise exception 'wallet has % open reservation(s) on the old bucket', n using errcode='P0001'; end if;
  delete from wallet_bucket_allocations where wallet_id = p_wallet and bucket_id = p_from;
  insert into wallet_bucket_allocations(wallet_id, bucket_id, exclusive, max_allocation_bps, logical_ack) values (p_wallet, p_to, p_exclusive, p_bps, p_ack);
  perform audit(w.workspace_id, 'wallet.move', 'wallets', p_wallet::text, bt.environment, jsonb_build_object('from', p_from, 'to', p_to, 'exclusive', p_exclusive));
end $$;

revoke execute on function wallet_address_ok(chain_family,text), wba_guard(), wallet_open_obligations(uuid), api_set_wallet_state(uuid,text,text),
  api_move_wallet_bucket(uuid,uuid,uuid,boolean,int,boolean), api_connect_wallet(uuid,text,chain_family,text,wallet_capability,text[]),
  api_allocate(uuid,uuid,uuid,uuid,numeric,text), api_paper_deposit(uuid,uuid,uuid,numeric,text) from public;
grant execute on function wallet_address_ok(chain_family,text), wallet_open_obligations(uuid), api_set_wallet_state(uuid,text,text), api_move_wallet_bucket(uuid,uuid,uuid,boolean,int,boolean),
  api_connect_wallet(uuid,text,chain_family,text,wallet_capability,text[]), api_allocate(uuid,uuid,uuid,uuid,numeric,text), api_paper_deposit(uuid,uuid,uuid,numeric,text) to authenticated, service_role;
grant execute on function wba_guard() to service_role;
