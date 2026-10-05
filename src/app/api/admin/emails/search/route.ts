import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeDriveNumber } from '@/lib/drive-number';
import { getDriveRegistrationDateBoundary, isEmailAllowedByDriveBoundary } from '@/lib/sync/drive-temporal-boundary';

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
  const driveKey = (searchParams.get('driveKey') || '').trim();

  const supabase = createAdminClient();

  try {
    // If a driveKey is provided, resolve target drive(s), exclude already-assigned circulars,
    // and enforce the drive registration temporal boundary (only circulars on or after registration date).
    const assignedCollegeEmailIds = new Set<string>();
    const takenCollegeEmailIds = new Set<string>();
    // Subjects of direct personal emails (no college_email_id) already assigned to OTHER drives
    const takenBySubject = new Set<string>();
    // Drive number variants for the target drive (all case forms); used to detect
    // college emails already serving this drive via their parsed_drive_numbers field.
    const driveNumVariants = new Set<string>();
    let boundary: { minAllowedDate: Date | null; registrationDate: Date | null; formattedRegistrationDate: string | null } = {
      minAllowedDate: null,
      registrationDate: null,
      formattedRegistrationDate: null,
    };

    if (driveKey) {
      let resolvedDriveNumber: string | null = null;
      let resolvedCompanyPattern: string | null = null;

      if (driveKey.startsWith('drive:')) {
        resolvedDriveNumber = normalizeDriveNumber(driveKey.slice(6));
      } else if (driveKey.startsWith('name:')) {
        resolvedCompanyPattern = driveKey.slice(5).trim();
      } else {
        const norm = normalizeDriveNumber(driveKey);
        if (norm) resolvedDriveNumber = norm;
        else resolvedCompanyPattern = driveKey.trim();
      }

      // Resolve the target drive(s).
      // NOTE: Do NOT use .or() with hyphenated drive numbers — PostgREST parses
      // hyphens as subtraction operators in the or() filter string, causing the
      // query to silently return 0 rows. Use separate .eq() queries instead.
      type TargetDrive = {
        id: string;
        drive_number: string;
        normalized_drive_number: string;
        drive_name: string;
        created_at: string;
        source_email_id: string | null;
        source_college_email_id: string | null;
        excluded_email_ids: string[];
        companies: { id: string; name: string; aliases: string[] } | null;
      };
      let targetDrives: TargetDrive[] | null = null;

      if (resolvedDriveNumber) {
        // Query by drive_number first, then by normalized_drive_number, merge results
        const [byDriveNum, byNormalized] = await Promise.all([
          supabase
            .from('placement_drives')
            .select('id, drive_number, normalized_drive_number, drive_name, created_at, source_email_id, source_college_email_id, excluded_email_ids, companies(id, name, aliases)')
            .eq('drive_number', resolvedDriveNumber),
          supabase
            .from('placement_drives')
            .select('id, drive_number, normalized_drive_number, drive_name, created_at, source_email_id, source_college_email_id, excluded_email_ids, companies(id, name, aliases)')
            .eq('normalized_drive_number', resolvedDriveNumber),
        ]);
        const seen = new Set<string>();
        const merged: TargetDrive[] = [];
        for (const d of [...(byDriveNum.data || []), ...(byNormalized.data || [])]) {
          if (!seen.has(d.id)) { seen.add(d.id); merged.push(d as unknown as TargetDrive); }
        }
        targetDrives = merged;
      } else if (resolvedCompanyPattern) {
        const { data } = await supabase
          .from('placement_drives')
          .select('id, drive_number, normalized_drive_number, drive_name, created_at, source_email_id, source_college_email_id, excluded_email_ids, companies(id, name, aliases)')
          .ilike('drive_name', `%${resolvedCompanyPattern}%`);
        targetDrives = data as unknown as TargetDrive[];
      }

      if (targetDrives && targetDrives.length > 0) {
        const driveIds = targetDrives.map((d) => d.id);
        const excludedIds = new Set<string>();
        for (const td of targetDrives) {
          if (Array.isArray(td.excluded_email_ids)) {
            for (const ex of td.excluded_email_ids) excludedIds.add(ex);
          }
        }

        // Calculate minimum allowed registration date boundary for this drive
        boundary = await getDriveRegistrationDateBoundary(
          supabase,
          driveIds,
          targetDrives[0]?.created_at
        );

        // 1. source_college_email_id set directly on the drive
        for (const d of targetDrives) {
          if (d.source_college_email_id && !excludedIds.has(d.source_college_email_id)) {
            assignedCollegeEmailIds.add(d.source_college_email_id);
          }
        }

        // 2. college_email_id referenced by personal_emails already assigned to this drive
        const { data: assignedReceipts } = await supabase
          .from('personal_emails')
          .select('college_email_id, canonical_email_id')
          .in('placement_drive_id', driveIds)
          .not('college_email_id', 'is', null);

        for (const r of assignedReceipts || []) {
          if (r.college_email_id && !excludedIds.has(r.college_email_id)) assignedCollegeEmailIds.add(r.college_email_id);
          if (r.canonical_email_id && !excludedIds.has(r.canonical_email_id)) assignedCollegeEmailIds.add(r.canonical_email_id);
        }

        // 3. college_emails whose parsed_drive_numbers JSON array contains any of the target drive numbers
        // driveNumVariants is declared in the outer scope so the college_emails loop can also use it.
        const addVariants = (num: string) => {
          if (!num) return;
          driveNumVariants.add(num);
          driveNumVariants.add(num.toUpperCase());
          const parts = num.split('-');
          if (parts.length >= 2) {
            parts[1] = parts[1].toUpperCase();
            driveNumVariants.add(parts.join('-'));
          }
        };

        if (resolvedDriveNumber) addVariants(resolvedDriveNumber);
        for (const td of targetDrives) {
          addVariants(td.drive_number);
          addVariants(td.normalized_drive_number);
        }

        for (const num of driveNumVariants) {
          const { data: alreadyParsed } = await supabase
            .from('college_emails')
            .select('id')
            .filter('parsed_drive_numbers', 'cs', JSON.stringify([num]));

          for (const ce of alreadyParsed || []) {
            if (!excludedIds.has(ce.id)) {
              assignedCollegeEmailIds.add(ce.id);
            }
          }
        }


        // 5. College circulars already assigned to ANY OTHER drive must never be
        // offered for linking again — one circular drives one placement drive.
        const { data: takenReceipts } = await supabase
          .from('personal_emails')
          .select('college_email_id, canonical_email_id')
          .not('placement_drive_id', 'is', null)
          .not('college_email_id', 'is', null)
          .not('assignment_source', 'eq', 'admin_unlinked');
        for (const r of takenReceipts || []) {
          if (r.college_email_id) takenCollegeEmailIds.add(r.college_email_id);
          if (r.canonical_email_id) takenCollegeEmailIds.add(r.canonical_email_id);
        }
        const { data: takenDrives } = await supabase
          .from('placement_drives')
          .select('id, source_college_email_id')
          .not('source_college_email_id', 'is', null);
        for (const d of takenDrives || []) {
          if (d.source_college_email_id && !driveIds.includes(d.id)) {
            takenCollegeEmailIds.add(d.source_college_email_id);
          }
        }

        // 6. For emails with NO college_email_id (direct personal receipts from
        // NeoPAT/VIT broadcasts), group by normalized subject. If ANY receipt of
        // the same subject is already assigned to a drive (excluding the target
        // drive), treat the entire subject group as taken — one email subject
        // maps to one drive.
        const { data: takenDirectReceipts } = await supabase
          .from('personal_emails')
          .select('subject, placement_drive_id')
          .not('placement_drive_id', 'is', null)
          .is('college_email_id', null)
          .not('assignment_source', 'eq', 'admin_unlinked');
        for (const r of takenDirectReceipts || []) {
          // Skip if already assigned to the TARGET drive (not a conflict)
          if (driveIds.includes(r.placement_drive_id)) continue;
          const normalized = (r.subject || '').toLowerCase().trim();
          if (normalized) takenBySubject.add(normalized);
        }
      }
    }

    let query = supabase
      .from('personal_emails')
      .select('id, user_id, subject, sender, received_at, body_snippet, college_email_id, canonical_email_id, placement_drive_id, users(name, email)')
      .order('received_at', { ascending: false })
      .limit(100);

    if (q) {
      query = query.ilike('subject', `%${q}%`);
    }

    if (unassignedOnly) {
      query = query.is('placement_drive_id', null);
    }

    if (boundary.minAllowedDate) {
      query = query.gte('received_at', boundary.minAllowedDate.toISOString());
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
      // Respect drive registration temporal boundary if set
      if (boundary.minAllowedDate && !isEmailAllowedByDriveBoundary(em.received_at, boundary.minAllowedDate)) {
        continue;
      }

      // Skip direct personal receipts (no college_email_id) whose subject is already
      // assigned to another drive. These are NeoPAT/VIT broadcast emails that were
      // forwarded to multiple students — one subject = one drive.
      if (!em.college_email_id && !em.canonical_email_id) {
        const normalizedSubject = (em.subject || '').toLowerCase().trim();
        if (normalizedSubject && takenBySubject.has(normalizedSubject)) {
          continue;
        }
      }

      // Group ONLY by canonical circular identity, never by subject: "Re: X" replies
      // in the same Gmail thread are DIFFERENT circulars with different attachments
      // and different recipients.
      const groupKey = em.canonical_email_id
        ? `can:${em.canonical_email_id}`
        : em.college_email_id
          ? `ce:${em.college_email_id}`
          : `raw:${em.id}`;

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

    // Also query college_emails if searching by keyword
    if (q) {
      let collegeQuery = supabase
        .from('college_emails')
        .select('id, subject, sender_email, received_at, created_at, body_text, parsed_drive_numbers')
        .or(`subject.ilike.%${q}%,parsed_company_name.ilike.%${q}%`)
        .order('received_at', { ascending: false })
        .limit(30);

      if (boundary.minAllowedDate) {
        collegeQuery = collegeQuery.gte('received_at', boundary.minAllowedDate.toISOString());
      }

      const { data: collegeMatches } = await collegeQuery;

      for (const cm of collegeMatches || []) {
        // Skip if already assigned to the target drive (by ID or parsed_drive_numbers)
        if (assignedCollegeEmailIds.has(cm.id)) continue;
        // parsed_drive_numbers ownership check: if this college email has been
        // parsed to belong to ANY drive, it's "claimed". Show it only if it
        // belongs to the TARGET drive. If it belongs to a sibling/other drive,
        // never offer it for linking — one circular = one drive.
        if (Array.isArray(cm.parsed_drive_numbers) && cm.parsed_drive_numbers.length > 0) {
          const pdns: string[] = cm.parsed_drive_numbers;
          const belongsToTarget = driveNumVariants.size > 0 && pdns.some((n) => driveNumVariants.has(n));
          if (!belongsToTarget) continue; // claimed by another drive — skip
        }
        // Skip circulars already consumed by any other drive
        if (takenCollegeEmailIds.has(cm.id)) continue;
        // Respect drive registration temporal boundary if set
        if (boundary.minAllowedDate && !isEmailAllowedByDriveBoundary(cm.received_at || cm.created_at, boundary.minAllowedDate)) {
          continue;
        }

        const groupKey = `can:${cm.id}`;
        if (!grouped.has(groupKey)) {
          grouped.set(groupKey, {
            id: cm.id,
            subject: cm.subject || 'No Subject',
            sender: cm.sender_email || 'vitlions2027@vitbhopal.ac.in',
            receivedAt: cm.received_at || cm.created_at,
            snippet: (cm.body_text || '').slice(0, 300),
            canonicalEmailId: cm.id,
            placementDriveId: null,
            receiptCount: 1,
            emailIds: [cm.id],
            students: [],
          });
        }
      }
    }

    return NextResponse.json({
      success: true,
      results: Array.from(grouped.values()),
      registrationDateBoundary: boundary.formattedRegistrationDate,
    });
  } catch (err: any) {
    console.error('[Admin Email Search API] Unexpected error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
