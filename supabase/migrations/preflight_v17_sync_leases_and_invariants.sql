-- Read-only V17 production preflight.
-- This file contains SELECT statements only. It does not create objects,
-- acquire leases, modify rows, or execute any migration/RPC.
-- Run the complete file and preserve every labeled result set.

-- ============================================================
-- 1. PostgreSQL version and NULLS NOT DISTINCT compatibility
-- ============================================================
SELECT
  '01_version' AS section,
  current_setting('server_version') AS postgres_version,
  current_setting('server_version_num')::integer AS postgres_version_num,
  CASE WHEN current_setting('server_version_num')::integer >= 150000
       THEN 'PASS' ELSE 'FAIL' END AS nulls_not_distinct_compatibility,
  'V17 requires PostgreSQL 15+ for NULLS NOT DISTINCT indexes' AS requirement;

-- ============================================================
-- 2. Required tables and columns
-- ============================================================
WITH required(table_name, column_name, requirement) AS (
  VALUES
    ('sync_state', 'user_id', 'V17 lease state key'),
    ('sync_state', 'is_syncing', 'V17 lease state'),
    ('sync_state', 'updated_at', 'legacy stale-lock fallback'),
    ('sync_state', 'run_id', 'V17 lease owner; added by migration'),
    ('sync_state', 'lease_expires_at', 'V17 lease expiry; added by migration'),
    ('sync_pages', 'id', 'lease-owned checkpoint key'),
    ('sync_pages', 'user_id', 'lease-owned checkpoint tenant key'),
    ('sync_pages', 'next_offset', 'checkpoint offset'),
    ('sync_pages', 'status', 'checkpoint status'),
    ('candidate_matches', 'user_id', 'V17 uniqueness/FK key'),
    ('candidate_matches', 'email_id', 'V17 uniqueness/FK key'),
    ('candidate_matches', 'neo_id', 'V17 uniqueness key'),
    ('candidate_matches', 'match_type', 'V17 uniqueness key'),
    ('gmail_accounts', 'id', 'tenant FK parent key'),
    ('gmail_accounts', 'user_id', 'tenant FK parent key'),
    ('companies', 'id', 'tenant FK parent key'),
    ('companies', 'user_id', 'tenant FK parent key'),
    ('placement_drives', 'id', 'tenant FK parent key'),
    ('placement_drives', 'user_id', 'tenant FK parent key'),
    ('placement_drives', 'company_id', 'tenant FK child key'),
    ('applications', 'id', 'tenant FK parent key'),
    ('applications', 'user_id', 'tenant FK child key'),
    ('applications', 'placement_drive_id', 'tenant FK child key'),
    ('emails', 'id', 'tenant FK parent key'),
    ('emails', 'user_id', 'tenant FK child key'),
    ('emails', 'gmail_account_id', 'tenant FK child key'),
    ('email_drive_links', 'id', 'tenant FK violation identifier'),
    ('email_drive_links', 'user_id', 'tenant FK child key'),
    ('email_drive_links', 'email_id', 'tenant FK child key'),
    ('email_drive_links', 'placement_drive_id', 'tenant FK child key'),
    ('events', 'id', 'tenant FK violation identifier'),
    ('events', 'user_id', 'tenant FK child key'),
    ('events', 'placement_drive_id', 'tenant FK child key')
), observed AS (
  SELECT r.table_name, r.column_name, r.requirement,
         (c.table_name IS NOT NULL) AS exists_now,
         c.data_type
  FROM required r
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public'
   AND c.table_name = r.table_name
   AND c.column_name = r.column_name
)
SELECT
  '02_required_schema' AS section,
  table_name,
  column_name,
  requirement,
  CASE WHEN exists_now THEN 'PASS' ELSE 'MISSING' END AS status,
  data_type
FROM observed
ORDER BY table_name, column_name;

SELECT
  '02_required_schema_summary' AS section,
  COUNT(*) AS required_columns,
  COUNT(*) FILTER (WHERE c.column_name IS NOT NULL) AS present_columns,
  COUNT(*) FILTER (WHERE c.column_name IS NULL) AS missing_columns,
  CASE WHEN COUNT(*) FILTER (WHERE c.column_name IS NULL) = 0
       THEN 'PASS' ELSE 'FAIL' END AS status
