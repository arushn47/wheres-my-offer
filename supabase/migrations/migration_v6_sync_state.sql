-- ============================================
-- Migration v6: Sync State Persistence & Concurrency Locks
-- ============================================
-- Run this in the Supabase SQL Editor.
-- Tracks real-time sync progress per user and prevents concurrent
-- sync execution between external 15-min cron and manual user sync.

CREATE TABLE IF NOT EXISTS sync_state (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  is_syncing BOOLEAN DEFAULT FALSE,
  phase TEXT DEFAULT 'idle',
  account_email TEXT,
  account_type TEXT,
  total_messages INTEGER DEFAULT 0,
  processed_messages INTEGER DEFAULT 0,
  new_emails INTEGER DEFAULT 0,
  new_companies INTEGER DEFAULT 0,
  skipped_duplicates INTEGER DEFAULT 0,
  current_subject TEXT,
  is_initial_sync BOOLEAN DEFAULT FALSE,
  started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  last_error TEXT
);

-- Index for quick lookup
CREATE INDEX IF NOT EXISTS idx_sync_state_user ON sync_state(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_state_syncing ON sync_state(is_syncing) WHERE is_syncing = TRUE;

-- Enable Row Level Security
ALTER TABLE sync_state ENABLE ROW LEVEL SECURITY;

-- Allow users to view and update their own sync state
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'sync_state' AND policyname = 'sync_state_own_data'
  ) THEN
    CREATE POLICY "sync_state_own_data" ON sync_state FOR ALL USING (user_id = auth.uid());
  END IF;
END $$;
