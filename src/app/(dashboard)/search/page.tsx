import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import SearchClient, { type SearchData, type SearchCompanyItem } from './search-client';
import { detectCampus, getDriveMode } from '@/lib/utils';
import { getEffectiveStage } from '@/lib/stages';

export const metadata: Metadata = {
  title: 'Global Search',
  description: 'Search across campus drives, company emails, job descriptions, test links, and shortlist records.',
};

export default async function SearchPage() {
  const session = await requireSession();
  const supabase = createAdminClient();

  // Fetch all companies, placement drives, applications, emails, events, and user account
  const [
    { data: companies },
    { data: placementDrives },
    { data: applications },
    { data: personalEmails },
    { data: collegeEmails },
    { data: events },
    { data: accounts },
  ] = await Promise.all([
    supabase
      .from('companies')
      .select('id, name, aliases, updated_at')
      .order('updated_at', { ascending: false }),

    supabase
      .from('placement_drives')
      .select('id, company_id, drive_name, drive_number, role, category, ctc, stipend, location, updated_at'),

    supabase
      .from('applications')
      .select('id, placement_drive_id, role, category, status, ctc, stipend, location, notes, manual_override, applied_at, last_updated')
      .eq('user_id', session.userId),

    supabase
      .from('personal_emails')
      .select('id, subject, sender, received_at, body_snippet, college_email_id, placement_drive_id')
      .eq('user_id', session.userId)
      .order('received_at', { ascending: false })
      .limit(100),

    supabase
      .from('college_emails')
      .select('id, subject, sender_email, received_at, created_at, body_snippet, body_text, parsed_company_name, parsed_drive_numbers')
      .order('received_at', { ascending: false })
      .limit(100),

    supabase
      .from('events')
      .select('id, title, event_type, start_time, venue, mode, placement_drive_id')
      .eq('user_id', session.userId)
      .order('start_time', { ascending: false })
      .limit(60),

    supabase
      .from('gmail_accounts')
      .select('email, account_type')
      .eq('user_id', session.userId),
  ]);

  const collegeAccount = accounts?.find((a) => a.account_type === 'college');
  const userCampus = detectCampus(collegeAccount?.email);

  const companyMap = new Map((companies || []).map((c) => [c.id, c]));
  const driveMap = new Map((placementDrives || []).map((d) => [d.id, d]));

  // Events grouped by drive id
  const eventsByDrive = new Map<string, any[]>();
  for (const ev of events || []) {
    if (ev.placement_drive_id) {
      const list = eventsByDrive.get(ev.placement_drive_id) || [];
      list.push(ev);
      eventsByDrive.set(ev.placement_drive_id, list);
    }
  }

  // Count drives per company to identify multi-drive companies
  const driveCountMap = new Map<string, number>();
  for (const d of placementDrives || []) {
    const comp = companyMap.get(d.company_id);
    const key = (comp?.name || d.drive_name || '').toLowerCase().trim();
    driveCountMap.set(key, (driveCountMap.get(key) || 0) + 1);
  }

  // Build unified entities: each placement drive is an individual opportunity!
  const companyItems: SearchCompanyItem[] = [];

  if (placementDrives && placementDrives.length > 0) {
    for (const drive of placementDrives) {
      const comp = companyMap.get(drive.company_id);
      const app = (applications || []).find((a) => a.placement_drive_id === drive.id);
      const driveEvents = eventsByDrive.get(drive.id) || [];
      const latestEvent = driveEvents.length > 0 ? driveEvents[0] : null;

      const rawStatus = app?.status || 'applied';
      const eff = getEffectiveStage(
        rawStatus,
        latestEvent,
        driveEvents,
        app?.notes,
        app?.manual_override
      );

      const notes = app?.notes || null;
      const driveMode = getDriveMode(notes, userCampus);
      const compName = comp?.name || drive.drive_name || 'Placement Drive';
      const isMultiDrive = (driveCountMap.get(compName.toLowerCase().trim()) || 0) > 1;

      companyItems.push({
        id: comp?.id || drive.company_id,
        driveId: drive.id,
        appId: app?.id || null,
        name: compName,
        aliases: comp?.aliases || null,
        driveNumber: drive.drive_number || null,
        driveName: drive.drive_name || null,
        role: app?.role || drive.role || null,
        category: app?.category || drive.category || null,
        ctc: app?.ctc || drive.ctc || null,
        stipend: app?.stipend || drive.stipend || null,
        location: app?.location || drive.location || null,
        notes,
        driveMode,
        status: eff.effectiveStatus,
        statusLabel: eff.statusSubtitle,
        isMultiDrive,
      });
    }
  }

  // Also include companies that don't have placement_drives (if any)
  const companiesWithDrives = new Set((placementDrives || []).map((d) => d.company_id));
  if (companies) {
    for (const comp of companies) {
      if (!companiesWithDrives.has(comp.id)) {
        const app = (applications || []).find((a) => (a as any).company_id === comp.id);
        const rawStatus = app?.status || 'applied';
        const eff = getEffectiveStage(rawStatus, null, [], app?.notes, app?.manual_override);
        const driveMode = getDriveMode(app?.notes, userCampus);

        companyItems.push({
          id: comp.id,
          driveId: null,
          appId: app?.id || null,
          name: comp.name,
          aliases: comp.aliases || null,
          driveNumber: null,
          driveName: null,
          role: app?.role || null,
          category: app?.category || null,
          ctc: app?.ctc || null,
          stipend: app?.stipend || null,
          location: app?.location || null,
          notes: app?.notes || null,
          driveMode,
          status: eff.effectiveStatus,
          statusLabel: eff.statusSubtitle,
          isMultiDrive: false,
        });
      }
    }
  }

  const mappedPersonalEmails = (personalEmails || []).map((em) => {
    const drive = em.placement_drive_id ? driveMap.get(em.placement_drive_id) : null;
    const compId = drive?.company_id || em.placement_drive_id;
    const comp = compId ? companyMap.get(compId) : null;
    return {
      id: em.id,
      driveId: em.placement_drive_id,
      subject: em.subject,
      sender: em.sender,
      receivedAt: em.received_at,
      companyId: compId,
      companyName: comp?.name || drive?.drive_name || null,
      snippet: em.body_snippet,
    };
  });

  const mappedCollegeEmails = (collegeEmails || []).map((ce) => {
    // Match drive by parsed_drive_numbers or company name
    let matchedDrive = null;
    if (ce.parsed_drive_numbers && ce.parsed_drive_numbers.length > 0) {
      for (const dn of ce.parsed_drive_numbers) {
        matchedDrive = (placementDrives || []).find((d) => d.drive_number === dn) || null;
        if (matchedDrive) break;
      }
    }
    const compId = matchedDrive?.company_id || null;
    const comp = compId ? companyMap.get(compId) : null;
    return {
      id: ce.id,
      driveId: matchedDrive?.id || null,
      subject: ce.subject,
      sender: ce.sender_email,
      receivedAt: (ce as any).received_at || ce.created_at,
      companyId: compId,
      companyName: comp?.name || ce.parsed_company_name || matchedDrive?.drive_name || null,
      snippet: ce.body_text || ce.body_snippet,
    };
  });

  const searchData: SearchData = {
    companies: companyItems,
    emails: [...mappedPersonalEmails, ...mappedCollegeEmails].sort((a, b) => {
      const tA = a.receivedAt ? new Date(a.receivedAt).getTime() : 0;
      const tB = b.receivedAt ? new Date(b.receivedAt).getTime() : 0;
      return tB - tA;
    }),
    events: (events || []).map((ev) => {
      const drive = ev.placement_drive_id ? driveMap.get(ev.placement_drive_id) : null;
      const compId = drive?.company_id || ev.placement_drive_id;
      const comp = compId ? companyMap.get(compId) : null;
      return {
        id: ev.id,
        driveId: ev.placement_drive_id,
        title: ev.title,
        eventType: ev.event_type,
        startTime: ev.start_time,
        venue: ev.venue,
        mode: ev.mode,
        companyId: compId,
        companyName: comp?.name || drive?.drive_name || 'Placement Drive',
      };
    }),
  };

  return (
    <Suspense fallback={<div className="p-8 text-center text-zinc-500 font-mono text-sm">Loading search...</div>}>
      <SearchClient data={searchData} />
    </Suspense>
  );
}
