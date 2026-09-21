-- ============================================================
-- Verify migration_v11_drive_identity_foundation.sql
-- ============================================================
-- READ ONLY. This file performs catalog checks only and does not mutate data.
-- Run after migration_v11 has been applied.

WITH required_tables(table_name) AS (
  VALUES
    ('placement_drives'),
    ('email_drive_links')
),
table_checks AS (
  SELECT
    'table.' || r.table_name AS check_name,
    CASE WHEN t.table_name IS NULL THEN 'FAIL' ELSE 'PASS' END AS status,
    CASE WHEN t.table_name IS NULL
      THEN 'Table is missing'
      ELSE 'Table exists'
    END AS details
  FROM required_tables r
  LEFT JOIN information_schema.tables t
    ON t.table_schema = 'public'
   AND t.table_name = r.table_name
),
required_columns(table_name, column_name) AS (
  VALUES
    ('applications', 'placement_drive_id'),
    ('emails', 'placement_drive_id'),
    ('emails', 'assignment_state'),
    ('emails', 'assignment_confidence'),
    ('emails', 'assignment_source'),
    ('events', 'placement_drive_id'),
    ('candidate_matches', 'placement_drive_id'),
    ('candidate_matches', 'application_id'),
    ('notifications', 'placement_drive_id')
),
column_checks AS (
  SELECT
    'column.' || r.table_name || '.' || r.column_name AS check_name,
    CASE WHEN c.column_name IS NULL THEN 'FAIL' ELSE 'PASS' END AS status,
    CASE WHEN c.column_name IS NULL
      THEN 'Column is missing'
      ELSE 'Column exists as ' || c.data_type
    END AS details
  FROM required_columns r
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public'
   AND c.table_name = r.table_name
   AND c.column_name = r.column_name
),
required_foreign_keys(constraint_name, table_name, target_table) AS (
  VALUES
    ('placement_drives_user_id_fkey', 'placement_drives', 'users'),
    ('placement_drives_company_id_fkey', 'placement_drives', 'companies'),
    ('email_drive_links_user_id_fkey', 'email_drive_links', 'users'),
    ('email_drive_links_email_id_fkey', 'email_drive_links', 'emails'),
    ('email_drive_links_drive_id_fkey', 'email_drive_links', 'placement_drives'),
    ('applications_placement_drive_id_fkey', 'applications', 'placement_drives'),
    ('emails_placement_drive_id_fkey', 'emails', 'placement_drives'),
    ('events_placement_drive_id_fkey', 'events', 'placement_drives'),
    ('candidate_matches_placement_drive_id_fkey', 'candidate_matches', 'placement_drives'),
    ('candidate_matches_application_id_fkey', 'candidate_matches', 'applications'),
    ('notifications_placement_drive_id_fkey', 'notifications', 'placement_drives')
),
foreign_key_checks AS (
  SELECT
    'foreign_key.' || r.constraint_name AS check_name,
    CASE
      WHEN c.oid IS NULL THEN 'FAIL'
      WHEN target.relname IS DISTINCT FROM r.target_table THEN 'FAIL'
      ELSE 'PASS'
    END AS status,
    CASE
      WHEN c.oid IS NULL THEN 'Foreign key constraint is missing'
      WHEN target.relname IS DISTINCT FROM r.target_table
        THEN 'Targets ' || COALESCE(target.relname, '<missing>') || ', expected ' || r.target_table
      ELSE 'Foreign key exists and targets ' || r.target_table
    END AS details
  FROM required_foreign_keys r
  LEFT JOIN pg_constraint c
    ON c.conname = r.constraint_name
   AND c.contype = 'f'
   AND c.connamespace = 'public'::regnamespace
  LEFT JOIN pg_class target ON target.oid = c.confrelid
),
required_indexes(index_name, table_name) AS (
  VALUES
    ('idx_placement_drives_user_drive_number', 'placement_drives'),
    ('idx_placement_drives_user', 'placement_drives'),
    ('idx_placement_drives_company', 'placement_drives'),
    ('idx_placement_drives_state', 'placement_drives'),
    ('idx_applications_user_drive', 'applications'),
    ('idx_applications_drive', 'applications'),
    ('idx_emails_drive', 'emails'),
    ('idx_emails_assignment', 'emails'),
    ('idx_events_drive', 'events'),
    ('idx_candidate_matches_drive', 'candidate_matches'),
    ('idx_candidate_matches_application', 'candidate_matches'),
    ('idx_notifications_drive', 'notifications'),
    ('idx_email_drive_links_email', 'email_drive_links'),
    ('idx_email_drive_links_drive', 'email_drive_links')
),
index_checks AS (
  SELECT
    'index.' || r.index_name AS check_name,
    CASE
      WHEN i.indexname IS NULL THEN 'FAIL'
      WHEN i.tablename <> r.table_name THEN 'FAIL'
      ELSE 'PASS'
    END AS status,
    CASE
      WHEN i.indexname IS NULL THEN 'Index is missing'
      WHEN i.tablename <> r.table_name
        THEN 'Index belongs to ' || i.tablename || ', expected ' || r.table_name
      ELSE i.indexdef
    END AS details
  FROM required_indexes r
  LEFT JOIN pg_indexes i
    ON i.schemaname = 'public'
   AND i.indexname = r.index_name
),
checks AS (
  SELECT * FROM table_checks
  UNION ALL SELECT * FROM column_checks
  UNION ALL SELECT * FROM foreign_key_checks
  UNION ALL SELECT * FROM index_checks
),
overall AS (
  SELECT
    'OVERALL' AS check_name,
    CASE WHEN EXISTS (SELECT 1 FROM checks WHERE status = 'FAIL')
      THEN 'FAIL' ELSE 'PASS' END AS status,
    CASE WHEN EXISTS (SELECT 1 FROM checks WHERE status = 'FAIL')
      THEN 'One or more v11 foundation objects are missing or inconsistent'
      ELSE 'All v11 foundation tables, columns, foreign keys, and indexes are present'
    END AS details
),
result_rows AS (
  SELECT check_name, status, details, 0 AS result_order FROM checks
  UNION ALL
  SELECT check_name, status, details, 1 AS result_order FROM overall
)
SELECT check_name, status, details
FROM result_rows
ORDER BY result_order, check_name;
