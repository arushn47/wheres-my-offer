import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { detectCampus, detectBranch, getDriveMode } from '@/lib/utils';
import { getEffectiveStage, isInactiveStatus, isEliminatedStatus } from '@/lib/stages';
import DashboardClient from './dashboard-client';

export const metadata: Metadata = {
  title: 'Dashboard — NeoPAT Tracker & Placement Command Center',
  description: 'Your central hub for NeoPAT campus placement drives, shortlist notifications, active stages, and upcoming test schedules.',
  alternates: {
    canonical: '/',
  },
};

export default async function DashboardPage() {
  const session = await requireSession();
  const supabase = createAdminClient();

  // Fetch stats, drives, applications, events, and user context
  const [
    { data: placementDrives },
    { data: companies },
    { data: applications },
    { data: rawUpcomingEvents },
    { data: accounts },
    { data: user },
    { data: candidateMatches },
  ] = await Promise.all([
    supabase
      .from('placement_drives')
      .select('id, company_id, drive_number, drive_name, role, category, ctc, stipend, location')
      .eq('user_id', session.userId),
    supabase
      .from('companies')
      .select('id, name')
      .eq('user_id', session.userId),
    supabase
      .from('applications')
      .select('id, status, role, category, ctc, stipend, location, notes, manual_override, last_updated, placement_drive_id, registration_deadline')
      .eq('user_id', session.userId)
      .order('last_updated', { ascending: false }),
    supabase
      .from('events')
      .select('id, placement_drive_id, event_type, title, start_time, end_time, venue, mode')
      .eq('user_id', session.userId)
      .order('start_time', { ascending: true }),
    supabase
      .from('gmail_accounts')
      .select('id, email, account_type, is_connected, last_sync_at')
      .eq('user_id', session.userId),
    supabase
      .from('users')
      .select('neo_id')
      .eq('id', session.userId)
      .single(),
    supabase
      .from('candidate_matches')
      .select('id, email_id, placement_drive_id')
      .eq('user_id', session.userId)
      .neq('match_type', 'xlsx_applied_list'),
  ]);

  const nowIso = new Date().toISOString();

  const companyById = new Map<string, string>((companies || []).map((c: any) => [c.id, c.name]));
  const driveMap = new Map((placementDrives || []).map((d: any) => [d.id, d]));
  const companyNameMap = new Map<string, string>();
  for (const d of (placementDrives || []) as any[]) {
    const cName = companyById.get(d.company_id) || (d.companies as any)?.name;
    if (cName) {
      companyNameMap.set(d.id, cName);
    }
  }

  const stats = {
    total_companies: placementDrives?.length || 0,
    active_applications: 0,
    total_applied: 0,
    applied: 0,
    shortlisted: 0,
    total_shortlisted: 0,
    active_shortlisted: 0,
    not_shortlisted: 0,
    upcoming_tests: 0,
    upcoming_interviews: 0,
    rejected: 0,
    withdrawn: 0,
    selected: 0,
  };

  const nonAppliedStatuses = ['not_applied', 'withdrawn', 'declined'];
  const appStatusMap = new Map<string, string>();

  const shortlistedCompanyIds = new Set(
    (candidateMatches || [])
      .map((cm: any) => cm.placement_drive_id)
      .filter(Boolean)
  );

  const testOrInterviewCompanyIds = new Set(
    (rawUpcomingEvents || [])
      .filter((e: any) => /test|coding|assessment|interview/i.test(e.event_type || ''))
      .map((e: any) => e.placement_drive_id)
  );

  if (applications) {
    for (const app of applications as any[]) {
      const s = (app.status || '').toLowerCase();
      const notes = app.notes || '';
      appStatusMap.set(app.placement_drive_id, app.status);

      const isApplied = !nonAppliedStatuses.includes(s);
      if (isApplied) stats.total_applied++;

      // Count as "active" if in an active status OR if it has a future registration deadline (registration_open)
      const hasRegistrationOpen = (s === 'not_applied' || !s) &&
        app.registration_deadline && app.registration_deadline > nowIso;
      if (!isInactiveStatus(s) || hasRegistrationOpen) stats.active_applications++;

      if (s === 'applied') stats.applied++;

      const isShortlistStage = [
        'shortlisted',
        'test',
        'test_scheduled',
        'test_ongoing',
        'test_completed',
        'interview',
        'interview_scheduled',
        'interview_ongoing',
        'interview_completed',
        'selected',
        'offer',
        'offer_received',
      ].includes(s);

      const hasRoundEvent = testOrInterviewCompanyIds.has(app.placement_drive_id);
      const hasEliminatedRoundNote = /eliminated in (test|interview|assessment)/i.test(notes) ||
        s === 'rejected_test' || s === 'rejected_interview' || s === 'test_eliminated' || s === 'interview_eliminated';

      // Candidate cracked shortlist if they progressed into test/interview rounds (or got matched in shortlist)
      const identity = app.placement_drive_id;
      const isCracked = (isShortlistStage || hasEliminatedRoundNote || (isApplied && (shortlistedCompanyIds.has(identity) || hasRoundEvent))) && isApplied;

      if (isCracked) {
        stats.total_shortlisted++;
        const isActiveInRound = isShortlistStage && !isEliminatedStatus(s);
        if (isActiveInRound) {
          stats.active_shortlisted++;
        }
      }

      if (s === 'not_shortlisted' || (s === 'rejected' && !isCracked)) stats.not_shortlisted++;
      if (isEliminatedStatus(s)) stats.rejected++;
      if (s === 'withdrawn' || s === 'declined') stats.withdrawn++;
      if (['selected', 'offer', 'offer_received'].includes(s)) stats.selected++;
    }

    stats.shortlisted = stats.total_shortlisted;
  }

  // Define what event types belong to which pipeline stage (in order)
  const EVENT_STAGE: Record<string, number> = {
    ppt: 1,
    online_test: 2,
    coding_test: 2,
    aptitude_test: 2,
    group_discussion: 2,
    technical_interview: 3,
    hr_interview: 3,
    interview: 3,
    final_interview: 4,
    offer: 5,
  };

  const STATUS_MAX_STAGE: Record<string, number> = {
    applied: 1,            // only PPT/intro events (cannot see tests until shortlisted!)
    ppt_scheduled: 1,      // only PPT
    shortlisted: 2,        // shortlisted for test
    test_scheduled: 2,     // can see test events, not interviews
    interview_scheduled: 3, // can see interview events
    selected: 5,
    offer_received: 5,
    rejected: 0,
    not_shortlisted: 0,
    not_applied: 0,
    declined: 0,
    withdrawn: 0,
  };

  // Deduplicate upcoming events by (placement_drive_id, event_type, date) and filter out eliminated companies
  const uniqueUpcomingEvents: NonNullable<typeof rawUpcomingEvents> = [];
  const seenEventKeys = new Set<string>();

  if (rawUpcomingEvents) {
    for (const event of rawUpcomingEvents) {
      if (event.start_time && event.start_time < nowIso) continue;

      const companyStatus = appStatusMap.get(event.placement_drive_id) || 'unknown';

      // Registration Deadline rule:
      // Keep it in upcoming events only if user hasn't applied yet
      if (event.event_type === 'registration_deadline') {
        const hasApplied = companyStatus !== 'not_applied' && companyStatus !== 'unknown';
        if (hasApplied) continue;
      } else {
        // Skip eliminated or opted-out companies
        if (isInactiveStatus(companyStatus)) {
          continue;
        }

        // Only show events up to the user's current pipeline stage unless manually overridden
        if (!(event as any).manual_override) {
          const maxStage = STATUS_MAX_STAGE[companyStatus] ?? 2;
          const evtStage = EVENT_STAGE[event.event_type] ?? 2;
          if (evtStage > maxStage) {
            continue;
          }
        }
      }

      // Deduplicate: 1 single timing per event stage
      const key = `${event.placement_drive_id}:${event.event_type}`;
      if (!seenEventKeys.has(key)) {
        seenEventKeys.add(key);
        uniqueUpcomingEvents.push(event);

        if (['online_test', 'coding_test'].includes(event.event_type)) stats.upcoming_tests++;
        if (['technical_interview', 'hr_interview', 'final_interview'].includes(event.event_type)) stats.upcoming_interviews++;
      }
    }
  }

  // Also include future registration deadlines stored on applications
  if (applications) {
    for (const a of applications as any[]) {
      if (a.registration_deadline && a.registration_deadline > nowIso && (a.status === 'not_applied' || a.status === 'unknown')) {
        const key = `${a.placement_drive_id}:registration_deadline`;
        if (!seenEventKeys.has(key)) {
          seenEventKeys.add(key);
          uniqueUpcomingEvents.push({
            id: `reg_${a.placement_drive_id}`,
            placement_drive_id: a.placement_drive_id,
            event_type: 'registration_deadline',
            title: 'Registration Deadline',
            start_time: a.registration_deadline,
            end_time: null,
            venue: 'NeoPAT Portal',
            mode: 'online',
          } as any);
        }
      }
    }
  }

  uniqueUpcomingEvents.sort((a, b) => {
    const tA = a.start_time ? new Date(a.start_time).getTime() : 0;
    const tB = b.start_time ? new Date(b.start_time).getTime() : 0;
    return tA - tB;
  });

  // Only pass top 6 to DashboardClient to avoid UI clutter, enriched with companyName
  const topUpcomingEvents = uniqueUpcomingEvents.slice(0, 6).map((e) => ({
    ...e,
    companyName: companyNameMap.get(e.placement_drive_id) || 'Campus Drive',
  }));

  const eventsByCompany = new Map<string, any[]>();
  if (rawUpcomingEvents) {
    for (const ev of rawUpcomingEvents) {
      const list = eventsByCompany.get(ev.placement_drive_id) || [];
      list.push(ev);
      eventsByCompany.set(ev.placement_drive_id, list);
    }
  }

  const connectedAccounts = (accounts || []).filter((a) => a.is_connected);
  const hasPersonalAccount = connectedAccounts.some((a) => a.account_type === 'personal');
  const hasCollegeAccount = connectedAccounts.some((a) => a.account_type === 'college');
  const disconnectedAccounts = (accounts || []).filter((a) => !a.is_connected);
  const hasNeoId = !!user?.neo_id;

  const collegeEmail = accounts?.find((a) => a.account_type === 'college')?.email;
  const personalEmail = accounts?.find((a) => a.account_type === 'personal')?.email || session.email;
  const campus = detectCampus(collegeEmail || personalEmail);
  const branch = detectBranch(collegeEmail);

  const allAppsList = (applications || []).map((a: any) => {
    const compEvents = eventsByCompany.get(a.placement_drive_id) || [];
    const latestEvent = compEvents[compEvents.length - 1] || null;
    const { effectiveStatus, statusSubtitle } = getEffectiveStage(a.status, latestEvent, compEvents, a.notes, a.manual_override);
    const drive = driveMap.get(a.placement_drive_id);
    const companyId = drive?.company_id || a.placement_drive_id;
    const companyName = companyById.get(companyId) || (drive as any)?.companies?.name || 'Company';

    return {
      id: a.id,
      companyId,
      companyName,
      companyLogo: null,
      status: effectiveStatus,
      statusSubtitle,
      role: a.role || drive?.role || null,
      ctc: a.ctc || drive?.ctc || null,
      stipend: a.stipend || drive?.stipend || null,
      location: a.location || drive?.location || null,
      category: a.category || drive?.category || null,
      notes: a.notes,
      driveMode: getDriveMode(a.notes, campus),
      lastUpdated: a.last_updated,
    };
  });

  return (
    <DashboardClient
      stats={stats}
      upcomingEvents={topUpcomingEvents}
      activeApplications={allAppsList}
      hasAccounts={hasPersonalAccount && hasCollegeAccount}
      hasPersonalAccount={hasPersonalAccount}
      hasCollegeAccount={hasCollegeAccount}
      disconnectedAccounts={disconnectedAccounts}
      hasNeoId={hasNeoId}
      neoId={user?.neo_id || null}
      campus={campus}
      branch={branch}
    />
  );
}
