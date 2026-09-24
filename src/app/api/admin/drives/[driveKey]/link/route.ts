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

    // 2. Fetch target placement drives across all users
    let driveQuery = supabase
      .from('placement_drives')
      .select('id, user_id, company_id, drive_number, normalized_drive_number, drive_name');

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

    // Map user_id to placement_drive row
    const userDriveMap = new Map<string, typeof matchedDrives[0]>();
    for (const d of matchedDrives) {
      userDriveMap.set(d.user_id, d);
    }

    // 3. Resolve all email IDs to link
    let idsToLink: string[] = emailIds && emailIds.length > 0 ? emailIds : [emailId];

    if (!emailIds || emailIds.length === 0) {
      const { data: baseEmail } = await supabase
        .from('emails')
        .select('id, canonical_email_id, subject')
        .eq('id', emailId)
        .maybeSingle();

      if (baseEmail?.canonical_email_id) {
        const { data: siblings } = await supabase
          .from('emails')
          .select('id')
          .eq('canonical_email_id', baseEmail.canonical_email_id);
        if (siblings && siblings.length > 0) {
          idsToLink = siblings.map((s) => s.id);
        }
      }
    }

    // 4. Fetch the emails to identify their user_id
    const { data: targetEmails, error: emailFetchErr } = await supabase
      .from('emails')
      .select('id, user_id, subject')
      .in('id', idsToLink);

    if (emailFetchErr || !targetEmails || targetEmails.length === 0) {
      return NextResponse.json({ error: 'No matching emails found to link' }, { status: 404 });
    }

    const referenceDrive = matchedDrives[0];
    const affectedUserIds = new Set<string>();

    for (const em of targetEmails) {
      let userDrive = userDriveMap.get(em.user_id);

      // If user doesn't have a placement_drive record for this company yet, create one
      if (!userDrive) {
        const { data: newDrive } = await supabase
          .from('placement_drives')
          .insert({
            user_id: em.user_id,
            company_id: referenceDrive.company_id,
            drive_name: referenceDrive.drive_name,
            drive_number: referenceDrive.drive_number,
            normalized_drive_number: referenceDrive.normalized_drive_number,
          })
          .select('id, user_id, company_id, drive_number, normalized_drive_number, drive_name')
          .single();

        if (newDrive) {
          userDrive = newDrive;
          userDriveMap.set(em.user_id, newDrive);
        }
      }

      if (userDrive) {
        affectedUserIds.add(em.user_id);

        // Update email to point to this placement_drive
        await supabase
          .from('emails')
          .update({
            placement_drive_id: userDrive.id,
            assignment_state: 'manual',
            assignment_confidence: 'high',
            assignment_source: 'admin_manual',
          })
          .eq('id', em.id);

        // Upsert into email_drive_links
        await supabase
          .from('email_drive_links')
          .upsert(
            {
              email_id: em.id,
              placement_drive_id: userDrive.id,
              user_id: em.user_id,
              link_type: 'primary',
              confidence: 'high',
              assignment_source: 'admin_manual',
              is_primary: true,
            },
            { onConflict: 'email_id,placement_drive_id' }
          );
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
      const drive = userDriveMap.get(userId);
      if (drive) {
        try {
          await recalculateApplicationStatuses(userId, undefined, {
            targetPlacementDriveIds: [drive.id],
          });
        } catch (repErr) {
          console.error(`[Admin Link Email] Reprocess failed for user ${userId}:`, repErr);
        }
      }
    }

    return NextResponse.json({
      success: true,
      message: `Successfully linked circular across ${targetEmails.length} student receipt(s) to ${referenceDrive.drive_name}.`,
      linkedCount: targetEmails.length,
      usersAffected: affectedUserIds.size,
    });
  } catch (err: any) {
    console.error('[Admin Link Email API] Error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