FROM (VALUES
  ('sync_state','user_id'),('sync_state','is_syncing'),('sync_state','updated_at'),
  ('sync_state','run_id'),('sync_state','lease_expires_at'),
  ('sync_pages','id'),('sync_pages','user_id'),('sync_pages','next_offset'),('sync_pages','status'),
  ('candidate_matches','user_id'),('candidate_matches','email_id'),('candidate_matches','neo_id'),('candidate_matches','match_type'),
  ('gmail_accounts','id'),('gmail_accounts','user_id'),('companies','id'),('companies','user_id'),
  ('placement_drives','id'),('placement_drives','user_id'),('placement_drives','company_id'),
  ('applications','id'),('applications','user_id'),('applications','placement_drive_id'),
  ('emails','id'),('emails','user_id'),('emails','gmail_account_id'),
  ('email_drive_links','id'),('email_drive_links','user_id'),('email_drive_links','email_id'),('email_drive_links','placement_drive_id'),
  ('events','id'),('events','user_id'),('events','placement_drive_id')
) AS required(table_name, column_name)
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public'
 AND c.table_name = required.table_name
 AND c.column_name = required.column_name;

-- ============================================================
-- 3. Candidate-match duplicates under V17 NULLS NOT DISTINCT semantics
-- ============================================================
SELECT
  '03_candidate_match_duplicates' AS section,
  user_id,
  email_id,
  neo_id,
  match_type,
  COUNT(*) AS duplicate_count,
  CASE WHEN COUNT(*) > 1 THEN 'FAIL' ELSE 'PASS' END AS status
FROM public.candidate_matches
GROUP BY user_id, email_id, neo_id, match_type
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC, user_id, neo_id, match_type;

SELECT
  '03_candidate_match_duplicate_summary' AS section,
  COUNT(*) AS duplicate_groups,
  COALESCE(SUM(duplicate_count), 0)::bigint AS rows_in_duplicate_groups,
  CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status,
  'Must be zero before idx_candidate_matches_identity_nulls_not_distinct can be created' AS requirement
FROM (
  SELECT user_id, email_id, neo_id, match_type, COUNT(*) AS duplicate_count
  FROM public.candidate_matches
  GROUP BY user_id, email_id, neo_id, match_type
  HAVING COUNT(*) > 1
) duplicates;

-- ============================================================
-- 4. Existing V17 target indexes and exact definitions
-- ============================================================
WITH targets(index_name, expected_definition) AS (
  VALUES
    ('idx_candidate_matches_identity_nulls_not_distinct', 'candidate_matches (user_id, email_id, neo_id, match_type) NULLS NOT DISTINCT'),
    ('idx_gmail_accounts_user_id', 'gmail_accounts (user_id, id)'),
    ('idx_companies_user_id', 'companies (user_id, id)'),
    ('idx_placement_drives_user_id', 'placement_drives (user_id, id)'),
    ('idx_applications_user_id', 'applications (user_id, id)'),
    ('idx_emails_user_id', 'emails (user_id, id)')
)
SELECT
  '04_v17_indexes' AS section,
  t.index_name,
  CASE WHEN i.indexname IS NULL THEN 'ABSENT'
       WHEN i.indexdef ILIKE '%NULLS NOT DISTINCT%' OR t.index_name <> 'idx_candidate_matches_identity_nulls_not_distinct'
         THEN 'PRESENT_REVIEW_DEFINITION'
       ELSE 'PRESENT_DEFINITION_MAY_NOT_MATCH' END AS status,
  t.expected_definition,
  i.indexdef AS actual_definition
FROM targets t
LEFT JOIN pg_indexes i
  ON i.schemaname = 'public'
 AND i.indexname = t.index_name
ORDER BY t.index_name;

