import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeDriveNumber } from '@/lib/drive-number';

export const dynamic = 'force-dynamic';

export async function GET(
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
    // Determine search criteria: is it a drive number or company name?
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

    // 1. Find matching placement_drives
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
      console.error('[Admin Drive Emails API] Drive query error:', driveErr);
      return NextResponse.json({ error: driveErr.message }, { status: 500 });
    }

    const driveIds = (matchedDrives || []).map((d) => d.id);

    // 2. Fetch users for attribution
    const { data: usersData } = await supabase
      .from('users')
      .select('id, name, email');
    const userMap = new Map<string, { name: string | null; email: string }>();
    for (const u of usersData || []) {
      userMap.set(u.id, { name: u.name, email: u.email });
    }

    // 3. Fetch all emails linked to these placement_drives
    let emails: any[] = [];
    if (driveIds.length > 0) {
      const { data: emailRows, error: emailErr } = await supabase
        .from('emails')
        .select('id, user_id, sender, subject, received_at, classification, body_snippet, placement_drive_id, canonical_email_id')
        .in('placement_drive_id', driveIds)
        .order('received_at', { ascending: false });

      if (emailErr) {
        console.error('[Admin Drive Emails API] Emails query error:', emailErr);
      } else {
        emails = emailRows || [];
      }
    }

    // 4. Also check canonical_emails if this drive has a driveNumber
    let canonicalEmails: any[] = [];
    if (driveNumber) {
      const { data: canonicalRows } = await supabase
        .from('canonical_emails')
        .select('id, sender, subject, received_at, classification, body_snippet, drive_number')
        .eq('drive_number', driveNumber)
        .order('received_at', { ascending: false });

      canonicalEmails = canonicalRows || [];
    }

    // Group identical circular receipts into 1 row per unique circular
    interface CircularGroup {
      id: string;
      subject: string;
      sender: string;
      receivedAt: string | null;
      classification: string;
      bodySnippet: string;
      canonicalEmailId: string | null;
      isCanonical: boolean;
      receiptCount: number;
      emailIds: string[];
      students: { userId: string; userName: string; userEmail: string }[];
    }

    const groupMap = new Map<string, CircularGroup>();

    for (const e of emails) {
      const u = userMap.get(e.user_id);
      const studentInfo = {
        userId: e.user_id,
        userName: u?.name || 'Student',
        userEmail: u?.email || '',
      };

      const normSubject = (e.subject || '')
        .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '')
        .trim()
        .toLowerCase();
      const groupKey = e.canonical_email_id
        ? `canonical:${e.canonical_email_id}`
        : `subject:${normSubject}`;

      const existing = groupMap.get(groupKey);
      if (existing) {
        existing.receiptCount++;
        existing.emailIds.push(e.id);
        if (!existing.students.some((s) => s.userId === e.user_id)) {
          existing.students.push(studentInfo);
        }
        if (e.received_at && (!existing.receivedAt || e.received_at > existing.receivedAt)) {
          existing.receivedAt = e.received_at;
        }
        if (!existing.canonicalEmailId && e.canonical_email_id) {
          existing.canonicalEmailId = e.canonical_email_id;
          existing.isCanonical = true;
        }
      } else {
        groupMap.set(groupKey, {
          id: e.id,
          subject: e.subject,
          sender: e.sender,
          receivedAt: e.received_at,
          classification: e.classification || 'unknown',
          bodySnippet: e.body_snippet || '',
          canonicalEmailId: e.canonical_email_id,
          isCanonical: Boolean(e.canonical_email_id),
          receiptCount: 1,
          emailIds: [e.id],
          students: [studentInfo],
        });
      }
    }

    const groupedEmails = Array.from(groupMap.values()).sort((a, b) => {
      const dateA = a.receivedAt ? new Date(a.receivedAt).getTime() : 0;
      const dateB = b.receivedAt ? new Date(b.receivedAt).getTime() : 0;
      return dateB - dateA;
    });

    return NextResponse.json({
      driveKey: decodedKey,
      driveNumber,
      totalCount: emails.length,
      uniqueCircularCount: groupedEmails.length,
      emails: groupedEmails,
      canonicalBroadcasts: canonicalEmails.map((c) => ({
        id: c.id,
        sender: c.sender,
        subject: c.subject,
        receivedAt: c.received_at,
        classification: c.classification,
        bodySnippet: c.body_snippet,
        driveNumber: c.drive_number,
      })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('[Admin Drive Emails API] Unexpected error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
