-- Multi-user foundation (spec: docs/MULTI-USER-SPEC.md)

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  password_hash text not null,
  is_owner      boolean not null default false,
  created_at    timestamptz not null default now()
);

create table if not exists sessions (
  token_hash  text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  user_agent  text
);
create index if not exists sessions_user_idx on sessions(user_id);

create table if not exists link_tokens (
  token       text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create table if not exists telegram_links (
  user_id     uuid primary key references users(id) on delete cascade,
  chat_id     text unique not null,
  linked_at   timestamptz not null default now()
);

create table if not exists subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references users(id) on delete cascade,
  channel_id           uuid not null references channels(id) on delete cascade,
  active               boolean not null default true,
  min_duration_minutes int,
  since                timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  unique(user_id, channel_id)
);
create index if not exists subscriptions_user_idx on subscriptions(user_id);
create index if not exists subscriptions_channel_idx on subscriptions(channel_id);

create table if not exists user_deliveries (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  video_id     text not null,
  status       text not null default 'pending',
  tailored     jsonb,
  rendered     text,
  created_at   timestamptz not null default now(),
  delivered_at timestamptz,
  unique(user_id, video_id)
);
create index if not exists user_deliveries_user_idx on user_deliveries(user_id, created_at desc);

create table if not exists user_profiles (
  user_id      uuid primary key references users(id) on delete cascade,
  profile_text text not null default '',
  updated_at   timestamptz not null default now()
);

alter table usage_events add column if not exists user_id uuid;
