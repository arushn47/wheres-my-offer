import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';

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
  const { classification, unlinkDrive, deleteEmail } = body;
  const supabase = createAdminClient();

  try {
    // 1. Fetch current email
    const { data: email, error: fetchErr } = await supabase
      .from('emails')
      .select('id, user_id, classification, placement_drive_id, canonical_email_id')
      .eq('id', emailId)
      .maybeSingle();

    if (fetchErr || !email) {
      return NextResponse.json({ error: fetchErr?.message || 'Email not found' }, { status: 404 });
    }

    // Handle Delete
    if (deleteEmail) {
      await Promise.all([
        supabase.from('candidate_matches').delete().eq('email_id', emailId),
        supabase.from('email_drive_links').delete().eq('email_id', emailId),
        supabase.from('events').delete().eq('source_email_id', emailId),
      ]);

      const { error: delErr } = await supabase.from('emails').delete().eq('id', emailId);
      if (delErr) {
        return NextResponse.json({ error: delErr.message }, { status: 500 });
      }

      return NextResponse.json({ success: true, message: 'Email deleted from pipeline' });
    }

    // Handle Unlink from Drive
    if (unlinkDrive) {
      let idsToUnlink: string[] = [emailId];

      if (Array.isArray(body.emailIds) && body.emailIds.length > 0) {
        idsToUnlink = body.emailIds;
      } else if (email.canonical_email_id) {
        const { data: siblings } = await supabase
          .from('emails')
          .select('id')
          .eq('canonical_email_id', email.canonical_email_id);
        if (siblings && siblings.length > 0) {
          idsToUnlink = siblings.map((s) => s.id);
        }
      }

      await Promise.all([
        supabase.from('email_drive_links').delete().in('email_id', idsToUnlink),
        supabase.from('candidate_matches').delete().in('email_id', idsToUnlink),
        supabase.from('events').delete().in('source_email_id', idsToUnlink),
      ]);

      const { error: unlinkErr } = await supabase
        .from('emails')
        .update({
          placement_drive_id: null,
          assignment_state: 'unassigned',
          // Mark as processed so the sync engine never re-assigns this email on the next run.
          // Emails with is_processed=false are picked up for reprocessing (and would be re-linked).
          is_processed: true,
          processed_at: new Date().toISOString(),
        })
        .in('id', idsToUnlink);

      if (unlinkErr) {
        return NextResponse.json({ error: unlinkErr.message }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        message: `Circular unlinked from drive for ${idsToUnlink.length} student receipt(s)`,
        unlinkedCount: idsToUnlink.length,
      });
    }

    // Handle Classification Update
    if (classification) {
      const updates: any = { classification };
      // If marking as irrelevant, set is_relevant = false
      if (classification === 'irrelevant') {
        updates.is_relevant = false;
      } else {
        updates.is_relevant = true;
      }

      const { error: updateErr } = await supabase
        .from('emails')
        .update(updates)
        .eq('id', emailId);

      if (updateErr) {
        return NextResponse.json({ error: updateErr.message }, { status: 500 });
      }

      // If linked to canonical email, update the canonical broadcast and all sibling receipts
      if (email.canonical_email_id) {
        await supabase
          .from('canonical_emails')
          .update({ classification })
          .eq('id', email.canonical_email_id);

        // Update all other user receipts sharing this canonical email
        await supabase
          .from('emails')
          .update(updates)
          .eq('canonical_email_id', email.canonical_email_id);
      }

      return NextResponse.json({
        success: true,
        message: `Classification updated to ${classification}${email.canonical_email_id ? ' (propagated across all canonical receipts)' : ''}`,
      });
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
    await Promise.all([
      supabase.from('candidate_matches').delete().eq('email_id', emailId),
      supabase.from('email_drive_links').delete().eq('email_id', emailId),
      supabase.from('events').delete().eq('source_email_id', emailId),
    ]);

    const { error: delErr } = await supabase.from('emails').delete().eq('id', emailId);
    if (delErr) {
      return NextResponse.json({ error: delErr.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: 'Email deleted from pipeline' });
  } catch (err: any) {
    console.error('[Admin Email DELETE API] Error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
