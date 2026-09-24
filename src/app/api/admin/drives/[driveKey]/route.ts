import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeDriveNumber } from '@/lib/drive-number';

export const dynamic = 'force-dynamic';

export async function PATCH(
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
    const body = await req.json();
    const {
      companyName,
      driveNumber,
      role,
      category,
      ctc,
      stipend,
      location,
      aliases,
    } = body;

    // Determine search criteria: is it a drive number or company name?
    let searchDriveNumber: string | null = null;
    let searchCompanyPattern: string | null = null;

    if (decodedKey.startsWith('drive:')) {
      searchDriveNumber = normalizeDriveNumber(decodedKey.slice(6));
    } else if (decodedKey.startsWith('name:')) {
      searchCompanyPattern = decodedKey.slice(5).trim();
    } else {
      const norm = normalizeDriveNumber(decodedKey);
      if (norm) {
        searchDriveNumber = norm;
      } else {
        searchCompanyPattern = decodedKey.trim();
      }
    }

    // 1. Find all matching placement_drives
    let driveQuery = supabase
      .from('placement_drives')
      .select('id, user_id, company_id, drive_number, normalized_drive_number, drive_name');

    if (searchDriveNumber) {
      driveQuery = driveQuery.or(`drive_number.eq.${searchDriveNumber},normalized_drive_number.eq.${searchDriveNumber}`);
    } else if (searchCompanyPattern) {
      driveQuery = driveQuery.ilike('drive_name', `%${searchCompanyPattern}%`);
    }

    const { data: matchedDrives, error: driveErr } = await driveQuery;
    if (driveErr) {
      return NextResponse.json({ error: driveErr.message }, { status: 500 });
    }

    if (!matchedDrives || matchedDrives.length === 0) {
      return NextResponse.json({ error: 'No matching placement drives found' }, { status: 404 });
    }

    const driveIds = matchedDrives.map((d) => d.id);
    const companyIds = Array.from(new Set(matchedDrives.map((d) => d.company_id).filter(Boolean)));

    // Prepare update payload for placement_drives
    const driveUpdate: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (companyName !== undefined && companyName !== null) {
      driveUpdate.drive_name = companyName.trim();
    }
    if (driveNumber !== undefined) {
      const trimmed = driveNumber ? String(driveNumber).trim() : null;
      driveUpdate.drive_number = trimmed;
      driveUpdate.normalized_drive_number = trimmed ? normalizeDriveNumber(trimmed) : null;
    }
    if (role !== undefined) driveUpdate.role = role ? String(role).trim() : null;
    if (category !== undefined) driveUpdate.category = category ? String(category).trim() : null;
    if (ctc !== undefined) driveUpdate.ctc = ctc ? String(ctc).trim() : null;
    if (stipend !== undefined) driveUpdate.stipend = stipend ? String(stipend).trim() : null;
    if (location !== undefined) driveUpdate.location = location ? String(location).trim() : null;

    // 2. Update all matching placement_drives
    const { error: updateErr } = await supabase
      .from('placement_drives')
      .update(driveUpdate)
      .in('id', driveIds);

    if (updateErr) {
      console.error('[Admin Edit Drive API] Error updating drives:', updateErr);
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    // 3. If companyName is updated, update company names for linked companies
    if (companyName && companyIds.length > 0) {
      await supabase
        .from('companies')
        .update({
          name: companyName.trim(),
          updated_at: new Date().toISOString(),
        })
        .in('id', companyIds);
    }

    // 3b. Update company aliases & drive resolutions if aliases are provided
    if (aliases !== undefined && companyIds.length > 0) {
      const aliasArr = Array.isArray(aliases)
        ? aliases.map((s: string) => String(s).trim()).filter(Boolean)
        : typeof aliases === 'string'
        ? aliases.split(',').map((s: string) => s.trim()).filter(Boolean)
        : [];

      await supabase
        .from('companies')
        .update({
          aliases: aliasArr,
          updated_at: new Date().toISOString(),
        })
        .in('id', companyIds);

      const targetDriveNumber = driveUpdate.drive_number || searchDriveNumber;
      const targetResolvedName = driveUpdate.drive_name || companyName || searchCompanyPattern || 'Company';

      if (targetDriveNumber && aliasArr.length > 0) {
        for (const al of aliasArr) {
          await supabase
            .from('drive_resolutions')
            .upsert(
              {
                drive_number: targetDriveNumber,
                company_base_name: al.toLowerCase(),
                resolved_company_name: targetResolvedName,
                resolved_role: driveUpdate.role || 'Default Role',
                resolved_via: 'manual_review',
                confidence: 'high',
                notes: 'Configured from Admin Panel',
                updated_at: new Date().toISOString(),
              },
              { onConflict: 'drive_number' }
            );
        }
      }
    }

    // 4. Return new driveKey and confirmation
    const newNormNumber = driveUpdate.normalized_drive_number || (searchDriveNumber ? searchDriveNumber : null);
    const newCompanyName = driveUpdate.drive_name || companyName || searchCompanyPattern || 'Unknown';
    const newKey = newNormNumber ? `drive:${newNormNumber}` : `name:${newCompanyName.toLowerCase().trim()}`;

    return NextResponse.json({
      success: true,
      message: `Updated ${matchedDrives.length} student records for drive`,
      newKey,
      updatedCount: matchedDrives.length,
    });
  } catch (err: any) {
    console.error('[Admin Edit Drive API] Unexpected error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
