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

  // Fetch companies, placement_drives, applications, events, emails, etc.
  const [
    { data: companies },
    { data: placementDrives },
    { data: applications },
    { data: events },
    { data: matches },
    { data: accounts },
  ] = await Promise.all([
    supabase
      .from('companies')
      .select('id, name, aliases, updated_at')
      .eq('user_id', session.userId)
      .order('updated_at', { ascending: false }),

    supabase
      .from('placement_drives')
      .select('id, company_id, drive_number, normalized_drive_number, drive_name, role, category, ctc, stipend, location, created_at, updated_at')
      .eq('user_id', session.userId),

    supabase
      .from('applications')
      .select('id, placement_drive_id, status, role, category, ctc, stipend, location, notes, manual_override, applied_at, last_updated, registration_deadline')
      .eq('user_id', session.userId),

    supabase
      .from('events')
      .select('id, placement_drive_id, event_type, title, start_time, end_time, venue, mode')
      .eq('user_id', session.userId)
      .order('start_time', { ascending: true }),

    supabase
      .from('candidate_matches')
      .select('id, placement_drive_id, email_id')
      .eq('user_id', session.userId)
      .neq('match_type', 'xlsx_applied_list'),

    supabase
      .from('gmail_accounts')
      .select('email, account_type')
      .eq('user_id', session.userId),
  ]);

  const collegeAccount = accounts?.find((a) => a.account_type === 'college');
  const userCampus = detectCampus(collegeAccount?.email);

  // Maps for efficient lookups
  const compMap = new Map((companies || []).map((comp) => [comp.id, comp]));
  
  const nowIso = new Date().toISOString();

  // 1. Combine placement_drives, legacy applications, and companies without drives into unified entities
  const entities: { type: 'drive' | 'legacy_app' | 'company_only', drive: any, app: any, company?: any, entityId: string }[] = [];
  
  if (placementDrives) {
    for (const drive of placementDrives) {
      const app = (applications || []).find((a: any) => a.placement_drive_id === drive.id);
      entities.push({
        type: 'drive',
        drive,
        app,
        entityId: drive.id,
      });
    }
  }

  if (applications) {
    for (const app of applications as any[]) {
      if (!app.placement_drive_id) {
        entities.push({
          type: 'legacy_app',
          drive: null,
          app,
          entityId: app.id,
        });
      }
    }
  }

  // Include any company that doesn't have a placement drive yet so all 70 companies are represented
  const companiesWithDrives = new Set((placementDrives || []).map((d: any) => d.company_id));
  if (companies) {
    for (const comp of companies) {
      if (!companiesWithDrives.has(comp.id)) {
        entities.push({
          type: 'company_only',
          drive: null,
          app: null,
          company: comp,
          entityId: comp.id,
        });
      }
    }
  }

  // Group events by entityId
  const eventMap = new Map();
  const allEventsByEntity = new Map();
  
  if (events) {
    for (const event of events) {
      const isPast = event.start_time && event.start_time < nowIso;
      
      const matchingEntities = entities.filter(ent => {
        if (event.placement_drive_id) {
          return ent.drive?.id === event.placement_drive_id;
        }
        return ent.type === 'legacy_app' && !event.placement_drive_id && ent.app?.placement_drive_id === event.placement_drive_id;
      });
      
      for (const ent of matchingEntities) {
        const isRegistered = ent.app && ent.app.status !== 'not_applied';
        
        // Filter registration deadlines: hide if already registered or in the past
        if (event.event_type === 'registration_deadline' && (isRegistered || isPast)) {
          continue;
        }
        
        if (event.start_time && event.start_time >= nowIso) {
          if (!eventMap.has(ent.entityId)) {
            eventMap.set(ent.entityId, event);
          }
        }
        
        const existing = allEventsByEntity.get(ent.entityId) || [];
        existing.push(event);
        allEventsByEntity.set(ent.entityId, existing);
      }
    }
  }

  // Synthesize registration_deadline event
  for (const ent of entities) {
    const regDeadline = ent.app?.registration_deadline || ent.drive?.registration_deadline;
    const status = ent.app?.status || 'not_applied';
    if (regDeadline && (status === 'not_applied' || status === 'unknown')) {
      const isPast = regDeadline < nowIso;
      if (!isPast) {
        const compEvts = allEventsByEntity.get(ent.entityId) || [];
        const hasEvt = compEvts.some((e: any) => e.event_type === 'registration_deadline');
        if (!hasEvt) {
          const synthEvt = {
            id: `reg_${ent.entityId}`,

            placement_drive_id: ent.drive?.id || null,
            event_type: 'registration_deadline',
            title: 'Registration Deadline',
            start_time: regDeadline,
            end_time: null,
            venue: 'NeoPAT Portal / Online Form',
            mode: 'online',
          };
          compEvts.push(synthEvt as any);
          allEventsByEntity.set(ent.entityId, compEvts);
          if (!eventMap.has(ent.entityId)) {
            eventMap.set(ent.entityId, synthEvt);
          }
        }
      }
    }
  }

  const matchedEmailIds = new Set((matches || []).map((m) => m.email_id).filter(Boolean));
  const matchedDriveIds = new Set((matches || []).map((m: any) => m.placement_drive_id).filter(Boolean));

  // Assemble full details based on Entities
  const formattedCompanies: CompanyWithDetails[] = entities.map((ent) => {
    const { drive, app, entityId } = ent;
    const companyId = drive?.company_id || ent.company?.id || (app as any)?.company_id;
    const comp = companyId ? compMap.get(companyId) : undefined;
    const effectiveLatestDate = drive?.updated_at || app?.last_updated || comp?.updated_at || drive?.created_at || new Date().toISOString();
    
    return {
      id: comp?.id || companyId || entityId, 
      appId: app ? app.id : undefined,
      driveId: drive ? drive.id : undefined,
      name: comp?.name || ent.company?.name || 'Unknown Company',
      legal_name: null,
      aliases: comp?.aliases || ent.company?.aliases || null,
      drive_number: drive?.drive_number || null,
      drive_name: drive?.drive_name || null,
      updated_at: effectiveLatestDate,
      latestEmailDate: effectiveLatestDate,
      application: app ? {
        id: app.id,
        status: app.status,
        role: app.role || drive?.role || null,
        category: app.category || drive?.category || null,
        ctc: app.ctc || drive?.ctc || null,
        stipend: app.stipend || drive?.stipend || null,
        location: app.location || drive?.location || null,
        notes: app.notes || null,
        manual_override: app.manual_override || false,
        applied_at: app.applied_at || null,
        last_updated: app.last_updated || new Date().toISOString(),
        registration_deadline: app.registration_deadline || null,
      } : {
        // Dummy unapplied application to show drive details
        id: '',
        status: 'not_applied',
        role: drive?.role || null,
        category: drive?.category || null,
        ctc: drive?.ctc || null,
        stipend: drive?.stipend || null,
        location: drive?.location || null,
        notes: null,
        manual_override: false,
        applied_at: null,
        last_updated: drive?.updated_at || comp?.updated_at || new Date().toISOString(),
        registration_deadline: drive?.registration_deadline || null,
      },
      latestEvent: eventMap.get(entityId) || null,
      events: allEventsByEntity.get(entityId) || [],
      neoIdMatched: drive ? matchedDriveIds.has(drive.id) : (app?.placement_drive_id ? matchedDriveIds.has(app.placement_drive_id) : false),
      emailCount: 0,
    };
  });

  return (
    <Suspense fallback={<div className="p-6 text-text-tertiary">Loading companies...</div>}>
      <CompaniesClient companies={formattedCompanies} userCampus={userCampus} />
    </Suspense>
  );
}
