-- Phase 2: per-user delivery fan-out (spec: docs/MULTI-USER-SPEC.md §8, §11 Phase 2)

-- Delivery-queue bookkeeping on user_deliveries (phase-2b's hardened queue model,
-- adapted to this schema's column naming: `status`, plus the existing delivered_at).
alter table user_deliveries add column if not exists skip_reason text;
alter table user_deliveries add column if not exists message_ids jsonb;
alter table user_deliveries add column if not exists error text;
alter table user_deliveries add column if not exists attempts int not null default 0;
alter table user_deliveries add column if not exists run_after timestamptz not null default now();
alter table user_deliveries add column if not exists claimed_at timestamptz;
create index if not exists user_deliveries_claim_idx on user_deliveries(status, run_after);

-- Telegram 403 (user blocked the bot) pauses the user instead of retrying forever.
alter table users add column if not exists status text not null default 'active';
