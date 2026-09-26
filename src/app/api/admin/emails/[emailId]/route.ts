import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeDriveNumber } from '@/lib/drive-number';
import { recalculateApplicationStatuses } from '@/app/api/sync/reprocess/route';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ emailId: string }> }
) {
  try {
    await requireAdmin();
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Unauthorized' },
      { status: err.status || 401 }
    );
  }

  const { emailId } = await params;
  const body = await req.json();
  const { classification, unlinkDrive, deleteEmail, driveKey } = body;
  const supabase = createAdminClient();

  try {
    // 1. Fetch current email (check personal_emails first, then college_emails)
    const { data: personalEmail, error: fetchErr } = await supabase
      .from('personal_emails')
      .select('id, user_id, classification, placement_drive_id, college_email_id, canonical_email_id, subject, rfc_message_id')
      .eq('id', emailId)
      .maybeSingle();

    let isCollegeEmail = false;
    let collegeEmailRecord: any = null;

    if (!personalEmail) {
      const { data: ce } = await supabase
        .from('college_emails')
        .select('id, subject, classification, parsed_company_name, parsed_drive_numbers')
        .eq('id', emailId)
        .maybeSingle();

      if (ce) {
        isCollegeEmail = true;
        collegeEmailRecord = ce;
      } else {
        return NextResponse.json({ error: fetchErr?.message || 'Email not found' }, { status: 404 });
      }
    }

    const collegeRef = isCollegeEmail
      ? emailId
      : (personalEmail?.college_email_id || personalEmail?.canonical_email_id);

    // Handle Delete
    if (deleteEmail) {
      if (isCollegeEmail) {
        const { data: linkedPersonal } = await supabase
          .from('personal_emails')
          .select('id')
          .or(`college_email_id.eq.${emailId},canonical_email_id.eq.${emailId}`);
        const personalIds = (linkedPersonal || []).map((p) => p.id);

        await Promise.all([
          supabase.from('candidate_matches').delete().eq('college_email_id', emailId),
          supabase.from('events').delete().eq('college_email_id', emailId),
          supabase.from('placement_drives').update({ source_college_email_id: null }).eq('source_college_email_id', emailId),
          personalIds.length > 0
            ? supabase.from('personal_emails').update({ college_email_id: null, canonical_email_id: null }).in('id', personalIds)
            : Promise.resolve(),
        ]);

        const { error: delErr } = await supabase.from('college_emails').delete().eq('id', emailId);
        if (delErr) {
          return NextResponse.json({ error: delErr.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, message: 'College circular deleted from pipeline' });
      } else {
        await Promise.all([
          supabase.from('candidate_matches').delete().eq('email_id', emailId),
          supabase.from('email_drive_links').delete().eq('email_id', emailId),
          supabase.from('events').delete().eq('source_email_id', emailId),
        ]);

        const { error: delErr } = await supabase.from('personal_emails').delete().eq('id', emailId);
        if (delErr) {
          return NextResponse.json({ error: delErr.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, message: 'Email deleted from pipeline' });
      }
    }

    // Handle Unlink from Drive
    if (unlinkDrive) {
      let idsToUnlink: string[] = [];

      if (isCollegeEmail) {
        // Collect all student personal receipts linked to this college circular
        const { data: siblings } = await supabase
          .from('personal_emails')
          .select('id')
          .or(`college_email_id.eq.${collegeRef},canonical_email_id.eq.${collegeRef}`);
        if (siblings && siblings.length > 0) {
          idsToUnlink = siblings.map((s) => s.id);
        }
        if (Array.isArray(body.emailIds) && body.emailIds.length > 0) {
          const extraIds = body.emailIds.filter((id: string) => id !== emailId);
          idsToUnlink = Array.from(new Set([...idsToUnlink, ...extraIds]));
        }
      } else {
        idsToUnlink = [emailId];
        if (Array.isArray(body.emailIds) && body.emailIds.length > 0) {
          idsToUnlink = body.emailIds;
        } else if (collegeRef) {
          const { data: siblings } = await supabase
            .from('personal_emails')
            .select('id')
            .or(`college_email_id.eq.${collegeRef},canonical_email_id.eq.${collegeRef}`);
          if (siblings && siblings.length > 0) {
            idsToUnlink = siblings.map((s) => s.id);
          }
        } else if (personalEmail?.subject) {
          const { data: siblingsBySubj } = await supabase
            .from('personal_emails')
            .select('id')
            .eq('subject', personalEmail.subject);
          if (siblingsBySubj && siblingsBySubj.length > 0) {
            idsToUnlink = Array.from(new Set([emailId, ...siblingsBySubj.map((s) => s.id)]));
          }
        }
      }

      const affectedDrivesByUser = new Map<string, Set<string>>();
      const targetDriveIds = new Set<string>();

      // Resolve targeted drives if driveKey was passed
      if (driveKey) {
        const decodedKey = decodeURIComponent(driveKey);
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

        let driveQuery = supabase
          .from('placement_drives')
          .select('id, drive_number, normalized_drive_number, drive_name, excluded_email_ids, source_college_email_id');

        if (driveNumber) {
          driveQuery = driveQuery.or(`drive_number.eq.${driveNumber},normalized_drive_number.eq.${driveNumber}`);
        } else if (companyPattern) {
          driveQuery = driveQuery.ilike('drive_name', `%${companyPattern}%`);
        }

        const { data: matchedKeyDrives } = await driveQuery;
        for (const md of matchedKeyDrives || []) {
          targetDriveIds.add(md.id);
        }
      }

      // 1. Collect affected drives from personal email receipts
      if (idsToUnlink.length > 0) {
        const { data: emailsBeforeUnlink } = await supabase
          .from('personal_emails')
          .select('id, user_id, placement_drive_id')
          .in('id', idsToUnlink);

        for (const receipt of emailsBeforeUnlink || []) {
          if (!receipt.placement_drive_id) continue;
          targetDriveIds.add(receipt.placement_drive_id);
          const driveIds = affectedDrivesByUser.get(receipt.user_id) || new Set<string>();
          driveIds.add(receipt.placement_drive_id);
          affectedDrivesByUser.set(receipt.user_id, driveIds);
        }

        const { data: existingLinks } = await supabase
          .from('email_drive_links')
          .select('user_id, placement_drive_id')
          .in('email_id', idsToUnlink);

        for (const link of existingLinks || []) {
          targetDriveIds.add(link.placement_drive_id);
          const driveIds = affectedDrivesByUser.get(link.user_id) || new Set<string>();
          driveIds.add(link.placement_drive_id);
          affectedDrivesByUser.set(link.user_id, driveIds);
        }
      }

      // 2. If circular is/has a collegeRef, dissociate placement_drives & delete college-level matches/events
      if (collegeRef) {
        const { data: drivesWithCollegeSource } = await supabase
          .from('placement_drives')
          .select('id')
          .eq('source_college_email_id', collegeRef);

        const collegeDriveIds = (drivesWithCollegeSource || []).map((d) => d.id);
        for (const cdId of collegeDriveIds) targetDriveIds.add(cdId);

        if (collegeDriveIds.length > 0) {
          await supabase
            .from('placement_drives')
            .update({ source_college_email_id: null })
            .in('id', collegeDriveIds);

          const { data: appsOnDrives } = await supabase
            .from('applications')
            .select('user_id, placement_drive_id')
            .in('placement_drive_id', collegeDriveIds);

          for (const app of appsOnDrives || []) {
            const driveIds = affectedDrivesByUser.get(app.user_id) || new Set<string>();
            driveIds.add(app.placement_drive_id);
            affectedDrivesByUser.set(app.user_id, driveIds);
          }
        }

        if (targetDriveIds.size > 0) {
          const { data: targetDriveRows } = await supabase
            .from('placement_drives')
            .select('drive_number, normalized_drive_number')
            .in('id', Array.from(targetDriveIds));

          const driveNumsToRemove = new Set(
            (targetDriveRows || []).flatMap((d) => [
              (d.drive_number || '').toLowerCase(),
              (d.normalized_drive_number || '').toLowerCase(),
            ]).filter(Boolean)
          );

          const { data: ceRow } = await supabase
            .from('college_emails')
            .select('parsed_drive_numbers')
            .eq('id', collegeRef)
            .maybeSingle();

          if (ceRow && Array.isArray(ceRow.parsed_drive_numbers)) {
            const remainingNums = ceRow.parsed_drive_numbers.filter(
              (num: string) => !driveNumsToRemove.has(num.toLowerCase())
            );
            await supabase
              .from('college_emails')
              .update({ parsed_drive_numbers: remainingNums })
              .eq('id', collegeRef);
          }
        } else {
          await supabase
            .from('college_emails')
            .update({
              parsed_drive_numbers: [],
            })
            .eq('id', collegeRef);
        }

        // Delete candidate matches and events that referenced this college circular
        const matchDeleteQuery = supabase.from('candidate_matches').delete().eq('college_email_id', collegeRef);
        const eventDeleteQuery = supabase.from('events').delete().eq('college_email_id', collegeRef);
        if (targetDriveIds.size > 0) {
          matchDeleteQuery.in('placement_drive_id', Array.from(targetDriveIds));
          eventDeleteQuery.in('placement_drive_id', Array.from(targetDriveIds));
        }
        await Promise.all([matchDeleteQuery, eventDeleteQuery]);
      }

      // 3. Persist unlinking into placement_drives.excluded_email_ids permanently!
      const allItemIdsToExclude = Array.from(new Set([
        emailId,
        ...idsToUnlink,
        ...(Array.isArray(body.emailIds) ? body.emailIds : []),
        ...(collegeRef ? [collegeRef] : []),
      ])).filter(Boolean);

      // Also gather any sibling college_emails with identical normalized subject
      const rawSub = collegeEmailRecord?.subject || personalEmail?.subject || '';
      const normSub = rawSub.replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '').trim();
      if (normSub.length >= 4) {
        const { data: siblingCollege } = await supabase
          .from('college_emails')
          .select('id')
          .ilike('subject', `%${normSub}%`);
        for (const sc of siblingCollege || []) {
          allItemIdsToExclude.push(sc.id);
        }
      }

      if (targetDriveIds.size > 0 && allItemIdsToExclude.length > 0) {
        const { data: drivesToExcludeOn } = await supabase
          .from('placement_drives')
          .select('id, excluded_email_ids, source_college_email_id')
          .in('id', Array.from(targetDriveIds));

        for (const td of drivesToExcludeOn || []) {
          const currentExcluded = new Set(td.excluded_email_ids || []);
          for (const itId of allItemIdsToExclude) currentExcluded.add(itId);

          await supabase
            .from('placement_drives')
            .update({
              excluded_email_ids: Array.from(currentExcluded),
              ...(td.source_college_email_id && allItemIdsToExclude.includes(td.source_college_email_id)
                ? { source_college_email_id: null }
                : {}),
            })
            .eq('id', td.id);
        }
      }

      // 4. Clear personal email links, matches, events, and update personal_emails
      if (idsToUnlink.length > 0) {
        await Promise.all([
          supabase.from('email_drive_links').delete().in('email_id', idsToUnlink),
          supabase.from('candidate_matches').delete().in('email_id', idsToUnlink),
          supabase.from('events').delete().in('source_email_id', idsToUnlink),
        ]);

        const { error: unlinkErr } = await supabase
          .from('personal_emails')
          .update({
            placement_drive_id: null,
            assignment_state: 'unassigned',
            assignment_source: 'admin_unlinked',
            is_relevant: false,
            is_processed: true,
            processed_at: new Date().toISOString(),
          })
          .in('id', idsToUnlink);

        if (unlinkErr) {
          return NextResponse.json({ error: unlinkErr.message }, { status: 500 });
        }
      }

      // 5. Ensure all users who applied to or were registered for target drives are reprocessed
      if (targetDriveIds.size > 0) {
        const { data: driveApps } = await supabase
          .from('applications')
          .select('user_id, placement_drive_id')
          .in('placement_drive_id', Array.from(targetDriveIds));

        for (const app of driveApps || []) {
          const driveIds = affectedDrivesByUser.get(app.user_id) || new Set<string>();
          driveIds.add(app.placement_drive_id);
          affectedDrivesByUser.set(app.user_id, driveIds);
        }
      }

      // 6. Recalculate each affected drive from the remaining linked evidence
      const reprocessErrors: string[] = [];
      for (const [userId, driveIds] of affectedDrivesByUser) {
        for (const driveId of driveIds) {
          try {
            await recalculateApplicationStatuses(userId, undefined, {
              targetPlacementDriveIds: [driveId],
              recalculateStatusesFromRemainingEvidence: true,
            });
          } catch (reprocessError) {
            console.error(`[Admin Email Unlink] Status recalculation failed for drive ${driveId}:`, reprocessError);
            reprocessErrors.push(driveId);
          }
        }
      }

      const totalUnlinkedCount = idsToUnlink.length || (isCollegeEmail ? 1 : 0);
      return NextResponse.json({
        success: true,
        message: reprocessErrors.length === 0
          ? `Circular unlinked and affected drive statuses recalculated for ${totalUnlinkedCount} receipt(s)`
          : `Circular unlinked for ${totalUnlinkedCount} receipt(s), but status recalculation failed for ${reprocessErrors.length} drive(s)`,
        unlinkedCount: totalUnlinkedCount,
        drivesReprocessed: Array.from(affectedDrivesByUser.values()).reduce((count, ids) => count + ids.size, 0) - reprocessErrors.length,
        reprocessErrors,
      });
    }

    // Handle Classification Update
    if (classification) {
      const updates: any = {
        classification,
        is_relevant: classification !== 'irrelevant',
        ...(classification === 'irrelevant'
          ? {
              placement_drive_id: null,
              assignment_state: 'unassigned',
              assignment_source: 'admin_unlinked',
            }
          : {}),
      };

      // If marked irrelevant with driveKey, persist into excluded_email_ids permanently
      if (classification === 'irrelevant' && driveKey) {
        const decodedKey = decodeURIComponent(driveKey);
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

        let driveQuery = supabase
          .from('placement_drives')
          .select('id, drive_number, normalized_drive_number, drive_name, excluded_email_ids');

        if (driveNumber) {
          driveQuery = driveQuery.or(`drive_number.eq.${driveNumber},normalized_drive_number.eq.${driveNumber}`);
        } else if (companyPattern) {
          driveQuery = driveQuery.ilike('drive_name', `%${companyPattern}%`);
        }

        const { data: matchedDrives } = await driveQuery;
        const allExcludeIds = [
          emailId,
          ...(Array.isArray(body.emailIds) ? body.emailIds : []),
          ...(collegeRef ? [collegeRef] : []),
        ];

        const rawSub = collegeEmailRecord?.subject || personalEmail?.subject || '';
        const normSub = rawSub.replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '').trim();
        if (normSub.length >= 4) {
          const { data: siblingCollege } = await supabase
            .from('college_emails')
            .select('id')
            .ilike('subject', `%${normSub}%`);
          for (const sc of siblingCollege || []) {
            allExcludeIds.push(sc.id);
          }
        }

        for (const td of matchedDrives || []) {
          const currentExcluded = new Set(td.excluded_email_ids || []);
          for (const itId of allExcludeIds) currentExcluded.add(itId);
          await supabase
            .from('placement_drives')
            .update({ excluded_email_ids: Array.from(currentExcluded) })
            .eq('id', td.id);
        }

        // Clean up matches and events
        await Promise.all([
          supabase.from('candidate_matches').delete().or(`email_id.eq.${emailId},college_email_id.eq.${emailId}`),
          supabase.from('events').delete().or(`source_email_id.eq.${emailId},college_email_id.eq.${emailId}`),
          supabase.from('email_drive_links').delete().eq('email_id', emailId),
        ]);
      }

      if (isCollegeEmail) {
        const { error: ceErr } = await supabase
          .from('college_emails')
          .update({ classification })
          .eq('id', emailId);

        if (ceErr) {
          return NextResponse.json({ error: ceErr.message }, { status: 500 });
        }

        // Propagate to all personal email receipts pointing to this college circular
        await supabase
          .from('personal_emails')
          .update(updates)
          .or(`college_email_id.eq.${emailId},canonical_email_id.eq.${emailId}`);

        return NextResponse.json({
          success: true,
          message: `Classification updated to ${classification} across college circular and student receipts`,
        });
      } else {
        const { error: updateErr } = await supabase
          .from('personal_emails')
          .update(updates)
          .eq('id', emailId);

        if (updateErr) {
          return NextResponse.json({ error: updateErr.message }, { status: 500 });
        }

        // If linked to college circular, update the college circular and all sibling receipts
        if (collegeRef) {
          await supabase
            .from('college_emails')
            .update({ classification })
            .eq('id', collegeRef);

          await supabase
            .from('personal_emails')
            .update(updates)
            .or(`college_email_id.eq.${collegeRef},canonical_email_id.eq.${collegeRef}`);
        }

        return NextResponse.json({
          success: true,
          message: `Classification updated to ${classification}${collegeRef ? ' (propagated across all receipts)' : ''}`,
        });
      }
    }

    return NextResponse.json({ message: 'No action specified' }, { status: 400 });
  } catch (err: any) {
    console.error('[Admin Email PATCH API] Error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ emailId: string }> }
) {
  try {
    await requireAdmin();
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Unauthorized' },
      { status: err.status || 401 }
    );
  }

  const { emailId } = await params;
  const supabase = createAdminClient();

  try {
    // Check personal_emails first
    const { data: personalEmail } = await supabase
      .from('personal_emails')
      .select('id')
      .eq('id', emailId)
      .maybeSingle();

    if (personalEmail) {
      await Promise.all([
        supabase.from('candidate_matches').delete().eq('email_id', emailId),
        supabase.from('email_drive_links').delete().eq('email_id', emailId),
        supabase.from('events').delete().eq('source_email_id', emailId),
      ]);

      const { error: delErr } = await supabase.from('personal_emails').delete().eq('id', emailId);
      if (delErr) {
        return NextResponse.json({ error: delErr.message }, { status: 500 });
      }

      return NextResponse.json({ success: true, message: 'Email deleted from pipeline' });
    }

    // Check college_emails
    const { data: collegeEmail } = await supabase
      .from('college_emails')
      .select('id')
      .eq('id', emailId)
      .maybeSingle();

    if (collegeEmail) {
      await Promise.all([
        supabase.from('candidate_matches').delete().eq('college_email_id', emailId),
        supabase.from('events').delete().eq('college_email_id', emailId),
        supabase.from('placement_drives').update({ source_college_email_id: null }).eq('source_college_email_id', emailId),
        supabase.from('personal_emails').update({ college_email_id: null, canonical_email_id: null }).eq('college_email_id', emailId),
      ]);

      const { error: delErr } = await supabase.from('college_emails').delete().eq('id', emailId);
      if (delErr) {
        return NextResponse.json({ error: delErr.message }, { status: 500 });
      }

      return NextResponse.json({ success: true, message: 'College circular deleted from pipeline' });
    }

    return NextResponse.json({ error: 'Email not found' }, { status: 404 });
  } catch (err: any) {
    console.error('[Admin Email DELETE API] Error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
