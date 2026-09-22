import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import CompanyDetailClient, { type CompanyDetail } from './company-detail-client';
import { detectCampus, detectBranch, detectRegNo } from '@/lib/utils';

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
    .eq('user_id', session.userId)
    .maybeSingle();

  let resolvedDriveId = urlDriveId || null;

  if (!company) {
    // Canonical Redirect: If params.id was a placement_drive_id, normalize to /companies/[companyId]?driveId=[driveId]
    const { data: drive } = await supabase
      .from('placement_drives')
      .select('id, company_id')
      .eq('id', companyId)
      .eq('user_id', session.userId)
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
    .select('id, drive_number, drive_name, role, category, ctc, stipend, location, registration_deadline, eligibility, branches, cgpa_requirement, backlog_requirement, source_email_id, created_at')
    .eq('company_id', company.id)
    .eq('user_id', session.userId);

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
      .select('id, event_type, title, start_time, end_time, venue, mode, placement_drive_id')
      .in('placement_drive_id', driveFilterIds)
      .eq('user_id', session.userId)
      .order('start_time', { ascending: false }),

    supabase
      .from('emails')
      .select('id, subject, sender, received_at, body_snippet, classification, thread_id, gmail_message_id, gmail_account_id, placement_drive_id')
      .in('placement_drive_id', driveFilterIds)
      .eq('user_id', session.userId)
      .order('received_at', { ascending: false }),

    substantiveAliases.length > 0
      ? supabase
          .from('emails')
          .select('id, subject, sender, received_at, body_snippet, classification, thread_id, gmail_message_id, gmail_account_id, placement_drive_id')
          .eq('user_id', session.userId)
          .is('placement_drive_id', null)
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
      .select('id, match_type, matched_value, match_location, created_at, email_id, neo_id')
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

  // Use the drive's official source email time as the cutoff anchor. Using the
  // earliest assigned email would allow an old circular to move the window
  // backwards and make unrelated historical emails appear in the timeline.
  const driveStartTime = sourceEmail?.received_at
    ? new Date(sourceEmail.received_at).getTime()
    : targetDrive?.created_at
      ? new Date(targetDrive.created_at).getTime()
    : application?.applied_at
      ? new Date(application.applied_at).getTime()
      : null;
  // Allow a small amount of clock drift, but never include older circulars.
  const driveMinAllowedTime = driveStartTime ? driveStartTime - 15 * 60 * 1000 : 0;

  // Combine verified assigned emails
  const allEmailsMap = new Map<string, any>();
  for (const em of (assignedEmails || [])) {
    allEmailsMap.set(em.id, em);
  }

  // Add verified linked emails
  const missingLinkedIds = (linkedEmailsData || [])
    .map((l: any) => l.email_id)
    .filter((id: string) => !allEmailsMap.has(id));
  if (missingLinkedIds.length > 0) {
    const { data: extraEmails } = await supabase
      .from('emails')
      .select('id, subject, sender, received_at, body_snippet, classification, thread_id, gmail_message_id, gmail_account_id, placement_drive_id')
      .in('id', missingLinkedIds);
    for (const em of (extraEmails || [])) {
      allEmailsMap.set(em.id, em);
    }
  }

  // Add unassigned fallback emails ONLY if they arrived on or after drive start date
  // AND match the company name with strict word boundaries
  for (const em of (unassignedEmailsResult?.data || [])) {
    const emTime = em.received_at ? new Date(em.received_at).getTime() : 0;
    // RULE: Never check or include emails that arrived before this drive came!
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

  // Final safety filter: enforce that no email before drive arrival is ever shown for this drive
  const emails = Array.from(allEmailsMap.values())
    .filter((e: any) => {
      if (!driveMinAllowedTime) return true;
      const t = e.received_at ? new Date(e.received_at).getTime() : 0;
      return t >= driveMinAllowedTime;
    })
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
  const companyEmailIds = new Set((emails || []).map((e) => e.id));
  const companyCandidateMatches = (candidateMatches || []).filter((cm) =>
    companyEmailIds.has((cm as { email_id?: string }).email_id || '')
  );

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
          role: application.role || targetDrive?.role || null,
          category: application.category,
          ctc: application.ctc || targetDrive?.ctc || null,
          stipend: application.stipend || targetDrive?.stipend || null,
          location: application.location || targetDrive?.location || null,
          eligibility: application.eligibility || targetDrive?.eligibility || null,
          branches: application.branches || targetDrive?.branches || null,
          cgpaRequirement: application.cgpa_requirement || targetDrive?.cgpa_requirement || null,
          backlogRequirement: application.backlog_requirement || targetDrive?.backlog_requirement || null,
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
    emails: (emails || []).map((em) => ({
      id: em.id,
      subject: em.subject || 'Campus Placement Notice',
      sender: em.sender || '',
      receivedAt: em.received_at || new Date().toISOString(),
      snippet: em.body_snippet || '',
      classification: em.classification || 'general',
      threadId: em.thread_id || null,
      gmailMessageId: em.gmail_message_id || null,
      accountEmail: em.gmail_account_id ? accountMap.get(em.gmail_account_id) || null : null,
      attachmentName: null,
    })),
    candidateMatches: companyCandidateMatches.map((cm) => ({
      id: cm.id,
      emailId: (cm as { email_id?: string | null }).email_id || null,
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
