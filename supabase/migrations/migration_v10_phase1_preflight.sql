-- ============================================
-- Phase 1 preflight: read-only single-row result
-- ============================================
-- Run this file first in the target Supabase project.
-- This file intentionally contains SELECT/catalog queries only.
-- It returns exactly one row for easy SQL Editor review.

WITH
application_duplicate_groups AS (
  SELECT user_id, company_id
  FROM public.applications
  GROUP BY user_id, company_id
  HAVING COUNT(*) > 1
),
gmail_account_duplicate_groups AS (
  SELECT user_id, email
  FROM public.gmail_accounts
  GROUP BY user_id, email
  HAVING COUNT(*) > 1
),
candidate_match_duplicate_groups AS (
  SELECT user_id, email_id, neo_id, match_type
  FROM public.candidate_matches
  WHERE email_id IS NOT NULL
  GROUP BY user_id, email_id, neo_id, match_type
  HAVING COUNT(*) > 1
),
candidate_match_check AS (
  SELECT
    c.conname,
    pg_get_constraintdef(c.oid) AS definition
  FROM pg_constraint c
  WHERE c.conrelid = 'public.candidate_matches'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%match_type%'
  ORDER BY c.conname
  LIMIT 1
),
candidate_match_unique_objects AS (
  SELECT
    i.relname AS index_name,
    cols.column_names
  FROM pg_class table_rel
  JOIN pg_index idx
    ON idx.indrelid = table_rel.oid
  JOIN pg_class i
    ON i.oid = idx.indexrelid
  LEFT JOIN LATERAL (
    SELECT ARRAY_AGG(a.attname ORDER BY key_columns.ordinality) AS column_names
    FROM unnest(idx.indkey) WITH ORDINALITY AS key_columns(attnum, ordinality)
    JOIN pg_attribute a
      ON a.attrelid = table_rel.oid
     AND a.attnum = key_columns.attnum
  ) cols ON TRUE
  WHERE table_rel.oid = 'public.candidate_matches'::regclass
    AND idx.indisunique
    AND idx.indnatts = 4
    AND idx.indnkeyatts = 4
    AND cols.column_names::text[] = ARRAY[
      'user_id',
      'email_id',
      'neo_id',
      'match_type'
    ]::text[]
)
SELECT
  (SELECT COUNT(*) FROM application_duplicate_groups)::bigint
    AS applications_duplicate_count,
  (SELECT COUNT(*) FROM gmail_account_duplicate_groups)::bigint
    AS gmail_accounts_duplicate_count,
  (SELECT COUNT(*) FROM candidate_match_duplicate_groups)::bigint
    AS candidate_matches_duplicate_count,
  (SELECT conname FROM candidate_match_check)
    AS candidate_match_check_constraint_name,
  (SELECT definition FROM candidate_match_check)
    AS candidate_match_check_constraint_definition,
  EXISTS (SELECT 1 FROM candidate_match_unique_objects)
    AS candidate_match_target_unique_exists,
  (SELECT index_name
   FROM candidate_match_unique_objects
   ORDER BY index_name
   LIMIT 1)
    AS candidate_match_target_unique_index_name;
