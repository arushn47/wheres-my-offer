import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { currentMutationLease } from '@/lib/sync/lease-context';
import { measuredAdminFetch } from './query-metrics';

/**
 * Creates a Supabase admin client using the service role key.
 * This bypasses RLS and should ONLY be used in server-side operations
 * like the sync engine where we need to write data on behalf of the user.
 *
 * NEVER expose this client to the frontend.
 */
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      global: {
        fetch: (input, init) => {
          const lease = currentMutationLease();
          const headers = new Headers(init?.headers);
          if (lease) headers.set('x-sync-run-id', lease.runId);
          return measuredAdminFetch(input, { ...init, headers });
        },
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}
