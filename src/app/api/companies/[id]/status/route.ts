import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';

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
  const body = await request.json();
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
      } else {
        const { data: company } = await supabase
          .from('companies')
          .select('id')
          .eq('id', companyOrDriveId)
          .maybeSingle();
        if (!company) {
          return NextResponse.json({ error: { message: 'Company not found', code: 'company_not_found' } }, { status: 404 });
        }
        // Create initial drive globally for this company
        const { data: newDrive } = await supabase
          .from('placement_drives')
          .insert({
            company_id: companyOrDriveId,
            identity_state: 'manually_assigned',
            identity_confidence: 'high',
            identity_source: 'manual_status_override',
          })
          .select('id')
          .single();
        targetDriveId = newDrive?.id || null;
      }
    }
  }

  if (!targetDriveId) {
    return NextResponse.json({ error: { message: 'Could not resolve placement drive for this company', code: 'drive_not_found' } }, { status: 404 });
  }

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

  const { data: existingApp } = await supabase
    .from('applications')
    .select('id')
    .eq('user_id', session.userId)
    .eq('placement_drive_id', targetDriveId)
    .maybeSingle();

  let application;
  let error;
  if (existingApp?.id) {
    const res = await supabase
      .from('applications')
      .update(applicationPayload)
      .eq('id', existingApp.id)
      .select()
      .single();
    application = res.data;
    error = res.error;
  } else {
    const res = await supabase
      .from('applications')
      .insert(applicationPayload)
      .select()
      .single();
    application = res.data;
    error = res.error;
  }

  if (error) {
    console.error('Failed to update status:', error);
    return NextResponse.json(
      { error: { message: error.message, code: 'db_error' } },
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
