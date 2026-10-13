-- APEX 0002: authoritative double-entry ledger, reservations, transfers, vault.
-- Invariants enforced by the database itself (not by application code):
--   I1  every ledger entry balances to zero per asset (deferred constraint trigger + function check)
--   I2  no non-contra account balance can go negative (CHECK) -> concurrent overspend is impossible
--   I3  postings never mix environments (paper can never touch live accounts)
--   I4  ledger_entries/postings are append-only; idempotency keys make replays no-ops
--   I5  only `available` accounts are reservable -> vault/pending/restricted funds never spendable

create table ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  environment environment not null,
  bucket_id uuid references buckets(id),                       -- null = wallet-level unassigned pool or external/equity
  wallet_chain_account_id uuid references wallet_chain_accounts(id),
  asset_id uuid not null references assets(id),
  state account_state not null,
  balance numeric(78,0) not null default 0,
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  constraint non_negative check (state in ('external','equity','fees_expense') or balance >= 0)
);
create unique index ledger_accounts_scope on ledger_accounts
  (workspace_id, environment, coalesce(bucket_id,'00000000-0000-0000-0000-000000000000'),
   coalesce(wallet_chain_account_id,'00000000-0000-0000-0000-000000000000'), asset_id, state);
create index on ledger_accounts (workspace_id, bucket_id);

create table ledger_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  environment environment not null,
  kind text not null,
  idempotency_key text not null,
  payload_hash text not null,
  memo text,
  ref jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);
create table ledger_postings (
  id bigint generated always as identity primary key,
  entry_id uuid not null references ledger_entries(id),
  account_id uuid not null references ledger_accounts(id),
  asset_id uuid not null references assets(id),
  amount numeric(78,0) not null check (amount <> 0)
);
create index on ledger_postings (entry_id);
create index on ledger_postings (account_id);
create trigger ledger_entries_immutable before update or delete on ledger_entries for each row execute function forbid_mutation();
create trigger ledger_postings_immutable before update or delete on ledger_postings for each row execute function forbid_mutation();

-- apply posting to balance (row lock on the account serialises competing spends) and enforce I3
create or replace function ledger_apply_posting() returns trigger language plpgsql as $$
declare acc ledger_accounts%rowtype; ent_env environment;
begin
  select environment into ent_env from ledger_entries where id = new.entry_id;
  update ledger_accounts set balance = balance + new.amount, version = version + 1
   where id = new.account_id returning * into acc;
  if acc.environment <> ent_env then
    raise exception 'environment mismatch: account % is %, entry is %', acc.id, acc.environment, ent_env using errcode='P0001';
  end if;
  if acc.asset_id <> new.asset_id then
    raise exception 'asset mismatch on posting' using errcode='P0001';
  end if;
  return new;
end $$;
create trigger ledger_postings_apply after insert on ledger_postings for each row execute function ledger_apply_posting();

create or replace function ledger_check_zero_sum() returns trigger language plpgsql as $$
begin
  if exists (select 1 from ledger_postings where entry_id = new.entry_id group by asset_id having sum(amount) <> 0) then
    raise exception 'ledger entry % does not balance to zero per asset', new.entry_id using errcode='P0001';
  end if;
  return null;
end $$;
create constraint trigger ledger_postings_zero_sum after insert on ledger_postings
  deferrable initially deferred for each row execute function ledger_check_zero_sum();

-- get-or-create an account for a scope
create or replace function ledger_account(ws uuid, env environment, bkt uuid, wca uuid, ast uuid, st account_state) returns uuid
language plpgsql as $$
declare aid uuid;
begin
  select id into aid from ledger_accounts where workspace_id=ws and environment=env
     and coalesce(bucket_id,'00000000-0000-0000-0000-000000000000')=coalesce(bkt,'00000000-0000-0000-0000-000000000000')
     and coalesce(wallet_chain_account_id,'00000000-0000-0000-0000-000000000000')=coalesce(wca,'00000000-0000-0000-0000-000000000000')
     and asset_id=ast and state=st;
  if aid is not null then return aid; end if;
  insert into ledger_accounts(workspace_id, environment, bucket_id, wallet_chain_account_id, asset_id, state)
  values (ws, env, bkt, wca, ast, st)
  on conflict do nothing;
  select id into aid from ledger_accounts where workspace_id=ws and environment=env
     and coalesce(bucket_id,'00000000-0000-0000-0000-000000000000')=coalesce(bkt,'00000000-0000-0000-0000-000000000000')
     and coalesce(wallet_chain_account_id,'00000000-0000-0000-0000-000000000000')=coalesce(wca,'00000000-0000-0000-0000-000000000000')
     and asset_id=ast and state=st;
  return aid;
