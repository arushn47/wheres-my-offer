-- ============================================
-- Migration v8: Notification Preferences Reminder Customization
-- ============================================
-- Run this in the Supabase SQL Editor.

ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS reminder_event_types TEXT[] DEFAULT ARRAY['online_test', 'coding_test', 'technical_interview', 'hr_interview', 'final_interview', 'ppt', 'registration_deadline'],
  ADD COLUMN IF NOT EXISTS reminder_lead_time_mins INTEGER[] DEFAULT ARRAY[1440, 120, 15];
