BEGIN;

ALTER TABLE public.canonical_emails
  ADD COLUMN IF NOT EXISTS message_id TEXT,
  ADD COLUMN IF NOT EXISTS body_text TEXT,
  ADD COLUMN IF NOT EXISTS identity_version INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS has_attachments BOOLEAN,
  ADD COLUMN IF NOT EXISTS metadata_key TEXT;

-- V20 rows used the old first-500-character identity and have no full body.
-- Keep them readable for legacy fallback, but prevent them from being cache hits.
UPDATE public.canonical_emails
SET identity_version = 1
WHERE body_text IS NULL AND identity_version = 2;

CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_emails_message_id
  ON public.canonical_emails (lower(message_id))
  WHERE message_id IS NOT NULL AND message_id <> '';

CREATE INDEX IF NOT EXISTS idx_canonical_emails_identity_version_key
  ON public.canonical_emails (identity_version, content_key);

CREATE INDEX IF NOT EXISTS idx_canonical_emails_message_metadata
  ON public.canonical_emails (lower(message_id), metadata_key)
  WHERE message_id IS NOT NULL AND message_id <> '';

ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS rfc_message_id TEXT;

CREATE INDEX IF NOT EXISTS idx_emails_rfc_message_id
  ON public.emails (lower(rfc_message_id))
  WHERE rfc_message_id IS NOT NULL AND rfc_message_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_attachments_email_attachment
  ON public.canonical_attachments (canonical_email_id, attachment_id);

ALTER TABLE public.canonical_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canonical_attachments ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  CREATE POLICY canonical_emails_authenticated_read
    ON public.canonical_emails FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY canonical_attachments_authenticated_read
    ON public.canonical_attachments FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
