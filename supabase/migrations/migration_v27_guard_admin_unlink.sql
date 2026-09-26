-- V27: Permanently protect admin-unlinked emails from being re-assigned.
-- ==============================================================
-- Background:
--   The "unlink" action marks an email receipt with assignment_source='admin_unlinked'
--   (placement_drive_id=null). A concurrent sync or bulk reprocess can load that email's
--   OLD drive assignment, then write it back AFTER the unlink, resurrecting the email.
--   Read-time guards can't prevent that write-after-unlink race.
--
-- Fix:
--   A BEFORE UPDATE trigger on emails that RAISES an error whenever an update tries to
--   assign a placement_drive_id to a receipt already marked 'admin_unlinked'. The admin
--   manual-link endpoint is the only path that may lift this marker; it is allowed because
--   lifting requires changing assignment_source away from 'admin_unlinked' (an explicit
--   admin act) in the SAME UPDATE statement that sets placement_drive_id.
--
-- Safe to re-run (idempotent).

CREATE OR REPLACE FUNCTION public.guard_admin_unlinked_email()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $func$
BEGIN
  -- Block only if the row is admin-unlinked AND the update tries to set a drive
  -- WITHOUT simultaneously changing assignment_source away from 'admin_unlinked'.
  IF OLD.assignment_source = 'admin_unlinked'
     AND NEW.placement_drive_id IS NOT NULL
     AND OLD.placement_drive_id IS DISTINCT FROM NEW.placement_drive_id
     AND NEW.assignment_source = 'admin_unlinked' THEN
    RAISE EXCEPTION
      'Email % is admin-unlinked and cannot be re-assigned. Only the admin link action may restore it.',
      OLD.id;
  END IF;
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS trg_emails_guard_admin_unlink ON public.emails;

CREATE TRIGGER trg_emails_guard_admin_unlink
  BEFORE UPDATE ON public.emails
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_admin_unlinked_email();
