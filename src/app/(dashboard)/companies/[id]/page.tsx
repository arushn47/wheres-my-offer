import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
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
  const { data: company } = await supabase
    .from('companies')
    .select('name')
    .eq('id', id)
    .single();

  const name = company?.name || 'Company Details';
  return {
    title: name,
    description: `Detailed recruitment drive history, schedule, test rounds, and email updates for ${name} on Where's My Offer?.`,
    alternates: {
      canonical: `/companies/${id}`,
    },
  };
}

export default async function CompanyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  const { id: companyId } = await params;
  const supabase = createAdminClient();

  // Fetch company, application, events, emails, candidate matches, user info, accounts, and attachments
  const [
    { data: company },
    { data: application },
    { data: events },
    { data: emails },
    { data: candidateMatches },
    { data: userProfile },
    { data: gmailAccounts },
  ] = await Promise.all([
    supabase
      .from('companies')
      .select('id, name, aliases, drive_number, drive_name')
      .eq('id', companyId)
      .eq('user_id', session.userId)
      .single(),

    supabase
      .from('applications')
      .select('*')
      .eq('company_id', companyId)
      .eq('user_id', session.userId)
      .single(),

    supabase
      .from('events')
      .select('id, event_type, title, start_time, venue, mode')
      .eq('company_id', companyId)
      .eq('user_id', session.userId)
      .order('start_time', { ascending: false }),

    supabase
      .from('emails')
      .select('id, subject, sender, received_at, body_snippet, classification, thread_id, gmail_message_id, gmail_account_id')
      .eq('company_id', companyId)
      .eq('user_id', session.userId)
      .order('received_at', { ascending: false }),

    supabase
      .from('candidate_matches')
      .select('id, match_type, matched_value, match_location, created_at, email_id, neo_id')
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

  if (!company) {
    notFound();
  }

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
    name: company.name,
    legalName: null,
    aliases: company.aliases,
    driveNumber: company.drive_number || null,
    driveName: company.drive_name || null,
    candidateName: userProfile?.name || session.name || 'Student Candidate',
    candidateRegId: userProfile?.neo_id || '',
    application: application
      ? {
          id: application.id,
          status: application.status,
          statusSource: application.status_source,
          statusConfidence: application.status_confidence,
          role: application.role,
          category: application.category,
          ctc: application.ctc,
          stipend: application.stipend,
          location: application.location,
          eligibility: application.eligibility,
          manualOverride: application.manual_override,
          notes: application.notes,
          appliedAt: application.applied_at,
          lastUpdated: application.last_updated,
        }
      : null,
    events: (events || [])
      .filter((e) => {
        if (e.event_type === 'registration_deadline') {
          const isRegistered = application && application.status !== 'not_applied';
          const isPast = e.start_time && new Date(e.start_time).getTime() <= Date.now();
          if (isRegistered || isPast) return false;
        }
        return true;
      })
      .map((e) => ({
        id: e.id,
        eventType: e.event_type,
        title: e.title,
        startTime: e.start_time,
        venue: e.venue,
        mode: e.mode,
      })),
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
