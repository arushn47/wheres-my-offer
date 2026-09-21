-- V19: Add watch_expires_at to gmail_accounts to track Pub/Sub watch subscription expiry.
-- Gmail watch() subscriptions expire every 7 days. The cron renewal job uses this
-- column to efficiently renew only accounts whose watch is about to expire.
-- Not executed automatically. Run in Supabase SQL Editor.

BEGIN;

ALTER TABLE public.gmail_accounts
  ADD COLUMN IF NOT EXISTS watch_expires_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.gmail_accounts.watch_expires_at IS
  'UTC timestamp when the Gmail Pub/Sub watch() subscription expires. NULL means no active watch. Renewed automatically by the daily cron.';

COMMIT;
