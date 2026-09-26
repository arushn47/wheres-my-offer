import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeDriveNumber } from '@/lib/drive-number';
import { recalculateApplicationStatuses } from '@/app/api/sync/reprocess/route';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

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
    const body = await req.json();
    const { emailId, emailIds, aliasToAdd } = body;

    if (!emailId && (!emailIds || emailIds.length === 0)) {
      return NextResponse.json({ error: 'emailId or emailIds is required' }, { status: 400 });
    }

    // 1. Identify search criteria for target drive
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

    // 2. Fetch target placement drives
    let driveQuery = supabase
      .from('placement_drives')
      .select('id, company_id, drive_number, normalized_drive_number, drive_name, excluded_email_ids, source_college_email_id');

    if (driveNumber) {
      driveQuery = driveQuery.or(`drive_number.eq.${driveNumber},normalized_drive_number.eq.${driveNumber}`);
    } else if (companyPattern) {
      driveQuery = driveQuery.ilike('drive_name', `%${companyPattern}%`);
    }

    const { data: matchedDrives, error: driveErr } = await driveQuery;
    if (driveErr) {
      return NextResponse.json({ error: driveErr.message }, { status: 500 });
    }

    if (!matchedDrives || matchedDrives.length === 0) {
      return NextResponse.json({ error: 'Target placement drive not found' }, { status: 404 });
    }

    // 3. Resolve all email IDs to link
    let idsToLink: string[] = emailIds && emailIds.length > 0 ? emailIds : [emailId];

    if (!emailIds || emailIds.length === 0) {
      const { data: baseEmail } = await supabase
        .from('personal_emails')
        .select('id, college_email_id, canonical_email_id, subject')
        .eq('id', emailId)
        .maybeSingle();

      const collegeRef = baseEmail?.college_email_id || baseEmail?.canonical_email_id;
      if (collegeRef) {
        const { data: siblings } = await supabase
          .from('personal_emails')
          .select('id')
          .or(`college_email_id.eq.${collegeRef},canonical_email_id.eq.${collegeRef}`);
        if (siblings && siblings.length > 0) {
          idsToLink = siblings.map((s) => s.id);
        }
      }
    }

    // 3b. Remove linked email IDs from excluded_email_ids on matched drives
    for (const d of matchedDrives) {
      if (Array.isArray(d.excluded_email_ids) && d.excluded_email_ids.length > 0) {
        const toRemove = new Set([...idsToLink, emailId].filter(Boolean));
        const updatedExcluded = d.excluded_email_ids.filter((id: string) => !toRemove.has(id));
        if (updatedExcluded.length !== d.excluded_email_ids.length) {
          await supabase
            .from('placement_drives')
            .update({ excluded_email_ids: updatedExcluded })
            .eq('id', d.id);
        }
      }
    }

    // 4. Fetch the emails to identify their user_id
    const { data: targetEmails, error: emailFetchErr } = await supabase
      .from('personal_emails')
      .select('id, user_id, subject')
      .in('id', idsToLink);

    const referenceDrive = matchedDrives[0];
    const affectedUserIds = new Set<string>();

    if (!emailFetchErr && targetEmails && targetEmails.length > 0) {
      for (const em of targetEmails) {
        affectedUserIds.add(em.user_id);

        // Update email to point directly to the global placement_drive
        await supabase
          .from('personal_emails')
          .update({
            placement_drive_id: referenceDrive.id,
            assignment_state: 'manual',
            assignment_confidence: 'high',
            assignment_source: 'admin_manual',
            is_relevant: true,
            is_processed: true,
            processed_at: new Date().toISOString(),
          })
          .eq('id', em.id);

        // Upsert into email_drive_links
        await supabase
          .from('email_drive_links')
          .upsert(
            {
              email_id: em.id,
              placement_drive_id: referenceDrive.id,
              user_id: em.user_id,
              link_type: 'primary',
              confidence: 'high',
              assignment_source: 'admin_manual',
              is_primary: true,
            },
            { onConflict: 'email_id,placement_drive_id' }
          );
      }
    } else {
      // Check if target is a college broadcast circular
      const { data: collegeEmails } = await supabase
        .from('college_emails')
        .select('id, subject, parsed_drive_numbers, parsed_company_name')
        .in('id', idsToLink);

      if (collegeEmails && collegeEmails.length > 0) {
        const primaryCollegeEmail = collegeEmails[0];

        // Set source_college_email_id on the drive if not already set
        if (!matchedDrives[0].source_college_email_id) {
          await supabase
            .from('placement_drives')
            .update({ source_college_email_id: primaryCollegeEmail.id })
            .in('id', matchedDrives.map((d) => d.id));
        }

        // Update college_emails.parsed_drive_numbers so subsequent searches
        // can detect this circular is already assigned
        for (const ce of collegeEmails) {
          const existingDriveNums: string[] = ce.parsed_drive_numbers || [];
          const driveNum = referenceDrive.drive_number || referenceDrive.normalized_drive_number;
          if (driveNum && !existingDriveNums.includes(driveNum)) {
            await supabase
              .from('college_emails')
              .update({
                parsed_drive_numbers: [...existingDriveNums, driveNum],
                parsed_company_name: ce.parsed_company_name || referenceDrive.drive_name || null,
              })
              .eq('id', ce.id);
          }
        }

        // Also link all personal_email receipts for this college circular to the drive,
        // so the search API's unassignedOnly filter excludes them correctly.
        const ceIds = collegeEmails.map((ce) => ce.id);
        const { data: ceReceipts } = await supabase
          .from('personal_emails')
          .select('id, user_id')
          .or(ceIds.map((id) => `college_email_id.eq.${id}`).join(','));

        if (ceReceipts && ceReceipts.length > 0) {
          for (const r of ceReceipts) {
            affectedUserIds.add(r.user_id);
            await supabase
              .from('personal_emails')
              .update({
                placement_drive_id: referenceDrive.id,
                assignment_state: 'manual',
                assignment_confidence: 'high',
                assignment_source: 'admin_manual',
                is_relevant: true,
                is_processed: true,
                processed_at: new Date().toISOString(),
              })
              .eq('id', r.id);

            await supabase
              .from('email_drive_links')
              .upsert(
                {
                  email_id: r.id,
                  placement_drive_id: referenceDrive.id,
                  user_id: r.user_id,
                  link_type: 'primary',
                  confidence: 'high',
                  assignment_source: 'admin_manual',
                  is_primary: true,
                },
                { onConflict: 'email_id,placement_drive_id' }
              );
          }
        }
      } else {
        return NextResponse.json({ error: 'No matching emails found to link' }, { status: 404 });
      }
    }

    // 5. If aliasToAdd provided, register in companies.aliases & drive_resolutions
    if (aliasToAdd && typeof aliasToAdd === 'string' && aliasToAdd.trim().length >= 2) {
      const cleanAlias = aliasToAdd.trim();
      const companyIds = Array.from(new Set(matchedDrives.map((d) => d.company_id).filter(Boolean)));

      if (companyIds.length > 0) {
        const { data: compRows } = await supabase
          .from('companies')
          .select('id, aliases')
          .in('id', companyIds);

        for (const comp of compRows || []) {
          const currentAliases = new Set(comp.aliases || []);
          currentAliases.add(cleanAlias);
          await supabase
            .from('companies')
            .update({ aliases: Array.from(currentAliases), updated_at: new Date().toISOString() })
            .eq('id', comp.id);
        }
      }

      if (referenceDrive.drive_number) {
        await supabase
          .from('drive_resolutions')
          .upsert(
            {
              drive_number: referenceDrive.drive_number,
              company_base_name: cleanAlias.toLowerCase(),
              resolved_company_name: referenceDrive.drive_name || cleanAlias,
              resolved_role: 'Default Role',
              resolved_via: 'manual_review',
              confidence: 'high',
              notes: 'Added via Admin manual email link',
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'drive_number' }
          );
      }
    }

    // 6. Reprocess the drive for all affected users
    for (const userId of affectedUserIds) {
      try {
        await recalculateApplicationStatuses(userId, undefined, {
          targetPlacementDriveIds: [referenceDrive.id],
          recalculateStatusesFromRemainingEvidence: true,
        });
      } catch (repErr) {
        console.error(`[Admin Link Email] Reprocess failed for user ${userId}:`, repErr);
      }
    }

    const linkedCount = targetEmails?.length || 1;
    return NextResponse.json({
      success: true,
      message: `Successfully linked circular across ${linkedCount} student receipt(s) to ${referenceDrive.drive_name}.`,
      linkedCount,
      usersAffected: affectedUserIds.size,
    });
  } catch (err: any) {
    console.error('[Admin Link Email API] Error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
