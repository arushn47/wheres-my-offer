import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeDriveNumber } from '@/lib/drive-number';

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

    // Also query college_emails if searching by keyword
    if (q) {
      // If a driveKey is provided, find all college email IDs already assigned to that drive
      // so we can exclude them (they already show in "Emails Assigned to This Drive").
      const assignedCollegeEmailIds = new Set<string>();

      if (driveKey) {
        // Parse the driveKey format: 'drive:pat-pl-2026-1333' or 'name:deloitte'
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

        // Resolve the target drive(s)
        let driveQuery = supabase
          .from('placement_drives')
          .select('id, drive_number, normalized_drive_number, drive_name, source_college_email_id, excluded_email_ids, companies(id, name, aliases)');

        if (resolvedDriveNumber) {
          driveQuery = driveQuery.or(
            `drive_number.eq.${resolvedDriveNumber},normalized_drive_number.eq.${resolvedDriveNumber}`
          );
        } else if (resolvedCompanyPattern) {
          driveQuery = driveQuery.ilike('drive_name', `%${resolvedCompanyPattern}%`);
        }

        const { data: targetDrives } = await driveQuery;

        if (targetDrives && targetDrives.length > 0) {
          const driveIds = targetDrives.map((d) => d.id);
          const excludedIds = new Set<string>();
          for (const td of targetDrives) {
            if (Array.isArray(td.excluded_email_ids)) {
              for (const ex of td.excluded_email_ids) excludedIds.add(ex);
            }
          }

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
          const driveNumVariants = new Set<string>();
          if (resolvedDriveNumber) driveNumVariants.add(resolvedDriveNumber);
          for (const td of targetDrives) {
            if (td.drive_number) driveNumVariants.add(td.drive_number);
            if (td.normalized_drive_number) driveNumVariants.add(td.normalized_drive_number);
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

          // 4. College circulars matching the drive's company name/aliases
          //    (matching the exact assignment criteria of /api/admin/drives/[driveKey]/emails)
          for (const td of targetDrives) {
            const company = (td as any).companies;
            const cName = company?.name || td.drive_name || '';
            const cAliases: string[] = Array.isArray(company?.aliases) ? company.aliases : [];
            const companyTerms = [cName, ...cAliases].filter((t) => typeof t === 'string' && t.trim().length >= 3);

            for (const term of companyTerms) {
              const cleanTerm = term.replace(/[.*+?^${}()|[\]\\,]/g, '').trim();
              if (!cleanTerm) continue;

              const { data: matchedByCompany } = await supabase
                .from('college_emails')
                .select('id, classification')
                .or(`subject.ilike.%${cleanTerm}%,parsed_company_name.ilike.%${cleanTerm}%`)
                .limit(50);

              for (const cm of matchedByCompany || []) {
                if (!excludedIds.has(cm.id) && cm.classification !== 'irrelevant') {
                  assignedCollegeEmailIds.add(cm.id);
                }
              }
            }
          }

          // 5. Collect normalized subjects of all personal_emails assigned to this drive
          //    so we can exclude college_emails with matching subjects even if no ID linkage exists
          const { data: allAssignedReceipts } = await supabase
            .from('personal_emails')
            .select('subject')
            .in('placement_drive_id', driveIds);

          const assignedNormSubjects = new Set<string>();
          for (const r of allAssignedReceipts || []) {
            const ns = (r.subject || '').replace(/^(?:re|fwd?)\s*:\s*/i, '').trim().toLowerCase();
            if (ns) assignedNormSubjects.add(ns);
          }

          // Attach to outer scope for use during filtering below
          (assignedCollegeEmailIds as any)._assignedNormSubjects = assignedNormSubjects;
        }
      }

      const { data: collegeMatches } = await supabase
        .from('college_emails')
        .select('id, subject, sender_email, received_at, created_at, body_snippet')
        .ilike('subject', `%${q}%`)
        .order('received_at', { ascending: false })
        .limit(30);

      // Retrieve the assigned-subjects set attached earlier
      const assignedNormSubjects: Set<string> = (assignedCollegeEmailIds as any)._assignedNormSubjects || new Set<string>();
      // Deduplicate by normalized subject so we don't show the same circular twice
      const seenSubjects = new Set<string>();

      for (const cm of collegeMatches || []) {
        // Skip if already assigned to the target drive (by ID or parsed_drive_numbers)
        if (assignedCollegeEmailIds.has(cm.id)) continue;

        const normSubject = (cm.subject || '').replace(/^(?:re|fwd?)\s*:\s*/i, '').trim().toLowerCase();

        // Skip if this subject already appears in personal_emails assigned to this drive
        if (assignedNormSubjects.has(normSubject)) continue;

        if (seenSubjects.has(normSubject)) continue;
        seenSubjects.add(normSubject);

        const groupKey = `can:${cm.id}`;
        if (!grouped.has(groupKey)) {
          grouped.set(groupKey, {
            id: cm.id,
            subject: cm.subject || 'No Subject',
            sender: cm.sender_email || 'vitlions2027@vitbhopal.ac.in',
            receivedAt: cm.received_at || cm.created_at,
            snippet: (cm.body_snippet || '').slice(0, 300),
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
    });
  } catch (err: any) {
    console.error('[Admin Email Search API] Unexpected error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
