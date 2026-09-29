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

    const allCandidateUserIds = Array.from(
      new Set([
        ...(apps || []).map((a) => a.user_id),
        ...(links || []).map((l) => l.user_id),
      ])
    );

    if (allCandidateUserIds.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No users found tracking this drive',
        usersAffected: 0,
      });
    }

    // Filter out admin users — they are not students and should never be reprocessed
    const { data: userRoles } = await supabase
      .from('users')
      .select('id, role, email')
      .in('id', allCandidateUserIds);

    const adminEmails = (process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    const distinctUserIds = allCandidateUserIds.filter((uid) => {
      const u = (userRoles || []).find((r) => r.id === uid);
      if (!u) return true; // include if we can't determine role
      if (u.role === 'admin') return false;
      if (u.email && adminEmails.includes(u.email.toLowerCase())) return false;
      return true;
    });

    if (distinctUserIds.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No non-admin users found tracking this drive',
        usersAffected: 0,
      });
    }

    // Preload shared college email data once — all user calls will reuse this
    const pageSize = 1000;
    const preloadedCollegeEmails: any[] = [];
    let clgPage = 0;
    while (true) {
      const { data: cChunk } = await supabase
        .from('college_emails')
        .select('id, subject, sender_email, received_at, created_at, body_snippet, body_text, classification, parsed_company_name, parsed_drive_numbers')
        .order('received_at', { ascending: true })
        .range(clgPage * pageSize, (clgPage + 1) * pageSize - 1);
      if (!cChunk || cChunk.length === 0) break;
      preloadedCollegeEmails.push(...cChunk.map((ce: any) => ({
        id: ce.id,
        subject: ce.subject,
        sender: ce.sender_email,
        received_at: ce.received_at || ce.created_at,
        body_snippet: ce.body_text || ce.body_snippet || '',
        classification: ce.classification,
        parsed_company_name: ce.parsed_company_name,
        parsed_drive_numbers: ce.parsed_drive_numbers || [],
        placement_drive_id: null,
        college_email_id: ce.id,
        canonical_email_id: ce.id,
        assignment_source: 'college_broadcast',
        has_canonical_body: Boolean(ce.body_text && ce.body_text.length > 500),
      })));
      if (cChunk.length < pageSize) break;
      clgPage++;
    }

    const preloadedCanonicalMap = new Map<string, string>();
    {
      const { data: canonicals } = await supabase
        .from('college_emails')
        .select('id, message_id, body_text, body_snippet')
        .not('message_id', 'is', null)
        .or('body_text.not.is.null,body_snippet.not.is.null');
      for (const c of canonicals || []) {
        const text = c.body_text || c.body_snippet || '';
        if (text && c.message_id && !preloadedCanonicalMap.has(c.message_id.toLowerCase().trim())) {
          preloadedCanonicalMap.set(c.message_id.toLowerCase().trim(), text);
        }
      }
    }

    // Run per-user recalculation in parallel with a concurrency limit
    const CONCURRENCY = 5;
    const results: Array<{ userId: string; updatedCount: number }> = [];

    for (let i = 0; i < distinctUserIds.length; i += CONCURRENCY) {
      const batch = distinctUserIds.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (userId) => {
          try {
            const res = await recalculateApplicationStatuses(userId, undefined, {
              targetPlacementDriveIds: driveIds,
              recalculateStatusesFromRemainingEvidence: true,
              skipBodyRecovery: true,
              preloadedCanonicalMap,
              preloadedCollegeEmails,
            });
            return { userId, updatedCount: res.updatedCount };
          } catch (userErr) {
            console.error(`[Admin Drive Reprocess] Failed for user ${userId}:`, userErr);
            return { userId, updatedCount: 0 };
          }
        })
      );
      results.push(...batchResults);
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
