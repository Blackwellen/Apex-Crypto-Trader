-- APEX 0262: token lifecycle state model (manual operator observations), news items with source verification,
-- and verified-only catalyst links. Nothing here is fetched from the internet: every row is an operator observation.

create table token_lifecycles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  chain_id text not null references chain_registry(id),
  contract text not null check (length(contract) between 1 and 128),
  symbol text not null check (length(symbol) between 1 and 40),
  stage text not null check (stage in ('observed','launchpad','bonding_curve','graduating','migrated','early_dex','mature_dex','cex_listed','dormant')),
  stage_observed_at timestamptz not null,
  source text not null check (length(source) between 2 and 200),
  evidence_ref text check (evidence_ref is null or length(evidence_ref) <= 500),
  note text check (note is null or length(note) <= 500),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  unique (workspace_id, chain_id, contract)
);
-- append-only history of every observation (including late/out-of-order ones)
create table token_lifecycle_events (
  id bigint generated always as identity primary key,
  lifecycle_id uuid not null references token_lifecycles(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  stage text not null check (stage in ('observed','launchpad','bonding_curve','graduating','migrated','early_dex','mature_dex','cex_listed','dormant')),
  observed_at timestamptz not null,
  source text not null, evidence_ref text, note text,
  recorded_by uuid not null, recorded_at timestamptz not null default now()
);
create index on token_lifecycle_events (lifecycle_id, observed_at desc);
create or replace function forbid_lifecycle_event_mutation() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from token_lifecycles where id = old.lifecycle_id) then return old; end if;  -- cascade from parent only
  raise exception 'token_lifecycle_events is append-only' using errcode = 'P0001';
end $$;
create trigger token_lifecycle_events_immutable before update or delete on token_lifecycle_events for each row execute function forbid_lifecycle_event_mutation();

create table news_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  headline text not null check (length(headline) between 3 and 300),
  kind text not null default 'news' check (kind in ('news','social_post','official_announcement','onchain_event')),
  source_name text not null check (length(source_name) between 2 and 120),
  source_url text check (source_url is null or source_url ~ '^https?://[^\s]+$'),
  published_at timestamptz not null,                -- the SOURCE's timestamp, as read by the operator
  observed_at timestamptz not null default now(),   -- when the operator entered it
  verified boolean not null default false,          -- unverified items are not signals
  verified_by uuid, verified_at timestamptz,
  verification_checklist jsonb, verification_note text,
  entered_by uuid not null,
  constraint verified_has_evidence check (not verified or (verified_by is not null and verified_at is not null and source_url is not null
    and verification_checklist is not null and verification_note is not null)),
  constraint published_not_future check (published_at <= observed_at + interval '5 minutes')
);
create index on news_items (workspace_id, observed_at desc);

create table news_catalyst_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  news_id uuid not null references news_items(id) on delete cascade,
  lifecycle_id uuid not null references token_lifecycles(id) on delete cascade,
  note text check (note is null or length(note) <= 300),
  linked_by uuid not null, created_at timestamptz not null default now(),
  unique (news_id, lifecycle_id)
);
-- data-model enforcement of "unverified social posts / news are not signals"
create or replace function enforce_verified_catalyst() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from news_items where id = new.news_id and verified and workspace_id = new.workspace_id) then
    raise exception 'unverified news items cannot be linked as catalysts' using errcode = 'P0001';
  end if;
  if not exists (select 1 from token_lifecycles where id = new.lifecycle_id and workspace_id = new.workspace_id) then
    raise exception 'token is not tracked in this workspace' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger news_catalyst_verified_only before insert or update on news_catalyst_links for each row execute function enforce_verified_catalyst();
create or replace function forbid_unverify_linked() returns trigger language plpgsql as $$
begin
  if old.verified and not new.verified and exists (select 1 from news_catalyst_links where news_id = old.id) then
    raise exception 'cannot unverify an item that is linked as a catalyst' using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger news_no_unverify_linked before update on news_items for each row execute function forbid_unverify_linked();

