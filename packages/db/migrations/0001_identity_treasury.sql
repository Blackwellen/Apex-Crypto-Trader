-- APEX 0001: identity, workspaces, portfolio/bucket/wallet structure, registries.
-- All monetary quantities elsewhere are integer base units (numeric(78,0)); never floats.
create extension if not exists pgcrypto;

create type app_role as enum ('owner','admin','trader','viewer');
create type environment as enum ('paper','live');
create type segregation_mode as enum ('physical','logical','protected');
create type wallet_capability as enum ('watch_only','user_signed','managed_signer','cex_view_only','cex_trade_only');
create type chain_family as enum ('evm','svm','sui','aptos','tron','cosmos','bitcoin','ton','near','cex');
create type cert_status as enum ('CERTIFIED','READ_ONLY','PENDING','UNSUPPORTED');
create type account_state as enum ('available','reserved','pending_out','fee_reserve','pending_bridge','restricted','vault','external','equity','fees_expense');

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  base_currency text not null default 'GBP' check (base_currency in ('GBP','USD')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  schema_version int not null default 1
);

create table memberships (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null,
  role app_role not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- membership helpers used by RLS (SECURITY DEFINER avoids recursive policy evaluation)
create or replace function is_member(ws uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships m where m.workspace_id = ws and m.user_id = auth.uid())
$$;
create or replace function has_role(ws uuid, roles app_role[]) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships m where m.workspace_id = ws and m.user_id = auth.uid() and m.role = any(roles))
$$;

-- Append-only audit log. No UPDATE/DELETE allowed (trigger), enforced for every role.
create table audit_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references workspaces(id),
  actor uuid,
  action text not null,
  entity text not null,
  entity_id text,
  environment environment,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create or replace function forbid_mutation() returns trigger language plpgsql as $$
begin raise exception 'table % is append-only', tg_table_name using errcode = 'P0001'; end $$;
create trigger audit_events_immutable before update or delete on audit_events for each row execute function forbid_mutation();
create or replace function audit(ws uuid, act text, ent text, ent_id text, env environment, det jsonb) returns void
language sql as $$ insert into audit_events(workspace_id, actor, action, entity, entity_id, environment, detail) values (ws, auth.uid(), act, ent, ent_id, env, coalesce(det,'{}')) $$;

create table portfolios (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  environment environment not null default 'paper',
  created_at timestamptz not null default now(),
  unique (workspace_id, environment, name)
);

create table buckets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  portfolio_id uuid not null references portfolios(id) on delete cascade,
  environment environment not null,
  name text not null check (length(name) between 1 and 120),
  kind text not null default 'trading' check (kind in ('trading','gas_reserve','protected_vault','research')),
  segregation segregation_mode not null default 'physical',
  base_currency text not null default 'GBP' check (base_currency in ('GBP','USD')),
  state text not null default 'active' check (state in ('active','halt_new_entries','exit_only','disabled')),
  policy jsonb not null default '{}'::jsonb,         -- current policy snapshot (also versioned below)
  policy_version int not null default 1,             -- optimistic concurrency token
  created_at timestamptz not null default now(),
  unique (portfolio_id, name),
  -- protected/vault buckets can never be strategy-tradeable
  constraint vault_not_trading check (kind <> 'protected_vault' or segregation = 'protected')
);
create index on buckets (workspace_id);

create table bucket_policy_versions (
  bucket_id uuid not null references buckets(id) on delete cascade,
  version int not null,
  policy jsonb not null,
  changed_by uuid,
  created_at timestamptz not null default now(),
  primary key (bucket_id, version)
);
create trigger bucket_policy_versions_immutable before update or delete on bucket_policy_versions for each row execute function forbid_mutation();

create table baskets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  bucket_id uuid not null references buckets(id) on delete cascade,
  name text not null,
  unique (bucket_id, name)
);
create table basket_members (
  basket_id uuid not null references baskets(id) on delete cascade,
  asset_id uuid not null,
  target_weight_bps int not null check (target_weight_bps between 0 and 10000),
  primary key (basket_id, asset_id)
);

