import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/companies/[id]
 * Deletes a company and all its related drives and data (events, applications, matches, notifications).
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: companyId } = await params;
  const supabase = createAdminClient();

  // Verify the company belongs to this user
  const { data: company, error: fetchError } = await supabase
    .from('companies')
    .select('id, name')
    .eq('id', companyId)
    .eq('user_id', session.userId)
    .single();

  if (fetchError || !company) {
    return NextResponse.json({ error: 'Company not found' }, { status: 404 });
  }

  // Find all drives for this company
  const { data: drives } = await supabase
    .from('placement_drives')
    .select('id')
    .eq('user_id', session.userId)
    .eq('company_id', companyId);

  const driveIds = (drives || []).map((d) => d.id);

  if (driveIds.length > 0) {
    // Unlink emails (set placement_drive_id to null instead of deleting emails)
    await supabase
      .from('emails')
      .update({ placement_drive_id: null })
      .in('placement_drive_id', driveIds)
      .eq('user_id', session.userId);

    // Delete email_drive_links
    await supabase
      .from('email_drive_links')
      .delete()
      .in('placement_drive_id', driveIds)
      .eq('user_id', session.userId);

    // Delete events for these drives
    await supabase
      .from('events')
      .delete()
      .in('placement_drive_id', driveIds)
      .eq('user_id', session.userId);

    // Delete notifications for these drives
    await supabase
      .from('notifications')
      .delete()
      .in('placement_drive_id', driveIds)
      .eq('user_id', session.userId);

    // Delete candidate matches for these drives
    await supabase
      .from('candidate_matches')
      .delete()
      .in('placement_drive_id', driveIds)
      .eq('user_id', session.userId);

    // Delete applications for these drives
    await supabase
      .from('applications')
      .delete()
      .in('placement_drive_id', driveIds)
      .eq('user_id', session.userId);

    // Delete placement drives
    await supabase
      .from('placement_drives')
      .delete()
      .eq('company_id', companyId)
      .eq('user_id', session.userId);
  }

  // Delete the company itself
  const { error: deleteError } = await supabase
    .from('companies')
    .delete()
    .eq('id', companyId)
    .eq('user_id', session.userId);

  if (deleteError) {
    console.error('Failed to delete company:', deleteError);
    return NextResponse.json({ error: 'Failed to delete company' }, { status: 500 });
  }

  return NextResponse.json({ success: true, deleted: company.name });
}
