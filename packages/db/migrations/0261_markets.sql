-- APEX 0261: saved market-filter views and the persisted watchlist. Workspace-scoped, RLS, audited api_* writers.
-- No market data is stored here: these are operator preferences and identities only.

create table saved_views (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  page text not null check (page in ('markets','meme_radar')),
  name text not null check (length(name) between 1 and 80),
  filters jsonb not null check (jsonb_typeof(filters) = 'object' and pg_column_size(filters) <= 4096),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, page, name)
);
create table watchlist_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  chain_id text not null references chain_registry(id),
  contract text not null check (length(contract) between 1 and 128),
  symbol text check (symbol is null or length(symbol) between 1 and 40),
  note text check (note is null or length(note) <= 300),
  added_by uuid not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, chain_id, contract)
);
create index on watchlist_items (workspace_id, created_at desc);

do $$ declare t text; begin
  foreach t in array array['saved_views','watchlist_items'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy %I on %I for select to authenticated using (is_member(workspace_id))', t || '_sel', t);
  end loop;
end $$;
grant select on saved_views, watchlist_items to authenticated;
grant all on saved_views, watchlist_items to service_role;

create or replace function api_save_market_view(p_ws uuid, p_page text, p_name text, p_filters jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare vid uuid;
begin
  perform assert_role(p_ws, array['owner','admin','trader']::app_role[]);
  insert into saved_views(workspace_id, page, name, filters, created_by) values (p_ws, p_page, trim(p_name), p_filters, auth.uid())
    on conflict (workspace_id, page, name) do update set filters = excluded.filters returning id into vid;
  perform audit(p_ws, 'market_view.save', 'saved_views', vid::text, null, jsonb_build_object('page', p_page, 'name', trim(p_name)));
  return vid;
end $$;

create or replace function api_delete_market_view(p_view uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v saved_views%rowtype;
begin
  select * into v from saved_views where id = p_view;
  if not found then raise exception 'view not found' using errcode='P0001'; end if;
  perform assert_role(v.workspace_id, array['owner','admin','trader']::app_role[]);
  delete from saved_views where id = p_view;
  perform audit(v.workspace_id, 'market_view.delete', 'saved_views', p_view::text, null, jsonb_build_object('name', v.name));
end $$;

create or replace function api_watch_asset(p_ws uuid, p_chain text, p_contract text, p_symbol text default null, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare wid uuid; c text;
begin
  perform assert_role(p_ws, array['owner','admin','trader']::app_role[]);
  if not exists (select 1 from chain_registry where id = p_chain) then raise exception 'unknown chain %', p_chain using errcode='P0001'; end if;
  c := trim(p_contract);
  insert into watchlist_items(workspace_id, chain_id, contract, symbol, note, added_by) values (p_ws, p_chain, c, nullif(trim(p_symbol), ''), p_note, auth.uid())
    on conflict (workspace_id, chain_id, contract) do update set note = coalesce(excluded.note, watchlist_items.note), symbol = coalesce(excluded.symbol, watchlist_items.symbol)
    returning id into wid;
  perform audit(p_ws, 'watchlist.add', 'watchlist_items', wid::text, null, jsonb_build_object('chain', p_chain, 'contract', c));
  return wid;
end $$;

create or replace function api_unwatch_asset(p_ws uuid, p_chain text, p_contract text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform assert_role(p_ws, array['owner','admin','trader']::app_role[]);
  delete from watchlist_items where workspace_id = p_ws and chain_id = p_chain and contract = trim(p_contract);
  perform audit(p_ws, 'watchlist.remove', 'watchlist_items', null, null, jsonb_build_object('chain', p_chain, 'contract', trim(p_contract)));
end $$;

revoke execute on function api_save_market_view(uuid,text,text,jsonb), api_delete_market_view(uuid), api_watch_asset(uuid,text,text,text,text), api_unwatch_asset(uuid,text,text) from public;
grant execute on function api_save_market_view(uuid,text,text,jsonb), api_delete_market_view(uuid), api_watch_asset(uuid,text,text,text,text), api_unwatch_asset(uuid,text,text) to authenticated, service_role;
