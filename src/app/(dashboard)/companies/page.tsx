import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import CompaniesClient, { type CompanyWithDetails } from './companies-client';

import { detectCampus } from '@/lib/utils';
import { summarizeRoundDecisions } from '@/lib/sync/round-status';
import { getRoundStatusDisplay } from '@/lib/sync/status-display';
import { readDriveActivity, readRoundStatusRows } from '@/lib/sync/dashboard-readers';

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
    driveActivity,
    roundDecisions,
  ] = await Promise.all([
    supabase
      .from('companies')
      .select('id, name, aliases, created_at, updated_at')
      .order('updated_at', { ascending: false }),

    supabase
      .from('placement_drives')
      .select('id, company_id, drive_number, normalized_drive_number, drive_name, role, category, ctc, stipend, location, created_at, updated_at, source_college_email_id, source_email_id'),

    supabase
      .from('applications')
      .select('id, placement_drive_id, status, role, category, ctc, stipend, location, notes, manual_override, applied_at, last_updated, registration_deadline, status_source_email_at')
      .eq('user_id', session.userId),

    supabase
      .from('events')
      .select('id, placement_drive_id, event_type, title, start_time, end_time, venue, mode, college_email_id, source_email_id')
      .eq('user_id', session.userId)
      .order('start_time', { ascending: true }),

    supabase
      .from('candidate_matches')
      .select('id, placement_drive_id, email_id, college_email_id')
      .eq('user_id', session.userId)
      .neq('match_type', 'xlsx_applied_list'),

    supabase
      .from('gmail_accounts')
      .select('email, account_type')
      .eq('user_id', session.userId),

    readDriveActivity(supabase, session.userId),
    readRoundStatusRows(supabase, session.userId),
  ]);

  const decisionsByDrive = new Map<string, typeof roundDecisions>();
  for (const decision of roundDecisions || []) {
    const rows = decisionsByDrive.get(decision.placement_drive_id) || [];
    rows.push(decision);
    decisionsByDrive.set(decision.placement_drive_id, rows);
  }

  const collegeAccount = accounts?.find((a) => a.account_type === 'college');
  const userCampus = detectCampus(collegeAccount?.email);

  // Maps for efficient lookups
  const compMap = new Map((companies || []).map((comp) => [comp.id, comp]));
  
  // Shared metadata map across all placement drives in the DB (for matching drive numbers)
  const sharedMetaMap = new Map<string, { role?: string | null; category?: string | null; ctc?: string | null; stipend?: string | null; location?: string | null }>();
  for (const sd of (placementDrives || [])) {
    const num = sd.normalized_drive_number || sd.drive_number;
    if (!num) continue;
    const key = num.toLowerCase().trim();
    const existing = sharedMetaMap.get(key) || {};
    if (!existing.ctc && sd.ctc) existing.ctc = sd.ctc;
    if (!existing.stipend && sd.stipend) existing.stipend = sd.stipend;
    if (!existing.location && sd.location) existing.location = sd.location;
    if (!existing.role && sd.role) existing.role = sd.role;
    if (!existing.category && sd.category) existing.category = sd.category;
    sharedMetaMap.set(key, existing);
  }
  
  const nowIso = new Date().toISOString();

  // 1. Combine placement_drives and legacy applications for this user into unified entities
  const entities: { type: 'drive' | 'legacy_app' | 'company_only', drive: any, app: any, company?: any, entityId: string }[] = [];
  const userDriveIdSet = new Set<string>((applications || []).map((a: any) => a.placement_drive_id).filter(Boolean));
  
  if (placementDrives) {
    for (const drive of placementDrives) {
      if (!userDriveIdSet.has(drive.id)) continue;
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

  const allCollegeEmailIds = new Set<string>();
  for (const e of events || []) if ((e as any).college_email_id) allCollegeEmailIds.add((e as any).college_email_id);
  for (const m of matches || []) if ((m as any).college_email_id) allCollegeEmailIds.add((m as any).college_email_id);
  for (const d of placementDrives || []) if ((d as any).source_college_email_id) allCollegeEmailIds.add((d as any).source_college_email_id);

  const { data: collegeEmailsData } = allCollegeEmailIds.size > 0
    ? await supabase.from('college_emails').select('id, received_at').in('id', Array.from(allCollegeEmailIds))
    : { data: [] };

  const collegeEmailMap = new Map<string, string>((collegeEmailsData || []).map((e: any) => [e.id, e.received_at]));

  const driveEmailMap = new Map<string, string>();
  const trackDriveEmail = (dId: string | null | undefined, dt: string | null | undefined) => {
    if (!dId || !dt) return;
    const prev = driveEmailMap.get(dId);
    if (!prev || new Date(dt).getTime() > new Date(prev).getTime()) {
      driveEmailMap.set(dId, dt);
    }
  };

  for (const pe of driveActivity) {
    trackDriveEmail(pe.placement_drive_id, pe.received_at);
  }
  for (const ev of (events || [])) {
    if (ev.placement_drive_id && (ev as any).college_email_id) {
      trackDriveEmail(ev.placement_drive_id, collegeEmailMap.get((ev as any).college_email_id));
    }
  }
  for (const cm of (matches || [])) {
    if (cm.placement_drive_id && (cm as any).college_email_id) {
      trackDriveEmail(cm.placement_drive_id, collegeEmailMap.get((cm as any).college_email_id));
    }
  }
  for (const pd of (placementDrives || [])) {
    if (pd.id && (pd as any).source_college_email_id) {
      trackDriveEmail(pd.id, collegeEmailMap.get((pd as any).source_college_email_id));
    }
  }
  for (const a of (applications || [])) {
    trackDriveEmail(a.placement_drive_id, (a as any).status_source_email_at);
    trackDriveEmail(a.placement_drive_id, a.applied_at);
  }

  // Also match by drive_numbers in recent college_emails
  const driveByNum = new Map<string, string>();
  for (const pd of (placementDrives || [])) {
    if (pd.drive_number) driveByNum.set(pd.drive_number.toLowerCase().trim(), pd.id);
    if (pd.normalized_drive_number) driveByNum.set(pd.normalized_drive_number.toLowerCase().trim(), pd.id);
  }

  const { data: recentCollegeEmails } = await supabase.from('college_emails')
    .select('id, received_at, parsed_drive_numbers')
    .not('parsed_drive_numbers', 'is', null)
    .order('received_at', { ascending: false })
    .limit(200);

  for (const ce of (recentCollegeEmails || [])) {
    for (const num of (ce.parsed_drive_numbers || [])) {
      if (typeof num === 'string') {
        const dId = driveByNum.get(num.toLowerCase().trim());
        if (dId) {
          trackDriveEmail(dId, ce.received_at);
        }
      }
    }
  }

  // Assemble full details based on Entities
  const formattedCompanies: CompanyWithDetails[] = entities.map((ent) => {
    const { drive, app, entityId } = ent;
    const companyId = drive?.company_id || ent.company?.id || (app as any)?.company_id;
    const comp = companyId ? compMap.get(companyId) : undefined;
    
    // Per-drive status/activity update timestamp:
    // 1. If manual override: the student manually adjusted their status (app.last_updated)
    // 2. Otherwise: the most recent update timestamp among:
    //    - latest drive circular/email (including test/interview/PPT schedule notifications)
    //    - status_source_email_at (verdict mail)
    //    - applied_at (registration mail)
    //    - drive creation date
    const targetDriveId = drive?.id || app?.placement_drive_id;
    const displayDecisions = summarizeRoundDecisions(decisionsByDrive.get(targetDriveId) || []);
    const roundDisplay = getRoundStatusDisplay(app?.status || 'not_applied', displayDecisions, Boolean(app?.manual_override), app?.notes || '');
    const latestEmail = targetDriveId ? driveEmailMap.get(targetDriveId) : undefined;
    const isManual = Boolean(app?.manual_override && app?.last_updated);

    const effectiveLatestDate = isManual
      ? app!.last_updated
      : latestEmail
        || (app as any)?.status_source_email_at
        || app?.applied_at
        || drive?.created_at
        || comp?.created_at
        || nowIso;
    
    const normNum = drive?.normalized_drive_number || drive?.drive_number;
    const shared = normNum ? sharedMetaMap.get(normNum.toLowerCase().trim()) : undefined;

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
      latestEmailDate: latestEmail || (app as any)?.status_source_email_at || app?.applied_at || undefined,
      application: app ? {
        id: app.id,
        status: roundDisplay.status,
        role: app.role || drive?.role || shared?.role || null,
        category: app.category || drive?.category || shared?.category || null,
        ctc: app.ctc || drive?.ctc || shared?.ctc || null,
        stipend: app.stipend || drive?.stipend || shared?.stipend || null,
        location: app.location || drive?.location || shared?.location || null,
        notes: app.notes || null,
        manual_override: app.manual_override || false,
        applied_at: app.applied_at || null,
        last_updated: app.last_updated || new Date().toISOString(),
        registration_deadline: app.registration_deadline || null,
        status_source_email_at: (app as any)?.status_source_email_at || null,
      } : {
        // Dummy unapplied application to show drive details
        id: '',
        status: 'not_applied',
        role: drive?.role || shared?.role || null,
        category: drive?.category || shared?.category || null,
        ctc: drive?.ctc || shared?.ctc || null,
        stipend: drive?.stipend || shared?.stipend || null,
        location: drive?.location || shared?.location || null,
        notes: null,
        manual_override: false,
        applied_at: null,
        last_updated: drive?.updated_at || comp?.updated_at || new Date().toISOString(),
        registration_deadline: drive?.registration_deadline || null,
      },
      latestEvent: eventMap.get(entityId) || null,
      events: allEventsByEntity.get(entityId) || [],
      roundDecisions: displayDecisions,
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
