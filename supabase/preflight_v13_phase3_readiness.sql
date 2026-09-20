-- Phase 3 production readiness report.
-- READ ONLY: this file contains SELECTs only. Do not replace with UPDATE/DELETE.
-- Run after migration_v13_phase3_functions.sql has been reviewed/applied.

-- 1. Per-user scope counts.
SELECT
  u.id AS user_id,
  u.email,
  (SELECT COUNT(*) FROM public.companies c WHERE c.user_id = u.id) AS companies,
  (SELECT COUNT(*) FROM public.placement_drives d WHERE d.user_id = u.id) AS placement_drives,
  (SELECT COUNT(*) FROM public.emails e WHERE e.user_id = u.id AND e.placement_drive_id IS NOT NULL) AS drive_owned_emails,
  (SELECT COUNT(*) FROM public.emails e WHERE e.user_id = u.id AND e.placement_drive_id IS NULL AND e.assignment_state = 'legacy') AS legacy_emails,
  (SELECT COUNT(*) FROM public.emails e WHERE e.user_id = u.id AND e.placement_drive_id IS NULL AND e.assignment_state IN ('ambiguous', 'conflict', 'unassigned')) AS quarantine_emails,
  (SELECT COUNT(*) FROM public.applications a WHERE a.user_id = u.id AND a.placement_drive_id IS NOT NULL) AS drive_owned_applications,
  (SELECT COUNT(*) FROM public.applications a WHERE a.user_id = u.id AND a.placement_drive_id IS NULL) AS legacy_applications,
  (SELECT COUNT(*) FROM public.events e WHERE e.user_id = u.id AND e.placement_drive_id IS NOT NULL) AS drive_owned_events,
  (SELECT COUNT(*) FROM public.events e WHERE e.user_id = u.id AND e.placement_drive_id IS NULL) AS legacy_events,
  (SELECT COUNT(*) FROM public.candidate_matches cm WHERE cm.user_id = u.id) AS candidate_matches,
  (SELECT COUNT(*) FROM public.notifications n WHERE n.user_id = u.id) AS notifications
FROM public.users u
ORDER BY u.email;

-- 2. Inconsistency/error summary per user.
SELECT user_id, issue, COUNT(*) AS row_count
FROM (
  SELECT a.user_id, 'application_drive_company_mismatch' AS issue
  FROM public.applications a
  JOIN public.placement_drives d ON d.id = a.placement_drive_id
  WHERE a.user_id IS DISTINCT FROM d.user_id OR a.company_id IS DISTINCT FROM d.company_id
  UNION ALL
  SELECT e.user_id, 'event_drive_company_mismatch'
  FROM public.events e
  JOIN public.placement_drives d ON d.id = e.placement_drive_id
  WHERE e.user_id IS DISTINCT FROM d.user_id OR e.company_id IS DISTINCT FROM d.company_id
  UNION ALL
  SELECT e.user_id, 'event_application_drive_mismatch'
  FROM public.events e
  JOIN public.applications a ON a.id = e.application_id
  WHERE e.placement_drive_id IS DISTINCT FROM a.placement_drive_id
  UNION ALL
  SELECT cm.user_id, 'candidate_match_application_drive_mismatch'
  FROM public.candidate_matches cm
  JOIN public.applications a ON a.id = cm.application_id
  WHERE cm.placement_drive_id IS DISTINCT FROM a.placement_drive_id
  UNION ALL
  SELECT cm.user_id, 'candidate_match_email_drive_mismatch'
  FROM public.candidate_matches cm
  JOIN public.emails e ON e.id = cm.email_id
  WHERE cm.placement_drive_id IS DISTINCT FROM e.placement_drive_id
  UNION ALL
  SELECT n.user_id, 'notification_event_drive_mismatch'
  FROM public.notifications n
  JOIN public.events e ON e.id = n.event_id
  WHERE n.placement_drive_id IS DISTINCT FROM e.placement_drive_id
  UNION ALL
  SELECT n.user_id, 'notification_application_drive_mismatch'
  FROM public.notifications n
  JOIN public.applications a ON a.id = n.application_id
  WHERE n.placement_drive_id IS DISTINCT FROM a.placement_drive_id
  UNION ALL
  SELECT d.user_id, 'orphaned_drive_company'
  FROM public.placement_drives d
  LEFT JOIN public.companies c ON c.id = d.company_id
  WHERE c.id IS NULL OR c.user_id IS DISTINCT FROM d.user_id
  UNION ALL
  SELECT a.user_id, 'orphaned_application_drive'
  FROM public.applications a
  LEFT JOIN public.placement_drives d ON d.id = a.placement_drive_id
  WHERE a.placement_drive_id IS NOT NULL AND d.id IS NULL
  UNION ALL
  SELECT e.user_id, 'orphaned_email_drive'
  FROM public.emails e
  LEFT JOIN public.placement_drives d ON d.id = e.placement_drive_id
  WHERE e.placement_drive_id IS NOT NULL AND d.id IS NULL
  UNION ALL
  SELECT e.user_id, 'orphaned_event_drive'
  FROM public.events e
  LEFT JOIN public.placement_drives d ON d.id = e.placement_drive_id
  WHERE e.placement_drive_id IS NOT NULL AND d.id IS NULL
  UNION ALL
  SELECT cm.user_id, 'orphaned_candidate_match_drive'
  FROM public.candidate_matches cm
  LEFT JOIN public.placement_drives d ON d.id = cm.placement_drive_id
  WHERE cm.placement_drive_id IS NOT NULL AND d.id IS NULL
  UNION ALL
  SELECT n.user_id, 'orphaned_notification_drive'
  FROM public.notifications n
  LEFT JOIN public.placement_drives d ON d.id = n.placement_drive_id
  WHERE n.placement_drive_id IS NOT NULL AND d.id IS NULL
) issues
GROUP BY user_id, issue
ORDER BY user_id, issue;