end $$;

-- post_entry: postings is [{"account": uuid, "amount": "123"}...]. Idempotent by (workspace, key).
-- Same key + same payload => returns original entry (no new postings). Same key + different payload => error.
create or replace function post_entry(ws uuid, env environment, p_kind text, p_key text, postings jsonb, p_memo text default null, p_ref jsonb default '{}')
returns uuid language plpgsql as $$
declare eid uuid; h text; p record; acc ledger_accounts%rowtype;
begin
  if jsonb_typeof(postings) <> 'array' or jsonb_array_length(postings) < 2 then raise exception 'entry needs >= 2 postings' using errcode='P0001'; end if;
  h := encode(digest(p_kind || '|' || (select jsonb_agg(x order by x->>'account', x->>'amount')::text from jsonb_array_elements(postings) x), 'sha256'), 'hex');
  select id into eid from ledger_entries where workspace_id = ws and idempotency_key = p_key;
  if eid is not null then
    if (select payload_hash from ledger_entries where id = eid) <> h then
      raise exception 'idempotency key % reused with different payload', p_key using errcode='P0001';
    end if;
    return eid;
  end if;
  begin
    insert into ledger_entries(workspace_id, environment, kind, idempotency_key, payload_hash, memo, ref, created_by)
    values (ws, env, p_kind, p_key, h, p_memo, p_ref, auth.uid()) returning id into eid;
  exception when unique_violation then
    select id into eid from ledger_entries where workspace_id = ws and idempotency_key = p_key;
    return eid;                                             -- lost the race to an identical request
  end;
  -- insert in account-id order => consistent lock order => no deadlocks between competing entries
  for p in select (x->>'account')::uuid as account, (x->>'amount')::numeric as amount
           from jsonb_array_elements(postings) x order by (x->>'account')::uuid loop
    select * into acc from ledger_accounts where id = p.account and workspace_id = ws;
    if not found then raise exception 'account % not in workspace', p.account using errcode='P0001'; end if;
    insert into ledger_postings(entry_id, account_id, asset_id, amount) values (eid, p.account, acc.asset_id, p.amount);
  end loop;
  if exists (select 1 from ledger_postings where entry_id = eid group by asset_id having sum(amount) <> 0) then
    raise exception 'ledger entry does not balance' using errcode='P0001';
  end if;
  return eid;
end $$;

-- Funding: external deposit confirmed on-chain -> wallet-level unassigned pool (reconciled holdings)
create or replace function ledger_deposit(ws uuid, env environment, wca uuid, ast uuid, amt numeric, p_key text, p_ref jsonb default '{}') returns uuid
language plpgsql as $$
declare ext uuid; pool uuid;
begin
  if amt <= 0 then raise exception 'amount must be positive' using errcode='P0001'; end if;
  ext := ledger_account(ws, env, null, null, ast, 'external');
  pool := ledger_account(ws, env, null, wca, ast, 'available');
  return post_entry(ws, env, 'deposit', p_key, jsonb_build_array(
     jsonb_build_object('account', ext, 'amount', (-amt)::text), jsonb_build_object('account', pool, 'amount', amt::text)), null, p_ref);
end $$;

-- Allocate wallet pool -> bucket available. Bucket must be same environment/workspace and not a vault.
create or replace function ledger_allocate(ws uuid, env environment, bkt uuid, wca uuid, ast uuid, amt numeric, p_key text) returns uuid
language plpgsql as $$
declare b buckets%rowtype; wid uuid; pool uuid; dst uuid; alloc wallet_bucket_allocations%rowtype;
begin
  select * into b from buckets where id = bkt and workspace_id = ws;
  if not found or b.environment <> env then raise exception 'bucket not found in environment' using errcode='P0001'; end if;
  select wallet_id into wid from wallet_chain_accounts where id = wca;
  select * into alloc from wallet_bucket_allocations where wallet_id = wid and bucket_id = bkt;
  if not found then raise exception 'wallet is not assigned to bucket' using errcode='P0001'; end if;
  pool := ledger_account(ws, env, null, wca, ast, 'available');
  dst  := ledger_account(ws, env, bkt, wca, ast, (case when b.kind='protected_vault' then 'vault' else 'available' end)::account_state);
  return post_entry(ws, env, 'allocate', p_key, jsonb_build_array(
     jsonb_build_object('account', pool, 'amount', (-amt)::text), jsonb_build_object('account', dst, 'amount', amt::text)));
end $$;

