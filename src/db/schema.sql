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

-- Spend ledger: one row per billable LLM / ASR call (Phase 0 cost kill-switch) -
create table if not exists usage_events (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null,            -- 'llm' | 'asr'
  provider      text,                     -- anthropic | openai | groq | openai-compatible ...
  model         text,
  input_tokens  int,
  output_tokens int,
  audio_seconds int,
  cost_usd      numeric(12,6) not null default 0,
  video_id      text,                     -- youtube id (free text); null for non-video calls
  created_at    timestamptz not null default now()
);
create index if not exists usage_events_created_idx on usage_events(created_at);

-- Per-video transcript cache (Phase 1): transcribe a video at most once ----------
create table if not exists transcripts (
  video_id   text primary key,        -- youtube video id
  text       text not null,
  source     text,                    -- supadata | audio
  char_len   int,
  created_at timestamptz not null default now()
);

-- Waterfall observability: one row per transcript-acquisition attempt, so the
-- dashboard//waterfall can show which tier served (or failed) each video --------
create table if not exists waterfall_events (
  id          bigserial primary key,   -- serial: stable ordering within a journey
  video_id    text not null,           -- youtube video id
  tier        text not null,           -- cache | supadata | audio | audio:groq | audio:openai
  outcome     text not null,           -- hit | miss | rate_limited | error
  detail      text,
  duration_ms int,
  created_at  timestamptz not null default now()
);
create index if not exists waterfall_events_video_idx   on waterfall_events(video_id);
create index if not exists waterfall_events_created_idx on waterfall_events(created_at);

-- Shared per-video digest cache (Phase 1): sections ①②③ computed once per video --
create table if not exists video_digests (
  video_id      text primary key,     -- youtube video id
  key_insights  jsonb,                -- section ①
  patterns      jsonb,                -- section ② (patterns)
  antipatterns  jsonb,                -- section ② (antipatterns)
  grading       jsonb,                -- section ③ (independent grade)
  extract_model text,
  grader_model  text,
  created_at    timestamptz not null default now()
);
