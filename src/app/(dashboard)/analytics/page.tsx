import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { loadRoundStatusSummaries } from '@/lib/sync/recruitment/round-status-data';
import { resolveRecruitmentStatus } from '@/lib/sync/recruitment/round-status';
import { detectCampus, detectBranch } from '@/lib/utils';
import AnalyticsClient from './_components/analytics-client';

export const metadata: Metadata = {
  title: 'Placement Radar Analytics',
  description: 'Visualize your placement conversion funnel, shortlist ratios, interview progression, and CTC offer trends.',
  alternates: {
    canonical: '/analytics',
  },
};

export default async function AnalyticsPage() {
  const session = await requireSession();
  const supabase = createAdminClient();

  // Fetch placement_drives, applications, events, companies, emails, candidate matches, accounts
  const [
    { data: placementDrives, count: totalPlacementDrivesCount },
    { data: rawApplications },
    { data: events },
    { data: companies },
    { count: emailsCount },
    { data: candidateMatches },
    { data: userProfile },
    { data: accounts },
    roundDecisionsByDrive,
  ] = await Promise.all([
    supabase
      .from('placement_drives')
      .select('id, company_id, drive_number, drive_name, role, category, ctc, stipend, location', { count: 'exact' }),
    supabase
      .from('applications')
      .select('id, placement_drive_id, status, role, category, ctc, stipend, location, notes, manual_override, applied_at, last_updated, registration_deadline')
      .eq('user_id', session.userId),
    supabase
      .from('events')
      .select('id, placement_drive_id, event_type, title, start_time')
      .eq('user_id', session.userId)
      .order('start_time', { ascending: true }),
    supabase
      .from('companies')
      .select('id, name'),
    supabase
      .from('personal_emails')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', session.userId),
    supabase
      .from('candidate_matches')
      .select('id, email_id, college_email_id, placement_drive_id')
      .eq('user_id', session.userId)
      .neq('match_type', 'xlsx_applied_list'),
    supabase
      .from('users')
      .select('name, neo_id')
      .eq('id', session.userId)
      .maybeSingle(),
    supabase
      .from('gmail_accounts')
      .select('email, account_type')
      .eq('user_id', session.userId),
    loadRoundStatusSummaries(supabase, session.userId),
  ]);

  const applications = (rawApplications || []).map(app => ({
    ...app,
    status: resolveRecruitmentStatus(app.status || 'not_applied', roundDecisionsByDrive.get(app.placement_drive_id), Boolean(app.manual_override), app.notes || ''),
  }));

  const compMap = new Map((companies || []).map((c) => [c.id, c.name]));
  const appMap = new Map((applications || []).map((a) => [a.placement_drive_id, a]));

  // Funnel metrics should represent drives tracked for this user, while the headline
  // catalog total below represents every placement drive available to all users.
  const unifiedDrives = (placementDrives || []).flatMap((drive) => {
    const app = appMap.get(drive.id);
    if (!app) return [];
    const companyName =
      compMap.get(drive.company_id) ||
      drive.drive_name ||
      'Placement Drive';

    return [{
      id: app?.id || drive.id,
      placement_drive_id: drive.id,
      company_id: drive.company_id,
      company_name: companyName,
      drive_number: drive.drive_number,
      status: app?.status || 'not_applied',
      notes: app?.notes || null,
      ctc: app?.ctc || drive.ctc || null,
      stipend: app?.stipend || drive.stipend || null,
      category: app?.category || drive.category || null,
      role: app?.role || drive.role || null,
      location: app?.location || drive.location || null,
      applied_at: app?.applied_at || null,
      last_updated: app?.last_updated || null,
      manual_override: app?.manual_override || false,
    }];
  });

  // Also include any legacy applications that don't have placement_drive_id (if any)
  if (applications) {
    for (const app of applications) {
      if (!app.placement_drive_id) {
        unifiedDrives.push({
          id: app.id,
          placement_drive_id: null,
          company_id: null,
          company_name: 'Opportunity',
          drive_number: null,
          status: app.status || 'not_applied',
          notes: app.notes || null,
          ctc: app.ctc || null,
          stipend: app.stipend || null,
          category: app.category || null,
          role: app.role || null,
          location: app.location || null,
          applied_at: app.applied_at || null,
          last_updated: app.last_updated || null,
          manual_override: app.manual_override || false,
        });
      }
    }
  }

  const collegeEmail = accounts?.find((a) => a.account_type === 'college')?.email;
  const personalEmail = accounts?.find((a) => a.account_type === 'personal')?.email || session.email;
  const campus = detectCampus(collegeEmail || personalEmail);
  const branch = detectBranch(collegeEmail);

  // Compute unique shortlisted drives from candidate_matches
  const uniqueMatchIds = new Set(
    (candidateMatches || [])
      .map((match) => match.placement_drive_id)
      .filter((driveId): driveId is string => Boolean(driveId))
  );

  return (
    <div className="mx-auto max-w-6xl w-full">
      <AnalyticsClient
        drives={unifiedDrives}
        applications={unifiedDrives}
        events={events || []}
        candidateMatches={candidateMatches || []}
        totalPlacementDrivesCount={totalPlacementDrivesCount || 0}
        trackedDrivesCount={unifiedDrives.length}
        emailsCount={emailsCount || 0}
        matchesCount={candidateMatches?.length || 0}
        uniqueMatchesCount={uniqueMatchIds.size}
        neoId={userProfile?.neo_id || null}
        campus={campus}
        branch={branch}
      />
    </div>
  );
}
