-- V18: durable Gmail Pub/Sub inbox for replay-safe webhook delivery.
-- Not executed automatically. Do not run as part of this code change.

BEGIN;

CREATE TABLE IF NOT EXISTS public.gmail_pubsub_inbox (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  subscription TEXT NOT NULL,
  message_id TEXT NOT NULL,
  email_address TEXT NOT NULL,
  history_id TEXT,
  publish_time TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'failed')),
  run_id UUID,
  attempts INTEGER NOT NULL DEFAULT 1,
  locked_until TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '2 minutes'),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gmail_pubsub_inbox_pkey PRIMARY KEY (id),
  CONSTRAINT gmail_pubsub_inbox_message_unique UNIQUE (subscription, message_id)
);

CREATE INDEX IF NOT EXISTS idx_gmail_pubsub_inbox_processing
  ON public.gmail_pubsub_inbox (status, locked_until);

CREATE OR REPLACE FUNCTION public.claim_gmail_pubsub_message(
  p_subscription TEXT,
  p_message_id TEXT,
  p_email_address TEXT,
  p_history_id TEXT,
  p_publish_time TIMESTAMPTZ,
  p_run_id UUID,
  p_lease_seconds INTEGER DEFAULT 120
)
RETURNS BOOLEAN
LANGUAGE SQL
VOLATILE
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.gmail_pubsub_inbox (
    subscription, message_id, email_address, history_id, publish_time,
    status, run_id, attempts, locked_until, updated_at
  )
  VALUES (
    p_subscription, p_message_id, p_email_address, p_history_id, p_publish_time,
    'processing', p_run_id, 1,
    NOW() + make_interval(secs => GREATEST(30, LEAST(p_lease_seconds, 900))), NOW()
  )
  ON CONFLICT (subscription, message_id) DO UPDATE
  SET status = 'processing',
      email_address = EXCLUDED.email_address,
      history_id = EXCLUDED.history_id,
      publish_time = EXCLUDED.publish_time,
      run_id = EXCLUDED.run_id,
      attempts = gmail_pubsub_inbox.attempts + 1,
      locked_until = NOW() + make_interval(secs => GREATEST(30, LEAST(p_lease_seconds, 900))),
      last_error = NULL,
      updated_at = NOW()
  WHERE gmail_pubsub_inbox.status = 'failed'
     OR gmail_pubsub_inbox.locked_until <= NOW()
  RETURNING TRUE;
$$;

CREATE OR REPLACE FUNCTION public.complete_gmail_pubsub_message(
  p_subscription TEXT,
  p_message_id TEXT,
  p_run_id UUID
)
RETURNS BOOLEAN
LANGUAGE SQL
VOLATILE
SET search_path = public, pg_temp
AS $$
  UPDATE public.gmail_pubsub_inbox
  SET status = 'completed', locked_until = NOW(), updated_at = NOW(), last_error = NULL
  WHERE subscription = p_subscription AND message_id = p_message_id
    AND run_id = p_run_id AND status = 'processing'
  RETURNING TRUE;
$$;

CREATE OR REPLACE FUNCTION public.fail_gmail_pubsub_message(
  p_subscription TEXT,
  p_message_id TEXT,
  p_run_id UUID,
  p_error TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
VOLATILE
SET search_path = public, pg_temp
AS $$
  UPDATE public.gmail_pubsub_inbox
  SET status = 'failed', locked_until = NOW(), updated_at = NOW(), last_error = LEFT(p_error, 2000)
  WHERE subscription = p_subscription AND message_id = p_message_id
    AND run_id = p_run_id AND status = 'processing'
  RETURNING TRUE;
$$;

REVOKE ALL ON FUNCTION public.claim_gmail_pubsub_message(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_gmail_pubsub_message(TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_gmail_pubsub_message(TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_gmail_pubsub_message(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_gmail_pubsub_message(TEXT, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_gmail_pubsub_message(TEXT, TEXT, UUID, TEXT) TO service_role;

COMMIT;
