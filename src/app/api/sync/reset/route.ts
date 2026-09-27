import { POST as resetUserPlacementData } from '@/app/api/user/reset/route';

export const dynamic = 'force-dynamic';

/**
 * POST /api/sync/reset
 * Nuclear reset: Wipes ALL placement data for the authenticated user and resets
 * Gmail sync history so the next sync does a full re-fetch from scratch.
 */
export async function POST() {
  return resetUserPlacementData();
}