-- Strategy budgets and reservations ---------------------------------------------------------
create table strategy_capital_budgets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  bucket_id uuid not null references buckets(id) on delete cascade,
  strategy_key text not null,
  asset_id uuid not null references assets(id),
  limit_amount numeric(78,0) not null check (limit_amount >= 0),
  reserved_amount numeric(78,0) not null default 0,
  version int not null default 1,
  unique (bucket_id, strategy_key, asset_id),
  constraint budget_not_exceeded check (reserved_amount >= 0 and reserved_amount <= limit_amount)
);

create table capital_reservations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  environment environment not null,
  bucket_id uuid not null references buckets(id),
  wallet_chain_account_id uuid not null references wallet_chain_accounts(id),
  asset_id uuid not null references assets(id),
  budget_id uuid references strategy_capital_budgets(id),
  amount numeric(78,0) not null check (amount > 0),
  status text not null default 'held' check (status in ('held','consumed','released')),
  intent_key text not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (workspace_id, intent_key)
);
create index on capital_reservations (bucket_id, status);

-- reserve_capital: atomic, idempotent by intent_key. Moves available -> reserved and charges the strategy budget.
create or replace function reserve_capital(ws uuid, env environment, bkt uuid, wca uuid, ast uuid, amt numeric, p_intent text, p_budget uuid default null)
returns uuid language plpgsql as $$
declare b buckets%rowtype; rid uuid; av uuid; rs uuid;
begin
  if amt <= 0 then raise exception 'amount must be positive' using errcode='P0001'; end if;
  select id into rid from capital_reservations where workspace_id = ws and intent_key = p_intent;
  if rid is not null then return rid; end if;                              -- idempotent replay
  select * into b from buckets where id = bkt and workspace_id = ws for share;
  if not found or b.environment <> env then raise exception 'bucket not found in environment' using errcode='P0001'; end if;
  if b.kind = 'protected_vault' or b.segregation = 'protected' then raise exception 'protected vault funds are never reservable' using errcode='P0001'; end if;
  if b.state <> 'active' then raise exception 'bucket is % ; new capital reservations refused', b.state using errcode='P0001'; end if;
  av := ledger_account(ws, env, bkt, wca, ast, 'available');
  rs := ledger_account(ws, env, bkt, wca, ast, 'reserved');
  begin
    -- everything inside this block (budget charge + reservation row + postings) is atomic; a concurrent identical
    -- intent_key loses on the unique index, is rolled back as a unit, and returns the winner's reservation.
    insert into capital_reservations(workspace_id, environment, bucket_id, wallet_chain_account_id, asset_id, budget_id, amount, intent_key)
      values (ws, env, bkt, wca, ast, p_budget, amt, p_intent) returning id into rid;
    if p_budget is not null then
      update strategy_capital_budgets set reserved_amount = reserved_amount + amt, version = version + 1
       where id = p_budget and bucket_id = bkt and asset_id = ast;           -- CHECK(reserved<=limit) blocks overspend
      if not found then raise exception 'budget not found' using errcode='P0001'; end if;
    end if;
    perform post_entry(ws, env, 'reserve', 'reserve:' || p_intent, jsonb_build_array(
       jsonb_build_object('account', av, 'amount', (-amt)::text), jsonb_build_object('account', rs, 'amount', amt::text)),
       null, jsonb_build_object('reservation', rid));
  exception when unique_violation then
    select id into rid from capital_reservations where workspace_id = ws and intent_key = p_intent;
    if rid is null then raise; end if;
  end;
  return rid;
end $$;

-- release (unused part) or consume (spent) a reservation; idempotent.
create or replace function release_reservation(p_reservation uuid, p_consume numeric default 0) returns void
language plpgsql as $$
declare r capital_reservations%rowtype; av uuid; rs uuid; ex uuid; back numeric;
begin
  select * into r from capital_reservations where id = p_reservation for update;
  if not found then raise exception 'reservation not found' using errcode='P0001'; end if;
  if r.status <> 'held' then return; end if;
  if p_consume < 0 or p_consume > r.amount then raise exception 'consume out of range' using errcode='P0001'; end if;
  back := r.amount - p_consume;
  av := ledger_account(r.workspace_id, r.environment, r.bucket_id, r.wallet_chain_account_id, r.asset_id, 'available');
  rs := ledger_account(r.workspace_id, r.environment, r.bucket_id, r.wallet_chain_account_id, r.asset_id, 'reserved');
  if back > 0 then
    perform post_entry(r.workspace_id, r.environment, 'release', 'release:' || r.id, jsonb_build_array(
       jsonb_build_object('account', rs, 'amount', (-back)::text), jsonb_build_object('account', av, 'amount', back::text)));
  end if;
  if p_consume > 0 then
    ex := ledger_account(r.workspace_id, r.environment, r.bucket_id, null, r.asset_id, 'external');   -- value left the bucket (spent into the trade)
    perform post_entry(r.workspace_id, r.environment, 'consume', 'consume:' || r.id, jsonb_build_array(
       jsonb_build_object('account', rs, 'amount', (-p_consume)::text), jsonb_build_object('account', ex, 'amount', p_consume::text)));
  end if;
  if r.budget_id is not null then
    update strategy_capital_budgets set reserved_amount = reserved_amount - r.amount, version = version + 1 where id = r.budget_id;
  end if;
  update capital_reservations set status = case when p_consume > 0 then 'consumed' else 'released' end, settled_at = now() where id = r.id;
