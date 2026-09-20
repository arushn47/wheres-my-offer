import { describe, expect, it } from 'vitest';
import {
  createSupabaseDiscoveryReader,
  type Phase3DiscoverySupabaseClient,
  type Phase3DiscoveryTableQuery,
  type Phase3ReadQuery,
} from './discovery';

const USER_A = 'user-a';

function makeSupabase(
  rowsByTable: Record<string, Record<string, unknown>[]>,
  options?: { ignoreUserFilter?: boolean }
): Phase3DiscoverySupabaseClient & {
  calls: Array<{ table: string; column: string; value: string }>;
} {
  const calls: Array<{ table: string; column: string; value: string }> = [];
  return {
    calls,
    from(table) {
      let filter: { column: string; value: string } | null = null;
      const query: Phase3ReadQuery<Record<string, unknown>> = {
        eq(column: string, value: string) {
          filter = { column, value };
          calls.push({ table, column, value });
          return query;
        },
        then<TResult1 = { data: Record<string, unknown>[] | null; error: { message: string } | null }, TResult2 = never>(
          resolve?: ((value: { data: Record<string, unknown>[] | null; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
          reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ) {
          const rows = options?.ignoreUserFilter
            ? rowsByTable[table] || []
            : (rowsByTable[table] || []).filter((row) => !filter || row[filter.column] === filter.value);
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      const tableQuery: Phase3DiscoveryTableQuery = {
        select() {
          return query;
        },
      };
      return tableQuery;
    },
  };
}

describe('createSupabaseDiscoveryReader', () => {
  it('reads and maps all Phase 3 discovery tables with a user filter', async () => {
    const supabase = makeSupabase({
      placement_drives: [
        {
          id: 'drive-1',
          user_id: USER_A,
          company_id: 'company-1',
          normalized_drive_number: 'r1',
          identity_state: 'assigned',
        },
      ],
      emails: [
        {
          id: 'email-1',
          user_id: USER_A,
          placement_drive_id: null,
          subject: 'subject',
          body_snippet: 'body',
        },
      ],
      applications: [{ id: 'app-1', user_id: USER_A, company_id: 'company-1', placement_drive_id: null }],
      events: [{ id: 'event-1', user_id: USER_A, company_id: 'company-1', placement_drive_id: null }],
      notifications: [{ id: 'notification-1', user_id: USER_A, company_id: null, placement_drive_id: null }],
      candidate_matches: [
        {
          id: 'match-1',
          user_id: USER_A,
          email_id: 'email-1',
          application_id: null,
          placement_drive_id: null,
        },
      ],
    });
    const reader = createSupabaseDiscoveryReader(supabase);

    await expect(reader.listUserDrives(USER_A)).resolves.toEqual([
      {
        id: 'drive-1',
        userId: USER_A,
        companyId: 'company-1',
        normalizedDriveNumber: 'r1',
        identityState: 'assigned',
      },
    ]);
    await expect(reader.listUserEmails(USER_A)).resolves.toHaveLength(1);
    await expect(reader.listUserApplications(USER_A)).resolves.toHaveLength(1);
    await expect(reader.listLegacyEvents(USER_A)).resolves.toHaveLength(1);
    await expect(reader.listLegacyNotifications(USER_A)).resolves.toHaveLength(1);
    await expect(reader.listLegacyCandidateMatches(USER_A)).resolves.toHaveLength(1);

    expect(supabase.calls).toHaveLength(6);
    expect(supabase.calls.every((call) => call.column === 'user_id' && call.value === USER_A)).toBe(true);
  });

  it('rejects a row that violates the user-scoped read boundary', async () => {
    const supabase = makeSupabase({
      applications: [{ id: 'app-1', user_id: 'user-other', company_id: 'company-1', placement_drive_id: null }],
    }, { ignoreUserFilter: true });
    const reader = createSupabaseDiscoveryReader(supabase);

    await expect(reader.listUserApplications(USER_A)).rejects.toThrow('outside user user-a');
  });
});
