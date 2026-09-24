import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Unauthorized' },
      { status: err.status || 401 }
    );
  }

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') || '').trim();
  const unassignedOnly = searchParams.get('unassignedOnly') !== 'false';

  const supabase = createAdminClient();

  try {
    let query = supabase
      .from('emails')
      .select('id, user_id, subject, sender, received_at, body_snippet, canonical_email_id, placement_drive_id, users(name, email)')
      .order('received_at', { ascending: false })
      .limit(100);

    if (q) {
      query = query.ilike('subject', `%${q}%`);
    }

    if (unassignedOnly) {
      query = query.is('placement_drive_id', null);
    }

    const { data: rawEmails, error } = await query;
    if (error) {
      console.error('[Admin Email Search] Error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Group circulars by canonical_email_id or normalized subject
    const grouped = new Map<string, {
      id: string;
      subject: string;
      sender: string;
      receivedAt: string | null;
      snippet: string;
      canonicalEmailId: string | null;
      placementDriveId: string | null;
      receiptCount: number;
      emailIds: string[];
      students: Array<{ name: string; email: string }>;
    }>();

    for (const em of rawEmails || []) {
      const normSubject = (em.subject || '').replace(/^(?:re|fwd?)\s*:\s*/i, '').trim().toLowerCase();
      const groupKey = em.canonical_email_id ? `can:${em.canonical_email_id}` : `sub:${normSubject}`;

      const u = Array.isArray(em.users) ? em.users[0] : em.users;
      const studentInfo = {
        name: u?.name || 'Student',
        email: u?.email || 'student@vitstudent.ac.in',
      };

      const existing = grouped.get(groupKey);
      if (existing) {
        existing.receiptCount += 1;
        existing.emailIds.push(em.id);
        if (!existing.students.some((s) => s.email === studentInfo.email)) {
          existing.students.push(studentInfo);
        }
      } else {
        grouped.set(groupKey, {
          id: em.id,
          subject: em.subject || 'No Subject',
          sender: em.sender || 'Unknown Sender',
          receivedAt: em.received_at,
          snippet: (em.body_snippet || '').slice(0, 300),
          canonicalEmailId: em.canonical_email_id || null,
          placementDriveId: em.placement_drive_id || null,
          receiptCount: 1,
          emailIds: [em.id],
          students: [studentInfo],
        });
      }
    }

    return NextResponse.json({
      success: true,
      results: Array.from(grouped.values()),
    });
  } catch (err: any) {
    console.error('[Admin Email Search API] Unexpected error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