-- ============================================================
-- 5. Existing V17 constraint names and definitions
-- ============================================================
WITH targets(table_name, constraint_name, expected_definition) AS (
  VALUES
    ('public.placement_drives', 'placement_drives_company_tenant_fkey', 'FOREIGN KEY (user_id, company_id) REFERENCES public.companies(user_id, id)'),
    ('public.applications', 'applications_drive_tenant_fkey', 'FOREIGN KEY (user_id, placement_drive_id) REFERENCES public.placement_drives(user_id, id)'),
    ('public.emails', 'emails_account_tenant_fkey', 'FOREIGN KEY (user_id, gmail_account_id) REFERENCES public.gmail_accounts(user_id, id)'),
    ('public.email_drive_links', 'email_drive_links_email_tenant_fkey', 'FOREIGN KEY (user_id, email_id) REFERENCES public.emails(user_id, id)'),
    ('public.email_drive_links', 'email_drive_links_drive_tenant_fkey', 'FOREIGN KEY (user_id, placement_drive_id) REFERENCES public.placement_drives(user_id, id)'),
    ('public.candidate_matches', 'candidate_matches_email_tenant_fkey', 'FOREIGN KEY (user_id, email_id) REFERENCES public.emails(user_id, id)'),
    ('public.candidate_matches', 'candidate_matches_drive_tenant_fkey', 'FOREIGN KEY (user_id, placement_drive_id) REFERENCES public.placement_drives(user_id, id)'),
    ('public.events', 'events_drive_tenant_fkey', 'FOREIGN KEY (user_id, placement_drive_id) REFERENCES public.placement_drives(user_id, id)')
)
SELECT
  '05_v17_constraints' AS section,
  t.table_name,
  t.constraint_name,
  CASE WHEN c.conname IS NULL THEN 'ABSENT'
       WHEN pg_get_constraintdef(c.oid, false) ILIKE '%' || split_part(t.expected_definition, ' REFERENCES', 1) || '%' THEN 'PRESENT_REVIEW_DEFINITION'
       ELSE 'PRESENT_DEFINITION_MAY_NOT_MATCH' END AS status,
  t.expected_definition,
  pg_get_constraintdef(c.oid, false) AS actual_definition
FROM targets t
LEFT JOIN pg_constraint c
  ON c.connamespace = 'public'::regnamespace
 AND c.conrelid = t.table_name::regclass
 AND c.conname = t.constraint_name
ORDER BY t.table_name, t.constraint_name;

-- ============================================================
-- 6. Existing sync_state columns and active/stale rows
-- ============================================================
SELECT
  '06_sync_state_columns' AS section,
  column_name,
  data_type,
  is_nullable,
  CASE WHEN column_name IN ('run_id','lease_expires_at') THEN 'V17_COLUMN' ELSE 'LEGACY_COLUMN' END AS column_role
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'sync_state'
ORDER BY ordinal_position;

-- to_jsonb keeps this query valid before V17 adds run_id/lease_expires_at.
SELECT
  '06_sync_state_rows' AS section,
  s.user_id,
  s.is_syncing,
  s.phase,
  s.updated_at,
  to_jsonb(s)->>'run_id' AS run_id_if_present,
  to_jsonb(s)->>'lease_expires_at' AS lease_expires_at_if_present,
  CASE
    WHEN s.is_syncing IS NOT TRUE THEN 'idle'
    WHEN to_jsonb(s)->>'lease_expires_at' IS NOT NULL
      AND (to_jsonb(s)->>'lease_expires_at')::timestamptz > NOW() THEN 'live_lease'
    WHEN s.updated_at > NOW() - INTERVAL '120 seconds' THEN 'active_or_recent_legacy_lock'
    ELSE 'stale_or_legacy_lock'
  END AS status
FROM public.sync_state s
ORDER BY s.updated_at DESC NULLS LAST;

