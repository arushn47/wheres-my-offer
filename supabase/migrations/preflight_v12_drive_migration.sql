-- ============================================================
-- Migration v12 focused read-only preflight
-- ============================================================
-- Run after migration_v11 has been applied and verified.
-- READ ONLY: SELECT/catalog queries only. This file does not execute v12,
-- modify data, classify records, or repair conflicts.
--
-- Result columns:
--   check_name | status (PASS/WARN/BLOCKED) | details
-- The final OVERALL row is BLOCKED when a v12 technical prerequisite fails,
-- WARN when only legacy/review data exists, and PASS otherwise.

WITH
checks AS (
  -- v12 adds identity_scope. It is expected to be absent before v12.
  SELECT
    'applications.identity_scope' AS check_name,
    CASE WHEN EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'applications'
        AND column_name = 'identity_scope'
    ) THEN 'WARN' ELSE 'PASS' END AS status,
    CASE WHEN EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'applications'
        AND column_name = 'identity_scope'
    ) THEN 'Column already exists; v12 must preserve and validate its values'
    ELSE 'Column is absent as expected; v12 will add it'
    END AS details

  UNION ALL

  SELECT
    'applications.duplicate_drive_identity',
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.applications
      WHERE placement_drive_id IS NOT NULL
      GROUP BY user_id, placement_drive_id
      HAVING COUNT(*) > 1
    ) THEN 'BLOCKED' ELSE 'PASS' END,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.applications
      WHERE placement_drive_id IS NOT NULL
      GROUP BY user_id, placement_drive_id
      HAVING COUNT(*) > 1
    ) THEN 'Duplicate (user_id, placement_drive_id) applications would block the v12 unique index'
    ELSE 'No duplicate drive-owned application identities'
    END

  UNION ALL

  SELECT
    'applications.duplicate_legacy_identity',
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.applications
      WHERE placement_drive_id IS NULL
      GROUP BY user_id, company_id
      HAVING COUNT(*) > 1
    ) THEN 'BLOCKED' ELSE 'PASS' END,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.applications
      WHERE placement_drive_id IS NULL
      GROUP BY user_id, company_id
      HAVING COUNT(*) > 1
    ) THEN 'Duplicate legacy (user_id, company_id) applications would block the v12 legacy unique index'
    ELSE 'No duplicate legacy application identities'
    END

  UNION ALL

  SELECT
    'applications.drive_ownership',
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.applications a
      JOIN public.placement_drives d ON d.id = a.placement_drive_id
      WHERE a.placement_drive_id IS NOT NULL
        AND (a.user_id <> d.user_id OR a.company_id <> d.company_id)
    ) THEN 'BLOCKED' ELSE 'PASS' END,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.applications a
      JOIN public.placement_drives d ON d.id = a.placement_drive_id
      WHERE a.placement_drive_id IS NOT NULL
        AND (a.user_id <> d.user_id OR a.company_id <> d.company_id)
    ) THEN 'Drive-owned applications disagree with drive user/company ownership'
    ELSE 'Application and drive ownership agrees'
    END

  UNION ALL

  SELECT
    'placement_drives.orphans',
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.placement_drives d
      LEFT JOIN public.companies c ON c.id = d.company_id
      WHERE c.id IS NULL OR d.user_id <> c.user_id
    ) THEN 'BLOCKED' ELSE 'PASS' END,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.placement_drives d
      LEFT JOIN public.companies c ON c.id = d.company_id
      WHERE c.id IS NULL OR d.user_id <> c.user_id
    ) THEN 'Placement drives have missing companies or cross-user company ownership'
    ELSE 'All placement drives reference companies owned by the same user'
    END

  UNION ALL

  SELECT
    'emails.drive_ownership',
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.emails e
      JOIN public.placement_drives d ON d.id = e.placement_drive_id
      WHERE e.placement_drive_id IS NOT NULL
        AND (e.user_id <> d.user_id OR (e.company_id IS NOT NULL AND e.company_id <> d.company_id))
    ) THEN 'BLOCKED' ELSE 'PASS' END,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.emails e
      JOIN public.placement_drives d ON d.id = e.placement_drive_id
      WHERE e.placement_drive_id IS NOT NULL
        AND (e.user_id <> d.user_id OR (e.company_id IS NOT NULL AND e.company_id <> d.company_id))
    ) THEN 'Drive-owned emails disagree with drive user/company ownership'
    ELSE 'Drive-owned email ownership agrees'
    END

  UNION ALL

  SELECT
    'emails.orphaned_drive_reference',
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.emails e
      LEFT JOIN public.placement_drives d ON d.id = e.placement_drive_id
      WHERE e.placement_drive_id IS NOT NULL AND d.id IS NULL
    ) THEN 'BLOCKED' ELSE 'PASS' END,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.emails e
      LEFT JOIN public.placement_drives d ON d.id = e.placement_drive_id
      WHERE e.placement_drive_id IS NOT NULL AND d.id IS NULL
    ) THEN 'Emails reference missing placement drives'
    ELSE 'No orphaned email drive references'
    END

  UNION ALL

  SELECT
    'emails.assignment_metadata',
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.emails
      WHERE (assignment_state IN ('assigned', 'manually_assigned') AND placement_drive_id IS NULL)
         OR (placement_drive_id IS NOT NULL AND assignment_state IN ('ambiguous', 'conflict', 'unassigned', 'legacy'))
    ) THEN 'BLOCKED' ELSE 'PASS' END,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.emails
      WHERE (assignment_state IN ('assigned', 'manually_assigned') AND placement_drive_id IS NULL)
         OR (placement_drive_id IS NOT NULL AND assignment_state IN ('ambiguous', 'conflict', 'unassigned', 'legacy'))
    ) THEN 'Email assignment state contradicts placement_drive_id ownership'
    ELSE 'No contradictory authoritative assignment metadata'
    END

  UNION ALL

  SELECT
    'emails.low_confidence',
    CASE WHEN EXISTS (SELECT 1 FROM public.emails WHERE assignment_confidence = 'low')
      THEN 'WARN' ELSE 'PASS' END,
    CASE WHEN EXISTS (SELECT 1 FROM public.emails WHERE assignment_confidence = 'low')
      THEN 'Low-confidence assignments require review and are not authoritative drive ownership'
    ELSE 'No low-confidence assignments'
    END

  UNION ALL

  SELECT
    'events.drive_ownership',
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.events e
      JOIN public.placement_drives d ON d.id = e.placement_drive_id
      WHERE e.placement_drive_id IS NOT NULL
        AND (e.user_id <> d.user_id OR e.company_id <> d.company_id)
    ) THEN 'BLOCKED' ELSE 'PASS' END,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.events e
      JOIN public.placement_drives d ON d.id = e.placement_drive_id
      WHERE e.placement_drive_id IS NOT NULL
        AND (e.user_id <> d.user_id OR e.company_id <> d.company_id)
    ) THEN 'Drive-owned events disagree with drive user/company ownership'
    ELSE 'Drive-owned event ownership agrees'
    END

  UNION ALL

  SELECT
    'events.application_drive_consistency',
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.events e
      JOIN public.applications a ON a.id = e.application_id
      WHERE e.placement_drive_id IS NOT NULL
        AND (a.user_id <> e.user_id OR a.company_id <> e.company_id OR a.placement_drive_id IS DISTINCT FROM e.placement_drive_id)
    ) THEN 'BLOCKED' ELSE 'PASS' END,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.events e
      JOIN public.applications a ON a.id = e.application_id
      WHERE e.placement_drive_id IS NOT NULL
        AND (a.user_id <> e.user_id OR a.company_id <> e.company_id OR a.placement_drive_id IS DISTINCT FROM e.placement_drive_id)
    ) THEN 'Event application_id does not belong to the event drive'
    ELSE 'Drive-owned event/application relationships agree'
    END

  UNION ALL

  SELECT
    'events.proposed_unique_identity',
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.events
      WHERE placement_drive_id IS NOT NULL AND start_time IS NOT NULL
      GROUP BY user_id, placement_drive_id, event_type, start_time
      HAVING COUNT(*) > 1
    ) THEN 'BLOCKED' ELSE 'PASS' END,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.events
      WHERE placement_drive_id IS NOT NULL AND start_time IS NOT NULL
      GROUP BY user_id, placement_drive_id, event_type, start_time
      HAVING COUNT(*) > 1
    ) THEN 'Duplicate rows would block the proposed drive event unique index'
    ELSE 'No proposed drive event uniqueness collisions'
    END

  UNION ALL

  SELECT
    'candidate_matches.drive_email_application_consistency',
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.candidate_matches cm
      LEFT JOIN public.placement_drives d ON d.id = cm.placement_drive_id
      LEFT JOIN public.emails e ON e.id = cm.email_id
      LEFT JOIN public.applications a ON a.id = cm.application_id
      WHERE cm.placement_drive_id IS NOT NULL
        AND (
          d.id IS NULL
          OR cm.user_id <> d.user_id
          OR (e.placement_drive_id IS NOT NULL AND e.placement_drive_id <> cm.placement_drive_id)
          OR (a.id IS NOT NULL AND (a.user_id <> cm.user_id OR a.placement_drive_id IS DISTINCT FROM cm.placement_drive_id))
        )
    ) THEN 'BLOCKED' ELSE 'PASS' END,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.candidate_matches cm
      LEFT JOIN public.placement_drives d ON d.id = cm.placement_drive_id
      LEFT JOIN public.emails e ON e.id = cm.email_id
      LEFT JOIN public.applications a ON a.id = cm.application_id
      WHERE cm.placement_drive_id IS NOT NULL
        AND (
          d.id IS NULL
          OR cm.user_id <> d.user_id
          OR (e.placement_drive_id IS NOT NULL AND e.placement_drive_id <> cm.placement_drive_id)
          OR (a.id IS NOT NULL AND (a.user_id <> cm.user_id OR a.placement_drive_id IS DISTINCT FROM cm.placement_drive_id))
        )
    ) THEN 'Candidate matches disagree with drive, email, or application ownership'
    ELSE 'Drive-owned candidate match relationships agree'
    END

  UNION ALL

  SELECT
    'candidate_matches.proposed_unique_identity',
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.candidate_matches
      WHERE placement_drive_id IS NOT NULL
      GROUP BY user_id, email_id, placement_drive_id, neo_id, match_type
      HAVING COUNT(*) > 1
    ) THEN 'BLOCKED' ELSE 'PASS' END,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.candidate_matches
      WHERE placement_drive_id IS NOT NULL
      GROUP BY user_id, email_id, placement_drive_id, neo_id, match_type
      HAVING COUNT(*) > 1
    ) THEN 'Duplicate rows would block the proposed drive candidate-match unique index'
    ELSE 'No proposed drive candidate-match uniqueness collisions'
    END

  UNION ALL

  SELECT
    'notifications.drive_application_event_consistency',
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.notifications n
      LEFT JOIN public.placement_drives d ON d.id = n.placement_drive_id
      LEFT JOIN public.applications a ON a.id = n.application_id
      LEFT JOIN public.events e ON e.id = n.event_id
      WHERE n.placement_drive_id IS NOT NULL
        AND (
          d.id IS NULL
          OR n.user_id <> d.user_id
          OR (a.id IS NOT NULL AND (a.user_id <> n.user_id OR a.placement_drive_id IS DISTINCT FROM n.placement_drive_id))
          OR (e.id IS NOT NULL AND (e.user_id <> n.user_id OR e.placement_drive_id IS DISTINCT FROM n.placement_drive_id))
        )
    ) THEN 'BLOCKED' ELSE 'PASS' END,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.notifications n
      LEFT JOIN public.placement_drives d ON d.id = n.placement_drive_id
      LEFT JOIN public.applications a ON a.id = n.application_id
      LEFT JOIN public.events e ON e.id = n.event_id
      WHERE n.placement_drive_id IS NOT NULL
        AND (
          d.id IS NULL
          OR n.user_id <> d.user_id
          OR (a.id IS NOT NULL AND (a.user_id <> n.user_id OR a.placement_drive_id IS DISTINCT FROM n.placement_drive_id))
          OR (e.id IS NOT NULL AND (e.user_id <> n.user_id OR e.placement_drive_id IS DISTINCT FROM n.placement_drive_id))
        )
    ) THEN 'Drive-owned notification relationships disagree'
    ELSE 'Drive-owned notification relationships agree'
    END

  UNION ALL

  SELECT
    'identity_scope.current_values',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'applications' AND column_name = 'identity_scope'
    ) THEN 'WARN' ELSE 'PASS' END,
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'applications' AND column_name = 'identity_scope'
    ) THEN 'identity_scope already exists; validate values before v12'
    ELSE 'identity_scope is absent and will be added by v12'
    END

  UNION ALL

  SELECT
    'legacy_records',
    CASE WHEN EXISTS (SELECT 1 FROM public.applications WHERE placement_drive_id IS NULL)
      OR EXISTS (SELECT 1 FROM public.candidate_matches WHERE placement_drive_id IS NULL)
      THEN 'WARN' ELSE 'PASS' END,
    'Legacy company-scoped rows require an explicit historical migration policy'
),
overall AS (
  SELECT
    'OVERALL' AS check_name,
    CASE
      WHEN EXISTS (SELECT 1 FROM checks WHERE status = 'BLOCKED') THEN 'BLOCKED'
      WHEN EXISTS (SELECT 1 FROM checks WHERE status = 'WARN') THEN 'REVIEW_REQUIRED'
      ELSE 'READY'
    END AS status,
    CASE
      WHEN EXISTS (SELECT 1 FROM checks WHERE status = 'BLOCKED')
        THEN 'Technical data conflicts must be resolved before migration_v12'
      WHEN EXISTS (SELECT 1 FROM checks WHERE status = 'WARN')
        THEN 'No technical blocker reported, but review legacy and existing identity_scope rows before migration_v12'
      ELSE 'No reported v12 blockers or warnings'
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
