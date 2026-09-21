-- ============================================
-- NeoTrack Database Migration v2
-- 1. Adds 'not_shortlisted' to applications.status check constraint
-- 2. Adds 'ppt_scheduled' to notifications.type check constraint
-- 3. Creates push_subscriptions & notification_preferences tables
-- 4. Adds dedupe_key and relational fields to notifications
-- ============================================

-- 1. Update applications status check constraint to include 'not_shortlisted'
ALTER TABLE public.applications DROP CONSTRAINT IF EXISTS applications_status_check;
ALTER TABLE public.applications ADD CONSTRAINT applications_status_check CHECK (
  status = ANY (ARRAY[
    'not_applied'::text,
    'applied'::text,
    'shortlisted'::text,
    'not_shortlisted'::text,
    'ppt_scheduled'::text,
    'test_scheduled'::text,
    'interview_scheduled'::text,
    'selected'::text,
    'rejected'::text,
    'withdrawn'::text,
    'declined'::text,
    'offer_received'::text,
    'unknown'::text
  ])
);

-- 2. Update notifications type check constraint to include 'ppt_scheduled'
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (
  type = ANY (ARRAY[
    'new_company'::text,
    'shortlist_match'::text,
    'test_scheduled'::text,
    'interview_scheduled'::text,
    'ppt_scheduled'::text,
    'deadline_approaching'::text,
    'status_change'::text,
    'sync_complete'::text,
    'general'::text
  ])
);

-- 3. Push Subscriptions Table
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON public.push_subscriptions(user_id);

-- 4. Notification Preferences Table
CREATE TABLE IF NOT EXISTS public.notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  browser_push_enabled BOOLEAN DEFAULT TRUE,
  in_app_enabled BOOLEAN DEFAULT TRUE,
  notify_status_change BOOLEAN DEFAULT TRUE,
  notify_shortlist BOOLEAN DEFAULT TRUE,
  notify_tests BOOLEAN DEFAULT TRUE,
  notify_interviews BOOLEAN DEFAULT TRUE,
  notify_ppt BOOLEAN DEFAULT TRUE,
  notify_new_jds BOOLEAN DEFAULT TRUE,
  notify_reminders BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Notifications table enhancements
ALTER TABLE public.notifications 
  ADD COLUMN IF NOT EXISTS body TEXT,
  ADD COLUMN IF NOT EXISTS link TEXT,
  ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES public.events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES public.applications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_notifications_dedupe ON public.notifications(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON public.notifications(user_id, created_at DESC);