-- ============================================================
-- 7. Cross-tenant violations for every proposed composite FK
-- ============================================================
WITH violations AS (
  SELECT 'placement_drives_company' AS violation, d.id::text AS record_id,
         d.user_id::text AS child_user_id, c.user_id::text AS parent_user_id
  FROM public.placement_drives d JOIN public.companies c ON c.id = d.company_id
  WHERE d.user_id IS DISTINCT FROM c.user_id
  UNION ALL
  SELECT 'applications_drive', a.id::text, a.user_id::text, d.user_id::text
  FROM public.applications a JOIN public.placement_drives d ON d.id = a.placement_drive_id
  WHERE a.user_id IS DISTINCT FROM d.user_id
  UNION ALL
  SELECT 'emails_account', e.id::text, e.user_id::text, a.user_id::text
  FROM public.emails e JOIN public.gmail_accounts a ON a.id = e.gmail_account_id
  WHERE e.user_id IS DISTINCT FROM a.user_id
  UNION ALL
  SELECT 'email_drive_links_email', l.id::text, l.user_id::text, e.user_id::text
  FROM public.email_drive_links l JOIN public.emails e ON e.id = l.email_id
  WHERE l.user_id IS DISTINCT FROM e.user_id
  UNION ALL
  SELECT 'email_drive_links_drive', l.id::text, l.user_id::text, d.user_id::text
  FROM public.email_drive_links l JOIN public.placement_drives d ON d.id = l.placement_drive_id
  WHERE l.user_id IS DISTINCT FROM d.user_id
  UNION ALL
  SELECT 'candidate_matches_email', m.id::text, m.user_id::text, e.user_id::text
  FROM public.candidate_matches m JOIN public.emails e ON e.id = m.email_id
  WHERE m.user_id IS DISTINCT FROM e.user_id
  UNION ALL
  SELECT 'candidate_matches_drive', m.id::text, m.user_id::text, d.user_id::text
  FROM public.candidate_matches m JOIN public.placement_drives d ON d.id = m.placement_drive_id
  WHERE m.user_id IS DISTINCT FROM d.user_id
  UNION ALL
  SELECT 'events_drive', e.id::text, e.user_id::text, d.user_id::text
  FROM public.events e JOIN public.placement_drives d ON d.id = e.placement_drive_id
  WHERE e.user_id IS DISTINCT FROM d.user_id
)
SELECT
  '07_cross_tenant_violations' AS section,
  violation,
  record_id,
  child_user_id,
  parent_user_id,
  'FAIL' AS status
FROM violations
ORDER BY violation, record_id;

WITH violation_counts AS (
  SELECT * FROM (
    SELECT 'placement_drives_company' AS violation, COUNT(*)::bigint AS count FROM public.placement_drives d JOIN public.companies c ON c.id=d.company_id WHERE d.user_id IS DISTINCT FROM c.user_id
    UNION ALL SELECT 'applications_drive', COUNT(*) FROM public.applications a JOIN public.placement_drives d ON d.id=a.placement_drive_id WHERE a.user_id IS DISTINCT FROM d.user_id
    UNION ALL SELECT 'emails_account', COUNT(*) FROM public.emails e JOIN public.gmail_accounts a ON a.id=e.gmail_account_id WHERE e.user_id IS DISTINCT FROM a.user_id
    UNION ALL SELECT 'email_drive_links_email', COUNT(*) FROM public.email_drive_links l JOIN public.emails e ON e.id=l.email_id WHERE l.user_id IS DISTINCT FROM e.user_id
    UNION ALL SELECT 'email_drive_links_drive', COUNT(*) FROM public.email_drive_links l JOIN public.placement_drives d ON d.id=l.placement_drive_id WHERE l.user_id IS DISTINCT FROM d.user_id
    UNION ALL SELECT 'candidate_matches_email', COUNT(*) FROM public.candidate_matches m JOIN public.emails e ON e.id=m.email_id WHERE m.user_id IS DISTINCT FROM e.user_id
    UNION ALL SELECT 'candidate_matches_drive', COUNT(*) FROM public.candidate_matches m JOIN public.placement_drives d ON d.id=m.placement_drive_id WHERE m.user_id IS DISTINCT FROM d.user_id
    UNION ALL SELECT 'events_drive', COUNT(*) FROM public.events e JOIN public.placement_drives d ON d.id=e.placement_drive_id WHERE e.user_id IS DISTINCT FROM d.user_id
  ) counts
)
SELECT
  '07_cross_tenant_summary' AS section,
  violation,
  count,
  CASE WHEN count = 0 THEN 'PASS' ELSE 'FAIL' END AS status
FROM violation_counts
ORDER BY violation;

-- ============================================================
-- 8. Existing V17 RPC names/signatures
-- ============================================================
SELECT
  '08_v17_functions' AS section,
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  pg_get_function_result(p.oid) AS result_type,
  'PRESENT_REVIEW' AS status
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('acquire_sync_lease','update_sync_lease','release_sync_lease','update_sync_page_checkpoint')
ORDER BY p.proname, arguments;