end $$;

-- Transfers: logical = single atomic entry; physical = pending_out until finality -------------
create table internal_transfers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  environment environment not null,
  kind text not null check (kind in ('logical','physical')),
  src_bucket uuid not null references buckets(id),
  src_wca uuid not null references wallet_chain_accounts(id),
  dst_bucket uuid not null references buckets(id),
  dst_wca uuid not null references wallet_chain_accounts(id),
  asset_id uuid not null references assets(id),
  amount numeric(78,0) not null check (amount > 0),
  fee_amount numeric(78,0) not null default 0 check (fee_amount >= 0),
  status text not null default 'requested' check (status in ('requested','pending_finality','confirmed','failed')),
  idempotency_key text not null,
  tx_ref text,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

create or replace function request_transfer(ws uuid, env environment, sb uuid, sw uuid, db uuid, dw uuid, ast uuid, amt numeric, p_key text, p_fee numeric default 0)
returns uuid language plpgsql as $$
declare tid uuid; kind_ text; sbk buckets%rowtype; dbk buckets%rowtype; src_av uuid; src_po uuid; dst_av uuid;
begin
  select id into tid from internal_transfers where workspace_id = ws and idempotency_key = p_key;
  if tid is not null then return tid; end if;
  select * into sbk from buckets where id = sb and workspace_id = ws;
  select * into dbk from buckets where id = db and workspace_id = ws;
  if sbk.id is null or dbk.id is null or sbk.environment <> env or dbk.environment <> env then raise exception 'bucket/environment mismatch' using errcode='P0001'; end if;
  if sbk.kind = 'protected_vault' then raise exception 'use vault release workflow for protected funds' using errcode='P0001'; end if;
  if not exists (select 1 from wallet_bucket_allocations a join wallet_chain_accounts w on w.wallet_id = a.wallet_id where w.id = sw and a.bucket_id = sb)
     or not exists (select 1 from wallet_bucket_allocations a join wallet_chain_accounts w on w.wallet_id = a.wallet_id where w.id = dw and a.bucket_id = db) then
    raise exception 'wallet not assigned to bucket' using errcode='P0001';
  end if;
  kind_ := case when sw = dw then 'logical' else 'physical' end;
  insert into internal_transfers(workspace_id, environment, kind, src_bucket, src_wca, dst_bucket, dst_wca, asset_id, amount, fee_amount, idempotency_key, created_by, status)
    values (ws, env, kind_, sb, sw, db, dw, ast, amt, p_fee, p_key, auth.uid(), case when kind_='logical' then 'confirmed' else 'pending_finality' end) returning id into tid;
  src_av := ledger_account(ws, env, sb, sw, ast, 'available');
  if kind_ = 'logical' then
    -- same wallet: both ledger accounts move atomically in one entry; no on-chain movement
    dst_av := ledger_account(ws, env, db, dw, ast, 'available');
    perform post_entry(ws, env, 'transfer_logical', 'xfer:' || tid, jsonb_build_array(
       jsonb_build_object('account', src_av, 'amount', (-amt)::text), jsonb_build_object('account', dst_av, 'amount', amt::text)));
  else
    -- different wallet: source funds become pending_out immediately; destination NOT credited until finality
    src_po := ledger_account(ws, env, sb, sw, ast, 'pending_out');
    perform post_entry(ws, env, 'transfer_pending', 'xfer:' || tid, jsonb_build_array(
       jsonb_build_object('account', src_av, 'amount', (-(amt + p_fee))::text), jsonb_build_object('account', src_po, 'amount', (amt + p_fee)::text)));
  end if;
  return tid;
end $$;

