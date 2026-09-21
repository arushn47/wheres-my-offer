-- ============================================
-- Migration V3: Fix not_shortlisted status + improve defaults
-- ============================================
-- Run this in Supabase SQL Editor

-- 1. Add 'not_shortlisted' to the applications.status CHECK constraint
-- The status-engine.ts tries to set this value but the DB was silently rejecting it
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_status_check;
ALTER TABLE applications ADD CONSTRAINT applications_status_check CHECK (status IN (
  'not_applied', 'applied', 'shortlisted', 'ppt_scheduled',
  'test_scheduled', 'interview_scheduled', 'selected',
  'rejected', 'not_shortlisted', 'withdrawn', 'declined', 'offer_received', 'unknown'
));
