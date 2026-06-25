-- ============================================================================
--  Podcast Digest Bot — schema (plain Postgres; e.g. Railway)
--  Idempotent: applied automatically on boot by src/db/migrate.ts.
--  gen_random_uuid() is built into Postgres 13+ (no pgcrypto extension needed).
-- ============================================================================

-- Channels the user follows ---------------------------------------------------
create table if not exists channels (
  id                   uuid primary key default gen_random_uuid(),
  youtube_channel_id   text unique not null,
  title                text,
  handle               text,
  url                  text,
  active               boolean not null default true,
  min_duration_minutes int,                 -- per-channel override; null = global
  last_checked_at      timestamptz,
  created_at           timestamptz not null default now()
);

-- Videos discovered on those channels -----------------------------------------
create table if not exists videos (
  id               uuid primary key default gen_random_uuid(),
  video_id         text unique not null,
  channel_id       uuid references channels(id) on delete cascade,
  title            text,
  url              text not null,
  published_at     timestamptz,
  duration_seconds int,
  is_long_form     boolean,
  -- pending | processing | done | skipped | failed | no_transcript
  status           text not null default 'pending',
  skip_reason      text,
  attempts            int not null default 0,
  transcript_attempts int not null default 0,
  created_at          timestamptz not null default now(),
  processed_at        timestamptz,
  claimed_at          timestamptz
);
create index if not exists videos_status_idx  on videos(status);
create index if not exists videos_channel_idx on videos(channel_id);

-- One produced digest per processed video -------------------------------------
create table if not exists digests (
  id            uuid primary key default gen_random_uuid(),
  video_id      uuid references videos(id) on delete cascade,
  key_insights  jsonb,   -- section 1
  patterns      jsonb,   -- section 2 (patterns)
  antipatterns  jsonb,   -- section 2 (antipatterns)
  grading       jsonb,   -- section 3 (the specified LLM's unbiased grade)
  tailored      jsonb,   -- section 4 (profile-matched learnings)
  rendered      text,    -- final Telegram message
  primary_model text,
  grader_model  text,
  created_at    timestamptz not null default now()
);
create index if not exists digests_video_idx on digests(video_id);

-- Single-row user profile that drives section 4 -------------------------------
create table if not exists user_profile (
  id           int primary key default 1,
  profile_text text not null default '',
  updated_at   timestamptz not null default now(),
  constraint user_profile_singleton check (id = 1)
);

-- Misc runtime settings (min duration override, etc.) -------------------------
create table if not exists settings (
  key   text primary key,
  value text
);

-- Delivery audit trail --------------------------------------------------------
create table if not exists delivery_log (
  id           uuid primary key default gen_random_uuid(),
  video_id     uuid references videos(id) on delete set null,
  chat_id      text,
  message_ids  jsonb,
  ok           boolean,
  error        text,
  delivered_at timestamptz not null default now()
);
