BEGIN;

-- 1. Composite indexes for high-frequency queries
CREATE INDEX IF NOT EXISTS idx_canonical_emails_status_identity
  ON public.canonical_emails (processing_status, identity_version);

CREATE INDEX IF NOT EXISTS idx_emails_user_sender_received
  ON public.emails (user_id, sender, received_at);

CREATE INDEX IF NOT EXISTS idx_emails_user_unlinked_canonical
  ON public.emails (user_id)
  WHERE canonical_email_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_user_type_created
  ON public.notifications (user_id, type, created_at);

CREATE INDEX IF NOT EXISTS idx_sync_pages_account_status
  ON public.sync_pages (gmail_account_id, status);

-- 2. RBAC column for users table (Phase E7 admin panel)
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user' CHECK (role IN ('user', 'admin'));

CREATE INDEX IF NOT EXISTS idx_users_role
  ON public.users (role);

-- 3. Truncate existing body_snippet for emails already linked to a canonical row (saves ~40MB/user)
UPDATE public.emails
SET body_snippet = substring(body_snippet FROM 1 FOR 500)
WHERE canonical_email_id IS NOT NULL AND length(body_snippet) > 500;

COMMIT;
