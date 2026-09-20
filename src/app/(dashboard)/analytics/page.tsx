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

  // Fetch applications, events, companies, emails, candidate matches, accounts
  const [
    { data: applications },
    { data: events },
    { data: companies },
    { data: placementDrives },
    { count: emailsCount },
    { data: candidateMatches },
    { data: userProfile },
    { data: accounts },
  ] = await Promise.all([
    supabase
      .from('applications')
      .select('id, placement_drive_id, status, notes, ctc, stipend, category, applied_at, last_updated')
      .eq('user_id', session.userId),
    supabase
      .from('events')
      .select('id, placement_drive_id, event_type, start_time')
      .eq('user_id', session.userId)
      .order('start_time', { ascending: true }),
    supabase
      .from('companies')
      .select('id, name')
      .eq('user_id', session.userId),
    supabase
      .from('placement_drives')
      .select('id')
      .eq('user_id', session.userId),
    supabase
      .from('emails')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', session.userId),
    supabase
      .from('candidate_matches')
      .select('id, email_id')
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

  // Resolve unique shortlisted company count
  let uniqueMatchesCount = 0;
  if (candidateMatches && candidateMatches.length > 0) {
    const matchedEmailIds = candidateMatches.map((m) => m.email_id).filter(Boolean);
    if (matchedEmailIds.length > 0) {
      const { data: matchedEmails } = await supabase
        .from('emails')
        .select('placement_drive_id')
        .in('id', matchedEmailIds);
      const uniqueMatchIds = new Set(
        (matchedEmails || []).map((e) => e.placement_drive_id).filter(Boolean)
      );
      uniqueMatchesCount = uniqueMatchIds.size;
    }
  }

  const collegeEmail = accounts?.find((a) => a.account_type === 'college')?.email;
  const personalEmail = accounts?.find((a) => a.account_type === 'personal')?.email || session.email;
  const campus = detectCampus(collegeEmail || personalEmail);
  const branch = detectBranch(collegeEmail);
  const driveEntityCount = new Set([
    ...(placementDrives || []).map((drive) => `drive:${drive.id}`),
    ...(applications || [])
      .filter((application) => !application.placement_drive_id)
      .map((application) => `legacy:${application.placement_drive_id}`),
  ]).size;

  return (
    <div className="mx-auto max-w-6xl w-full">
      <AnalyticsClient
        applications={applications || []}
        events={events || []}
        companiesCount={driveEntityCount}
        emailsCount={emailsCount || 0}
        matchesCount={candidateMatches?.length || 0}
        uniqueMatchesCount={uniqueMatchesCount}
        neoId={userProfile?.neo_id || null}
        campus={campus}
        branch={branch}
      />
    </div>
  );
}
