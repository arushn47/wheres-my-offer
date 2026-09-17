import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import CompaniesClient, { type CompanyWithDetails } from './companies-client';

import { detectCampus } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'NeoPAT Recruitment Drives & Companies',
  description: 'View and track all NeoPAT campus recruitment drives, company CTCs, stipends, job roles, and application statuses.',
  alternates: {
    canonical: '/companies',
  },
};

export default async function CompaniesPage() {
  const session = await requireSession();
  const supabase = createAdminClient();

  // Fetch companies, applications, latest events, candidate matches, and connected accounts for the user
  const [
    { data: companies },
    { data: applications },
    { data: events },
    { data: matches },
    { data: emails },
    { data: accounts },
  ] = await Promise.all([
    supabase
      .from('companies')
      .select('id, name, drive_number, drive_name, aliases, updated_at')
      .eq('user_id', session.userId)
      .order('updated_at', { ascending: false }),

    supabase
      .from('applications')
      .select('id, company_id, status, role, category, ctc, stipend, location, notes, manual_override, applied_at, last_updated, registration_deadline')
      .eq('user_id', session.userId),

    supabase
      .from('events')
      .select('id, company_id, event_type, title, start_time, venue, mode')
      .eq('user_id', session.userId)
      .order('start_time', { ascending: true }),

    supabase
      .from('candidate_matches')
      .select('id, application_id, email_id')
      .eq('user_id', session.userId)
      .neq('match_type', 'xlsx_applied_list'),

    supabase
      .from('emails')
      .select('id, company_id, received_at')
      .eq('user_id', session.userId),

    supabase
      .from('gmail_accounts')
      .select('email, account_type')
      .eq('user_id', session.userId)
      .eq('is_connected', true),
  ]);

  const collegeAccount = accounts?.find((a) => a.account_type === 'college');
  const userCampus = detectCampus(collegeAccount?.email);

  // Maps for efficient lookups
  const appMap = new Map((applications || []).map((app) => [app.company_id, app]));
  const nowIso = new Date().toISOString();
  const eventMap = new Map();
  const allEventsByCompany = new Map<string, typeof events>();
  if (events) {
    for (const event of events) {
      const app = appMap.get(event.company_id);
      const isRegistered = app && app.status !== 'not_applied';
      const isPast = event.start_time && event.start_time < nowIso;

      // Filter registration deadlines: hide if already registered or in the past
      if (event.event_type === 'registration_deadline' && (isRegistered || isPast)) {
        continue;
      }

      if (event.start_time && event.start_time >= nowIso) {
        if (!eventMap.has(event.company_id)) {
          eventMap.set(event.company_id, event);
        }
      }

      const existing = allEventsByCompany.get(event.company_id) || [];
      existing.push(event);
      allEventsByCompany.set(event.company_id, existing);
    }
  }

  // Synthesize registration_deadline event if stored on application but missing from events
  if (applications) {
    for (const app of applications as any[]) {
      if (app.registration_deadline && (!app.status || app.status === 'not_applied' || app.status === 'unknown')) {
        const isPast = app.registration_deadline < nowIso;
        if (!isPast) {
          const compEvts = allEventsByCompany.get(app.company_id) || [];
          const hasEvt = compEvts.some((e: any) => e.event_type === 'registration_deadline');
          if (!hasEvt) {
            const synthEvt = {
              id: `reg_${app.company_id}`,
              company_id: app.company_id,
              event_type: 'registration_deadline',
              title: 'Registration Deadline',
              start_time: app.registration_deadline,
              end_time: null,
              venue: 'NeoPAT Portal / Online Form',
              mode: 'online',
            };
            compEvts.push(synthEvt as any);
            allEventsByCompany.set(app.company_id, compEvts);
            if (!eventMap.has(app.company_id)) {
              eventMap.set(app.company_id, synthEvt);
            }
          }
        }
      }
    }
  }

  const emailCountMap = new Map<string, number>();
  const latestEmailMap = new Map<string, string>();
  if (emails) {
    for (const email of emails) {
      if (email.company_id) {
        emailCountMap.set(email.company_id, (emailCountMap.get(email.company_id) || 0) + 1);
        if (email.received_at) {
          const prev = latestEmailMap.get(email.company_id);
          if (!prev || new Date(email.received_at) > new Date(prev)) {
            latestEmailMap.set(email.company_id, email.received_at);
          }
        }
      }
    }
  }

  const matchedEmailIds = new Set((matches || []).map((m) => m.email_id).filter(Boolean));
  const matchedCompanyIds = new Set(
    (emails || [])
      .filter((e) => matchedEmailIds.has(e.id))
      .map((e) => e.company_id)
      .filter(Boolean)
  );

  // Assemble full details
  const formattedCompanies: CompanyWithDetails[] = (companies || []).map((comp) => {
    const app = appMap.get(comp.id) || null;
    return {
      id: comp.id,
      name: comp.name,
      legal_name: null,
      aliases: comp.aliases,
      drive_number: comp.drive_number || null,
      drive_name: comp.drive_name || null,
      updated_at: comp.updated_at,
      latestEmailDate: latestEmailMap.get(comp.id) || comp.updated_at,
      application: app
        ? {
            id: app.id,
            status: app.status,
            role: app.role,
            category: app.category,
            ctc: app.ctc,
            stipend: app.stipend,
            location: app.location,
            notes: app.notes,
            manual_override: app.manual_override,
            applied_at: app.applied_at,
            last_updated: app.last_updated,
            registration_deadline: app.registration_deadline || null,
          }
        : null,
      latestEvent: eventMap.get(comp.id) || null,
      events: allEventsByCompany.get(comp.id) || [],
      neoIdMatched: matchedCompanyIds.has(comp.id),
      emailCount: emailCountMap.get(comp.id) || 0,
    };
  });

  return (
    <Suspense fallback={<div className="p-6 text-text-tertiary">Loading companies...</div>}>
      <CompaniesClient companies={formattedCompanies} userCampus={userCampus} />
    </Suspense>
  );
}
