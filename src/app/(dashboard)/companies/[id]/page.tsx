import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import CompanyDetailClient, { type CompanyDetail } from './company-detail-client';
import { detectCampus, detectBranch, detectRegNo } from '@/lib/utils';

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

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const supabase = createAdminClient();
  let { data: company } = await supabase
    .from('companies')
    .select('name')
    .eq('id', id)
    .maybeSingle();

  if (!company) {
    const { data: drive } = await supabase
      .from('placement_drives')
      .select('company_id')
      .eq('id', id)
      .maybeSingle();
    if (drive) {
      const { data: c } = await supabase
        .from('companies')
        .select('name')
        .eq('id', drive.company_id)
        .maybeSingle();
      company = c;
    }
  }

  const name = company?.name || 'Company Details';
  return {
    title: name,
    description: `Detailed recruitment drive history, schedule, test rounds, and email updates for ${name} on Where's My Offer?.`,
    alternates: {
      canonical: `/companies/${id}`,
    },
  };
}

export default async function CompanyDetailPage(props: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await requireSession();
  const params = await props.params;
  const searchParams = props.searchParams ? await props.searchParams : {};
  const companyId = params.id;
  const appId = searchParams.appId as string | undefined;
  const urlDriveId = searchParams.driveId as string | undefined;
  const supabase = createAdminClient();

  // 1. Fetch company early (or resolve via placement_drive if id is driveId)
  let { data: company } = await supabase
    .from('companies')
    .select('id, name, aliases')
    .eq('id', companyId)
    .maybeSingle();

  let resolvedDriveId = urlDriveId || null;

  if (!company) {
    // Canonical Redirect: If params.id was a placement_drive_id, normalize to /companies/[companyId]?driveId=[driveId]
    const { data: drive } = await supabase
      .from('placement_drives')
      .select('id, company_id')
      .eq('id', companyId)
      .maybeSingle();
    if (drive) {
      const sp = new URLSearchParams();
      sp.set('driveId', drive.id);
      for (const [k, v] of Object.entries(searchParams)) {
        if (k !== 'driveId' && k !== 'appId' && typeof v === 'string') {
          sp.set(k, v);
        }
      }
      redirect(`/companies/${drive.company_id}?${sp.toString()}`);
    }
  }

  if (!company) {
    notFound();
  }

  // 2. Resolve all drives for this company
  const { data: companyDrives } = await supabase
    .from('placement_drives')
    .select('id, drive_number, normalized_drive_number, drive_name, role, category, ctc, stipend, location, registration_deadline, eligibility, branches, cgpa_requirement, backlog_requirement, source_email_id, source_college_email_id, excluded_email_ids, created_at')
    .eq('company_id', company.id);

  const driveIds = (companyDrives || []).map((d) => d.id);

  // 3. Resolve target drive
  let targetDrive = null;
  if (resolvedDriveId) {
    targetDrive = (companyDrives || []).find((d) => d.id === resolvedDriveId) || null;
  }
  if (!targetDrive && companyDrives && companyDrives.length > 0) {
    targetDrive = companyDrives[0];
  }
  const placementDriveId = targetDrive?.id || null;

  // Collect all excluded email IDs across drives for this company
  const excludedEmailIds = new Set<string>();
  for (const d of (companyDrives || [])) {
    if (Array.isArray((d as any).excluded_email_ids)) {
      for (const exId of (d as any).excluded_email_ids) {
        if (exId) excludedEmailIds.add(exId);
      }
    }
  }

  // 3b. Resolve shared drive metadata across all placement drives for this drive number
  let sharedDriveMeta: any = null;
  const targetDriveNum = targetDrive?.normalized_drive_number || targetDrive?.drive_number;
  if (targetDriveNum) {
    const { data: siblingDrive } = await supabase
      .from('placement_drives')
      .select('role, category, ctc, stipend, location, eligibility, branches, cgpa_requirement, backlog_requirement')
      .or(`normalized_drive_number.eq.${targetDriveNum},drive_number.eq.${targetDriveNum}`)
      .or('ctc.not.is.null,location.not.is.null,stipend.not.is.null,role.not.is.null')
      .limit(1)
      .maybeSingle();
    sharedDriveMeta = siblingDrive;
  }

  // 4. Resolve application
  let application = null;
  if (appId) {
    const { data: app } = await supabase
      .from('applications')
      .select('*')
      .eq('id', appId)
      .eq('user_id', session.userId)
      .maybeSingle();
    application = app;
  } else if (placementDriveId) {
    const { data: app } = await supabase
      .from('applications')
      .select('*')
      .eq('placement_drive_id', placementDriveId)
      .eq('user_id', session.userId)
      .maybeSingle();
    application = app;
  }

  // 5. Query events and emails using placement_drive_id, email_drive_links, and company name matching
  const targetDriveIds = placementDriveId ? [placementDriveId] : driveIds;
  const driveFilterIds = targetDriveIds.length > 0 ? targetDriveIds : ['00000000-0000-0000-0000-000000000000'];

  const companyAliases = Array.from(new Set([
    company.name,
    ...(company.aliases || []),
    ...(targetDrive?.drive_number ? [targetDrive.drive_number] : []),
  ])).filter((a) => a && a.length >= 3);

  // Substantive aliases only for SQL query (>= 4 chars, excluding generic words)
  const substantiveAliases = companyAliases.filter((a) => {
    const clean = a.trim().toLowerCase();
    return clean.length >= 4 && !['group', 'india', 'campus', 'work', 'part', 'data', 'asia', 'tech', 'life', 'pls'].includes(clean);
  });

  const [
    { data: events },
    { data: assignedEmails },
    unassignedEmailsResult,
    { data: linkedEmailsData },
    { data: candidateMatches },
    { data: userProfile },
    { data: gmailAccounts },
  ] = await Promise.all([
    supabase
      .from('events')
      .select('id, event_type, title, start_time, end_time, venue, mode, placement_drive_id, college_email_id, source_email_id')
      .in('placement_drive_id', driveFilterIds)
      .eq('user_id', session.userId)
      .order('start_time', { ascending: false }),

    supabase
      .from('personal_emails')
      .select('id, subject, sender, received_at, body_snippet, college_email_id, canonical_email_id, classification, thread_id, gmail_message_id, gmail_account_id, placement_drive_id, assignment_source, is_relevant')
      .in('placement_drive_id', driveFilterIds)
      .eq('user_id', session.userId)
      .order('received_at', { ascending: false }),

    substantiveAliases.length > 0
      ? supabase
          .from('personal_emails')
          .select('id, subject, sender, received_at, body_snippet, college_email_id, canonical_email_id, classification, thread_id, gmail_message_id, gmail_account_id, placement_drive_id, assignment_source, is_relevant')
          .eq('user_id', session.userId)
          .is('placement_drive_id', null)
          .or('assignment_source.is.null,assignment_source.neq.admin_unlinked')
          .or(substantiveAliases.map((a) => `subject.ilike.%${a.replace(/,/g, '')}%`).join(','))
          .order('received_at', { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [] }),

    supabase
      .from('email_drive_links')
      .select('email_id')
      .in('placement_drive_id', driveFilterIds)
      .eq('user_id', session.userId),

    supabase
      .from('candidate_matches')
      .select('id, match_type, matched_value, match_location, created_at, email_id, college_email_id, neo_id')
      .in('placement_drive_id', driveFilterIds)
      .eq('user_id', session.userId)
      .neq('match_type', 'xlsx_applied_list'),

    supabase
      .from('users')
      .select('name, neo_id')
      .eq('id', session.userId)
      .maybeSingle(),

    supabase
      .from('gmail_accounts')
      .select('id, email, account_type')
      .eq('user_id', session.userId),
  ]);

  const sourceEmail = targetDrive?.source_email_id
    ? (assignedEmails || []).find((email: any) => email.id === targetDrive.source_email_id)
    : null;

  // Determine anchor time for unassigned fallback emails.
  const anchorEmailTimes = (assignedEmails || [])
    .filter((em: any) => !placementDriveId || em.placement_drive_id === placementDriveId)
    .map((em: any) => em.received_at ? new Date(em.received_at).getTime() : 0)
    .filter((t: number) => t > 0);

  const driveStartTime = sourceEmail?.received_at
    ? new Date(sourceEmail.received_at).getTime()
    : anchorEmailTimes.length > 0
      ? Math.min(...anchorEmailTimes)
      : application?.applied_at
        ? new Date(application.applied_at).getTime()
        : null;

  // Allow circulars arriving up to 24h prior to the anchor time (matching sync engine ±24h grace window)
  const driveMinAllowedTime = driveStartTime ? driveStartTime - 24 * 60 * 60 * 1000 : 0;

  // Combine verified assigned emails (authoritative for this drive)
  const allEmailsMap = new Map<string, any>();
  for (const em of (assignedEmails || [])) {
    if (em.classification === 'irrelevant' || em.is_relevant === false) continue;
    if (em.assignment_source === 'admin_unlinked') continue;
    if (excludedEmailIds.has(em.id)) continue;
    if (em.college_email_id && excludedEmailIds.has(em.college_email_id)) continue;
    if (em.canonical_email_id && excludedEmailIds.has(em.canonical_email_id)) continue;
    allEmailsMap.set(em.id, em);
  }

  // Add verified linked emails
  const missingLinkedIds = (linkedEmailsData || [])
    .map((l: any) => l.email_id)
    .filter((id: string) => !allEmailsMap.has(id) && !excludedEmailIds.has(id));
  if (missingLinkedIds.length > 0) {
    const [{ data: extraPersonal }, { data: extraCollege }] = await Promise.all([
      supabase
        .from('personal_emails')
        .select('id, subject, sender, received_at, body_snippet, canonical_email_id, college_email_id, classification, thread_id, gmail_message_id, gmail_account_id, placement_drive_id, assignment_source, is_relevant')
        .in('id', missingLinkedIds),
      supabase
        .from('college_emails')
        .select('id, subject, sender_email, received_at, created_at, body_snippet, classification')
        .in('id', missingLinkedIds),
    ]);
    for (const em of (extraPersonal || [])) {
      if (em.classification === 'irrelevant' || em.is_relevant === false) continue;
      if (em.assignment_source === 'admin_unlinked') continue;
      if (excludedEmailIds.has(em.id)) continue;
      if (em.college_email_id && excludedEmailIds.has(em.college_email_id)) continue;
      if (em.canonical_email_id && excludedEmailIds.has(em.canonical_email_id)) continue;
      allEmailsMap.set(em.id, em);
    }
    for (const em of (extraCollege || [])) {
      if (em.classification === 'irrelevant') continue;
      if (excludedEmailIds.has(em.id)) continue;
      allEmailsMap.set(em.id, {
        id: em.id,
        subject: em.subject,
        sender: em.sender_email,
        received_at: em.received_at || em.created_at,
        body_snippet: em.body_snippet,
        classification: em.classification,
        is_college_broadcast: true,
      });
    }
  }

  // Add unassigned fallback emails ONLY if they arrived within this drive's active timeframe
  // AND match the company name with strict word boundaries
  for (const em of (unassignedEmailsResult?.data || [])) {
    if ((em as any).assignment_source === 'admin_unlinked') continue;
    if (em.classification === 'irrelevant' || em.is_relevant === false) continue;
    if (excludedEmailIds.has(em.id)) continue;
    if (em.college_email_id && excludedEmailIds.has(em.college_email_id)) continue;
    if (em.canonical_email_id && excludedEmailIds.has(em.canonical_email_id)) continue;

    const emTime = em.received_at ? new Date(em.received_at).getTime() : 0;
    // RULE: Never check or include unassigned emails that arrived before this drive came!
    if (driveMinAllowedTime > 0 && emTime < driveMinAllowedTime) {
      continue;
    }
    const sub = em.subject || '';
    const isRealMatch = substantiveAliases.some((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(sub);
    });
    if (isRealMatch) {
      allEmailsMap.set(em.id, em);
    }
  }

  // Resolve all college circulars relevant to this drive
  const collegeEmailIds = new Set<string>();
  for (const d of (companyDrives || [])) {
    if ((d as any).source_college_email_id && !excludedEmailIds.has((d as any).source_college_email_id)) {
      collegeEmailIds.add((d as any).source_college_email_id);
    }
  }
  for (const ev of (events || [])) {
    if ((ev as any).college_email_id && !excludedEmailIds.has((ev as any).college_email_id)) {
      collegeEmailIds.add((ev as any).college_email_id);
    }
  }
  for (const cm of (candidateMatches || [])) {
    if ((cm as any).college_email_id && !excludedEmailIds.has((cm as any).college_email_id)) {
      collegeEmailIds.add((cm as any).college_email_id);
    }
  }

  // Also resolve college circulars explicitly linked to this drive by drive number
  const driveNumbers = Array.from(new Set(
    (companyDrives || []).flatMap((d: any) => [d.drive_number, d.normalized_drive_number].filter(Boolean) as string[])
  ));

  for (const dNum of driveNumbers) {
    const { data: cByNum } = await supabase
      .from('college_emails')
      .select('id')
      .filter('parsed_drive_numbers', 'cs', JSON.stringify([dNum]));
    for (const c of cByNum || []) {
      if (!excludedEmailIds.has(c.id)) {
        collegeEmailIds.add(c.id);
      }
    }
  }

  const orConditions: string[] = [];
  if (collegeEmailIds.size > 0) {
    orConditions.push(`id.in.(${Array.from(collegeEmailIds).join(',')})`);
  }
  if (company.name && company.name.length >= 3) {
    const escaped = company.name.replace(/[.*+?^${}()|[\]\\,]/g, '').trim();
    if (escaped) {
      orConditions.push(`parsed_company_name.ilike.%${escaped}%`);
      orConditions.push(`subject.ilike.%${escaped}%`);
    }
  }
  for (const alias of substantiveAliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\,]/g, '').trim();
    if (escaped && escaped.length >= 4 && escaped.toLowerCase() !== company.name.toLowerCase()) {
      orConditions.push(`subject.ilike.%${escaped}%`);
      orConditions.push(`parsed_company_name.ilike.%${escaped}%`);
    }
  }

  if (orConditions.length > 0) {
    const { data: collegeEmailRows } = await supabase
      .from('college_emails')
      .select('id, subject, sender_email, received_at, created_at, body_snippet, body_text, classification, parsed_company_name, parsed_drive_numbers')
      .or(orConditions.join(','))
      .order('received_at', { ascending: false })
      .limit(50);

    const seenCollegeSubjects = new Set<string>();
    // Pre-populate seen subjects from personal emails already in allEmailsMap
    for (const em of allEmailsMap.values()) {
      const norm = (em.subject || '').replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '').trim().toLowerCase();
      if (norm) seenCollegeSubjects.add(norm);
    }

    for (const ce of (collegeEmailRows || [])) {
      // Exclude unlinked and irrelevant circulars
      if (excludedEmailIds.has(ce.id)) continue;
      if (ce.classification === 'irrelevant') continue;

      const normSub = (ce.subject || '')
        .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '')
        .trim()
        .toLowerCase();
      // Deduplicate broadcast copies with identical normalized subjects
      if (normSub && seenCollegeSubjects.has(normSub)) {
        continue;
      }

      if (!allEmailsMap.has(ce.id)) {
        const isDriveNumberMatch = driveNumbers.some((dNum) => {
          const dLower = dNum.toLowerCase();
          const parsedNums = ((ce as any).parsed_drive_numbers || []).map((n: string) => n.toLowerCase());
          return parsedNums.includes(dLower);
        });
        const isExplicitId = collegeEmailIds.has(ce.id) || isDriveNumberMatch;
        const sub = ce.subject || '';
        const parsedName = (ce as any).parsed_company_name || '';
        const matchesWordBoundary = substantiveAliases.some((alias) => {
          const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = alias.length <= 3
            ? new RegExp(`\\b${escaped}\\b`, 'i')
            : new RegExp(`\\b${escaped}`, 'i');
          return regex.test(sub) || regex.test(parsedName);
        });

        if (isExplicitId || matchesWordBoundary) {
          // If not an explicit ID linked directly to this drive, enforce drive window & tier compatibility
          if (!isExplicitId) {
            const ceTime = ce.received_at
              ? new Date(ce.received_at).getTime()
              : (ce.created_at ? new Date(ce.created_at).getTime() : 0);

            // 1. RULE: Only circulars arriving on or after the date of drive (with ±24h grace window)
            if (driveMinAllowedTime > 0 && ceTime > 0 && ceTime < driveMinAllowedTime) {
              continue;
            }

            // 2. Reject circulars whose subject explicitly specifies a scheduled date in the distant past
            const scheduledDate = parseScheduledDate(sub);
            if (scheduledDate && driveMinAllowedTime > 0 && scheduledDate < driveMinAllowedTime - 7 * 86400000) {
              continue;
            }

            // 3. Reject cross-tier mismatch (e.g. Regular Internship circular leaking into Dream Internship drive)
            const driveCat = (targetDrive?.category || '').toLowerCase();
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

          if (normSub) seenCollegeSubjects.add(normSub);
          allEmailsMap.set(ce.id, {
            id: ce.id,
            subject: ce.subject,
            sender: ce.sender_email || 'vitlions2027@vitbhopal.ac.in',
            received_at: ce.received_at || ce.created_at,
            body_snippet: ce.body_text || ce.body_snippet || '',
            canonical_email_id: ce.id,
            classification: ce.classification || 'general',
            thread_id: null,
            gmail_message_id: null,
            gmail_account_id: null,
            placement_drive_id: placementDriveId,
          });
        }
      }
    }
  }

  // Fetch canonical bodies and attachments separately so a PostgREST relationship/schema-cache
  // issue cannot make the underlying per-user email rows disappear from the timeline.
  const canonicalIds = Array.from(new Set(
    Array.from(allEmailsMap.values())
      .map((em: any) => em.college_email_id || em.canonical_email_id || (em.is_college ? em.id : null))
      .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
  ));
  const canonicalBodyById = new Map<string, string>();
  const attachmentByCollegeEmailId = new Map<string, string>();
  if (canonicalIds.length > 0) {
    const [canonicalRes, attachmentRes] = await Promise.all([
      supabase
        .from('college_emails')
        .select('id, body_text, body_snippet')
        .in('id', canonicalIds),
      supabase
        .from('college_attachments')
        .select('college_email_id, filename')
        .in('college_email_id', canonicalIds),
    ]);

    if (canonicalRes.error) {
      console.warn('[CompanyDetailPage] Could not load college email bodies:', canonicalRes.error.message);
    } else {
      for (const canonical of canonicalRes.data || []) {
        const body = canonical.body_text || canonical.body_snippet || '';
        if (body) canonicalBodyById.set(canonical.id, body);
      }
    }

    if (attachmentRes.data) {
      for (const att of attachmentRes.data) {
        if (att.college_email_id && att.filename) {
          attachmentByCollegeEmailId.set(att.college_email_id, att.filename);
        }
      }
    }

    // Also pull attachment filenames from candidate_matches across all users for these canonical emails
    const { data: globalMatches } = await supabase
      .from('candidate_matches')
      .select('college_email_id, matched_value')
      .in('college_email_id', canonicalIds)
      .not('college_email_id', 'is', null);

    for (const gm of globalMatches || []) {
      if (gm.college_email_id && !attachmentByCollegeEmailId.has(gm.college_email_id)) {
        const m = gm.matched_value?.match(/Matched in (.+?)\s*\(/i);
        if (m && m[1]) {
          attachmentByCollegeEmailId.set(gm.college_email_id, m[1].trim());
        }
      }
    }
  }

  // Sort verified and matched emails from newest to oldest
  const emails = Array.from(allEmailsMap.values())
    .sort((a, b) => {
      const tA = a.received_at ? new Date(a.received_at).getTime() : 0;
      const tB = b.received_at ? new Date(b.received_at).getTime() : 0;
      return tB - tA;
    });

  // Map account id to email address
  const accountMap = new Map<string, string>();
  (gmailAccounts || []).forEach((acc) => {
    accountMap.set(acc.id, acc.email);
  });

  // Filter candidate matches to only those belonging to this company's emails
  const companyEmailIds = new Set([
    ...(emails || []).map((e: any) => e.id),
    ...(emails || []).map((e: any) => e.college_email_id || e.canonical_email_id).filter(Boolean),
  ]);
  const companyCandidateMatches = (candidateMatches || []).filter((cm: any) => {
    const emailRef = cm.college_email_id || cm.email_id;
    return emailRef ? companyEmailIds.has(emailRef) : true;
  });

  const detail: CompanyDetail = {
    id: company.id,
    placementDriveId,
    name: company.name,
    legalName: null,
    aliases: company.aliases,
    driveNumber: targetDrive?.drive_number || null,
    driveName: targetDrive?.drive_name || null,
    candidateName: userProfile?.name || session.name || 'Student Candidate',
    candidateRegId: userProfile?.neo_id || '',
    application: application
      ? {
          id: application.id,
          status: application.status,
          statusSource: application.status_source,
          statusConfidence: application.status_confidence,
          role: application.role || targetDrive?.role || sharedDriveMeta?.role || null,
          category: application.category || targetDrive?.category || sharedDriveMeta?.category || null,
          ctc: application.ctc || targetDrive?.ctc || sharedDriveMeta?.ctc || null,
          stipend: application.stipend || targetDrive?.stipend || sharedDriveMeta?.stipend || null,
          location: application.location || targetDrive?.location || sharedDriveMeta?.location || null,
          eligibility: application.eligibility || targetDrive?.eligibility || sharedDriveMeta?.eligibility || null,
          branches: application.branches || targetDrive?.branches || sharedDriveMeta?.branches || null,
          cgpaRequirement: application.cgpa_requirement || targetDrive?.cgpa_requirement || sharedDriveMeta?.cgpa_requirement || null,
          backlogRequirement: application.backlog_requirement || targetDrive?.backlog_requirement || sharedDriveMeta?.backlog_requirement || null,
          manualOverride: application.manual_override,
          notes: application.notes,
          appliedAt: application.applied_at,
          lastUpdated: application.last_updated,
        }
      : null,
    events: (() => {
      const nowMs = Date.now();
      const filtered = (events || [])
        .filter((e) => {
          if (e.event_type === 'registration_deadline') {
            const isRegistered = application && application.status !== 'not_applied' && application.status !== 'unknown';
            const isPast = e.start_time && new Date(e.start_time).getTime() <= nowMs;
            if (isRegistered || isPast) return false;
          }
          return true;
        })
        .map((e) => ({
          id: e.id,
          eventType: e.event_type,
          title: e.title,
          startTime: e.start_time,
          endTime: e.end_time,
          venue: e.venue,
          mode: e.mode,
        }));

      const hasRegEvt = filtered.some((e) => e.eventType === 'registration_deadline');
      if (!hasRegEvt && application?.registration_deadline) {
        const regTime = new Date(application.registration_deadline).getTime();
        const isNotRegistered = !application.status || application.status === 'not_applied' || application.status === 'unknown';
        if (regTime > nowMs && isNotRegistered) {
          filtered.push({
            id: `reg_${company.id}`,
            eventType: 'registration_deadline',
            title: 'Registration Deadline',
            startTime: application.registration_deadline,
            endTime: null,
            venue: 'NeoPAT Portal / Online Form',
            mode: 'online',
          });
        }
      }
      return filtered;
    })(),
    emails: (emails || []).map((em: any) => {
      const colId = em.college_email_id || em.canonical_email_id || (em.is_college ? em.id : null);
      return {
        id: em.id,
        collegeEmailId: colId || null,
        subject: em.subject || 'Campus Placement Notice',
        sender: em.sender || '',
        receivedAt: em.received_at || new Date().toISOString(),
        snippet: (colId ? canonicalBodyById.get(colId) : null) || em.body_snippet || '',
        classification: em.classification || 'general',
        threadId: em.thread_id || null,
        gmailMessageId: em.gmail_message_id || null,
        accountEmail: em.gmail_account_id ? accountMap.get(em.gmail_account_id) || null : null,
        attachmentName: colId ? attachmentByCollegeEmailId.get(colId) || null : null,
      };
    }),
    candidateMatches: companyCandidateMatches.map((cm: any) => ({
      id: cm.id,
      emailId: cm.email_id || null,
      collegeEmailId: cm.college_email_id || null,
      matchType: cm.match_type,
      matchedValue: cm.matched_value,
      matchLocation: (cm as { match_location?: string | null }).match_location || null,
      neoId: (cm as { neo_id?: string | null }).neo_id || null,
      createdAt: cm.created_at,
    })),
  };

  const collegeAccount = (gmailAccounts || []).find((acc) => acc.account_type === 'college');
  const userCampus = detectCampus(collegeAccount?.email);
  const userRegNo = detectRegNo(collegeAccount?.email) || userProfile?.neo_id || null;
  const userBranch = detectBranch(collegeAccount?.email) || (userRegNo ? detectBranch(userRegNo) : null);

  return (
    <CompanyDetailClient
      company={detail}
      userCampus={userCampus}
      userBranch={userBranch}
      userRegNo={userRegNo}
    />
  );
}
