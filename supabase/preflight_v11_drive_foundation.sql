-- ============================================================
-- NeoTrack Phase 1 / migration v11 read-only preflight
-- ============================================================
-- Run this file against the current pre-v11 database.
-- READ ONLY: SELECT/catalog queries only. No data or schema mutation.
--
-- The SQL editor should return one result set. Each row is one check and the
-- final row is the overall result. Do not apply v11 until the result is
-- reviewed and all BLOCKED rows are resolved.

WITH
required_tables(table_name) AS (
  VALUES
    ('users'),
    ('companies'),
    ('applications'),
    ('emails'),
    ('events'),
    ('candidate_matches'),
    ('notifications')
),
table_checks AS (
  SELECT
    'base_table.' || r.table_name AS check_name,
    CASE WHEN t.table_name IS NULL THEN 'BLOCKED' ELSE 'PASS' END AS status,
    CASE WHEN t.table_name IS NULL
      THEN 'Required base table is missing'
      ELSE 'Required base table exists'
    END AS details
  FROM required_tables r
  LEFT JOIN information_schema.tables t
    ON t.table_schema = 'public'
   AND t.table_name = r.table_name
),
required_columns(table_name, column_name, expected_type) AS (
  VALUES
    ('users', 'id', 'uuid'),
    ('companies', 'id', 'uuid'),
    ('companies', 'user_id', 'uuid'),
    ('applications', 'id', 'uuid'),
    ('applications', 'user_id', 'uuid'),
    ('applications', 'company_id', 'uuid'),
    ('emails', 'id', 'uuid'),
    ('emails', 'user_id', 'uuid'),
    ('emails', 'company_id', 'uuid'),
    ('events', 'id', 'uuid'),
    ('events', 'user_id', 'uuid'),
    ('events', 'company_id', 'uuid'),
    ('candidate_matches', 'id', 'uuid'),
    ('candidate_matches', 'user_id', 'uuid'),
    ('candidate_matches', 'email_id', 'uuid'),
    ('notifications', 'id', 'uuid'),
    ('notifications', 'user_id', 'uuid'),
    ('notifications', 'company_id', 'uuid')
),
column_checks AS (
  SELECT
    'base_column.' || r.table_name || '.' || r.column_name AS check_name,
    CASE
      WHEN c.column_name IS NULL THEN 'BLOCKED'
      WHEN c.data_type <> r.expected_type THEN 'BLOCKED'
      ELSE 'PASS'
    END AS status,
    CASE
      WHEN c.column_name IS NULL THEN 'Required column is missing'
      WHEN c.data_type <> r.expected_type THEN 'Expected ' || r.expected_type || ', found ' || c.data_type
      ELSE 'Required column and type are present'
    END AS details
  FROM required_columns r
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public'
   AND c.table_name = r.table_name
   AND c.column_name = r.column_name
),
extension_checks AS (
  SELECT
    'extension.uuid-ossp' AS check_name,
    CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'uuid-ossp')
      THEN 'PASS' ELSE 'BLOCKED' END AS status,
    CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'uuid-ossp')
      THEN 'uuid-ossp is installed'
      ELSE 'uuid-ossp is missing; v11 uses uuid_generate_v4()'
    END AS details
),
v11_columns(table_name, column_name, expected_type) AS (
  VALUES
    ('applications', 'placement_drive_id', 'uuid'),
    ('emails', 'placement_drive_id', 'uuid'),
    ('emails', 'assignment_state', 'text'),
    ('emails', 'assignment_confidence', 'text'),
    ('emails', 'assignment_source', 'text'),
    ('events', 'placement_drive_id', 'uuid'),
    ('candidate_matches', 'placement_drive_id', 'uuid'),
    ('candidate_matches', 'application_id', 'uuid'),
    ('notifications', 'placement_drive_id', 'uuid')
),
v11_column_checks AS (
  SELECT
    'v11_column.' || v.table_name || '.' || v.column_name AS check_name,
    CASE
      WHEN c.column_name IS NULL THEN 'PASS'
      WHEN c.data_type <> v.expected_type THEN 'BLOCKED'
      ELSE 'WARN'
    END AS status,
    CASE
      WHEN c.column_name IS NULL THEN 'Column is absent and will be added by v11'
      WHEN c.data_type <> v.expected_type THEN 'Existing column has incompatible type ' || c.data_type
      ELSE 'Column already exists with compatible type; v11 must preserve it'
    END AS details
  FROM v11_columns v
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public'
   AND c.table_name = v.table_name
   AND c.column_name = v.column_name
),
constraint_name_checks AS (
  SELECT
    'v11_constraint_name.' || n.constraint_name AS check_name,
    CASE WHEN c.oid IS NULL THEN 'PASS' ELSE 'WARN' END AS status,
    CASE WHEN c.oid IS NULL
      THEN 'Constraint name is available'
      ELSE 'Constraint name already exists; inspect before applying v11'
    END AS details
  FROM (VALUES
    ('applications_placement_drive_id_fkey'),
    ('emails_placement_drive_id_fkey'),
    ('events_placement_drive_id_fkey'),
    ('candidate_matches_placement_drive_id_fkey'),
    ('candidate_matches_application_id_fkey'),
    ('notifications_placement_drive_id_fkey'),
    ('email_drive_links_identity_unique')
  ) n(constraint_name)
  LEFT JOIN pg_constraint c ON c.conname = n.constraint_name
),
index_name_checks AS (
  SELECT
    'v11_index_name.' || n.index_name AS check_name,
    CASE WHEN i.indexname IS NULL THEN 'PASS' ELSE 'WARN' END AS status,
    CASE WHEN i.indexname IS NULL
      THEN 'Index name is available'
      ELSE 'Index name already exists; inspect definition before applying v11'
    END AS details
  FROM (VALUES
    ('idx_placement_drives_user_drive_number'),
    ('idx_applications_user_drive'),
    ('idx_candidate_matches_application'),
    ('idx_candidate_matches_drive'),
    ('idx_events_drive'),
    ('idx_notifications_drive')
  ) n(index_name)
  LEFT JOIN pg_indexes i
    ON i.schemaname = 'public'
   AND i.indexname = n.index_name
),
candidate_duplicate_checks AS (
  SELECT
    'candidate_matches.logical_identity' AS check_name,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.candidate_matches
      WHERE email_id IS NOT NULL
      GROUP BY user_id, email_id, neo_id, match_type
      HAVING COUNT(*) > 1
    ) THEN 'BLOCKED' ELSE 'PASS' END AS status,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.candidate_matches
      WHERE email_id IS NOT NULL
      GROUP BY user_id, email_id, neo_id, match_type
      HAVING COUNT(*) > 1
    ) THEN 'Duplicate candidate match logical identities exist'
    ELSE 'No duplicate candidate match identities found'
    END AS details
),
candidate_null_email_checks AS (
  SELECT
    'candidate_matches.null_email_identity' AS check_name,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.candidate_matches
      WHERE email_id IS NULL
      GROUP BY user_id, neo_id, match_type
      HAVING COUNT(*) > 1
    ) THEN 'WARN' ELSE 'PASS' END AS status,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.candidate_matches
      WHERE email_id IS NULL
      GROUP BY user_id, neo_id, match_type
      HAVING COUNT(*) > 1
    ) THEN 'Repeated NULL-email evidence is not covered by normal unique semantics'
    ELSE 'No repeated NULL-email evidence groups found'
    END AS details
),
orphan_checks AS (
  SELECT
    'applications.company_id_orphans' AS check_name,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.applications a
      LEFT JOIN public.companies c ON c.id = a.company_id
      WHERE c.id IS NULL
    ) THEN 'BLOCKED' ELSE 'PASS' END AS status,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.applications a
      LEFT JOIN public.companies c ON c.id = a.company_id
      WHERE c.id IS NULL
    ) THEN 'Applications reference missing companies'
    ELSE 'No orphaned application company references'
    END AS details
  UNION ALL
  SELECT
    'emails.company_id_orphans',
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.emails e
      LEFT JOIN public.companies c ON c.id = e.company_id
      WHERE e.company_id IS NOT NULL AND c.id IS NULL
    ) THEN 'BLOCKED' ELSE 'PASS' END,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.emails e
      LEFT JOIN public.companies c ON c.id = e.company_id
      WHERE e.company_id IS NOT NULL AND c.id IS NULL
    ) THEN 'Emails reference missing companies'
    ELSE 'No orphaned email company references'
    END
  UNION ALL
  SELECT
    'events.company_id_orphans',
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.events e
      LEFT JOIN public.companies c ON c.id = e.company_id
      WHERE c.id IS NULL
    ) THEN 'BLOCKED' ELSE 'PASS' END,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.events e
      LEFT JOIN public.companies c ON c.id = e.company_id
      WHERE c.id IS NULL
    ) THEN 'Events reference missing companies'
    ELSE 'No orphaned event company references'
    END
),
checks AS (
  SELECT * FROM table_checks
  UNION ALL SELECT * FROM column_checks
  UNION ALL SELECT * FROM extension_checks
  UNION ALL SELECT * FROM v11_column_checks
  UNION ALL SELECT * FROM constraint_name_checks
  UNION ALL SELECT * FROM index_name_checks
  UNION ALL SELECT * FROM candidate_duplicate_checks
  UNION ALL SELECT * FROM candidate_null_email_checks
  UNION ALL SELECT * FROM orphan_checks
),
overall AS (
  SELECT
    'OVERALL' AS check_name,
    CASE
      WHEN EXISTS (SELECT 1 FROM checks WHERE status = 'BLOCKED') THEN 'BLOCKED'
      WHEN EXISTS (SELECT 1 FROM checks WHERE status = 'WARN') THEN 'REVIEW_REQUIRED'
      ELSE 'READY_TO_REVIEW'
    END AS status,
    'Review all rows before applying migration_v11' AS details
),
result_rows AS (
  SELECT check_name, status, details, 0 AS result_order
  FROM checks
  UNION ALL
  SELECT check_name, status, details, 1 AS result_order
  FROM overall
)
SELECT check_name, status, details
FROM result_rows
ORDER BY result_order, check_name;