-- Registries (global reference data, readable by any authenticated user)
create table chain_registry (
  id text primary key,                      -- e.g. eip155:8453, solana:mainnet
  namespace text not null,
  chain_ref text not null,
  family chain_family not null,
  name text not null,
  is_testnet boolean not null default false,
  native_symbol text not null,
  native_decimals int not null check (native_decimals between 0 and 36),
  finality_model text not null,
  address_format text not null,
  explorer_url text,
  enabled boolean not null default false,   -- monitoring/trading off until explicitly enabled
  details jsonb not null default '{}'::jsonb
);
create table chain_capabilities (
  chain_id text not null references chain_registry(id) on delete cascade,
  capability text not null,
  status cert_status not null default 'PENDING',
  evidence_ref text,
  updated_at timestamptz not null default now(),
  primary key (chain_id, capability),
  -- a capability can only be CERTIFIED with a recorded evidence reference
  constraint certified_needs_evidence check (status <> 'CERTIFIED' or evidence_ref is not null)
);
create table venue_registry (
  id text primary key,
  name text not null,
  kind text not null check (kind in ('cex','dex','aggregator')),
  uk_availability text not null default 'UNVERIFIED' check (uk_availability in ('UNVERIFIED','AVAILABLE','RESTRICTED')),
  spot_only boolean not null default true,
  status cert_status not null default 'PENDING'
);

-- canonical asset identity: chain + contract/mint (+ programme), never ticker text
create table assets (
  id uuid primary key default gen_random_uuid(),
  chain_id text not null references chain_registry(id),
  contract text not null default 'native',
  symbol text not null,
  decimals int not null check (decimals between 0 and 36),
  token_program text,
  unique (chain_id, contract)
);

create table wallets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  nickname text not null check (length(nickname) between 1 and 80),
  family chain_family not null,
  address text not null,                    -- PUBLIC address only. No key material column exists anywhere.
  capability wallet_capability not null default 'watch_only',
  state text not null default 'active' check (state in ('active','paused','archived','revoked')),
  signer_ref text,                          -- opaque KMS/MPC/provider reference, never a secret
  created_at timestamptz not null default now(),
  unique (workspace_id, family, address),
  constraint managed_needs_signer_ref check (capability <> 'managed_signer' or signer_ref is not null)
);
create table wallet_chain_accounts (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references wallets(id) on delete cascade,
  chain_id text not null references chain_registry(id),
  unique (wallet_id, chain_id)
);

create table wallet_bucket_allocations (
  wallet_id uuid not null references wallets(id) on delete cascade,
  bucket_id uuid not null references buckets(id) on delete cascade,
  exclusive boolean not null default true,
  max_allocation_bps int not null default 10000 check (max_allocation_bps between 1 and 10000),
  logical_ack boolean not null default false,   -- explicit acknowledgement for shared (non-exclusive) wallets
  created_at timestamptz not null default now(),
  primary key (wallet_id, bucket_id),
  constraint shared_needs_ack check (exclusive or logical_ack)
);
-- a wallet with an exclusive allocation cannot be allocated to any other bucket
create or replace function check_wallet_exclusivity() returns trigger language plpgsql as $$
begin
  if exists (select 1 from wallet_bucket_allocations a where a.wallet_id = new.wallet_id and a.bucket_id <> new.bucket_id and (a.exclusive or new.exclusive)) then
    raise exception 'wallet % has an exclusive allocation; physical segregation forbids another bucket', new.wallet_id using errcode='P0001';
  end if;
  if (select sum(max_allocation_bps) from wallet_bucket_allocations where wallet_id = new.wallet_id and bucket_id <> new.bucket_id) + new.max_allocation_bps > 10000 then
    raise exception 'wallet % allocation exceeds 100%%', new.wallet_id using errcode='P0001';
  end if;
  return new;
end $$;
create trigger wba_exclusivity before insert or update on wallet_bucket_allocations for each row execute function check_wallet_exclusivity();
