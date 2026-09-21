-- ============================================
-- Migration v7: Count-Based Resumable Sync Pages & Recency Guard
-- ============================================
-- Run this in the Supabase SQL Editor.

-- 1. Create sync_state table if not already created (from v6)
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
  current_page_index INTEGER DEFAULT 0,
  total_pages INTEGER DEFAULT 1,
  started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_state_user ON sync_state(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_state_syncing ON sync_state(is_syncing) WHERE is_syncing = TRUE;
ALTER TABLE sync_state ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'sync_state' AND policyname = 'sync_state_own_data'
  ) THEN
    CREATE POLICY "sync_state_own_data" ON sync_state FOR ALL USING (user_id = auth.uid());
  END IF;
END $$;

-- 2. Add page tracking to sync_state if table already existed without them
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS current_page_index INTEGER DEFAULT 0;
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS total_pages INTEGER DEFAULT 1;

-- 3. Create sync_pages table for count-based chunked synchronization
CREATE TABLE IF NOT EXISTS sync_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  gmail_account_id UUID REFERENCES gmail_accounts(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL,            -- 0 = most recent page (Page 0)
  message_ids JSONB NOT NULL,             -- Array of Gmail message IDs in this slice, newest-first
  next_offset INTEGER DEFAULT 0,          -- Resume checkpoint within this page (index into reversed chronological slice)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'complete')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(gmail_account_id, page_index)
);

CREATE INDEX IF NOT EXISTS idx_sync_pages_account_status ON sync_pages(gmail_account_id, status, page_index);
CREATE INDEX IF NOT EXISTS idx_sync_pages_user_status ON sync_pages(user_id, status);
ALTER TABLE sync_pages ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'sync_pages' AND policyname = 'sync_pages_own_data'
  ) THEN
    CREATE POLICY "sync_pages_own_data" ON sync_pages FOR ALL USING (user_id = auth.uid());
  END IF;
END $$;

-- 4. Add status_source_email_at to applications table for recency guard
ALTER TABLE applications ADD COLUMN IF NOT EXISTS status_source_email_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_applications_source_email_at ON applications(user_id, status_source_email_at);
