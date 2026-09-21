import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { detectCampus, detectBranch } from '@/lib/utils';
import AnalyticsClient from './analytics-client';

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
    { data: placementDrives },
    { data: applications },
    { data: events },
    { data: companies },
    { count: emailsCount },
    { data: candidateMatches },
    { data: userProfile },
    { data: accounts },
  ] = await Promise.all([
    supabase
      .from('placement_drives')
      .select('id, company_id, drive_number, drive_name, role, category, ctc, stipend, location')
      .eq('user_id', session.userId),
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
      .select('id, name')
      .eq('user_id', session.userId),
    supabase
      .from('emails')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', session.userId),
    supabase
      .from('candidate_matches')
      .select('id, email_id, placement_drive_id')
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
  ]);

  const compMap = new Map((companies || []).map((c) => [c.id, c.name]));
  const appMap = new Map((applications || []).map((a) => [a.placement_drive_id, a]));

  const unifiedDrives = (placementDrives || []).map((drive) => {
    const app = appMap.get(drive.id);
    const companyName =
      compMap.get(drive.company_id) ||
      ((drive as any).companies as { name?: string } | null)?.name ||
      drive.drive_name ||
      'Placement Drive';

    return {
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
    };
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

  // Include any standalone company that doesn't have a placement drive yet
  const companiesWithDrives = new Set((placementDrives || []).map((d: any) => d.company_id));
  if (companies) {
    for (const comp of companies) {
      if (!companiesWithDrives.has(comp.id)) {
        unifiedDrives.push({
          id: comp.id,
          placement_drive_id: null,
          company_id: comp.id,
          company_name: comp.name,
          drive_number: null,
          status: 'not_applied',
          notes: null,
          ctc: null,
          stipend: null,
          category: null,
          role: null,
          location: null,
          applied_at: null,
          last_updated: null,
          manual_override: false,
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
    (candidateMatches || []).map((m: any) => m.placement_drive_id).filter(Boolean)
  );

  return (
    <div className="mx-auto max-w-6xl w-full">
      <AnalyticsClient
        drives={unifiedDrives}
        applications={unifiedDrives}
        events={events || []}
        candidateMatches={candidateMatches || []}
        companiesCount={unifiedDrives.length}
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