-- ============================================================
-- 9. Final PASS / FAIL / REVIEW summary
-- ============================================================
WITH required_columns AS (
  SELECT COUNT(*) FILTER (WHERE c.column_name IS NULL)::bigint AS missing
  FROM (VALUES
    ('sync_state','user_id'),('sync_state','is_syncing'),('sync_state','updated_at'),('sync_state','run_id'),('sync_state','lease_expires_at'),
    ('sync_pages','id'),('sync_pages','user_id'),('sync_pages','next_offset'),('sync_pages','status'),
    ('candidate_matches','user_id'),('candidate_matches','email_id'),('candidate_matches','neo_id'),('candidate_matches','match_type')
  ) required(table_name,column_name)
  LEFT JOIN information_schema.columns c ON c.table_schema='public' AND c.table_name=required.table_name AND c.column_name=required.column_name
), duplicate_groups AS (
  SELECT COUNT(*)::bigint AS count FROM (
    SELECT user_id,email_id,neo_id,match_type FROM public.candidate_matches
    GROUP BY user_id,email_id,neo_id,match_type HAVING COUNT(*) > 1
  ) d
), cross_tenant AS (
  SELECT COALESCE(SUM(count),0)::bigint AS count FROM (
    SELECT COUNT(*)::bigint AS count FROM public.placement_drives d JOIN public.companies c ON c.id=d.company_id WHERE d.user_id IS DISTINCT FROM c.user_id
    UNION ALL SELECT COUNT(*) FROM public.applications a JOIN public.placement_drives d ON d.id=a.placement_drive_id WHERE a.user_id IS DISTINCT FROM d.user_id
    UNION ALL SELECT COUNT(*) FROM public.emails e JOIN public.gmail_accounts a ON a.id=e.gmail_account_id WHERE e.user_id IS DISTINCT FROM a.user_id
    UNION ALL SELECT COUNT(*) FROM public.email_drive_links l JOIN public.emails e ON e.id=l.email_id WHERE l.user_id IS DISTINCT FROM e.user_id
    UNION ALL SELECT COUNT(*) FROM public.email_drive_links l JOIN public.placement_drives d ON d.id=l.placement_drive_id WHERE l.user_id IS DISTINCT FROM d.user_id
    UNION ALL SELECT COUNT(*) FROM public.candidate_matches m JOIN public.emails e ON e.id=m.email_id WHERE m.user_id IS DISTINCT FROM e.user_id
    UNION ALL SELECT COUNT(*) FROM public.candidate_matches m JOIN public.placement_drives d ON d.id=m.placement_drive_id WHERE m.user_id IS DISTINCT FROM d.user_id
    UNION ALL SELECT COUNT(*) FROM public.events e JOIN public.placement_drives d ON d.id=e.placement_drive_id WHERE e.user_id IS DISTINCT FROM d.user_id
  ) v
), version_check AS (
  SELECT current_setting('server_version_num')::integer AS version_num
)
SELECT '09_final_summary' AS section, 'postgres_version' AS check_name,
       CASE WHEN version_num >= 150000 THEN 'PASS' ELSE 'FAIL' END AS status,
       version_num::text AS value,
       'PostgreSQL 15+ required for NULLS NOT DISTINCT' AS details
FROM version_check
UNION ALL
SELECT '09_final_summary','candidate_match_duplicates',CASE WHEN count=0 THEN 'PASS' ELSE 'FAIL' END,count::text,'Must be zero' FROM duplicate_groups
UNION ALL
SELECT '09_final_summary','cross_tenant_violations',CASE WHEN count=0 THEN 'PASS' ELSE 'FAIL' END,count::text,'Must be zero' FROM cross_tenant
UNION ALL
SELECT '09_final_summary','required_columns',CASE WHEN missing=0 THEN 'PASS' ELSE 'FAIL' END,missing::text,'Missing-column count; V17 columns are expected missing before migration' FROM required_columns
UNION ALL
SELECT '09_final_summary','migration_execution_readiness','REVIEW','SEE_ABOVE','Do not execute V17 until every result set is reviewed';
