import { describe, it, expect } from 'vitest';
import { backfillCanonicalEmails } from './canonical-backfill';

describe('Phase D backfill dry-run', () => {
  it.skipIf(!process.env.NEXT_PUBLIC_SUPABASE_URL)('runs 25-row dry run against live Supabase', async () => {
    const result = await backfillCanonicalEmails({
      dryRun: true,
      limit: 25,
    });
    console.log(JSON.stringify(result, null, 2));
    expect(result.processed).toBeGreaterThanOrEqual(0);
  });
});