do $$ declare t text; begin
  foreach t in array array['token_lifecycles','token_lifecycle_events','news_items','news_catalyst_links'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy %I on %I for select to authenticated using (is_member(workspace_id))', t || '_sel', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;

create or replace function api_log_token_observation(p_ws uuid, p_chain text, p_contract text, p_symbol text, p_stage text, p_observed_at timestamptz,
  p_source text, p_evidence text default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare lc token_lifecycles%rowtype; c text := trim(p_contract); applied boolean := true;
begin
  perform assert_role(p_ws, array['owner','admin','trader']::app_role[]);
  if not exists (select 1 from chain_registry where id = p_chain) then raise exception 'unknown chain %', p_chain using errcode='P0001'; end if;
  if p_observed_at > now() + interval '5 minutes' then raise exception 'observation time is in the future' using errcode='P0001'; end if;
  select * into lc from token_lifecycles where workspace_id = p_ws and chain_id = p_chain and contract = c for update;
  if not found then
    insert into token_lifecycles(workspace_id, chain_id, contract, symbol, stage, stage_observed_at, source, evidence_ref, note, created_by)
      values (p_ws, p_chain, c, trim(p_symbol), p_stage, p_observed_at, trim(p_source), p_evidence, p_note, auth.uid()) returning * into lc;
  elsif p_observed_at >= lc.stage_observed_at then
    update token_lifecycles set stage = p_stage, stage_observed_at = p_observed_at, source = trim(p_source), evidence_ref = p_evidence, note = p_note, updated_at = now() where id = lc.id;
  else
    applied := false;     -- late observation: kept in history, does not rewind the current stage
  end if;
  insert into token_lifecycle_events(lifecycle_id, workspace_id, stage, observed_at, source, evidence_ref, note, recorded_by)
    values (lc.id, p_ws, p_stage, p_observed_at, trim(p_source), p_evidence, p_note, auth.uid());
  perform audit(p_ws, 'lifecycle.observe', 'token_lifecycles', lc.id::text, null, jsonb_build_object('chain', p_chain, 'contract', c, 'stage', p_stage, 'applied_as_current', applied));
  return jsonb_build_object('id', lc.id, 'appliedAsCurrent', applied);
end $$;

create or replace function api_add_news_item(p_ws uuid, p_headline text, p_kind text, p_source_name text, p_source_url text, p_published_at timestamptz) returns uuid
language plpgsql security definer set search_path = public as $$
declare nid uuid;
begin
  perform assert_role(p_ws, array['owner','admin','trader']::app_role[]);
  insert into news_items(workspace_id, headline, kind, source_name, source_url, published_at, entered_by)
    values (p_ws, trim(p_headline), p_kind, trim(p_source_name), nullif(trim(p_source_url), ''), p_published_at, auth.uid()) returning id into nid;
  perform audit(p_ws, 'news.add', 'news_items', nid::text, null, jsonb_build_object('kind', p_kind, 'source', p_source_name, 'verified', false));
  return nid;
end $$;

-- verification needs EVERY checklist item true plus a written note and a source URL; there is no way to verify partially.
create or replace function api_verify_news_item(p_item uuid, p_checklist jsonb, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare n news_items%rowtype; k text;
begin
  select * into n from news_items where id = p_item for update;
  if not found then raise exception 'news item not found' using errcode='P0001'; end if;
  perform assert_role(n.workspace_id, array['owner','admin','trader']::app_role[]);
  if n.source_url is null then raise exception 'cannot verify an item without a source URL' using errcode='P0001'; end if;
  foreach k in array array['source_identified','timestamp_confirmed','primary_source_corroborated','not_promotional_or_paid'] loop
    if coalesce(p_checklist->>k, 'false') <> 'true' then raise exception 'verification checklist item % is not confirmed', k using errcode='P0001'; end if;
  end loop;
  if p_note is null or length(trim(p_note)) < 5 then raise exception 'a verification note is required' using errcode='P0001'; end if;
  update news_items set verified = true, verified_by = auth.uid(), verified_at = now(), verification_checklist = p_checklist, verification_note = trim(p_note) where id = p_item;
  perform audit(n.workspace_id, 'news.verify', 'news_items', p_item::text, null, jsonb_build_object('note', left(trim(p_note), 200)));
end $$;

create or replace function api_link_catalyst(p_item uuid, p_lifecycle uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare n news_items%rowtype; lid uuid;
begin
  select * into n from news_items where id = p_item;
  if not found then raise exception 'news item not found' using errcode='P0001'; end if;
  perform assert_role(n.workspace_id, array['owner','admin','trader']::app_role[]);
  insert into news_catalyst_links(workspace_id, news_id, lifecycle_id, note, linked_by) values (n.workspace_id, p_item, p_lifecycle, p_note, auth.uid())
    on conflict (news_id, lifecycle_id) do update set note = excluded.note returning id into lid;
  perform audit(n.workspace_id, 'news.link_catalyst', 'news_catalyst_links', lid::text, null, jsonb_build_object('news', p_item, 'lifecycle', p_lifecycle));
  return lid;
end $$;

revoke execute on function api_log_token_observation(uuid,text,text,text,text,timestamptz,text,text,text), api_add_news_item(uuid,text,text,text,text,timestamptz),
  api_verify_news_item(uuid,jsonb,text), api_link_catalyst(uuid,uuid,text), enforce_verified_catalyst(), forbid_unverify_linked(), forbid_lifecycle_event_mutation() from public;
grant execute on function api_log_token_observation(uuid,text,text,text,text,timestamptz,text,text,text), api_add_news_item(uuid,text,text,text,text,timestamptz),
  api_verify_news_item(uuid,jsonb,text), api_link_catalyst(uuid,uuid,text) to authenticated, service_role;
