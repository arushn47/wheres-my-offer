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
      .select('id, company_id, drive_number, normalized_drive_number, drive_name');

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
    // Alias edits must apply ONLY to the company of the drive group the admin edited.
    // matchedDrives can include sibling drive rows that share a company_id (e.g. two
    // "Deloitte" drive numbers under one company); writing aliases to the shared
    // company row silently "links" sibling drives by giving them the same alias set.
    const primaryDrive = matchedDrives[0];
    const editScopeCompanyIds = Array.from(new Set([primaryDrive.company_id].filter(Boolean)));
    // companyName rename keeps the broader scope: it is a brand correction across the org.
    const renameScopeCompanyIds = companyIds;

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
    if (companyName && renameScopeCompanyIds.length > 0) {
      await supabase
        .from('companies')
        .update({
          name: companyName.trim(),
          updated_at: new Date().toISOString(),
        })
        .in('id', renameScopeCompanyIds);
    }

    // 3b. Aliases are DRIVE-SCOPED — each drive_number gets its own alias list.
    //
    // Storage: a single `drive_resolutions` row (resolved_via='manual_review') per
    // drive_number, with aliases encoded as JSON in the `notes` field:
    //   notes = "Configured from Admin Panel\naliases_json:[\"infosys regular\",\"infosys se\"]"
    //
    // Why NOT companies.aliases:
    //   Both Infosys drives (1078=Super Dream, 1338=Regular) share the same company_id.
    //   Writing to companies.aliases instantly applies to BOTH drives — the admin
    //   typed aliases for 1338 but 1078's display also changes. That's wrong.
    //
    // Why NOT multiple drive_resolutions rows:
    //   drive_resolutions has UNIQUE(drive_number) — only 1 row per drive. Inserting
    //   2 alias rows fails with a constraint violation on the 2nd insert.
    //
    // Solution: one upsert row per drive, aliases stored as JSON in notes. The GET
    // route reads driveAliasesMap from drive_resolutions (manual_review rows) and
    // will be updated to parse aliases_json from notes.
    if (aliases !== undefined) {
      const aliasArr = Array.isArray(aliases)
        ? aliases.map((s: string) => String(s).trim().toLowerCase()).filter(Boolean)
        : typeof aliases === 'string'
        ? aliases.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean)
        : [];

      const targetDriveNumber = searchDriveNumber || matchedDrives[0]?.drive_number;
      const resolvedName = companyName?.trim() || matchedDrives[0]?.drive_name || 'Company';
      const resolvedRole = role?.trim() || 'Default Role';

      if (targetDriveNumber) {
        // Build the notes string: keep the standard marker + append aliases_json
        const notesValue = aliasArr.length > 0
          ? `Configured from Admin Panel\naliases_json:${JSON.stringify(aliasArr)}`
          : 'Configured from Admin Panel';

        // Upsert: if a manual_review row already exists for this drive, update it;
        // otherwise insert a new one. onConflict:'drive_number' handles both cases.
        const { error: aliasErr } = await supabase
          .from('drive_resolutions')
          .upsert(
            {
              drive_number: targetDriveNumber,
              company_base_name: aliasArr[0] || resolvedName.toLowerCase(),
              resolved_company_name: resolvedName,
              resolved_role: resolvedRole,
              resolved_via: 'manual_review',
              confidence: 'high',
              notes: notesValue,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'drive_number' }
          );

        if (aliasErr) {
          console.error('[Admin Edit Drive API] Error saving aliases to drive_resolutions:', aliasErr);
          // Non-fatal: log but continue
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
