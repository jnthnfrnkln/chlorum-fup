-- Equipe portal: JF delegates to-dos to direct reports and gets status updates.
-- Everything lives in its own schema, with RLS on and no policies, so the
-- public API keys can read nothing. Only the `portal` edge function (service
-- role) and Claude's sync (SQL) touch it.
create schema if not exists equipe;
revoke all on schema equipe from anon, authenticated;
grant usage on schema equipe to service_role;

create table equipe.people (
  slug        text primary key,             -- vault file name: joao, duque...
  name        text not null,
  role        text not null,
  email       text,
  lang        text not null default 'pt' check (lang in ('pt','es','en')),
  is_admin    boolean not null default false,
  token       text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  last_seen_at timestamptz,
  created_at  timestamptz not null default now()
);

create table equipe.items (
  id           uuid primary key default gen_random_uuid(),
  person_slug  text not null references equipe.people(slug),
  vault_key    text not null unique,         -- sha1 of the vault line as first imported
  vault_text   text not null,                -- current text in JF's vault (English)
  source_link  text,                         -- [[meeting note]] wikilink target
  title        text,                         -- what the report sees (JF can edit before sharing)
  title_local  text,                         -- Portuguese / Spanish translation, filled by the sync
  shared       boolean not null default false,
  shared_at    timestamptz,
  status       text not null default 'open'
               check (status in ('open','in_progress','blocked','needs_jf','done_proposed','done','dropped','gone_from_vault')),
  due          date,
  last_update_at timestamptz,
  jf_unread    boolean not null default false,
  report_unread boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on equipe.items (person_slug, shared);

create table equipe.updates (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references equipe.items(id) on delete cascade,
  author      text not null check (author in ('report','jf','system')),
  body        text not null check (length(body) between 1 and 8000),
  status      text,                          -- status the author set with this update
  summary_en  text,                          -- English one-liner, filled by the sync
  synced_at   timestamptz,                   -- written into the vault
  created_at  timestamptz not null default now()
);
create index on equipe.updates (item_id, created_at);
create index on equipe.updates (synced_at) where synced_at is null;

alter table equipe.people  enable row level security;
alter table equipe.items   enable row level security;
alter table equipe.updates enable row level security;
grant all on all tables in schema equipe to service_role;
