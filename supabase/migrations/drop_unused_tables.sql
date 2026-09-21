-- ============================================
-- NeoTrack: Drop Unused Tables Migration
-- ============================================
-- These 3 tables exist in the schema but have 0 rows and 0 write paths in the codebase.
-- Dropping them reduces schema complexity and eliminates confusion.
--
-- Run this in the Supabase SQL Editor.

-- 1. Drop indexes first
DROP INDEX IF EXISTS idx_attachments_email;
DROP INDEX IF EXISTS idx_attachments_hash;
DROP INDEX IF EXISTS idx_documents_company;
DROP INDEX IF EXISTS idx_status_history_app;

-- 2. Drop RLS policies
DROP POLICY IF EXISTS "attachments_own_data" ON attachments;
DROP POLICY IF EXISTS "documents_own_data" ON documents;
DROP POLICY IF EXISTS "status_history_own_data" ON status_history;

-- 3. Drop tables (CASCADE handles any remaining FK references)
DROP TABLE IF EXISTS attachments CASCADE;
DROP TABLE IF EXISTS documents CASCADE;
DROP TABLE IF EXISTS status_history CASCADE;
