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

    // 1. Find all matching placement_drives
    let query = supabase
      .from('placement_drives')
      .select('id, drive_number, normalized_drive_number, drive_name');

    if (driveNumber) {
      query = query.or(`drive_number.eq.${driveNumber},normalized_drive_number.eq.${driveNumber}`);
    } else if (companyPattern) {
      query = query.ilike('drive_name', `%${companyPattern}%`);
    }

    const { data: drives, error: driveErr } = await query;
    if (driveErr) {
      return NextResponse.json({ error: driveErr.message }, { status: 500 });
    }

    const driveIds = (drives || []).map((d) => d.id);
    if (driveIds.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No drives found to reprocess',
        usersAffected: 0,
      });
    }

    // Find all users who track these drives via applications or linked emails
    const [{ data: apps }, { data: links }] = await Promise.all([
      supabase.from('applications').select('user_id').in('placement_drive_id', driveIds),
      supabase.from('email_drive_links').select('user_id').in('placement_drive_id', driveIds),
    ]);

    const distinctUserIds = Array.from(
      new Set([
        ...(apps || []).map((a) => a.user_id),
        ...(links || []).map((l) => l.user_id),
      ])
    );

    if (distinctUserIds.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No users found tracking this drive',
        usersAffected: 0,
      });
    }

    const results: Array<{ userId: string; updatedCount: number }> = [];

    for (const userId of distinctUserIds) {
      try {
        const res = await recalculateApplicationStatuses(userId, undefined, {
          targetPlacementDriveIds: driveIds,
          recalculateStatusesFromRemainingEvidence: true,
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