-- 3. Exact drive-owned record counts by tenant/company/drive.
SELECT
  d.user_id,
  d.company_id,
  c.name AS company_name,
  d.id AS placement_drive_id,
  d.normalized_drive_number,
  COUNT(DISTINCT e.id) AS emails,
  COUNT(DISTINCT a.id) AS applications,
  COUNT(DISTINCT ev.id) AS events,
  COUNT(DISTINCT cm.id) AS candidate_matches,
  COUNT(DISTINCT n.id) AS notifications
FROM public.placement_drives d
JOIN public.companies c ON c.id = d.company_id
LEFT JOIN public.emails e ON e.placement_drive_id = d.id
LEFT JOIN public.applications a ON a.placement_drive_id = d.id
LEFT JOIN public.events ev ON ev.placement_drive_id = d.id
LEFT JOIN public.candidate_matches cm ON cm.placement_drive_id = d.id
LEFT JOIN public.notifications n ON n.placement_drive_id = d.id
GROUP BY d.user_id, d.company_id, c.name, d.id, d.normalized_drive_number
ORDER BY d.user_id, c.name, d.normalized_drive_number;

-- 4. Whirlpool isolation. This returns the two requested drives and flags any
-- dependent row whose company/tenant does not match its drive. It does not repair.
WITH whirlpool_drives AS (
  SELECT d.id, d.user_id, d.company_id, d.normalized_drive_number
  FROM public.placement_drives d
  JOIN public.companies c ON c.id = d.company_id
  WHERE lower(c.name) = 'whirlpool'
    AND d.normalized_drive_number IN ('1204', '1317')
)
SELECT
  wd.normalized_drive_number,
  wd.id AS placement_drive_id,
  'email' AS record_type,
  e.id AS record_id,
  CASE WHEN e.user_id = wd.user_id AND e.company_id = wd.company_id AND e.placement_drive_id = wd.id THEN 'PASS' ELSE 'CONFLICT' END AS status
FROM whirlpool_drives wd
JOIN public.emails e ON e.placement_drive_id = wd.id
UNION ALL
SELECT wd.normalized_drive_number, wd.id, 'application', a.id,
  CASE WHEN a.user_id = wd.user_id AND a.company_id = wd.company_id AND a.placement_drive_id = wd.id THEN 'PASS' ELSE 'CONFLICT' END
FROM whirlpool_drives wd JOIN public.applications a ON a.placement_drive_id = wd.id
UNION ALL
SELECT wd.normalized_drive_number, wd.id, 'event', e.id,
  CASE WHEN e.user_id = wd.user_id AND e.company_id = wd.company_id AND e.placement_drive_id = wd.id THEN 'PASS' ELSE 'CONFLICT' END
FROM whirlpool_drives wd JOIN public.events e ON e.placement_drive_id = wd.id
UNION ALL
SELECT wd.normalized_drive_number, wd.id, 'candidate_match', cm.id,
  CASE WHEN cm.user_id = wd.user_id AND cm.placement_drive_id = wd.id THEN 'PASS' ELSE 'CONFLICT' END
FROM whirlpool_drives wd JOIN public.candidate_matches cm ON cm.placement_drive_id = wd.id
UNION ALL
SELECT wd.normalized_drive_number, wd.id, 'notification', n.id,
  CASE WHEN n.user_id = wd.user_id AND n.company_id = wd.company_id AND n.placement_drive_id = wd.id THEN 'PASS' ELSE 'CONFLICT' END
FROM whirlpool_drives wd JOIN public.notifications n ON n.placement_drive_id = wd.id
ORDER BY normalized_drive_number, record_type, record_id;

-- 5. Legacy Whirlpool rows must remain explicitly null-drive.
SELECT
  c.name AS company_name,
  e.id AS email_id,
  e.placement_drive_id,
  CASE WHEN e.placement_drive_id IS NULL THEN 'PASS' ELSE 'CONFLICT' END AS status
FROM public.emails e
JOIN public.companies c ON c.id = e.company_id
WHERE lower(c.name) = 'whirlpool'
  AND e.assignment_state IN ('legacy', 'ambiguous', 'conflict', 'unassigned')
ORDER BY e.id;