create or replace function confirm_transfer(p_transfer uuid, p_tx_ref text) returns void language plpgsql as $$
declare t internal_transfers%rowtype; po uuid; dst uuid; fx uuid;
begin
  select * into t from internal_transfers where id = p_transfer for update;
  if t.status = 'confirmed' then return; end if;
  if t.status <> 'pending_finality' then raise exception 'transfer is %', t.status using errcode='P0001'; end if;
  po := ledger_account(t.workspace_id, t.environment, t.src_bucket, t.src_wca, t.asset_id, 'pending_out');
  dst := ledger_account(t.workspace_id, t.environment, t.dst_bucket, t.dst_wca, t.asset_id, 'available');
  fx := ledger_account(t.workspace_id, t.environment, t.src_bucket, null, t.asset_id, 'fees_expense');
  perform post_entry(t.workspace_id, t.environment, 'transfer_confirm', 'xfer-confirm:' || t.id,
     jsonb_build_array(jsonb_build_object('account', po, 'amount', (-(t.amount + t.fee_amount))::text),
                       jsonb_build_object('account', dst, 'amount', t.amount::text))
     || case when t.fee_amount > 0 then jsonb_build_array(jsonb_build_object('account', fx, 'amount', t.fee_amount::text)) else '[]'::jsonb end,
     null, jsonb_build_object('tx', p_tx_ref));
  update internal_transfers set status = 'confirmed', tx_ref = p_tx_ref where id = t.id;
end $$;

-- failed transfer: reservation is returned to source (NOT recreated independently)
create or replace function fail_transfer(p_transfer uuid) returns void language plpgsql as $$
declare t internal_transfers%rowtype; po uuid; av uuid;
begin
  select * into t from internal_transfers where id = p_transfer for update;
  if t.status = 'failed' then return; end if;
  if t.status <> 'pending_finality' then raise exception 'transfer is %', t.status using errcode='P0001'; end if;
  po := ledger_account(t.workspace_id, t.environment, t.src_bucket, t.src_wca, t.asset_id, 'pending_out');
  av := ledger_account(t.workspace_id, t.environment, t.src_bucket, t.src_wca, t.asset_id, 'available');
  perform post_entry(t.workspace_id, t.environment, 'transfer_fail', 'xfer-fail:' || t.id, jsonb_build_array(
     jsonb_build_object('account', po, 'amount', (-(t.amount + t.fee_amount))::text), jsonb_build_object('account', av, 'amount', (t.amount + t.fee_amount)::text)));
  update internal_transfers set status = 'failed' where id = t.id;
end $$;

-- Protected vault release: needs an approved, delay-elapsed approval request ---------------
create table approval_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('vault_release','permission_increase','deployment_gate','capital_transfer')),
  subject jsonb not null,
  requested_by uuid not null,
  approved_by uuid,
  status text not null default 'pending' check (status in ('pending','approved','rejected','executed')),
  not_before timestamptz not null default now() + interval '24 hours',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint approver_differs check (approved_by is null or approved_by <> requested_by or kind = 'deployment_gate')
);

create or replace function release_vault(p_approval uuid, p_key text) returns uuid language plpgsql as $$
declare a approval_requests%rowtype; s jsonb; vb buckets%rowtype; vault_acc uuid; dst uuid; amt numeric;
begin
  select * into a from approval_requests where id = p_approval for update;
  if not found or a.kind <> 'vault_release' then raise exception 'approval not found' using errcode='P0001'; end if;
  if a.status = 'executed' then return (select id from ledger_entries where workspace_id = a.workspace_id and idempotency_key = p_key); end if;
  if a.status <> 'approved' then raise exception 'approval is %', a.status using errcode='P0001'; end if;
  if now() < a.not_before then raise exception 'vault withdrawal delay has not elapsed' using errcode='P0001'; end if;
  if not has_role(a.workspace_id, array['owner']::app_role[]) then raise exception 'only an owner can release vault funds' using errcode='P0001'; end if;
  s := a.subject; amt := (s->>'amount')::numeric;
  vault_acc := ledger_account(a.workspace_id, (s->>'environment')::environment, (s->>'vault_bucket')::uuid, (s->>'wca')::uuid, (s->>'asset')::uuid, 'vault');
  dst := ledger_account(a.workspace_id, (s->>'environment')::environment, null, (s->>'wca')::uuid, (s->>'asset')::uuid, 'available');
  update approval_requests set status = 'executed' where id = a.id;
  perform audit(a.workspace_id, 'vault.release', 'approval_requests', a.id::text, (s->>'environment')::environment, s);
  return post_entry(a.workspace_id, (s->>'environment')::environment, 'vault_release', p_key, jsonb_build_array(
     jsonb_build_object('account', vault_acc, 'amount', (-amt)::text), jsonb_build_object('account', dst, 'amount', amt::text)));
end $$;
