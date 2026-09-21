-- V20: Canonical email deduplication tables.
-- Stores shared broadcast email content once, linked via FK from per-user emails rows.
-- Run in Supabase SQL Editor. Zero-downtime -- additive only, no existing tables altered destructively.

BEGIN;

-- ============================================================
-- canonical_emails: one row per unique broadcast email body
-- Only college circulars (vitlions2027@vitbhopal.ac.in) are
-- canonicalized. Personal NeoPAT emails remain fully per-user.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.canonical_emails (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  content_key              TEXT        NOT NULL UNIQUE,
  sender_email             TEXT        NOT NULL,
  subject                  TEXT        NOT NULL,
  body_snippet             TEXT,
  classification           TEXT,
  classification_confidence REAL,
  parsed_company_name      TEXT,
  parsed_drive_numbers     JSONB,
  parsed_job_details       JSONB,
  parsed_events            JSONB,
  parser_version           INTEGER     NOT NULL DEFAULT 1,
  processing_status        TEXT        NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processing', 'complete', 'error')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_canonical_emails_content_key
  ON public.canonical_emails (content_key);

CREATE INDEX IF NOT EXISTS idx_canonical_emails_status
  ON public.canonical_emails (processing_status)
  WHERE processing_status != 'complete';

-- ============================================================
-- canonical_attachments: one row per unique Excel/attachment
-- ============================================================
CREATE TABLE IF NOT EXISTS public.canonical_attachments (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_email_id  UUID        NOT NULL REFERENCES public.canonical_emails(id) ON DELETE CASCADE,
  gmail_message_id    TEXT        NOT NULL,
  gmail_account_id    UUID        NOT NULL,
  attachment_id       TEXT        NOT NULL,
  filename            TEXT,
  size_bytes          BIGINT,
  content_hash        TEXT        UNIQUE,
  extracted_rows      JSONB,
  parse_status        TEXT        NOT NULL DEFAULT 'pending'
    CHECK (parse_status IN ('pending', 'processing', 'complete', 'error')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_canonical_attachments_email_id
  ON public.canonical_attachments (canonical_email_id);

-- ============================================================
-- Add nullable FK from emails to canonical_emails.
-- Old rows stay NULL. Only new emails after deployment get the pointer.
-- ============================================================
ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS canonical_email_id UUID
  REFERENCES public.canonical_emails(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_emails_canonical_email_id
  ON public.emails (canonical_email_id)
  WHERE canonical_email_id IS NOT NULL;

COMMIT;
