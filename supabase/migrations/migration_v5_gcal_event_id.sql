-- Migration: Add gcal_event_id to events table
-- Run this in the Supabase SQL Editor (or via CLI)

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS gcal_event_id TEXT DEFAULT NULL;

-- Optional: index for faster lookups when syncing/deleting by GCal event ID
CREATE INDEX IF NOT EXISTS idx_events_gcal_event_id ON events (gcal_event_id)
  WHERE gcal_event_id IS NOT NULL;
