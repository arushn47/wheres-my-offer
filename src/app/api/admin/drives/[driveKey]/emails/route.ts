import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeDriveNumber } from '@/lib/drive-number';

function parseScheduledDate(sub: string): number | null {
  const m1 = sub.match(/scheduled\s+on\s+[([]?(\d{1,2}(?:st|nd|rd|th)?)\s+([A-Za-z]+)(?:\s+(20\d{2}|\b2[4-7]\b))?/i);
  if (m1) {
    const day = m1[1].replace(/\D/g, '');
    const month = m1[2];
    const year = m1[3] ? (m1[3].length === 2 ? '20' + m1[3] : m1[3]) : '2026';
    const p = Date.parse(`${day} ${month} ${year} UTC`);
    if (!isNaN(p)) return p;
  }
  const m2 = sub.match(/scheduled\s+on\s+[([]?(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2}|\b2[4-7]\b)/i);
  if (m2) {
    const day = parseInt(m2[1], 10);
    const month = parseInt(m2[2], 10) - 1;
    let year = parseInt(m2[3], 10);
    if (year < 100) year += 2000;
    return Date.UTC(year, month, day);
  }
  return null;
}

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
      .select('id, company_id, drive_number, normalized_drive_number, drive_name, category, excluded_email_ids, source_college_email_id, source_email_id, created_at, companies(id, name, aliases)');

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
    const firstDrive = matchedDrives?.[0];
    const company = (firstDrive as any)?.companies;
    const companyName = company?.name || firstDrive?.drive_name || '';
    const aliases: string[] = Array.isArray(company?.aliases) ? company.aliases : [];
    const driveCat = (firstDrive?.category || '').toLowerCase();

    // Collect all excluded email IDs across matching placement_drives
    const excludedEmailIds = new Set<string>();
    for (const d of matchedDrives || []) {
      if (Array.isArray(d.excluded_email_ids)) {
        for (const exId of d.excluded_email_ids) {
          if (exId) excludedEmailIds.add(exId);
        }
      }
    }

    // 2. Fetch users for attribution
    const { data: usersData } = await supabase
      .from('users')
      .select('id, name, email');
    const userMap = new Map<string, { name: string | null; email: string }>();
    for (const u of usersData || []) {
      userMap.set(u.id, { name: u.name, email: u.email });
    }

    // 3. Fetch all personal emails linked to these placement_drives
    let emails: any[] = [];
    if (driveIds.length > 0) {
      const { data: emailRows, error: emailErr } = await supabase
        .from('personal_emails')
        .select('id, user_id, sender, subject, received_at, classification, body_snippet, placement_drive_id, college_email_id, canonical_email_id, assignment_source, is_relevant')
        .in('placement_drive_id', driveIds)
        .order('received_at', { ascending: false });

      if (emailErr) {
        console.error('[Admin Drive Emails API] Emails query error:', emailErr);
      } else {
        emails = (emailRows || []).filter((em: any) => {
          if (em.assignment_source === 'admin_unlinked') return false;
          if (em.is_relevant === false) return false;
          if (em.classification === 'irrelevant') return false;
          if (excludedEmailIds.has(em.id)) return false;
          if (em.college_email_id && excludedEmailIds.has(em.college_email_id)) return false;
          if (em.canonical_email_id && excludedEmailIds.has(em.canonical_email_id)) return false;
          return true;
        });
      }
    }

    // Determine anchor time for unassigned/college circular filtering
    const anchorEmailTimes = emails
      .map((em: any) => em.received_at ? new Date(em.received_at).getTime() : 0)
      .filter((t: number) => t > 0);
    const driveStartTime = anchorEmailTimes.length > 0
      ? Math.min(...anchorEmailTimes)
      : (firstDrive?.created_at ? new Date(firstDrive.created_at).getTime() : 0);
    const driveMinAllowedTime = driveStartTime ? driveStartTime - 24 * 60 * 60 * 1000 : 0;

    // 4. Resolve relevant college broadcast circulars for this drive
    const orConditions: string[] = [];
    for (const d of matchedDrives || []) {
      if (d.source_college_email_id && !excludedEmailIds.has(d.source_college_email_id)) {
        orConditions.push(`id.eq.${d.source_college_email_id}`);
      }
    }
    if (companyName && companyName.length >= 3) {
      const escaped = companyName.replace(/[.*+?^${}()|[\]\\,]/g, '').trim();
      if (escaped) {
        orConditions.push(`parsed_company_name.ilike.%${escaped}%`);
        orConditions.push(`subject.ilike.%${escaped}%`);
      }
    }
    for (const alias of aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\,]/g, '').trim();
      if (escaped && escaped.length >= 4 && escaped.toLowerCase() !== companyName.toLowerCase()) {
        orConditions.push(`subject.ilike.%${escaped}%`);
        orConditions.push(`parsed_company_name.ilike.%${escaped}%`);
      }
    }

    let collegeEmails: any[] = [];
    if (orConditions.length > 0) {
      const { data: collegeRows, error: collegeErr } = await supabase
        .from('college_emails')
        .select('id, sender_email, subject, received_at, created_at, classification, body_snippet, parsed_company_name')
        .or(orConditions.join(','))
        .order('received_at', { ascending: false })
        .limit(50);

      if (collegeErr) {
        console.error('[Admin Drive Emails API] College emails query error:', collegeErr);
      } else {
        for (const cr of (collegeRows || [])) {
          // Strictly exclude if this circular was unlinked or marked irrelevant
          if (excludedEmailIds.has(cr.id)) continue;
          if (cr.classification === 'irrelevant') continue;

          const isExplicit = (matchedDrives || []).some((d: any) => d.source_college_email_id === cr.id);
          const crTime = cr.received_at ? new Date(cr.received_at).getTime() : (cr.created_at ? new Date(cr.created_at).getTime() : 0);
          const sub = cr.subject || '';

          if (!isExplicit) {
            if (driveMinAllowedTime > 0 && crTime > 0 && crTime < driveMinAllowedTime) {
              continue;
            }
            const scheduledDate = parseScheduledDate(sub);
            if (scheduledDate && driveMinAllowedTime > 0 && scheduledDate < driveMinAllowedTime - 7 * 86400000) {
              continue;
            }
            const isDreamDrive = driveCat.includes('dream') || driveCat.includes('super');
            const isRegularDrive = driveCat.includes('regular');
            const subLower = sub.toLowerCase();
            if (isDreamDrive && subLower.includes('regular internship') && !subLower.includes('dream')) {
              continue;
            }
            if (isRegularDrive && (subLower.includes('dream internship') || subLower.includes('super dream'))) {
              continue;
            }
          }

          collegeEmails.push({
            id: cr.id,
            sender: cr.sender_email || 'vitlions2027@vitbhopal.ac.in',
            subject: cr.subject,
            received_at: cr.received_at || cr.created_at,
            classification: cr.classification,
            body_snippet: cr.body_snippet,
            college_email_id: cr.id,
            canonical_email_id: cr.id,
          });
        }
      }
    }

    // Group identical circular receipts into 1 row per unique circular (deduplicated by normalized subject)
    interface CircularGroup {
      id: string;
      subject: string;
      sender: string;
      receivedAt: string | null;
      classification: string;
      bodySnippet: string;
      collegeEmailId: string | null;
      canonicalEmailId: string | null;
      isCollegeCircular: boolean;
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
      const collegeRef = e.college_email_id || e.canonical_email_id;
      // Key by normalized subject so duplicate student receipts collapse
      const groupKey = normSubject ? `subject:${normSubject}` : (collegeRef ? `college:${collegeRef}` : `email:${e.id}`);

      const existing = groupMap.get(groupKey);
      if (existing) {
        existing.receiptCount++;
        if (!existing.emailIds.includes(e.id)) {
          existing.emailIds.push(e.id);
        }
        if (!existing.students.some((s) => s.userId === e.user_id)) {
          existing.students.push(studentInfo);
        }
        if (e.received_at && (!existing.receivedAt || e.received_at > existing.receivedAt)) {
          existing.receivedAt = e.received_at;
        }
        if (!existing.collegeEmailId && collegeRef) {
          existing.collegeEmailId = collegeRef;
          existing.canonicalEmailId = collegeRef;
          existing.isCollegeCircular = true;
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
          collegeEmailId: collegeRef || null,
          canonicalEmailId: collegeRef || null,
          isCollegeCircular: Boolean(collegeRef),
          isCanonical: Boolean(collegeRef),
          receiptCount: 1,
          emailIds: [e.id],
          students: [studentInfo],
        });
      }
    }

    // Merge college broadcast circulars into groupMap so they appear in admin view
    for (const ce of collegeEmails) {
      const normSubject = (ce.subject || '')
        .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '')
        .trim()
        .toLowerCase();
      const groupKey = normSubject ? `subject:${normSubject}` : `college:${ce.id}`;
      const existing = groupMap.get(groupKey);
      if (existing) {
        existing.isCollegeCircular = true;
        existing.isCanonical = true;
        if (!existing.emailIds.includes(ce.id)) {
          existing.emailIds.push(ce.id);
          existing.receiptCount++;
        }
        if (!existing.collegeEmailId) existing.collegeEmailId = ce.id;
        if (!existing.canonicalEmailId) existing.canonicalEmailId = ce.id;
        if (!existing.subject) existing.subject = ce.subject;
        if (ce.received_at && (!existing.receivedAt || ce.received_at > existing.receivedAt)) {
          existing.receivedAt = ce.received_at;
        }
      } else {
        groupMap.set(groupKey, {
          id: ce.id,
          subject: ce.subject,
          sender: ce.sender,
          receivedAt: ce.received_at,
          classification: ce.classification || 'general',
          bodySnippet: ce.body_snippet || '',
          collegeEmailId: ce.id,
          canonicalEmailId: ce.id,
          isCollegeCircular: true,
          isCanonical: true,
          receiptCount: 1,
          emailIds: [ce.id],
          students: [],
        });
      }
    }

    const groupedEmails = Array.from(groupMap.values()).sort((a, b) => {
      const dateA = a.receivedAt ? new Date(a.receivedAt).getTime() : 0;
      const dateB = b.receivedAt ? new Date(b.receivedAt).getTime() : 0;
      return dateB - dateA;
    });

    const formattedCollegeCirculars = collegeEmails.map((c) => ({
      id: c.id,
      sender: c.sender,
      subject: c.subject,
      receivedAt: c.received_at,
      classification: c.classification,
      bodySnippet: c.body_snippet,
      driveNumber: c.drive_number,
    }));

    return NextResponse.json({
      driveKey: decodedKey,
      driveNumber,
      totalCount: emails.length,
      uniqueCircularCount: groupedEmails.length,
      emails: groupedEmails,
      collegeCirculars: formattedCollegeCirculars,
      canonicalBroadcasts: formattedCollegeCirculars, // backwards compatibility
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('[Admin Drive Emails API] Unexpected error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
