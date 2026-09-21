-- Phase 1: enforce tenant isolation for user-owned tables.
-- Service-role operations continue to work because Supabase service_role bypasses RLS.

BEGIN;

DO $$
DECLARE
  table_name text;
  user_owned_tables text[] := ARRAY[
    'gmail_accounts', 'companies', 'placement_drives', 'applications', 'emails',
    'email_drive_links', 'attachments', 'candidate_matches', 'events', 'documents',
    'notifications', 'push_subscriptions', 'notification_preferences', 'feedback_reports'
  ];
BEGIN
  FOREACH table_name IN ARRAY user_owned_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    BEGIN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())',
        table_name || '_tenant_isolation', table_name
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  CREATE POLICY users_tenant_isolation ON public.users
    FOR ALL TO authenticated
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.status_history ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  CREATE POLICY status_history_tenant_isolation ON public.status_history
    FOR ALL TO authenticated
    USING (EXISTS (
      SELECT 1 FROM public.applications a
      WHERE a.id = status_history.application_id AND a.user_id = auth.uid()
    ))
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.applications a
      WHERE a.id = status_history.application_id AND a.user_id = auth.uid()
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
