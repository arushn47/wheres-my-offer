import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { applicationStatusInput } from '@/lib/security/input';

export const dynamic = 'force-dynamic';

/**
 * PATCH /api/companies/[id]/status
 *
 * Allows manual override of application status for a company drive.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: { message: 'Unauthorized', code: 'unauthorized' } },
      { status: 401 }
    );
  }

  const { id: companyOrDriveId } = await params;
  const input = applicationStatusInput.safeParse(await request.json().catch(() => null));
  if (!input.success) return NextResponse.json({ error: { message: 'Invalid status update', code: 'bad_request' } }, { status: 400 });
  const body = input.data;
  const { status, role, ctc, location, notes, placement_drive_id: requestedDriveId, application_id: requestedApplicationId } = body;

  if (!status) {
    return NextResponse.json(
      { error: { message: 'Status is required', code: 'bad_request' } },
      { status: 400 }
    );
  }

  let normalizedStatus = status;
  let normalizedNotes = notes;

  if (status === 'rejected_test' || status === 'test_eliminated') {
    normalizedStatus = 'rejected';
    normalizedNotes = notes || 'Eliminated in Test Round';
  } else if (status === 'rejected_interview' || status === 'interview_eliminated') {
    normalizedStatus = 'rejected';
    normalizedNotes = notes || 'Interviewed · Not Selected';
  } else if (status === 'not_shortlisted') {
    normalizedStatus = 'not_shortlisted';
    normalizedNotes = notes || 'Not Shortlisted for Test';
  } else if (notes === null) {
    normalizedNotes = null;
  }

  const supabase = createAdminClient();

  let targetDriveId: string | null = requestedDriveId || null;

  if (targetDriveId) {
    const { data: drive } = await supabase
      .from('placement_drives')
      .select('id, company_id')
      .eq('id', targetDriveId)
      .maybeSingle();
    if (!drive) {
      return NextResponse.json({ error: { message: 'Placement drive not found', code: 'drive_not_found' } }, { status: 404 });
    }
    if (drive.id !== companyOrDriveId && drive.company_id !== companyOrDriveId) return NextResponse.json({ error: { message: 'Drive does not belong to this company', code: 'drive_not_found' } }, { status: 404 });
    targetDriveId = drive.id;
  }

  // Resolve whether companyOrDriveId is a placement_drive id or company id
  if (!targetDriveId) {
    const { data: directDrive } = await supabase
      .from('placement_drives')
      .select('id, company_id')
      .eq('id', companyOrDriveId)
      .maybeSingle();

    if (directDrive) {
      targetDriveId = directDrive.id;
    } else {
      // It's a company ID. Find or create a drive for it.
      const { data: drives } = await supabase
        .from('placement_drives')
        .select('id')
        .eq('company_id', companyOrDriveId);

      if (drives && drives.length > 0) {
        targetDriveId = drives[0].id;
      }
    }
  }

  if (!targetDriveId) {
    return NextResponse.json({ error: { message: 'Could not resolve placement drive for this company', code: 'drive_not_found' } }, { status: 404 });
  }

  const { data: ownedApplication, error: ownershipError } = await supabase.from('applications')
    .select('id').eq('placement_drive_id', targetDriveId).eq('user_id', session.userId).maybeSingle();
  if (ownershipError || !ownedApplication || (requestedApplicationId && requestedApplicationId !== ownedApplication.id)) return NextResponse.json({ error: { message: 'Application not found', code: 'application_not_found' } }, { status: 404 });

  // Upsert application record with manual override flag
  const applicationPayload = {
    user_id: session.userId,
    placement_drive_id: targetDriveId,
    status: normalizedStatus,
    status_source: 'manual_override',
    status_confidence: 'manual',
    manual_override: true,
    role: role || undefined,
    ctc: ctc || undefined,
    location: location || undefined,
    notes: normalizedNotes !== undefined ? normalizedNotes : undefined,
    last_updated: new Date().toISOString(),
  };

  const { data: application, error } = await supabase
      .from('applications')
      .update(applicationPayload)
      .eq('id', ownedApplication.id)
      .eq('user_id', session.userId)
      .select()
      .single();

  if (error) {
    console.error('Failed to update status:', error);
    return NextResponse.json(
      { error: { message: 'Failed to update application', code: 'db_error' } },
      { status: 500 }
    );
  }

  // Trigger background Google Calendar reconciliation so status changes
  // are immediately reflected on the user's Google Calendar.
  import('@/lib/calendar/google-sync').then(({ reconcileUserGoogleCalendar }) => {
    reconcileUserGoogleCalendar(session.userId).catch((err) => {
      console.warn('[GCal Status Sync] Background reconciliation error:', err);
    });
  });

  return NextResponse.json({ data: application, error: null });
}
