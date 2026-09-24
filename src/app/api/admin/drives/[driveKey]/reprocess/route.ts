import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeDriveNumber } from '@/lib/drive-number';
import { recalculateApplicationStatuses } from '@/app/api/sync/reprocess/route';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // Allow sufficient compute time on Vercel Fluid

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ driveKey: string }> }
) {
  try {
    await requireAdmin();
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Unauthorized' },
      { status: err.status || 401 }
    );
  }

  const { driveKey } = await params;
  const decodedKey = decodeURIComponent(driveKey);
  const supabase = createAdminClient();

  try {
    let driveNumber: string | null = null;
    let companyPattern: string | null = null;

    if (decodedKey.startsWith('drive:')) {
      driveNumber = normalizeDriveNumber(decodedKey.slice(6));
    } else if (decodedKey.startsWith('name:')) {
      companyPattern = decodedKey.slice(5).trim();
    } else {
      const norm = normalizeDriveNumber(decodedKey);
      if (norm) {
        driveNumber = norm;
      } else {
        companyPattern = decodedKey.trim();
      }
    }

    // 1. Find all matching placement_drives to identify affected users
    let query = supabase
      .from('placement_drives')
      .select('id, user_id, drive_number, normalized_drive_number, drive_name');

    if (driveNumber) {
      query = query.or(`drive_number.eq.${driveNumber},normalized_drive_number.eq.${driveNumber}`);
    } else if (companyPattern) {
      query = query.ilike('drive_name', `%${companyPattern}%`);
    }

    const { data: drives, error: driveErr } = await query;
    if (driveErr) {
      return NextResponse.json({ error: driveErr.message }, { status: 500 });
    }

    const distinctUserIds = Array.from(new Set((drives || []).map((d) => d.user_id)));

    if (distinctUserIds.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No users found tracking this drive',
        usersAffected: 0,
      });
    }

    // 2. Map drive IDs by user and reprocess ONLY this drive
    const userDrivesMap = new Map<string, string[]>();
    for (const d of drives || []) {
      const list = userDrivesMap.get(d.user_id) || [];
      list.push(d.id);
      userDrivesMap.set(d.user_id, list);
    }

    const results: Array<{ userId: string; updatedCount: number }> = [];

    for (const [userId, targetDriveIds] of userDrivesMap.entries()) {
      try {
        const res = await recalculateApplicationStatuses(userId, undefined, {
          targetPlacementDriveIds: targetDriveIds,
        });
        results.push({ userId, updatedCount: res.updatedCount });
      } catch (userErr) {
        console.error(`[Admin Drive Reprocess] Failed for user ${userId}:`, userErr);
      }
    }

    return NextResponse.json({
      success: true,
      driveKey: decodedKey,
      driveNumber,
      usersAffected: distinctUserIds.length,
      result: {
        usersAffected: distinctUserIds.length,
        details: results,
      },
      details: results,
      message: `Successfully reprocessed drive for ${distinctUserIds.length} user(s).`,
    });
  } catch (err: any) {
    console.error('[Admin Drive Reprocess API] Error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
