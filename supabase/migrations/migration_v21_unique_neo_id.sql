-- ============================================================
-- Migration V21: Enforce Unique Candidate Registration ID (neo_id)
--
-- Why:
-- In NeoPAT, candidate registration IDs are unique identifiers per student.
-- Allowing multiple accounts to share the same Neo ID causes cross-account
-- data pollution (e.g. User B receiving shortlist alerts meant for User A).
--
-- Safe Deduplication:
-- If duplicates exist (e.g. test accounts copying an existing ID), this
-- migration preserves the earliest account (by created_at) and clears
-- duplicate subsequent accounts so the unique index can be created cleanly.
-- ============================================================

BEGIN;

-- 1. Deduplicate any existing duplicate neo_id values
WITH ranked_users AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY UPPER(TRIM(neo_id)) 
           ORDER BY created_at ASC
         ) AS rank
  FROM public.users
  WHERE neo_id IS NOT NULL AND TRIM(neo_id) != ''
)
UPDATE public.users
SET neo_id = NULL,
    updated_at = NOW()
WHERE id IN (
  SELECT id FROM ranked_users WHERE rank > 1
);

-- 2. Drop legacy non-unique index if present
DROP INDEX IF EXISTS public.idx_users_neo_id;

-- 3. Create case-insensitive unique partial index on users.neo_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_neo_id_unique
  ON public.users (UPPER(TRIM(neo_id)))
  WHERE neo_id IS NOT NULL AND TRIM(neo_id) != '';

COMMIT;
