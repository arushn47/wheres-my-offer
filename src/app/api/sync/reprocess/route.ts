import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  classifyEmail,
  cleanCompanyName,
  extractCompanyName,
  normalizeCompanyName,
  isInvalidCompanyName,
  extractCompanyAliases,
} from '@/lib/sync/classifier';
import { cleanRoleTitle, extractDriveNumber, extractEvents, extractJobDetails, extractLatestTravelRequirement, extractTravelRequirement } from '@/lib/sync/events';
import { isFuzzyCompanyMatch } from '@/lib/sync/engine';
import { recoverTruncatedEmailBodies } from '@/lib/sync/email-body-recovery';
import { refreshTravelModeNote } from '@/lib/utils';
import {
  buildCircularCatalog,
  loadAllDriveResolutions,
  resolveDriveByTimingCorrelation,
} from '@/lib/sync/drive-correlator';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 300s â€” maximum allowed on Vercel Fluid Compute (Hobby & Pro)

/**
 * Re-indexes all stored emails using the strict 2-tier architecture:
 *
 * Tier 1: ONLY emails from noreply.cdcinfo@vitstudent.ac.in (the official NeoPAT notification sender)
 *         define the company drives in NeoTrack.
 * Tier 2: College circulars (@vitbhopal.ac.in) ONLY enrich existing NeoPAT drives with CTC, JDs,
 *         test dates, and shortlist verification. Non-NeoPAT drives (e.g. Datagrokr) are discarded.
 */
/**
 * Phase 4 only: Recalculates application statuses, CTCs, roles, and events for all
 * companies of a user by loading ALL their emails at once and doing holistic analysis.
 *
 * This is the same computation that happens at the end of performReprocess but runs
 * standalone â€” called from the sync engine after all pages complete to correct any
 * status errors from incremental per-email processing.
 */
export async function recalculateApplicationStatuses(
  userId: string,
  onProgress?: (p: { step: number; totalSteps: number; message: string }) => void,
  options?: {
    deepGSheetScan?: boolean;
    targetPlacementDriveIds?: string[];
    recalculateStatusesFromRemainingEvidence?: boolean;
  }
): Promise<{ updatedCount: number; results: Array<{ company: string; status: string; role?: string | null; ctc?: string | null }> }> {
  const supabase = createAdminClient();

  onProgress?.({
    step: 5,
    totalSteps: 5,
    message: `Recalculating application stages, CTCs & calendar events for official drivesâ€¦`,
  });

  const { data: userData } = await supabase
    .from('users')
    .select('neo_id, email, name')
    .eq('id', userId)
    .single();

  const userNeoId = userData?.neo_id || null;
  const userEmail = userData?.email || '';

  if (!userEmail) return { updatedCount: 0, results: [] };

  // Preload college_emails by RFC message ID for rows whose foreign-key link is missing.
  const { data: canonicalsWithBody } = await supabase
    .from('college_emails')
    .select('id, message_id, body_text, body_snippet')
    .not('message_id', 'is', null)
    .or('body_text.not.is.null,body_snippet.not.is.null');

  const canonicalByMsgId = new Map<string, string>();
  for (const c of canonicalsWithBody || []) {
    const text = c.body_text || c.body_snippet || '';
    if (text) {
      if (c.message_id && !canonicalByMsgId.has(c.message_id.toLowerCase().trim())) {
        canonicalByMsgId.set(c.message_id.toLowerCase().trim(), text);
      }
    }
  }

  // Fetch all emails for this user (paginated)
  const allEmails: Array<{
    id: string;
    subject: string | null;
    sender: string | null;
    body_snippet: string | null;
    canonical_email_id: string | null;
    college_email_id: string | null;
    rfc_message_id?: string | null;
    classification: string | null;
    placement_drive_id: string | null;
    received_at: string | null;
    gmail_account_id?: string | null;
    gmail_message_id?: string | null;
    assignment_state?: string | null;
    assignment_source?: string | null;
    has_canonical_body?: boolean;
  }> = [];

  const pageSize = 1000;
  let page = 0;
  while (true) {
    const { data: chunk, error: chunkErr } = await supabase
      .from('personal_emails')
      .select('id, subject, sender, body_snippet, gmail_account_id, gmail_message_id, canonical_email_id, college_email_id, college_emails!personal_emails_college_email_id_fkey(body_text, body_snippet), rfc_message_id, classification, placement_drive_id, received_at, assignment_state, assignment_source')
      .eq('user_id', userId)
      .order('received_at', { ascending: true })
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (chunkErr) {
      console.error('[recalculateApplicationStatuses] Error loading personal_emails:', chunkErr);
      break;
    }
    if (!chunk || chunk.length === 0) break;
    allEmails.push(...chunk.map((email: any) => {
      const canonical = Array.isArray(email.college_emails)
        ? email.college_emails[0]
        : email.college_emails;
      let fullBody = canonical?.body_text || canonical?.body_snippet || null;
      if (!fullBody && email.rfc_message_id) {
        fullBody = canonicalByMsgId.get(email.rfc_message_id.toLowerCase().trim()) || null;
      }
      const hasCanonicalBody = Boolean(fullBody && fullBody.length > 500);
      if (!fullBody) {
        fullBody = email.body_snippet || '';
      }
      return {
        ...email,
        body_snippet: fullBody,
        has_canonical_body: hasCanonicalBody,
      };
    }));
    if (chunk.length < pageSize) break;
    page++;
  }

  const recoveredBodies = await recoverTruncatedEmailBodies(allEmails);
  for (const email of allEmails) {
    const recoveredBody = recoveredBodies.get(email.id);
    if (recoveredBody) email.body_snippet = recoveredBody;
  }

  // Also fetch college broadcast circulars (shared college_emails table)
  const allCollegeEmails: Array<{
    id: string;
    subject: string | null;
    sender: string | null;
    body_snippet: string | null;
    received_at: string | null;
    classification: string | null;
    parsed_company_name?: string | null;
    parsed_drive_numbers?: string[] | null;
    placement_drive_id?: string | null;
    college_email_id?: string | null;
    canonical_email_id?: string | null;
    assignment_source?: string | null;
    has_canonical_body?: boolean;
  }> = [];

  let clgPage = 0;
  while (true) {
    const { data: cChunk, error: cErr } = await supabase
      .from('college_emails')
      .select('id, subject, sender_email, received_at, created_at, body_snippet, body_text, classification, parsed_company_name, parsed_drive_numbers')
      .order('received_at', { ascending: true })
      .range(clgPage * pageSize, (clgPage + 1) * pageSize - 1);

    if (cErr) {
      console.error('[recalculateApplicationStatuses] Error loading college_emails:', cErr);
      break;
    }
    if (!cChunk || cChunk.length === 0) break;

    allCollegeEmails.push(...cChunk.map((ce: any) => ({
      id: ce.id,
      subject: ce.subject,
      sender: ce.sender_email,
      received_at: ce.received_at || ce.created_at,
      body_snippet: ce.body_text || ce.body_snippet || '',
      classification: ce.classification,
      parsed_company_name: ce.parsed_company_name,
      parsed_drive_numbers: ce.parsed_drive_numbers || [],
      placement_drive_id: null,
      college_email_id: ce.id,
      canonical_email_id: ce.id,
      assignment_source: 'college_broadcast',
      has_canonical_body: Boolean(ce.body_text && ce.body_text.length > 500),
    })));

    if (cChunk.length < pageSize) break;
    clgPage++;
  }

  if (allEmails.length === 0 && allCollegeEmails.length === 0) return { updatedCount: 0, results: [] };


  const [
    { data: remainingCompanies },
    { data: placementDrives },
    { data: driveLinks },
    { data: allUserApps },
    { data: allManualEvents },
  ] = await Promise.all([
    supabase
      .from('companies')
      .select('id, name, aliases'),
    supabase
      .from('placement_drives')
      .select('id, company_id, drive_number, normalized_drive_number, drive_name, role, category, ctc, stipend, location, registration_deadline, eligibility, branches, cgpa_requirement, backlog_requirement, excluded_email_ids, created_at'),
    supabase
      .from('email_drive_links')
      .select('email_id, placement_drive_id'),
    supabase
      .from('applications')
      .select('id, placement_drive_id, status, manual_override, role, ctc, stipend, location, notes, applied_at, registration_deadline, eligibility, branches, cgpa_requirement, backlog_requirement')
      .eq('user_id', userId),
    supabase
      .from('events')
      .select('*')
      .eq('user_id', userId)
      .eq('manual_override', true),
  ]);

  if (!remainingCompanies || remainingCompanies.length === 0) return { updatedCount: 0, results: [] };

  const appsByDriveId = new Map<string, any>();
  for (const app of (allUserApps || [])) {
    if (app.placement_drive_id) {
      appsByDriveId.set(app.placement_drive_id, app);
    }
  }

  const manualEventsByDriveId = new Map<string, any[]>();
  for (const me of (allManualEvents || [])) {
    if (me.placement_drive_id) {
      const list = manualEventsByDriveId.get(me.placement_drive_id) || [];
      list.push(me);
      manualEventsByDriveId.set(me.placement_drive_id, list);
    }
  }

  const companyMap = new Map((remainingCompanies || []).map((c) => [c.id, c]));
  const drivesByCompanyId = new Map<string, any[]>();
  for (const d of (placementDrives || [])) {
    const list = drivesByCompanyId.get(d.company_id) || [];
    list.push(d);
    drivesByCompanyId.set(d.company_id, list);
  }

  const allDrives = [...(placementDrives || [])];

  // Deduplicate rogue companies ending with UG/PG or duplicate names if base company exists
  for (const c of remainingCompanies) {
    if (/\b(?:ug|pg)\b/i.test(c.name)) {
      const baseName = c.name.replace(/\s+(?:ug|pg)\b.*$/i, '').trim();
      const baseComp = remainingCompanies.find(
        (other) => other.id !== c.id && other.name.toLowerCase() === baseName.toLowerCase()
      );
      if (baseComp) {
        const cDrives = drivesByCompanyId.get(c.id) || [];
        const baseDrives = drivesByCompanyId.get(baseComp.id) || [];
        const targetDriveId = baseDrives[0]?.id;
        for (const cd of cDrives) {
          if (targetDriveId) {
            await supabase.from('personal_emails').update({ placement_drive_id: targetDriveId }).eq('placement_drive_id', cd.id);
            await supabase.from('applications').delete().eq('placement_drive_id', cd.id);
            await supabase.from('events').delete().eq('placement_drive_id', cd.id);
            await supabase.from('notifications').delete().eq('placement_drive_id', cd.id);
            await supabase.from('email_drive_links').delete().eq('placement_drive_id', cd.id);
          }
          await supabase.from('placement_drives').delete().eq('id', cd.id);
        }
        await supabase.from('companies').delete().eq('id', c.id);
      }
    }
  }

  // Sanitize legacy suffixed company names like "Euler Motors (1170)"
  for (const c of remainingCompanies) {
    if (/\s*\(\d+\)\s*$/.test(c.name)) {
      const cleanName = c.name.replace(/\s*\(\d+\)\s*$/, '').trim();
      await supabase.from('companies').update({ name: cleanName }).eq('id', c.id);
      c.name = cleanName;
    }
  }

  const { data: candidateMatches } = await supabase
    .from('candidate_matches')
    .select('id, match_type, email_id, college_email_id, matched_value, matched_round_type, placement_drive_id')
    .eq('user_id', userId);

  const driveExclusionsMap = new Map<string, Set<string>>();
  for (const d of (placementDrives || [])) {
    if (Array.isArray((d as any).excluded_email_ids) && (d as any).excluded_email_ids.length > 0) {
      driveExclusionsMap.set(d.id, new Set((d as any).excluded_email_ids));
    }
  }

  const emailsByDriveId = new Map<string, typeof allEmails>();
  for (const e of allEmails) {
    if (e.placement_drive_id && e.assignment_source !== 'admin_unlinked' && e.classification !== 'irrelevant') {
      const driveExcluded = driveExclusionsMap.get(e.placement_drive_id);
      if (driveExcluded && (driveExcluded.has(e.id) || (e.canonical_email_id && driveExcluded.has(e.canonical_email_id)))) {
        continue;
      }
      const list = emailsByDriveId.get(e.placement_drive_id) || [];
      list.push(e);
      emailsByDriveId.set(e.placement_drive_id, list);
    }
  }

  const emailById = new Map(allEmails.map((e) => [e.id, e]));
  const userPersonalEmailIdSet = new Set(allEmails.map((e) => e.id));

  // Index college circulars for rapid lookup & drive mapping
  const collegeEmailsByDriveNum = new Map<string, typeof allCollegeEmails>();
  const collegeEmailById = new Map<string, (typeof allCollegeEmails)[0]>();
  for (const ce of allCollegeEmails) {
    collegeEmailById.set(ce.id, ce);
    for (const dNum of (ce.parsed_drive_numbers || [])) {
      const cleanNum = dNum.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (cleanNum) {
        const list = collegeEmailsByDriveNum.get(cleanNum) || [];
        list.push(ce);
        collegeEmailsByDriveNum.set(cleanNum, list);
      }
    }
  }

  const candidateMatchesByDriveId = new Map<string, any[]>();
  for (const cm of (candidateMatches || [])) {
    if (cm.placement_drive_id) {
      const list = candidateMatchesByDriveId.get(cm.placement_drive_id) || [];
      list.push(cm);
      candidateMatchesByDriveId.set(cm.placement_drive_id, list);
    }
  }

  for (const link of (driveLinks || [])) {
    const linkedEmail = emailById.get(link.email_id);
    if (linkedEmail && linkedEmail.assignment_source !== 'admin_unlinked' && linkedEmail.classification !== 'irrelevant') {
      const driveExcluded = driveExclusionsMap.get(link.placement_drive_id);
      if (driveExcluded && (driveExcluded.has(linkedEmail.id) || (linkedEmail.canonical_email_id && driveExcluded.has(linkedEmail.canonical_email_id)) || (linkedEmail.college_email_id && driveExcluded.has(linkedEmail.college_email_id)))) {
        continue;
      }
      const list = emailsByDriveId.get(link.placement_drive_id) || [];
      if (!list.some(e => e.id === linkedEmail.id)) {
        list.push(linkedEmail);
        emailsByDriveId.set(link.placement_drive_id, list);
      }
    }
  }

  let updatedAppsCount = 0;
  const applicationResults: Array<{ company: string; status: string; role?: string | null; ctc?: string | null }> = [];

  const isPersonalNeoPatEmail = (e: { sender?: string | null }) =>
    /noreply\.cdcinfo@vitstudent\.ac\.in/i.test(e.sender || '');

  const isRegistrationCircular = (e: { subject?: string | null; body_snippet?: string | null }) => {
    const text = `${e.subject || ''}\n${e.body_snippet || ''}`;
    return (
      (/name\s+of\s+the\s+company/i.test(text) && /category/i.test(text)) ||
      /super\s*dream.*registration|dream.*registration|placement\s+registration|internship\s+registration/i.test(
        e.subject || ''
      )
    );
  };

  const targetDriveSet = options?.targetPlacementDriveIds && options.targetPlacementDriveIds.length > 0
    ? new Set(options.targetPlacementDriveIds)
    : null;
  const drivesToProcess = targetDriveSet
    ? allDrives.filter((d) => targetDriveSet.has(d.id))
    : allDrives;

  const DRIVE_BATCH_SIZE = 8;
  for (let bIdx = 0; bIdx < drivesToProcess.length; bIdx += DRIVE_BATCH_SIZE) {
    const driveBatch = drivesToProcess.slice(bIdx, bIdx + DRIVE_BATCH_SIZE);
    onProgress?.({
      step: 5,
      totalSteps: 5,
      message: `Recalculating application stages, CTCs & calendar events (${Math.min(bIdx + DRIVE_BATCH_SIZE, drivesToProcess.length)} / ${drivesToProcess.length})…`,
    });

    await Promise.all(
      driveBatch.map(async (drive) => {
        const comp = companyMap.get(drive.company_id);
        if (!comp) return;

    const driveEmails = [...(emailsByDriveId.get(drive.id) || [])];
    const driveExcluded = driveExclusionsMap.get(drive.id);

    // 1. Include college email set as source on drive
    if ((drive as any).source_college_email_id) {
      const ce = collegeEmailById.get((drive as any).source_college_email_id);
      if (ce && (!driveExcluded || !driveExcluded.has(ce.id))) {
        if (!driveEmails.some((existing) => existing.id === ce.id)) {
          driveEmails.push(ce as any);
        }
      }
    }

    // 2. Include college emails matching drive number
    const driveNum = drive.normalized_drive_number || drive.drive_number;
    if (driveNum) {
      const cleanNum = driveNum.toLowerCase().replace(/[^a-z0-9]/g, '');
      const numMatches = collegeEmailsByDriveNum.get(cleanNum) || [];
      for (const ce of numMatches) {
        if (driveExcluded && driveExcluded.has(ce.id)) continue;
        if (!driveEmails.some((existing) => existing.id === ce.id)) {
          driveEmails.push(ce as any);
        }
      }
    }

    // 3. Include college emails linked to candidate matches for this drive
    const driveMatches = candidateMatchesByDriveId.get(drive.id) || [];
    for (const dm of driveMatches) {
      const refId = dm.college_email_id || dm.email_id;
      if (refId && collegeEmailById.has(refId)) {
        const ce = collegeEmailById.get(refId)!;
        if (driveExcluded && driveExcluded.has(ce.id)) continue;
        if (!driveEmails.some((existing) => existing.id === ce.id)) {
          driveEmails.push(ce as any);
        }
      }
    }

    // Determine verified start date of this drive from its official assigned emails
    const verifiedTimes = driveEmails
      .map((e) => new Date(e.received_at || 0).getTime())
      .filter((t) => t > 0);
    const verifiedDriveStartTime = verifiedTimes.length > 0
      ? Math.min(...verifiedTimes)
      : null;
    const fallbackDriveTime = drive.created_at ? new Date(drive.created_at).getTime() : 0;
    const driveMinAllowedTime = verifiedDriveStartTime
      ? verifiedDriveStartTime - 24 * 60 * 60 * 1000
      : (fallbackDriveTime ? fallbackDriveTime - 24 * 60 * 60 * 1000 : 0);

    const aliases = (comp.aliases || []).map((a: string) => a.toLowerCase().trim());
    const compNameLower = comp.name.toLowerCase().trim();

    const isCompanySubjectMatch = (subject: string): boolean => {
      const sub = subject.toLowerCase();
      // Match full company name with word boundary
      if (compNameLower.length >= 3) {
        const escaped = compNameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escaped}\\b`, 'i').test(sub)) return true;
      }
      // Match drive number
      if (drive.drive_number) {
        const cleanDn = drive.drive_number.toLowerCase().replace(/[^a-z0-9]/g, '');
        const cleanSub = sub.replace(/[^a-z0-9]/g, '');
        if (cleanDn.length >= 4 && cleanSub.includes(cleanDn)) return true;
      }
      // Match substantive aliases (must be >= 4 chars, never short acronyms or generic words)
      for (const a of aliases) {
        if (!a || a.length < 4 || ['ngi', 'pan', 'work', 'part', 'pls', 'data', 'asia', 'tech'].includes(a)) continue;
        const escaped = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escaped}\\b`, 'i').test(sub)) {
          return true;
        }
      }
      return false;
    };

    // 4. Fallback: unassigned personal emails matching company within active timeframe
    for (const e of allEmails) {
      if (!e.placement_drive_id && e.assignment_source !== 'admin_unlinked' && e.subject && e.received_at) {
        const eTime = new Date(e.received_at).getTime();
        if (driveMinAllowedTime > 0 && eTime < driveMinAllowedTime) {
          continue;
        }
        if (isCompanySubjectMatch(e.subject)) {
          if (!driveEmails.some(existing => existing.id === e.id)) {
            driveEmails.push(e);
          }
        }
      }
    }

    // 5. Fallback: college broadcast circulars matching company within active timeframe
    for (const ce of allCollegeEmails) {
      if (ce.classification === 'irrelevant' || !ce.subject || !ce.received_at) continue;
      if (driveExcluded && driveExcluded.has(ce.id)) continue;
      const eTime = new Date(ce.received_at).getTime();
      if (driveMinAllowedTime > 0 && eTime < driveMinAllowedTime) continue;
      if (isCompanySubjectMatch(ce.subject) || (ce.parsed_company_name && isFuzzyCompanyMatch(comp.name, ce.parsed_company_name))) {
        if (!driveEmails.some(existing => existing.id === ce.id)) {
          driveEmails.push(ce as any);
        }
      }
    }

    if (driveEmails.length === 0) return;

    const companyEmails = driveEmails;
    const emailIds = new Set(companyEmails.map((e) => e.id));
    const collegeEmailIds = new Set(companyEmails.map((e) => e.college_email_id || e.canonical_email_id).filter(Boolean));
    const matchedEmailIds = new Set(
      (candidateMatches || [])
        .filter((cm) => {
          const match = cm as unknown as { email_id: string | null; college_email_id: string | null; match_type?: string; matched_value?: string | null };
          const emailRef = match.email_id || match.college_email_id;
          if (!emailRef || !emailIds.has(emailRef) && !collegeEmailIds.has(emailRef) || match.match_type === 'xlsx_applied_list') return false;
          return !/applied[\s_-]*list|opt[\s_-]*in[\s_-]*list|opt_in|registration[\s_-]*list|applied[\s_-]*(?:student|candidate)/i.test(match.matched_value || '');
        })
        .map((cm) => (cm as unknown as { email_id: string | null; college_email_id: string | null }).email_id || (cm as unknown as { college_email_id: string }).college_email_id)
        .filter(Boolean)
    );

    // 0. Scan any Google Sheets pubhtml shortlists in company emails for candidate matches (only when deep scan requested)
    const gsheetEventsForCompany: Array<{
      eventType: string;
      title: string;
      startTime: Date;
      venue: string;
      mode: string;
      confidence: string;
      hasExplicitTime: boolean;
    }> = [];

    if (options?.deepGSheetScan) {
      const { extractGoogleSheetUrls, scanGoogleSheetForCandidate } = await import('@/lib/sync/gsheet-parser');

      for (const email of companyEmails) {
        const emailText = `${email.subject || ''}\n${email.body_snippet || ''}`;
        const isRelevantCandidateEmail =
          /shortlist|selection|selected|test|assessment|interview|score|rank|eligible|candidates|students/i.test(
            emailText
          );
        if (!isRelevantCandidateEmail) continue;

        const alreadyMatched = (candidateMatches || []).some(
          (cm) => {
            const match = cm as unknown as { email_id: string | null; college_email_id: string | null };
            return match.email_id === email.id || match.college_email_id === email.id;
          }
        );
        if (alreadyMatched) continue;

        const gUrls = extractGoogleSheetUrls(emailText);
        for (const gUrl of gUrls) {
          const gMatch = await scanGoogleSheetForCandidate(gUrl, userEmail, userNeoId, userData?.name);
          if (gMatch && gMatch.matched) {
            matchedEmailIds.add(email.id);
            const matchExists = (candidateMatches || []).some(
              (cm) => {
                const match = cm as unknown as { email_id: string | null; college_email_id: string | null };
                return match.email_id === email.id || match.college_email_id === email.id;
              }
            );
            if (!matchExists) {
              const { error: candidateMatchError } = await supabase.from('candidate_matches').insert({
                user_id: userId,
                email_id: email.id,
                placement_drive_id: drive.id,
                neo_id: userNeoId || userEmail,
                match_type: 'xlsx_cell',
                matched_value: gMatch.details,
                confidence: 'high',
              });
              if (candidateMatchError && candidateMatchError.code !== '23505') {
                throw candidateMatchError;
              }
            }

            if (gMatch.eventDate) {
              const isPpt = /ppt|pre[\s-]*placement/i.test(email.subject || '');
              const isInterview = /interview/i.test(email.subject || '');
              const eventType = isPpt ? 'ppt' : isInterview ? 'technical_interview' : 'online_test';
              const title = isPpt
                ? 'Pre-Placement Talk (PPT)'
                : isInterview
                ? 'Interview'
                : `Online Assessment${gMatch.slot ? ` (${gMatch.slot})` : ''}`;

              const startTime = new Date(gMatch.eventDate);
              startTime.setHours(gMatch.slot && /slot\s*2/i.test(gMatch.slot) ? 14 : 9, 0, 0, 0);
              gsheetEventsForCompany.push({
                eventType,
                title,
                startTime,
                venue: 'Campus / Offline',
                mode: 'online',
                confidence: 'high',
                hasExplicitTime: true,
              });
            }
            break;
          }
        }
      }
    }

    const sortedCompanyEmails = [...companyEmails].sort(
      (a, b) => new Date(b.received_at || 0).getTime() - new Date(a.received_at || 0).getTime()
    );
    const chronologicalCompanyEmails = [...companyEmails].sort(
      (a, b) => new Date(a.received_at || 0).getTime() - new Date(b.received_at || 0).getTime()
    );
    const personalCompanyEmails = chronologicalCompanyEmails.filter(isPersonalNeoPatEmail);
    const collegeCompanyEmails = chronologicalCompanyEmails.filter((e) => !isPersonalNeoPatEmail(e));

    const fullCirculars = collegeCompanyEmails.filter((e) => {
      const text = `${e.subject || ''}\n${e.body_snippet || ''}`;
      return (
        /name\s+of\s+the\s+company/i.test(text) &&
        /eligibility\s+criteria/i.test(text) &&
        /category/i.test(text)
      );
    });

    const updateCircular = [...fullCirculars].reverse().find((e) =>
      /\b(?:update|updated|revised|reschedule|corrigendum)\b/i.test(e.subject || '')
    );

    const mainCircularEmail =
      updateCircular ||
      (fullCirculars.length > 0 ? fullCirculars[fullCirculars.length - 1] : null) ||
      [...collegeCompanyEmails].reverse().find((e) =>
        /super\s*dream.*registration|dream.*registration|placement\s+registration|internship\s+registration|offer\s+registration/i.test(e.subject || '')
      ) ||
      [...collegeCompanyEmails].reverse().find((e) =>
        /date\s+of\s+visit/i.test(e.body_snippet || '') || /registration/i.test(e.subject || '')
      ) ||
      collegeCompanyEmails[0] || chronologicalCompanyEmails[0];

    const registrationCirculars = collegeCompanyEmails.filter(isRegistrationCircular);
    registrationCirculars.sort(
      (a, b) => new Date(a.received_at || 0).getTime() - new Date(b.received_at || 0).getTime()
    );
    const driveRegistrationEmail = registrationCirculars[0] || mainCircularEmail;
    const personalDate = personalCompanyEmails[0]?.received_at ? new Date(personalCompanyEmails[0].received_at) : null;
    const circularDate = driveRegistrationEmail?.received_at ? new Date(driveRegistrationEmail.received_at) : null;
    let driveStartDate: Date | null = null;
    if (personalDate && circularDate) {
      driveStartDate = personalDate.getTime() < circularDate.getTime() ? personalDate : circularDate;
    } else {
      driveStartDate = personalDate || circularDate || null;
    }

    // Find if there is a next drive for this company to avoid date bleed
    const siblingDrives = allDrives.filter((d) => d.company_id === drive.company_id && d.id !== drive.id);
    let nextDriveStartDate: Date | null = null;
    if (driveStartDate && siblingDrives.length > 0) {
      for (const sib of siblingDrives) {
        const sibEmails = emailsByDriveId.get(sib.id) || [];
        const sibPersonal = sibEmails.filter(isPersonalNeoPatEmail);
        const sibStart = sibPersonal[0]?.received_at ? new Date(sibPersonal[0].received_at) : (sib.created_at ? new Date(sib.created_at) : null);
        if (sibStart && sibStart.getTime() > driveStartDate.getTime()) {
          if (!nextDriveStartDate || sibStart.getTime() < nextDriveStartDate.getTime()) {
            nextDriveStartDate = sibStart;
          }
        }
      }
    }

    // Active emails for this drive: strictly scoped to this drive's emails, respecting start date and next drive boundary
    const activeDriveEmails = chronologicalCompanyEmails.filter((e) => {
      const eTime = new Date(e.received_at || 0).getTime();
      // Allow circulars that arrived up to 24h before the drive announcement
      if (driveStartDate && eTime < driveStartDate.getTime() - 24 * 60 * 60 * 1000) return false;
      if (nextDriveStartDate && eTime >= nextDriveStartDate.getTime() - 5 * 60 * 1000) return false;
      return true;
    });

    const mainEmailText = mainCircularEmail ? `${mainCircularEmail.subject || ''}\n${mainCircularEmail.body_snippet || ''}` : '';
    const mainJobDetails = extractJobDetails(mainEmailText);

    const combinedEmailText = activeDriveEmails
      .map((e) => `${e.subject || ''}\n${e.body_snippet || ''}`)
      .join('\n\n');

    const extractedJob = {
      role: mainJobDetails.role,
      category: mainJobDetails.category,
      ctc: mainJobDetails.ctc,
      stipend: mainJobDetails.stipend,
      location: mainJobDetails.location,
      eligibility: mainJobDetails.eligibility,
      branches: mainJobDetails.branches,
      cgpaRequirement: mainJobDetails.cgpaRequirement,
      backlogRequirement: mainJobDetails.backlogRequirement,
    };

    if (!extractedJob.ctc || !extractedJob.stipend || !extractedJob.location || !extractedJob.role || !extractedJob.eligibility) {
      const combinedDetails = extractJobDetails(combinedEmailText);
      if (!extractedJob.ctc && combinedDetails.ctc) extractedJob.ctc = combinedDetails.ctc;
      if (!extractedJob.stipend && combinedDetails.stipend) extractedJob.stipend = combinedDetails.stipend;
      if (!extractedJob.location && combinedDetails.location) extractedJob.location = combinedDetails.location;
      if (!extractedJob.role && combinedDetails.role) extractedJob.role = combinedDetails.role;
      if (!extractedJob.category && combinedDetails.category) extractedJob.category = combinedDetails.category;
      if (!extractedJob.eligibility && combinedDetails.eligibility) extractedJob.eligibility = combinedDetails.eligibility;
      if ((!extractedJob.branches || extractedJob.branches.length === 0) && combinedDetails.branches && combinedDetails.branches.length > 0) extractedJob.branches = combinedDetails.branches;
      if (!extractedJob.cgpaRequirement && combinedDetails.cgpaRequirement) extractedJob.cgpaRequirement = combinedDetails.cgpaRequirement;
      if (!extractedJob.backlogRequirement && combinedDetails.backlogRequirement) extractedJob.backlogRequirement = combinedDetails.backlogRequirement;
    }

    // Existing drive metadata is user-scoped; avoid borrowing similarly numbered drives
    // from another user's placement history.
    if (!extractedJob.ctc && drive.ctc) extractedJob.ctc = drive.ctc;
    if (!extractedJob.stipend && drive.stipend) extractedJob.stipend = drive.stipend;
    if (!extractedJob.location && drive.location) extractedJob.location = drive.location;
    if (!extractedJob.role && drive.role) extractedJob.role = drive.role;
    if (!extractedJob.category && drive.category) extractedJob.category = drive.category;

    // If critical job details (location, stipend, CTC) are missing because this company
    // is a role-specific record (e.g. "Zluri SDET", "Apple SDET", "Apple SRE") whose circular
    // was announced under the base brand ("Zluri", "Apple"), search user's emails for base brand circulars
    const allowCrossEmailJobEnrichment = false;
    if (allowCrossEmailJobEnrichment && (!extractedJob.location || !extractedJob.stipend || !extractedJob.ctc)) {
      const nameLower = comp.name.toLowerCase();
      const cleanTokens = nameLower
        .replace(/\s*(?:SDET|SRE|Intern|Fulltime|FTE|Graduate|Engineer|Analyst|Consultant|LLP|Pvt\s*Ltd|Limited|Technologies|Solutions|Services).*$/i, '')
        .split(/\s+/)
        .filter((t: string) => t.length >= 3);
      const normCompAlpha = comp.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

      const brandEmails = allEmails.filter((e) => {
        if (driveStartDate && new Date(e.received_at || 0).getTime() < driveStartDate.getTime()) return false;
        const subj = (e.subject || '').toLowerCase();
        const normSubjAlpha = subj.replace(/[^a-zA-Z0-9]/g, '');
        if (cleanTokens.length > 0 && cleanTokens.every((t: string) => subj.includes(t))) return true;
        const acronym = comp.name.match(/\b([A-Z])/g)?.join('').toLowerCase();
        if (acronym && acronym.length >= 3 && new RegExp(`\\b${acronym}\\b`, 'i').test(subj)) return true;
        if (cleanTokens[0] && cleanTokens[0].length >= 4 && (subj.includes(cleanTokens[0]) || normSubjAlpha.includes(cleanTokens[0]))) return true;
        if (normCompAlpha.length >= 4 && normSubjAlpha.includes(normCompAlpha)) return true;
        return false;
      });

      if (brandEmails.length > 0) {
        const brandText = brandEmails.map((e) => `${e.subject || ''}\n${e.body_snippet || ''}`).join('\n\n');
        const brandDetails = extractJobDetails(brandText);
        if (!extractedJob.location && brandDetails.location) extractedJob.location = brandDetails.location;
        if (!extractedJob.stipend && brandDetails.stipend) extractedJob.stipend = brandDetails.stipend;
        if (!extractedJob.ctc && brandDetails.ctc) extractedJob.ctc = brandDetails.ctc;
        if (!extractedJob.role && brandDetails.role) extractedJob.role = brandDetails.role;
      }
    }

    const withdrawalEmails = activeDriveEmails.filter((e) => {
      if (!userPersonalEmailIdSet.has(e.id)) return false;
      const full = `${e.subject || ''} ${e.body_snippet || ''}`.toLowerCase();
      if (
        /who\s+(?:wish|want)\s+to\s+opt|if\s+you\s+(?:wish|want)\s+to\s+opt|opt[\s-]*out\s+(?:form|link|google|portal)|voluntary\s+withdrawal\s+only|forms\.gle/i.test(
          full
        )
      ) {
        return false;
      }
      return (
        e.classification === 'withdrawal' ||
        e.classification === 'decline' ||
        /registration.*withdrawn|your registration.*withdrawn|declined\s+drive/i.test(full) ||
        /confirmation.*drive\s+registration\s+update.*withdrawn/i.test(full)
      );
    });

    const latestWithdrawalTime = withdrawalEmails.reduce((max, e) => {
      const t = e.received_at ? new Date(e.received_at).getTime() : 0;
      return Math.max(max, t);
    }, 0);

    const registrationEmails = activeDriveEmails.filter((e) => {
      // Registration confirmations MUST be personal receipts sent to this user!
      if (!userPersonalEmailIdSet.has(e.id)) return false;

      const subj = (e.subject || '').toLowerCase();
      const full = `${subj} ${e.body_snippet || ''}`.toLowerCase();
      const isPersonalNeoPat = /noreply\.cdcinfo@vitstudent\.ac\.in/i.test(e.sender || '');
      const compDriveNum = (drive as any).drive_number;
      const driveMatches = !comp.name.match(/sdet|sre|sap|gds|aerospace/i) ||
        !compDriveNum || new RegExp(compDriveNum.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(`${e.subject || ''} ${e.body_snippet || ''}`);
      return (
        (isPersonalNeoPat && driveMatches && e.classification === 'registration_confirmation') ||
        /confirmed:\s*your\s+registration/i.test(subj) ||
        /registration\s+(confirmed|successful|received)/i.test(full) ||
        /successfully\s+registered|thank\s+you\s+for\s+(registering|applying)/i.test(full)
      );
    });

    const latestRegistrationTime = registrationEmails.reduce((max, e) => {
      const t = e.received_at ? new Date(e.received_at).getTime() : 0;
      return Math.max(max, t);
    }, 0);

    const hasRegistrationConfirmation = registrationEmails.length > 0;
    const hasReRegisteredAfterWithdrawal = hasRegistrationConfirmation && latestRegistrationTime > latestWithdrawalTime;
    const isWithdrawn = withdrawalEmails.length > 0 && !hasReRegisteredAfterWithdrawal;
    const hasConfirmedRegistration = hasRegistrationConfirmation && !isWithdrawn;

    const isAfterRegistration = (e: { received_at: string | null }) => {
      if (!latestRegistrationTime) return true;
      const t = e.received_at ? new Date(e.received_at).getTime() : 0;
      return t >= (latestRegistrationTime - 2 * 60 * 1000);
    };

    const selectionListPattern = /selection\s+list|congratulations.*offer|selected\s+candidates|final\s+select/i;
    const selectionEmails = activeDriveEmails.filter((e) =>
      isAfterRegistration(e) && selectionListPattern.test(e.subject || '')
    );

    const nextRoundPattern =
      /interview\s+(?:is\s+)?scheduled|technical\s+interview|hr\s+interview|final\s+interview|interview\s+shortlist|shortlist\s+for\s+interview|shortlisted\s+for\s+(?:the\s+)?interview|next\s+round\s+of\s+(?:the\s+)?(?:selection\s+process|selection|process|hiring)|selection\s+process\s+is\s+scheduled|physical\s+selection/i;
    const nextRoundEmails = activeDriveEmails.filter((e) => {
      if (!isAfterRegistration(e)) return false;
      const subj = e.subject || '';
      const body = e.body_snippet || '';
      const full = `${subj} ${body}`;

      // If subject explicitly announces an online test/assessment (e.g. "WorkIndia online test and selection process is scheduled"),
      // and does NOT explicitly say "interview", it is a test round email â€” NOT a next round / interview email!
      if (/(?:online\s+)?test|assessment|coding\s+test|\bexam\b/i.test(subj) && !/interview/i.test(subj)) {
        return false;
      }

      if (nextRoundPattern.test(subj)) return true;
      if (/next\s+round/i.test(subj)) {
        if (/(?:online\s+)?test|assessment\s*\d|coding\s+test|\bshl\b|\bmettl\b|\bhackerrank\b/i.test(subj)) {
          return false;
        }
        if (/interview|in[\s-]*person|f2f|resumes?|formal\s+dress|blacklisted/i.test(full)) {
          return true;
        }
        return !/online\s+test|coding\s+test|\bshl\b|\bmettl\b|\bhackerrank\b/i.test(body);
      }
      return false;
    });

    const isInterviewOrSelectionEmail = (e: { subject?: string | null; body_snippet?: string | null }) => {
      const s = e.subject || '';
      if (/(?:online\s+)?test|assessment|coding\s+test|\bexam\b/i.test(s) && !/interview/i.test(s)) {
        return false;
      }
      return nextRoundPattern.test(s) || selectionListPattern.test(s);
    };

    const isPptEmail = (e: { subject?: string | null }) => {
      const s = (e.subject || '').toLowerCase();
      return /ppt|pre[\s-]*placement/i.test(s) && !/test|exam|assessment|coding|mettl|hackerrank/i.test(s);
    };

    const testShortlistPattern =
      /test\s+shortlist|shortlist\s+for\s+(?:the\s+)?(?:test|assessment|exam)|shortlisted\s+for\s+(?:the\s+)?(?:online\s+)?(?:test|assessment)|candidate[s]?\s+shortlisted|shortlisted\s+(?:candidates|students)|shortlist\s+will\s+be\s+shared|only\s+shortlisted\s+students|attached\s+(?:updated\s+)?(?:shortlist|shortlisted)|attached\s+.*shortlist|attached\s+(?:students?|candidates?)\s+list|\bneo\s+id\b/i;
    const testShortlistEmails = activeDriveEmails.filter((e) => {
      if (!isAfterRegistration(e)) return false;
      if (isInterviewOrSelectionEmail(e)) return false;
      if (isPptEmail(e)) return false;
      if (isRegistrationCircular(e) || e.classification === 'registration') return false;
      if (e.classification === 'shortlist') return true;
      const full = `${e.subject || ''} ${e.body_snippet || ''}`;
      // Exclude applied / opt-in rosters that do not explicitly announce a shortlist
      if (
        /attached\s+(?:final\s+|updated\s+)?(?:applied|opt[\s-]*in|registered)\s+(?:students?|candidates?)\s+list|opt[\s-]*in\s+list/i.test(full) &&
        !/shortlist|shortlisted/i.test(e.subject || '')
      ) {
        return false;
      }
      // Exclude emails that merely state a shortlist "will be shared" or "will be confirmed" in the future
      if (
        /shortlist(?:ed)?\s+.*will\s+be\s+(?:shared|confirmed|announced|sent)|will\s+be\s+confirmed\s+shortly/i.test(full) &&
        !/attached\s+(?:shortlist|shortlisted)/i.test(full) &&
        !/shortlist|shortlisted/i.test(e.subject || '')
      ) {
        return false;
      }
      return testShortlistPattern.test(full);
    });

    const isTestEmail = (e: { subject: string | null; body_snippet: string | null; classification?: string | null; received_at?: string | null }) => {
      if (!isAfterRegistration(e as { received_at: string | null })) return false;
      if (isPptEmail(e)) return false;

      const s = (e.subject || '').toLowerCase();
      const b = (e.body_snippet || '').toLowerCase();
      const full = `${s} ${b}`;

      // 1. Explicit scheduling phrase in subject or direct test links
      const isExplicitSubjectSchedule =
        /(?:online\s+)?(?:test|assessment|exam)\s+(?:is\s+)?(?:scheduled|rescheduled)|(?:online\s+)?(?:test|assessment|exam)\s+schedule/i.test(s) ||
        /test\s+link|assessment\s+link|exam\s+link/i.test(s);

      if (isExplicitSubjectSchedule) {
        return true;
      }

      // 2. Registration circulars, opt-in Google Forms, or mandatory registration emails
      if (
        isRegistrationCircular(e) ||
        e.classification === 'registration' ||
        /super\s*dream.*registration|dream.*registration|placement\s+registration|internship\s+registration/i.test(s) ||
        /forms\.gle|google\s+form|registration\s+link|register\s+(?:in|on)\s+the\s+(?:below\s+)?link|mandatory\s+.*registration/i.test(full)
      ) {
        // Only accept if body explicitly states "test is scheduled on <date>"
        if (!/(?:online\s+)?(?:test|assessment|exam)\s+(?:is\s+)?scheduled\s+(?:on|for)|\bon\s+\d{1,2}[-/.]\d{1,2}/i.test(b)) {
          return false;
        }
      }

      // 3. Merely describing duration (e.g. "Online Test: 45-60 minutes") in interview process without scheduling a date
      if (
        /(?:interview|selection|evaluation|recruitment)\s+process/i.test(full) &&
        /online\s+test\s*[:\-â€“â€”]?\s*\d+\s*(?:mins?|minutes?)/i.test(full) &&
        !/(?:test|assessment)\s+(?:is\s+)?scheduled\s+(?:on|for)|\bon\s+\d{1,2}[-/.]\d{1,2}/i.test(full)
      ) {
        return false;
      }

      // 4. If email explicitly states date will be informed later and has no test date
      if (
        /date\s+of\s+visit\s*[:\-â€“â€”]?\s*will\s+be\s+informed|will\s+be\s+informed\s+later/i.test(full) &&
        !/(?:test|assessment)\s+(?:is\s+)?scheduled\s+(?:on|for)|\bon\s+\d{1,2}[-/.]\d{1,2}/i.test(full)
      ) {
        return false;
      }

      // 5. Positive body test schedule triggers
      const hasBodySchedule =
        /(?:online\s+)?(?:test|assessment|exam)\s+(?:is\s+)?scheduled\s+(?:on|for)/i.test(b) ||
        /(?:online\s+)?(?:test|assessment|exam)\s+on\s+\d{1,2}[-/.]\d{1,2}/i.test(b) ||
        /test\s+will\s+be\s+conducted\s+on\s+\d{1,2}/i.test(b) ||
        /test\s+link\s*[:\-â€“â€”]|assessment\s+link\s*[:\-â€“â€”]|login\s+window|test\s+window\s*[:\-â€“â€”]|test\s+credentials/i.test(b) ||
        /(?:codility|hackerrank|mettl)\s+(?:test|assessment|link)/i.test(full);

      return hasBodySchedule;
    };

    const testEmails = activeDriveEmails.filter(isTestEmail);

    const hasDirectPersonalTestInvitation = activeDriveEmails.some((e) => {
      if (!isAfterRegistration(e)) return false;
      const senderLower = (e.sender || '').toLowerCase();
      const isPersonalSender =
        senderLower.includes('noreply.cdcinfo@vitstudent.ac.in') ||
        senderLower.includes('vit - soft skill assessments');
      if (!isPersonalSender) return false;
      const full = `${e.subject || ''} ${e.body_snippet || ''}`.toLowerCase();
      const hasTestKeywords = /test\s*link|assessment\s*link|login\s*window|exam\s*link|password|passkey/i.test(full);
      return hasTestKeywords || e.classification === 'test';
    });

    const matchedShortlistEmailIds = new Set(
      (candidateMatches || [])
        .filter((m) => {
          if (m.match_type === 'xlsx_applied_list') {
            return false;
          }
          const val = (m.matched_value || '').toLowerCase();
          if (/applied[_\s-]*list|opt[_\s-]*in[_\s-]*list|opt_in|registration[_\s-]*list|applied[_\s-]*student|applied[_\s-]*candidate/i.test(val)) {
            return false;
          }
          return true;
        })
        .map((m) => (m as unknown as { email_id: string | null; college_email_id: string | null }).email_id || (m as unknown as { college_email_id: string }).college_email_id)
        .filter(Boolean)
    );

    const roundForMatchedEmail = (emailId: string, round: 'test' | 'interview' | 'selected') =>
      (candidateMatches || []).some((m) => {
        const match = m as unknown as { email_id: string | null; college_email_id: string | null; matched_round_type?: string | null; match_type?: string };
        return (match.email_id === emailId || match.college_email_id === emailId) &&
          match.matched_round_type === round &&
          match.match_type !== 'xlsx_applied_list';
      });

    const sortedSelectionEmails = [...selectionEmails].sort(
      (a, b) => (a.received_at ? new Date(a.received_at).getTime() : 0) - (b.received_at ? new Date(b.received_at).getTime() : 0)
    );
    const isMatchedInSelectionList = sortedSelectionEmails.some((e) => roundForMatchedEmail(e.id, 'selected'));

    const sortedNextRoundEmails = [...nextRoundEmails].sort(
      (a, b) => (a.received_at ? new Date(a.received_at).getTime() : 0) - (b.received_at ? new Date(b.received_at).getTime() : 0)
    );
    const isMatchedInNextRound = sortedNextRoundEmails.some((e) => roundForMatchedEmail(e.id, 'interview'));

    const hasCompanyCandidateMatch = activeDriveEmails.some((e) => matchedEmailIds.has(e.id));

    const sortedTestShortlists = [...testShortlistEmails].sort(
      (a, b) => (a.received_at ? new Date(a.received_at).getTime() : 0) - (b.received_at ? new Date(b.received_at).getTime() : 0)
    );

    let isMatchedInTest = false;
    if (sortedTestShortlists.length > 0) {
      const latestTestShortlistEmail = sortedTestShortlists[sortedTestShortlists.length - 1];
      isMatchedInTest = roundForMatchedEmail(latestTestShortlistEmail.id, 'test');
    }
    if (!isMatchedInTest) {
      isMatchedInTest =
        testShortlistEmails.some((e) => roundForMatchedEmail(e.id, 'test')) ||
        testEmails.some((e) => roundForMatchedEmail(e.id, 'test'));
    }
    // A personal test invitation email (e.g. Goldman Sachs direct link) only establishes shortlisting
    // when NO explicit test shortlist roster (Excel/attachment) exists for this drive.
    // If an explicit shortlist was published (e.g. Work India), only candidates actually in that shortlist were shortlisted.
    if (!isMatchedInTest && hasDirectPersonalTestInvitation && testShortlistEmails.length === 0) {
      isMatchedInTest = true;
    }


    const allExtractedEvents = activeDriveEmails.flatMap((e) =>
      extractEvents({
        gmailMessageId: e.id,
        threadId: null,
        sender: '',
        senderEmail: '',
        subject: e.subject || '',
        receivedAt: e.received_at ? new Date(e.received_at) : new Date(),
        bodySnippet: e.body_snippet || '',
        bodyPlain: e.body_snippet || '',
        bodyHtml: '',
        hasAttachments: false,
        attachments: [],
        labels: [],
      })
    );

    const hasPptEvent = activeDriveEmails.some((e) => {
      if (!isAfterRegistration(e)) return false;
      // Use the same isPptEmail() classifier used elsewhere in this function
      if (isPptEmail(e)) return true;
      // Also check body snippet for explicit "pre-placement talk" mention
      const body = (e.body_snippet || '').toLowerCase();
      return /pre[\s-]*placement(?:\s+talk)?/i.test(body);
    });

    let computedStatus = 'not_applied';

    const positiveMatchedEmails = activeDriveEmails.filter((e) => matchedShortlistEmailIds.has(e.id));
    const latestPositiveMatchEmailTime = positiveMatchedEmails.reduce((max, e) => {
      const t = e.received_at ? new Date(e.received_at).getTime() : 0;
      return Math.max(max, t);
    }, 0);

    const latestGsheetTime = gsheetEventsForCompany.reduce((max, g) => {
      const t = g.startTime ? new Date(g.startTime).getTime() : 0;
      return Math.max(max, t);
    }, 0);

    const latestPositiveMatchTime = Math.max(latestPositiveMatchEmailTime, latestGsheetTime);

    const genuinePositiveMatchAfterWithdrawal =
      isWithdrawn &&
      (isMatchedInSelectionList || isMatchedInNextRound || isMatchedInTest) &&
      (latestPositiveMatchTime > latestWithdrawalTime || hasDirectPersonalTestInvitation);

    // Track why the candidate got 'rejected' so getEffectiveStage can distinguish:
    // - 'rejected' + 'Eliminated in Test Round' note  â†’ rejected_test (wrote test, failed)
    // - 'rejected' + 'Interviewed Â· Not Selected' note â†’ rejected_interview (interviewed, not selected)
    // - 'not_shortlisted'                              â†’ not shortlisted for test (pre-test screening)
    let computedRejectionNote: string | null = null;

    if (isWithdrawn && !genuinePositiveMatchAfterWithdrawal) {
      computedStatus = 'withdrawn';
    } else if (isMatchedInSelectionList) {
      computedStatus = 'selected';
    } else if (isMatchedInNextRound) {
      const nextRoundMatchTime = Math.max(latestPositiveMatchEmailTime, latestGsheetTime);
      const subsequentSelectionEmails = selectionEmails.filter((e) => {
        const t = e.received_at ? new Date(e.received_at).getTime() : 0;
        return t > (nextRoundMatchTime + 30 * 60 * 1000);
      });
      const interviewEvents = allExtractedEvents.filter(
        (e) => ['technical_interview', 'hr_interview', 'final_interview'].includes(e.eventType) && e.startTime
      );
      const hasUpcomingInterviewEvent = interviewEvents.some((e) => Boolean(e.startTime && e.startTime.getTime() > Date.now()));
      const latestInterviewEventTime = interviewEvents.reduce(
        (max, e) => Math.max(max, e.startTime ? e.startTime.getTime() : 0),
        0
      );
      const interviewTime = latestInterviewEventTime || nextRoundMatchTime;

       if (!hasUpcomingInterviewEvent && subsequentSelectionEmails.length > 0) {
        computedStatus = 'rejected';
        // User was interviewed (matched in next-round / interview shortlist) but a
        // selection list came out afterwards without them â†’ Interviewed Â· Not Selected
        computedRejectionNote = 'Interviewed Â· Not Selected';
      } else if (!hasUpcomingInterviewEvent && interviewTime > 0 && (Date.now() - interviewTime) > 14 * 24 * 60 * 60 * 1000) {
        computedStatus = 'rejected';
        computedRejectionNote = 'Interviewed Â· Not Selected';
      } else if (!hasUpcomingInterviewEvent && interviewTime > 0 && interviewTime < Date.now()) {
        computedStatus = 'interview_completed';
      } else {
        computedStatus = 'interview_scheduled';
      }
    } else if (isMatchedInTest) {
      const testMatchTime = Math.max(latestPositiveMatchEmailTime, latestGsheetTime);
      const testEvents = allExtractedEvents.filter(
        (e) => ['online_test', 'coding_test'].includes(e.eventType) && e.startTime
      );
      const hasUpcomingTestEvent = testEvents.some((e) => Boolean(e.startTime && e.startTime.getTime() > Date.now()));
      const latestTestEventTime = testEvents.reduce(
        (max, e) => Math.max(max, e.startTime ? e.startTime.getTime() : 0),
        0
      );
      const testTime = latestTestEventTime || testMatchTime;

      const subsequentPostTestEmails = nextRoundEmails.filter((e) => {
        const t = e.received_at ? new Date(e.received_at).getTime() : 0;
        return t > (testMatchTime + 30 * 60 * 1000);
      });

       if (!hasUpcomingTestEvent && subsequentPostTestEmails.length > 0) {
        computedStatus = 'rejected';
        // User was shortlisted for the test (matched in test email) but a post-test
        // round email came without them â†’ Eliminated in Test Round
        computedRejectionNote = 'Eliminated in Test Round';
      } else if (!hasUpcomingTestEvent && selectionEmails.some((e) =>
        Boolean(e.received_at && new Date(e.received_at).getTime() > testMatchTime + 30 * 60 * 1000))) {
        computedStatus = 'not_shortlisted';
      } else if (!hasUpcomingTestEvent && testTime > 0 && testTime < Date.now()) {
        // A completed test is not a rejection. Only an explicit result or a
        // later shortlist/selection round can establish elimination.
        computedStatus = 'test_completed';
      } else {
        computedStatus = 'test_scheduled';
      }
    } else if (hasConfirmedRegistration) {
      if (selectionEmails.length > 0 || nextRoundEmails.length > 0 || testShortlistEmails.length > 0) {
        computedStatus = 'not_shortlisted';
      } else if (testEmails.length > 0) {
        // A test was scheduled. If we have no positive candidate match for any test or
        // shortlist email, the user was not shortlisted (the test announcement went to all
        // registered students but a separate shortlist determined who actually sits).
        // Only keep test_scheduled if there's a positive match somewhere (handled above).
        const hasAnyMatchInTestEmails = testEmails.some((e) => matchedEmailIds.has(e.id));
        if (hasAnyMatchInTestEmails) {
          computedStatus = 'test_scheduled';
        } else {
          // No match in test emails â†’ likely a general schedule announcement without
          // personal shortlist confirmation. Stay as not_shortlisted if a test existed.
          computedStatus = 'not_shortlisted';
        }
      } else if (hasPptEvent) {
        computedStatus = 'ppt_scheduled';
      } else {
        computedStatus = 'applied';
      }
    } else if (hasCompanyCandidateMatch) {
      if (selectionEmails.length > 0 || nextRoundEmails.length > 0 || testShortlistEmails.length > 0) {
        computedStatus = 'not_shortlisted';
      } else if (testEmails.length > 0) {
        const hasAnyMatchInTestEmails = testEmails.some((e) => matchedEmailIds.has(e.id));
        if (hasAnyMatchInTestEmails) {
          computedStatus = 'test_scheduled';
        } else {
          computedStatus = 'not_shortlisted';
        }
      } else if (hasPptEvent) {
        computedStatus = 'ppt_scheduled';
      } else {
        computedStatus = 'applied';
      }
    } else if (selectionEmails.length > 0 || nextRoundEmails.length > 0 || testShortlistEmails.length > 0 || testEmails.length > 0) {
      computedStatus = 'not_applied';
    } else {
      computedStatus = 'not_applied';
    }

    const existingApp = appsByDriveId.get(drive.id) || null;

    // GUARD: Reprocess only has access to email subjects + body snippets â€” it cannot
    // re-scan Excel attachments. The live sync (status-engine) CAN scan attachments and
    // correctly marks candidates as not_shortlisted when their ID is absent from a
    // shortlist Excel. Without this guard, reprocess would overwrite a sync-computed
    // not_shortlisted back to test_scheduled/applied every 15 min cron cycle.
    // Preserve not_shortlisted unless there is concrete positive evidence of shortlisting.
    if (
      !existingApp?.manual_override &&
      !options?.recalculateStatusesFromRemainingEvidence &&
      existingApp?.status === 'not_shortlisted' &&
      ['test_scheduled', 'ppt_scheduled', 'applied'].includes(computedStatus) &&
      !isMatchedInTest &&
      !isMatchedInNextRound &&
      !isMatchedInSelectionList
    ) {
      computedStatus = 'not_shortlisted';
    }

    const STATUS_PRIORITY: Record<string, number> = {
      unknown: 0,
      not_applied: 1,
      applied: 2,
      ppt_scheduled: 3,
      shortlisted: 4,
      test_scheduled: 5,
      test_completed: 6,
      interview_scheduled: 7,
      interview_completed: 8,
      selected: 9,
      offer_received: 10,
      not_shortlisted: 11,
      rejected: 12,
      withdrawn: 13,
      declined: 13,
    };
    const existingPriority = STATUS_PRIORITY[existingApp?.status || 'unknown'] ?? 0;
    const computedPriority = STATUS_PRIORITY[computedStatus] ?? 0;
    const hasPriorCandidateEvidence = matchedShortlistEmailIds.size > 0;
    const hasShortlistMatch = isMatchedInTest || isMatchedInNextRound || isMatchedInSelectionList;
    const isPhantomRejection =
      !existingApp?.manual_override &&
      existingApp?.status === 'rejected' &&
      computedStatus === 'not_shortlisted';

    const isEvidenceBackedTerminal =
      ['rejected', 'selected', 'offer_received'].includes(computedStatus) &&
      hasPriorCandidateEvidence;
    const monotonicStatus =
      existingApp?.manual_override ||
      (!options?.recalculateStatusesFromRemainingEvidence && !isPhantomRejection && existingApp?.status && computedPriority < existingPriority && !isEvidenceBackedTerminal)
        ? existingApp.status
        : computedStatus;

    const finalStatus = monotonicStatus;

    let finalRole = existingApp?.manual_override ? existingApp.role : extractedJob.role;
    finalRole = cleanRoleTitle(finalRole);

    // Travel/venue instructions evolve over the drive lifecycle. Prefer the newest
    // active email that explicitly states a venue/mode, rather than freezing the
    // value from the original registration circular.
    const newestFirstTravelTexts = [...activeDriveEmails]
      .sort((a, b) => new Date(b.received_at || 0).getTime() - new Date(a.received_at || 0).getTime())
      .map((email) => `${email.subject || ''}\n${email.body_snippet || ''}`);
    const travelReq = extractLatestTravelRequirement(newestFirstTravelTexts) ||
      (mainEmailText ? extractTravelRequirement(mainEmailText) : null) ||
      extractTravelRequirement(combinedEmailText);
    const existingTravel = existingApp?.notes ? existingApp.notes.split('\n')[0]?.trim() : null;
    const hasCampusLabEvent = allExtractedEvents.some((e) => /campus\s*\/\s*offline|\blc\s*\d+\b|\blab\b/i.test(e.venue || ''));
    const hasOnlineEvent = allExtractedEvents.some((e) => e.mode === 'online' || /online|virtual/i.test(e.venue || ''));

    const shouldRefreshTravelMode = Boolean(
      options?.recalculateStatusesFromRemainingEvidence && travelReq
    );
    let finalTravel = existingApp?.manual_override && !shouldRefreshTravelMode
      ? (existingApp?.notes || null)
      : travelReq;
    if (!finalTravel) {
      if (hasCampusLabEvent) finalTravel = 'bhopal';
      else if (hasOnlineEvent) finalTravel = 'online';
      else if (existingTravel && ['bhopal', 'bhopal_lab', 'online', 'vellore', 'chennai', 'ap', 'respective_campus'].includes(existingTravel)) {
        finalTravel = existingTravel;
      }
    }

    // Build the final notes value:
    // - For manual override: preserve existing notes verbatim.
    // - For computed rejection states: the rejection context note is the authoritative first line;
    //   travel mode (if known) is appended as a second line so it isn't lost.
    // - Otherwise: travel note is used as-is.
    let finalNotes: string | null;
    if (existingApp?.manual_override) {
      const previousNotes = existingApp?.notes || '';
      if (shouldRefreshTravelMode && travelReq) {
        finalNotes = refreshTravelModeNote(previousNotes, travelReq);
      } else {
        finalNotes = existingApp?.notes || null;
      }
    } else if (computedRejectionNote) {
      // Rejection context is the primary note; optionally append travel mode
      finalNotes = finalTravel
        ? `${computedRejectionNote}\n${finalTravel}`
        : computedRejectionNote;
    } else {
      finalNotes = finalTravel || null;
    }

    let workLocation = extractedJob.location || null;
    if (
      workLocation &&
      (/\byou\b|\bwe\b|\bi\b|\bcan\b|\bwrite\b|\bwant\b|\btest\b|\blab\b|\blc\s*\d+|\bsjt|\bprp|\banna|\bhall\b|---|forwarded|own\s+location|\b(?:lc|sjt|prp|tt|mb|cb|smv)\s*\d+\b|please find|attached shortlisted|services interested|as per business|nonsense|come at|economy class|round trip|placement office|\bpre$/i.test(
        workLocation
      ) ||
        /^(?:vit\s+(?:vellore|chennai|bhopal|ap)(?:\s+campus)?|(?:vellore|chennai|bhopal|ap)\s+campus)$/i.test(workLocation.trim()))
    ) {
      workLocation = null;
    }
    if (workLocation) {
      if (/remote/i.test(workLocation)) workLocation = 'Remote';
      else if (/pan\s+india/i.test(workLocation)) workLocation = 'Pan India';
    }

    let finalCategory = extractedJob.category || null;
    const finalCtc = existingApp?.manual_override ? existingApp.ctc : (extractedJob.ctc || null);
    const finalStipend = existingApp?.manual_override ? existingApp.stipend : (extractedJob.stipend || null);
    if (finalCtc) {
      const matches = [...finalCtc.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));
      if (matches.length > 0) {
        const maxCtc = Math.max(...matches);
        const isIntern = Boolean(finalStipend) || /internship|intern\b/i.test(mainEmailText);
        if (maxCtc >= 10) {
          finalCategory = isIntern ? 'Super Dream Internship' : 'Super Dream Offer';
        } else if (maxCtc >= 4.5) {
          finalCategory = isIntern ? 'Dream Internship' : 'Dream Offer';
        } else {
          finalCategory = 'Regular Offer';
        }
      }
    }

    const regDeadlineEvt = allExtractedEvents.find((e) => e.eventType === 'registration_deadline' && e.startTime);
    const finalRegDeadline = regDeadlineEvt?.startTime ? regDeadlineEvt.startTime.toISOString() : (existingApp?.registration_deadline || null);

    const appPayload = {
      user_id: userId,
      placement_drive_id: drive.id,
      status: finalStatus,
      status_source: existingApp?.manual_override ? 'manual_override' : 'sync_reprocess',
      status_confidence: 'high',
      manual_override: Boolean(existingApp?.manual_override),
      role: finalRole,
      category: finalCategory,
      ctc: finalCtc,
      stipend: finalStipend,
      location: workLocation || null,
      registration_deadline: finalRegDeadline,
      eligibility: extractedJob.eligibility || existingApp?.eligibility || null,
      branches: (extractedJob.branches && extractedJob.branches.length > 0) ? extractedJob.branches : (existingApp?.branches || null),
      cgpa_requirement: extractedJob.cgpaRequirement || existingApp?.cgpa_requirement || null,
      backlog_requirement: extractedJob.backlogRequirement || existingApp?.backlog_requirement || null,
      notes: finalNotes,
      applied_at: (registrationEmails[0]?.received_at ? new Date(registrationEmails[0].received_at) : (driveStartDate || (existingApp?.applied_at ? new Date(existingApp.applied_at) : new Date()))).toISOString(),
      last_updated: new Date().toISOString(),
    };

    // Enrich placement_drives with the latest extracted job metadata from all linked circulars
    // (regardless of whether this specific user applied to this drive or not)
    await supabase.from('placement_drives').update({
      role: finalRole || drive.role || null,
      category: finalCategory || drive.category || null,
      ctc: finalCtc || drive.ctc || null,
      stipend: finalStipend || drive.stipend || null,
      location: workLocation || drive.location || null,
      registration_deadline: finalRegDeadline || drive.registration_deadline || null,
      eligibility: extractedJob.eligibility || drive.eligibility || null,
      branches: (extractedJob.branches && extractedJob.branches.length > 0) ? extractedJob.branches : (drive.branches || null),
      cgpa_requirement: extractedJob.cgpaRequirement || drive.cgpa_requirement || null,
      backlog_requirement: extractedJob.backlogRequirement || drive.backlog_requirement || null,
      updated_at: new Date().toISOString(),
    }).eq('id', drive.id);

    const hasUserPersonalEmails = driveEmails.some((de) => userPersonalEmailIdSet.has(de.id));
    const userCandidateMatches = candidateMatchesByDriveId.get(drive.id) || [];
    const hasCandidateMatch = userCandidateMatches.length > 0;

    // RULE: A user ONLY has an application for a placement drive if:
    // 1. The user received personal NeoPAT emails for it (eligibility, registration, test link, etc.), OR
    // 2. The user has confirmed registration / applied, OR
    // 3. The user was matched in an official candidate shortlist, OR
    // 4. The user manually added / overrode the application.
    // If NONE of these apply, the drive was for other students/campuses/branches.
    // NEVER create a phantom application for this user, and PURGE any existing unapplied record!
    if (
      !hasUserPersonalEmails &&
      !hasConfirmedRegistration &&
      !hasCandidateMatch &&
      !existingApp?.manual_override
    ) {
      if (existingApp?.id) {
        await supabase.from('applications').delete().eq('id', existingApp.id);
        await supabase.from('events').delete().eq('user_id', userId).eq('placement_drive_id', drive.id);
      }
      return;
    }

    if (existingApp?.id) {
      await supabase.from('applications').update(appPayload).eq('id', existingApp.id);
    } else {
      await supabase.from('applications').insert(appPayload);
    }

    const manualEvents = manualEventsByDriveId.get(drive.id) || [];

    await supabase
      .from('events')
      .delete()
      .eq('user_id', userId)
      .eq('placement_drive_id', drive.id)
      .eq('manual_override', false);

    const isOptedOut = ['declined', 'withdrawn'].includes(finalStatus);

    if (!isOptedOut) {
      const sortedEmails = [...activeDriveEmails].sort((a, b) => {
        const tA = a.received_at ? new Date(a.received_at).getTime() : 0;
        const tB = b.received_at ? new Date(b.received_at).getTime() : 0;
        return tA - tB;
      });

      const latestEventsByType = new Map<string, any>();
      for (const e of sortedEmails) {
        const evts = extractEvents({
          gmailMessageId: e.id,
          threadId: null,
          sender: '',
          senderEmail: '',
          subject: e.subject || '',
          receivedAt: e.received_at ? new Date(e.received_at) : new Date(),
          bodySnippet: e.body_snippet || '',
          bodyPlain: e.body_snippet || '',
          bodyHtml: '',
          hasAttachments: false,
          attachments: [],
          labels: [],
        });

        for (const evt of evts) {
          if (!evt.startTime) continue;
          const normalizedKey =
            evt.eventType === 'coding_test' || evt.eventType === 'online_test'
              ? 'online_test'
              : evt.eventType;
          const existing = latestEventsByType.get(normalizedKey);

          if (existing && existing.hasExplicitTime && !evt.hasExplicitTime) {
            latestEventsByType.set(normalizedKey, {
              ...existing,
              venue: evt.venue && evt.venue !== 'Campus / Offline' ? evt.venue : existing.venue,
              mode: evt.mode !== 'unknown' ? evt.mode : existing.mode,
            });
          } else {
            latestEventsByType.set(normalizedKey, evt);
          }
        }
      }

      for (const gEvt of gsheetEventsForCompany) {
        latestEventsByType.set('online_test', {
          eventType: gEvt.eventType,
          title: gEvt.title,
          startTime: gEvt.startTime,
          endTime: null,
          venue: gEvt.venue,
          mode: gEvt.mode,
          confidence: gEvt.confidence,
          hasExplicitTime: gEvt.hasExplicitTime,
        });
      }

      const manualEventTypes = new Set(
        (manualEvents || []).map((m) =>
          m.event_type === 'coding_test' ? 'online_test' : m.event_type
        )
      );

      const eventsToInsert: any[] = [];
      for (const evt of Array.from(latestEventsByType.values())) {
        const normalizedKey =
          evt.eventType === 'coding_test' || evt.eventType === 'online_test'
            ? 'online_test'
            : evt.eventType;

        if (manualEventTypes.has(normalizedKey)) {
          continue;
        }

        // Candidates not shortlisted or not applied must NEVER receive test or interview events
        if (
          ['not_shortlisted', 'not_applied'].includes(finalStatus) &&
          normalizedKey !== 'ppt' &&
          normalizedKey !== 'registration_deadline'
        ) {
          continue;
        }
        if (finalStatus === 'rejected') {
          if (!isMatchedInNextRound && ['interview', 'technical_interview', 'hr_interview', 'final_interview'].includes(normalizedKey)) {
            continue;
          }
          if (!isMatchedInTest && !isMatchedInNextRound && normalizedKey === 'online_test') {
            continue;
          }
        }

        eventsToInsert.push({
          user_id: userId,
          placement_drive_id: drive.id,
          event_type: evt.eventType,
          title: `${comp.name} - ${evt.title}`,
          start_time: evt.startTime.toISOString(),
          end_time: evt.endTime ? evt.endTime.toISOString() : null,
          venue: evt.venue,
          mode: evt.mode,
          confidence: evt.confidence,
          manual_override: false,
        });
      }

      if (eventsToInsert.length > 0) {
        await supabase.from('events').insert(eventsToInsert);
      }
    }

    updatedAppsCount++;
    applicationResults.push({
      company: comp.name,
      status: finalStatus,
      role: finalRole,
      ctc: extractedJob.ctc,
    });
      })
    );
  }

  console.log(`[recalculateApplicationStatuses] User ${userId}: holistic calculation updated ${updatedAppsCount} applications.`);
  return { updatedCount: updatedAppsCount, results: applicationResults };
}

export async function performReprocess(
  userId: string,
  onProgress?: (p: { step: number; totalSteps: number; message: string }) => void
) {
  const reprocessStartTime = Date.now();
  const supabase = createAdminClient();

  onProgress?.({
    step: 1,
    totalSteps: 5,
    message: 'Cleaning recipient matches & fetching stored circularsâ€¦',
  });

  // Fetch user details
  const { data: userData } = await supabase
    .from('users')
    .select('neo_id, email, name')
    .eq('id', userId)
    .single();

  const userNeoId = userData?.neo_id || null;
  const userEmail = userData?.email || '';

  // 1. Clean dirty candidate matches (false positives on recipient email headers)
  if (userEmail) {
    const regMatch = userEmail.match(/([0-9]{2}[a-z]{3}[0-9]{4,5})/i);
    const regNo = regMatch ? regMatch[1].toUpperCase() : '';

    const { data: allMatches } = await supabase
      .from('candidate_matches')
      .select('id, match_type, matched_value')
      .eq('user_id', userId);

    const matchesToDelete = (allMatches || []).filter((m) => {
      if (m.match_type === 'xlsx_applied_list') return true;
      if (/applied[_\s-]*list|opt[_\s-]*in[_\s-]*list|opt_in|registration[_\s-]*list|applied[_\s-]*student|applied[_\s-]*candidate/i.test(m.matched_value || '')) {
        return true;
      }
      if (m.match_type === 'xlsx_cell' || m.match_type === 'email_body' || m.match_type === 'gsheet_cell') return false; // Keep verified shortlist matches
      const val = (m.matched_value || '').toUpperCase();
      if (regNo && val.includes(regNo) && !val.includes(userNeoId || '___NO_NEO___')) {
        return true;
      }
      return false;
    });

    if (matchesToDelete.length > 0) {
      await supabase
        .from('candidate_matches')
        .delete()
        .in('id', matchesToDelete.map((m) => m.id));
    }
  }

  // 2. Fetch ALL stored emails for this user with automatic pagination.
  // Full content lives in college_emails after body_snippet was capped at 500 chars.
  const { data: canonicalBodies } = await supabase
    .from('college_emails')
    .select('message_id, body_text, body_snippet')
    .not('message_id', 'is', null)
    .or('body_text.not.is.null,body_snippet.not.is.null');
  const bodyByMessageId = new Map<string, string>();
  for (const canonical of canonicalBodies || []) {
    const key = canonical.message_id?.toLowerCase().trim();
    const text = canonical.body_text || canonical.body_snippet;
    if (key && text && !bodyByMessageId.has(key)) bodyByMessageId.set(key, text);
  }

  const emails: Array<{
    id: string;
    subject: string | null;
    sender: string | null;
    body_snippet: string | null;
    classification: string | null;
    placement_drive_id: string | null;
    received_at: string | null;
    assignment_state?: string | null;
    assignment_source?: string | null;
    rfc_message_id?: string | null;
    canonical_email_id?: string | null;
    college_email_id?: string | null;
    is_relevant?: boolean | null;
    gmail_account_id?: string | null;
    gmail_message_id?: string | null;
  }> = [];

  const pageSize = 1000;
  let page = 0;
  while (true) {
    const { data: chunk, error: chunkErr } = await supabase
      .from('personal_emails')
      .select('id, subject, sender, body_snippet, gmail_account_id, gmail_message_id, canonical_email_id, college_email_id, is_relevant, college_emails!personal_emails_college_email_id_fkey(body_text, body_snippet), rfc_message_id, classification, placement_drive_id, received_at, assignment_state, assignment_source')
      .eq('user_id', userId)
      .order('received_at', { ascending: true })
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (chunkErr) {
      console.error('[performReprocess] Error loading personal_emails:', chunkErr);
      break;
    }
    if (!chunk || chunk.length === 0) break;
    emails.push(...chunk.map((email: any) => {
      const canonical = Array.isArray(email.college_emails) ? email.college_emails[0] : email.college_emails;
      let fullBody = canonical?.body_text || canonical?.body_snippet ||
        (email.rfc_message_id ? bodyByMessageId.get(email.rfc_message_id.toLowerCase().trim()) : null) || null;
      const hasCanonicalBody = Boolean(fullBody && fullBody.length > 500);
      if (!fullBody) {
        fullBody = email.body_snippet || '';
      }
      return { ...email, body_snippet: fullBody, has_canonical_body: hasCanonicalBody };
    }));
    if (chunk.length < pageSize) break;
    page++;
  }

  const recoveredBodies = await recoverTruncatedEmailBodies(emails);
  for (const email of emails) {
    const recoveredBody = recoveredBodies.get(email.id);
    if (recoveredBody) email.body_snippet = recoveredBody;
  }

  // Also fetch college broadcast circulars from shared college_emails table
  const collegeEmails: Array<{
    id: string;
    subject: string | null;
    sender: string | null;
    body_snippet: string | null;
    classification: string | null;
    received_at: string | null;
    parsed_company_name?: string | null;
    parsed_drive_numbers?: string[] | null;
    has_canonical_body?: boolean;
    assignment_source?: string | null;
    canonical_email_id?: string | null;
    college_email_id?: string | null;
  }> = [];

  let clgPage = 0;
  while (true) {
    const { data: cChunk, error: cErr } = await supabase
      .from('college_emails')
      .select('id, subject, sender_email, received_at, created_at, body_snippet, body_text, classification, parsed_company_name, parsed_drive_numbers')
      .order('received_at', { ascending: true })
      .range(clgPage * pageSize, (clgPage + 1) * pageSize - 1);

    if (cErr) {
      console.error('[performReprocess] Error loading college_emails:', cErr);
      break;
    }
    if (!cChunk || cChunk.length === 0) break;

    collegeEmails.push(...cChunk.map((ce: any) => ({
      id: ce.id,
      subject: ce.subject,
      sender: ce.sender_email,
      received_at: ce.received_at || ce.created_at,
      body_snippet: ce.body_text || ce.body_snippet || '',
      classification: ce.classification,
      parsed_company_name: ce.parsed_company_name,
      parsed_drive_numbers: ce.parsed_drive_numbers || [],
      has_canonical_body: Boolean(ce.body_text && ce.body_text.length > 500),
      canonical_email_id: ce.id,
      college_email_id: ce.id,
    })));

    if (cChunk.length < pageSize) break;
    clgPage++;
  }

  if (emails.length === 0 && collegeEmails.length === 0) {
    return { success: true, message: 'No emails found to reprocess', fixed: 0 };
  }

  // Separate personal emails into NeoPAT emails (noreply.cdcinfo@vitstudent.ac.in)
  const isNeoPatSender = (sender: string) => /noreply\.cdcinfo@vitstudent\.ac\.in/i.test(sender);

  const processableEmails = emails.filter((email) => email.assignment_source !== 'admin_unlinked');
  const neoPatEmails = processableEmails.filter((e) => isNeoPatSender(e.sender || ''));
  // Process NeoPAT circulars chronologically so registration & eligibility emails establish drive identity
  neoPatEmails.sort((a, b) => new Date(a.received_at || 0).getTime() - new Date(b.received_at || 0).getTime());

  // 2.5 Dynamic Timing Correlation Setup
  const circularCatalog = buildCircularCatalog(collegeEmails);
  const persistedResolutions = await loadAllDriveResolutions(supabase);
  const driveResolutionsMap = new Map<string, string>();
  for (const [dNum, r] of persistedResolutions.entries()) {
    driveResolutionsMap.set(dNum, r.resolvedCompanyName);
  }

  // 3. Phase 1: Establish Official NeoPAT Companies ONLY
  // ONLY emails from noreply.cdcinfo@vitstudent.ac.in define the company drives in NeoTrack!
  onProgress?.({
    step: 2,
    totalSteps: 5,
    message: `Analyzing ${neoPatEmails.length} official NeoPAT drives & resolving track numbersâ€¦`,
  });

  // Pre-load all existing global companies and drives into memory to avoid thousands of slow DB roundtrips
  const { data: initialDbCompanies } = await supabase
    .from('companies')
    .select('id, name, aliases, updated_at');

  const { data: initialDbDrives } = await supabase
    .from('placement_drives')
    .select('id, company_id, drive_number, normalized_drive_number, drive_name, role, excluded_email_ids, created_at, source_email_id');

  const companiesById = new Map<string, any>();
  const companiesByName = new Map<string, any>();
  for (const c of (initialDbCompanies || [])) {
    companiesById.set(c.id, c);
    companiesByName.set(c.name.toLowerCase().trim(), c);
    for (const a of (c.aliases || [])) {
      companiesByName.set(a.toLowerCase().trim(), c);
    }
  }

  const driveById = new Map<string, any>();
  const driveByNumber = new Map<string, any>();
  const drivesByCompanyId = new Map<string, any[]>();
  const driveDateMap = new Map<string, Date>();

  for (const d of (initialDbDrives || [])) {
    driveById.set(d.id, d);
    if (d.drive_number) {
      driveByNumber.set(d.drive_number.toLowerCase().trim(), d);
    }
    const list = drivesByCompanyId.get(d.company_id) || [];
    list.push(d);
    drivesByCompanyId.set(d.company_id, list);
  }

  const validDriveIdSet = new Set<string>();
  const validCompanyIdSet = new Set<string>();
  const emailUpdates: Array<{ id: string; placement_drive_id: string | null; classification: string; is_relevant: boolean }> = [];

  const companiesToUpdate = new Map<string, { aliases?: string[]; name?: string }>();
  const drivesToUpdate = new Map<string, { drive_number?: string; normalized_drive_number?: string; drive_name?: string | null }>();
  const driveResolutionsToUpsert = new Map<string, any>();

  // Sanitize company names with legacy drive suffixes (e.g. "Euler Motors (1170)")
  for (const c of (initialDbCompanies || [])) {
    if (/\s*\(\d+\)\s*$/.test(c.name)) {
      const cleanName = c.name.replace(/\s*\(\d+\)\s*$/, '').trim();
      c.name = cleanName;
      companiesToUpdate.set(c.id, { ...(companiesToUpdate.get(c.id) || {}), name: cleanName });
      companiesByName.set(cleanName.toLowerCase(), c);
    }
  }

  for (let idx = 0; idx < neoPatEmails.length; idx++) {
    const email = neoPatEmails[idx];
    if (idx % 30 === 0 || idx === neoPatEmails.length - 1) {
      onProgress?.({
        step: 2,
        totalSteps: 5,
        message: `Analyzing official NeoPAT drives (${idx + 1}/${neoPatEmails.length})â€¦`,
      });
    }

    const subject = email.subject || '';
    const sender = email.sender || '';
    const bodySnippet = email.body_snippet || '';
    const emailDate = email.received_at ? new Date(email.received_at) : new Date();
    const fullEmailText = `${subject}\n${bodySnippet}`;
    const driveNumber = extractDriveNumber(fullEmailText);
    const driveNameMatch = fullEmailText.match(/(?:drive\s+name|name\s+of\s+the\s+drive)\s*[:\-*]*\s*([A-Za-z0-9&\s\-\.()]+?)(?:\s+(?:drive\s+number|new\s+drive\s+date|category|date\s+of\s+visit|eligibility|eligible|ctc|role|stipend|company|date|please|if\b|\n|\r|\*|$))/i);
    const driveName = driveNameMatch ? driveNameMatch[1].trim() : null;

    const classification = classifyEmail({
      gmailMessageId: email.id,
      threadId: null,
      sender,
      senderEmail: sender.match(/<([^>]+)>/)?.[1] || sender,
      subject,
      receivedAt: emailDate,
      bodySnippet,
      bodyPlain: bodySnippet,
      bodyHtml: '',
      hasAttachments: false,
      attachments: [],
      labels: [],
    }, driveResolutionsMap);

    let companyName = classification.companyName;
    const isPlacement = !['irrelevant', 'unclassified', 'general'].includes(classification.classification);

    if (driveNumber && companyName && isPlacement) {
      const baseClean = cleanCompanyName(companyName);
      if (['Apple', 'Honeywell', 'Zluri', 'EY'].some((b) => b.toLowerCase() === baseClean.toLowerCase())) {
        const resolution = await resolveDriveByTimingCorrelation(
          supabase,
          driveNumber,
          baseClean,
          emailDate,
          circularCatalog,
          persistedResolutions
        );
        if (resolution) {
          companyName = resolution.resolvedCompanyName;
          driveResolutionsMap.set(driveNumber, resolution.resolvedCompanyName);
        }
      }
    }

    if (companyName && isPlacement) {
      const normalized = normalizeCompanyName(companyName);
      if (!normalized || isInvalidCompanyName(normalized)) {
        continue;
      }

      // 1. Resolve Company
      let comp = driveNumber && driveByNumber.has(driveNumber.toLowerCase().trim())
        ? companiesById.get(driveByNumber.get(driveNumber.toLowerCase().trim()).company_id)
        : null;

      if (!comp) {
        comp = companiesByName.get(normalized.toLowerCase());
      }
      if (!comp) {
        for (const [key, c] of companiesByName.entries()) {
          if (isFuzzyCompanyMatch(key, normalized) || isFuzzyCompanyMatch(c.name, normalized)) {
            comp = c;
            break;
          }
        }
      }
      if (!comp) {
        // Create company
        const generatedAliases = extractCompanyAliases(companyName, normalized, driveName);
        if (driveNumber && !generatedAliases.includes(driveNumber.toLowerCase())) {
          generatedAliases.push(driveNumber.toLowerCase());
        }

        let { data: newComp, error: insertError } = await supabase
          .from('companies')
          .insert({
            name: normalized,
            aliases: generatedAliases,
          })
          .select('id, name, aliases')
          .single();

        if (insertError && insertError.code === '23505') {
          const { data: existingByName } = await supabase
            .from('companies')
            .select('id, name, aliases')
            .eq('name', normalized)
            .maybeSingle();
          if (existingByName) newComp = existingByName;
        }

        if (newComp) {
          comp = newComp;
          companiesById.set(newComp.id, newComp);
          companiesByName.set(newComp.name.toLowerCase(), newComp);
          for (const a of (newComp.aliases || [])) {
            companiesByName.set(a.toLowerCase(), newComp);
          }
        }
      }

      if (!comp) continue;

      // 2. Resolve Placement Drive
      let targetDrive: any = null;
      if (driveNumber) {
        const dNumLower = driveNumber.toLowerCase().trim();
        targetDrive = driveByNumber.get(dNumLower);

        if (!targetDrive) {
          // Check initialDbDrives
          const existingDrive = (initialDbDrives || []).find((d: any) => d.drive_number?.toLowerCase() === dNumLower);
          if (existingDrive) {
            targetDrive = existingDrive;
          } else {
            // Check if there is an unassigned dummy drive for this company
            const nullDrive = (initialDbDrives || []).find((d: any) => d.company_id === comp.id && !d.drive_number);
            if (nullDrive) {
              targetDrive = nullDrive;
              targetDrive.drive_number = driveNumber;
              targetDrive.normalized_drive_number = dNumLower;
              targetDrive.drive_name = driveName || comp.name;
              drivesToUpdate.set(targetDrive.id, {
                drive_number: driveNumber,
                normalized_drive_number: dNumLower,
                drive_name: targetDrive.drive_name,
              });
            } else {
              // Create brand new placement drive globally!
              const { data: createdDrive } = await supabase
                .from('placement_drives')
                .insert({
                  company_id: comp.id,
                  drive_number: driveNumber,
                  normalized_drive_number: dNumLower,
                  drive_name: driveName || comp.name,
                  created_at: emailDate.toISOString(),
                })
                .select('id, company_id, drive_number, normalized_drive_number, drive_name, role, excluded_email_ids, created_at, source_email_id')
                .single();
              if (createdDrive) {
                targetDrive = createdDrive;
                initialDbDrives?.push(createdDrive);
              }
            }
          }

          if (targetDrive) {
            driveByNumber.set(dNumLower, targetDrive);
            driveById.set(targetDrive.id, targetDrive);
            const compDrives = drivesByCompanyId.get(comp.id) || [];
            if (!compDrives.some((d: any) => d.id === targetDrive.id)) compDrives.push(targetDrive);
            drivesByCompanyId.set(comp.id, compDrives);
          }
        }

        if (targetDrive) {
          const prevStart = driveDateMap.get(targetDrive.id);
          if (!prevStart || emailDate.getTime() < prevStart.getTime()) {
            driveDateMap.set(targetDrive.id, emailDate);
          }
          driveResolutionsToUpsert.set(driveNumber, {
            drive_number: driveNumber,
            company_base_name: cleanCompanyName(companyName),
            resolved_role: comp.name,
            resolved_company_name: comp.name,
            resolved_via: 'direct_role_text',
            confidence: 'high',
            updated_at: new Date().toISOString(),
          });
        }
      } else {
        // NeoPAT email without drive number (e.g. withdrawal confirmation)
        const compDrives = drivesByCompanyId.get(comp.id) || [];
        const validPastDrives = compDrives.filter((d: any) => {
          const dStart = driveDateMap.get(d.id);
          return !dStart || dStart.getTime() <= emailDate.getTime() + 6 * 3600 * 1000;
        });
        validPastDrives.sort((a: any, b: any) => {
          const aTime = driveDateMap.get(a.id)?.getTime() || 0;
          const bTime = driveDateMap.get(b.id)?.getTime() || 0;
          return bTime - aTime;
        });
        targetDrive = validPastDrives[0] || compDrives[0];
      }

      if (targetDrive) {
        validDriveIdSet.add(targetDrive.id);
        validCompanyIdSet.add(comp.id);
        emailUpdates.push({
          id: email.id,
          placement_drive_id: targetDrive.id,
          classification: classification.classification,
          is_relevant: true,
        });
      }
    } else {
      emailUpdates.push({
        id: email.id,
        placement_drive_id: null,
        classification: classification.classification,
        is_relevant: false,
      });
    }
  }

  // Preserve manually-linked, cross-user confirmed, or non-NeoPAT drives that have no source_email_id
  // These are legitimate drives created without a NeoPAT registration email (e.g. KPMG, Rystad Energy)
  for (const d of (initialDbDrives || [])) {
    if (!validDriveIdSet.has(d.id) && !d.source_email_id) {
      validDriveIdSet.add(d.id);
      if (d.company_id) {
        validCompanyIdSet.add(d.company_id);
      }
    }
  }

  // Flush queued company updates in small parallel batches
  if (companiesToUpdate.size > 0) {
    const updateEntries = Array.from(companiesToUpdate.entries());
    for (let i = 0; i < updateEntries.length; i += 20) {
      const batch = updateEntries.slice(i, i + 20);
      await Promise.all(
        batch.map(([id, payload]) => supabase.from('companies').update(payload).eq('id', id))
      );
    }
  }

  // Flush queued drive updates in small parallel batches
  if (drivesToUpdate.size > 0) {
    const updateEntries = Array.from(drivesToUpdate.entries());
    for (let i = 0; i < updateEntries.length; i += 20) {
      const batch = updateEntries.slice(i, i + 20);
      await Promise.all(
        batch.map(([driveId, payload]) => supabase.from('placement_drives').update(payload).eq('id', driveId))
      );
    }
  }

  // Flush queued drive_resolutions in a single batch
  if (driveResolutionsToUpsert.size > 0) {
    await supabase
      .from('drive_resolutions')
      .upsert(Array.from(driveResolutionsToUpsert.values()), { onConflict: 'drive_number' });
  }

  // 4. Phase 2: Purge ANY Drive & Company in DB that is NOT in the Official NeoPAT List
  onProgress?.({
    step: 3,
    totalSteps: 5,
    message: `Verified ${validDriveIdSet.size} official NeoPAT drives across ${validCompanyIdSet.size} companies. Purging unverified entriesâ€¦`,
  });

  const { data: userApps } = await supabase
    .from('applications')
    .select('id, placement_drive_id, manual_override')
    .eq('user_id', userId);

  // Drives that are legitimately tracked for THIS user:
  // 1. From this user's personal NeoPAT emails (validDriveIdSet)
  // 2. From candidate_matches for this user
  const { data: userCandidateMatches } = await supabase
    .from('candidate_matches')
    .select('placement_drive_id')
    .eq('user_id', userId);

  const userAllowedDriveIds = new Set<string>(validDriveIdSet);
  for (const cm of (userCandidateMatches || [])) {
    if (cm.placement_drive_id) userAllowedDriveIds.add(cm.placement_drive_id);
  }

  const orphanDriveIds = (userApps || [])
    .filter((a: any) => !a.manual_override && a.placement_drive_id && !userAllowedDriveIds.has(a.placement_drive_id))
    .map((a: any) => a.placement_drive_id);

  if (orphanDriveIds.length > 0) {
    await supabase.from('events').delete().eq('user_id', userId).in('placement_drive_id', orphanDriveIds);
    await supabase.from('applications').delete().eq('user_id', userId).in('placement_drive_id', orphanDriveIds);
    await supabase.from('notifications').delete().eq('user_id', userId).in('placement_drive_id', orphanDriveIds);
    await supabase.from('email_drive_links').delete().eq('user_id', userId).in('placement_drive_id', orphanDriveIds);
  }

  // 5. Phase 3: Match College Emails against Official NeoPAT Placement Drives ONLY
  onProgress?.({
    step: 4,
    totalSteps: 5,
    message: `Matching ${collegeEmails.length} college circulars, test links & shortlists…`,
  });

  let collegeLinkedCount = 0;
  let collegeDiscardedCount = 0;
  const collegeEmailUpdates: Array<{
    id: string;
    parsed_drive_numbers: string[];
    parsed_company_name: string | null;
    classification: string;
  }> = [];
  const driveSourceUpdates: Array<{
    driveId: string;
    sourceCollegeEmailId: string;
  }> = [];
  const personalReceiptUpdates: Array<{
    collegeEmailId: string;
    placementDriveId: string;
  }> = [];

  for (const email of collegeEmails) {
    if (email.assignment_source === 'admin_unlinked' || email.classification === 'irrelevant') {
      continue;
    }
    const subject = email.subject || '';
    const sender = email.sender || '';
    const bodySnippet = email.body_snippet || '';
    const emailDate = email.received_at ? new Date(email.received_at) : new Date();

    const classification = classifyEmail({
      gmailMessageId: email.id,
      threadId: null,
      sender,
      senderEmail: sender.match(/<([^>]+)>/)?.[1] || sender,
      subject,
      receivedAt: emailDate,
      bodySnippet,
      bodyPlain: bodySnippet,
      bodyHtml: '',
      hasAttachments: false,
      attachments: [],
      labels: [],
    }, driveResolutionsMap);

    const fullEmailText = `${subject}\n${bodySnippet}`;
    const driveNumber = extractDriveNumber(fullEmailText);
    const companyName = classification.companyName;
    let matchedDriveId: string | null = null;

    // 1. Primary Identity Anchor: Drive Number match
    if (driveNumber && driveByNumber.has(driveNumber.toLowerCase().trim())) {
      const cand = driveByNumber.get(driveNumber.toLowerCase().trim())!;
      const isExcluded = Array.isArray(cand.excluded_email_ids) && (
        cand.excluded_email_ids.includes(email.id) ||
        (email.canonical_email_id && cand.excluded_email_ids.includes(email.canonical_email_id)) ||
        (email.college_email_id && cand.excluded_email_ids.includes(email.college_email_id))
      );
      if (!isExcluded) {
        matchedDriveId = cand.id;
      }
    } else {
      let matchedCompId: string | null = null;
      if (companyName) {
        const normalized = normalizeCompanyName(companyName).toLowerCase();
        const found = companiesByName.get(normalized);
        if (found && validCompanyIdSet.has(found.id)) {
          matchedCompId = found.id;
        } else {
          for (const [cName, c] of companiesByName.entries()) {
            if (validCompanyIdSet.has(c.id) && (isFuzzyCompanyMatch(cName, companyName) || isFuzzyCompanyMatch(c.name, companyName))) {
              matchedCompId = c.id;
              break;
            }
          }
        }
      }

      // Reverse search fallback
      if (!matchedCompId && !companyName) {
        const sanitizedSubject = subject.replace(/\((?:a|an|the)?\s*[^)]*?(?:company|group|subsidiary|division)[^)]*\)/gi, ' ');
        const subjectLower = sanitizedSubject.toLowerCase();
        for (const [cId, comp] of companiesById.entries()) {
          if (!validCompanyIdSet.has(cId) || comp.name.length < 4 || isInvalidCompanyName(comp.name)) continue;
          const escaped = comp.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i');
          if (regex.test(subjectLower)) {
            matchedCompId = cId;
            break;
          }
        }
      }

      if (matchedCompId) {
        let compDrives = (drivesByCompanyId.get(matchedCompId) || []).filter((d: any) => {
          if (!Array.isArray(d.excluded_email_ids)) return true;
          if (d.excluded_email_ids.includes(email.id)) return false;
          if (email.canonical_email_id && d.excluded_email_ids.includes(email.canonical_email_id)) return false;
          if (email.college_email_id && d.excluded_email_ids.includes(email.college_email_id)) return false;
          return true;
        });
        const isReg = /registration/i.test(subject);
        const graceMs = isReg ? 24 * 60 * 60 * 1000 : 0;

        if (compDrives.length === 1) {
          const dStart = driveDateMap.get(compDrives[0].id);
          // Only link if email is not older than the drive start (24h grace only for registration circulars)
          if (!dStart || emailDate.getTime() >= dStart.getTime() - graceMs) {
            matchedDriveId = compDrives[0].id;
          }
        } else if (compDrives.length > 1) {
          // Check for explicit category match first (e.g. Super Dream vs Dream)
          const textLower = `${subject} ${bodySnippet}`.toLowerCase();
          const hasSuperDream = /super\s*dream/i.test(textLower);
          const hasDream = !hasSuperDream && /\bdream\b/i.test(textLower);

          let candidateDrives = compDrives;
          if (hasSuperDream) {
            const superMatches = compDrives.filter((d: any) =>
              /super\s*dream/i.test(d.category || d.drive_name || '')
            );
            if (superMatches.length > 0) candidateDrives = superMatches;
          } else if (hasDream) {
            const dreamMatches = compDrives.filter((d: any) =>
              /dream/i.test(d.category || d.drive_name || '') &&
              !/super\s*dream/i.test(d.category || d.drive_name || '')
            );
            if (dreamMatches.length > 0) candidateDrives = dreamMatches;
          } else if (/\bregular\b/i.test(textLower)) {
            const regularMatches = compDrives.filter((d: any) =>
              /regular/i.test(d.category || d.drive_name || '')
            );
            if (regularMatches.length > 0) candidateDrives = regularMatches;
          }

          // Date-scoped circular linking: filter to drives whose startDate <= emailDate (+ graceMs only for registration)
          const eligibleDrives = candidateDrives.filter((d: any) => {
            const dStart = driveDateMap.get(d.id);
            return !dStart || dStart.getTime() <= emailDate.getTime() + graceMs;
          });
          if (eligibleDrives.length > 0) {
            eligibleDrives.sort((a: any, b: any) => {
              const aTime = driveDateMap.get(a.id)?.getTime() || 0;
              const bTime = driveDateMap.get(b.id)?.getTime() || 0;
              return bTime - aTime;
            });
            matchedDriveId = eligibleDrives[0].id;
          }
        }
      }
    }

    if (matchedDriveId) {
      collegeLinkedCount++;
      const targetDriveObj = driveById.get(matchedDriveId);
      const driveNum = targetDriveObj?.drive_number || targetDriveObj?.normalized_drive_number;
      const currentNums: string[] = email.parsed_drive_numbers || [];
      const updatedNums = driveNum && !currentNums.includes(driveNum)
        ? [...currentNums, driveNum]
        : currentNums;
      const comp = targetDriveObj ? companiesById.get(targetDriveObj.company_id) : null;

      const numsChanged = updatedNums.length !== currentNums.length || updatedNums.some((n, idx) => n !== currentNums[idx]);
      const nameChanged = Boolean(comp?.name && comp.name !== email.parsed_company_name);
      const classChanged = Boolean(classification.classification && classification.classification !== email.classification);

      if (numsChanged || nameChanged || classChanged) {
        collegeEmailUpdates.push({
          id: email.id,
          parsed_drive_numbers: updatedNums,
          parsed_company_name: comp?.name || email.parsed_company_name || null,
          classification: classification.classification,
        });
      }

      if (targetDriveObj && !targetDriveObj.source_college_email_id && /registration/i.test(subject)) {
        if (!driveSourceUpdates.some((d) => d.driveId === targetDriveObj.id)) {
          driveSourceUpdates.push({
            driveId: targetDriveObj.id,
            sourceCollegeEmailId: email.id,
          });
        }
      }

      personalReceiptUpdates.push({
        collegeEmailId: email.id,
        placementDriveId: matchedDriveId,
      });
    } else {
      collegeDiscardedCount++;
    }
  }

  // 1. Update personal emails (from Phase 1 NeoPAT matching)
  const groupedPersonalUpdates = new Map<string, string[]>();
  for (const u of emailUpdates) {
    const key = `${u.placement_drive_id || 'null'}|${u.classification}|${u.is_relevant}`;
    if (!groupedPersonalUpdates.has(key)) groupedPersonalUpdates.set(key, []);
    groupedPersonalUpdates.get(key)!.push(u.id);
  }

  for (const [key, ids] of groupedPersonalUpdates.entries()) {
    const [compIdStr, cls, isRelStr] = key.split('|');
    const compId = compIdStr === 'null' ? null : compIdStr;
    const isRel = isRelStr === 'true';

    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await supabase
        .from('personal_emails')
        .update({
          placement_drive_id: compId,
          classification: cls as any,
          is_relevant: isRel,
        })
        .in('id', chunk);
    }
  }

  // 2. Batch update college circulars with matched drive numbers & company names (only changed rows)
  if (collegeEmailUpdates.length > 0) {
    for (let i = 0; i < collegeEmailUpdates.length; i += 50) {
      const chunk = collegeEmailUpdates.slice(i, i + 50);
      await Promise.all(
        chunk.map((u) =>
          supabase
            .from('college_emails')
            .update({
              parsed_drive_numbers: u.parsed_drive_numbers,
              parsed_company_name: u.parsed_company_name,
              classification: u.classification as any,
            })
            .eq('id', u.id)
        )
      );
    }
  }

  // 3. Update placement drives with primary registration circular
  if (driveSourceUpdates.length > 0) {
    for (const dsu of driveSourceUpdates) {
      await supabase
        .from('placement_drives')
        .update({ source_college_email_id: dsu.sourceCollegeEmailId })
        .eq('id', dsu.driveId)
        .is('source_college_email_id', null);
    }
  }

  // 4. Update personal email receipts that reference matched college circulars
  if (personalReceiptUpdates.length > 0) {
    const { data: userCollegeReceipts } = await supabase
      .from('personal_emails')
      .select('id, college_email_id')
      .eq('user_id', userId)
      .not('college_email_id', 'is', null)
      .is('placement_drive_id', null);

    if (userCollegeReceipts && userCollegeReceipts.length > 0) {
      const driveByCollegeEmailId = new Map(
        personalReceiptUpdates.map((pru) => [pru.collegeEmailId, pru.placementDriveId])
      );
      for (const receipt of userCollegeReceipts) {
        if (!receipt.college_email_id) continue;
        const targetDriveId = driveByCollegeEmailId.get(receipt.college_email_id);
        if (targetDriveId) {
          await supabase
            .from('personal_emails')
            .update({ placement_drive_id: targetDriveId })
            .eq('id', receipt.id);
        }
      }
    }
  }

  // Scan Excel shortlist attachments only if candidate matches haven't been resolved yet
  const { count: existingCandidateMatchesCount } = await supabase
    .from('candidate_matches')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (!existingCandidateMatchesCount || existingCandidateMatchesCount === 0) {
    try {
      const { scanAndPersistCandidateMatches } = await import('@/lib/sync/attachment-scanner');
      await scanAndPersistCandidateMatches(supabase, userId);
    } catch (scanErr) {
      console.warn('[performReprocess] Attachment scan non-critical error:', scanErr);
    }
  }

  // 6. Phase 4: Recalculate Stage Progression & Events for Official NeoPAT Drives
  const phase4Res = await recalculateApplicationStatuses(userId, onProgress);
  const updatedAppsCount = phase4Res.updatedCount;
  const applicationResults = phase4Res.results || [];

  return {
    success: true,
    message: `Successfully re-indexed: ${validDriveIdSet.size} official NeoPAT drives tracked`,
    neoPatDrivesCount: validDriveIdSet.size,
    deletedNonNeoPatCompanies: [],
    collegeCircularsLinked: collegeLinkedCount,
    collegeCircularsDiscarded: collegeDiscardedCount,
    updatedApplications: updatedAppsCount,
    results: applicationResults,
  };
}

export async function POST(req: Request) {
  let userId: string | null = null;
  const session = await getSession();
  if (session) {
    userId = session.userId;
  } else {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const url = new URL(req.url);
      const authHeader = req.headers.get('authorization');
      const querySecret = url.searchParams.get('secret') || url.searchParams.get('key');
      const isAuthorized =
        authHeader === `Bearer ${secret}` ||
        authHeader === secret ||
        querySecret === secret;
      if (isAuthorized) {
        userId = url.searchParams.get('userId') || '48380752-3627-4b81-b44a-4e158002902c';
      }
    }
  }

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const isStream =
    req.headers.get('accept')?.includes('text/event-stream') ||
    new URL(req.url).searchParams.get('stream') === 'true';

  if (isStream) {
    const encoder = new TextEncoder();
    let isClosed = false;
    let heartbeat: NodeJS.Timeout | null = null;
    let streamController: ReadableStreamDefaultController | null = null;

    const cleanup = () => {
      if (isClosed) return;
      isClosed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (streamController) {
        try {
          streamController.close();
        } catch {
          // Stream may already be closed
        }
        streamController = null;
      }
    };

    if (req.signal.aborted) {
      cleanup();
    } else {
      req.signal.addEventListener('abort', cleanup, { once: true });
    }

    const stream = new ReadableStream({
      async start(controller) {
        streamController = controller;

        const sendEvent = (event: string, data: unknown) => {
          if (isClosed || req.signal.aborted) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            cleanup();
          }
        };

        heartbeat = setInterval(() => {
          if (isClosed || req.signal.aborted) {
            cleanup();
            return;
          }
          try {
            controller.enqueue(encoder.encode(`: keep-alive\n\n`));
          } catch {
            cleanup();
          }
        }, 2000);

        try {
          sendEvent('start', { message: 'Analyzing placement archive & re-indexing drivesâ€¦' });

          const statusResult = await performReprocess(userId!, (progress) => {
            sendEvent('progress', progress);
          });

          // Trigger calendar reconciliation in background so HTTP response returns instantly
          import('@/lib/calendar/google-sync')
            .then(({ reconcileUserGoogleCalendar }) => reconcileUserGoogleCalendar(userId!))
            .catch((cErr) => console.warn('[Reprocess Route] Calendar reconcile warning:', cErr));

          sendEvent('complete', {
            success: true,
            updatedApplications: statusResult.updatedApplications,
            neoPatDrivesCount: statusResult.neoPatDrivesCount,
            collegeCircularsLinked: statusResult.collegeCircularsLinked,
            collegeCircularsDiscarded: statusResult.collegeCircularsDiscarded,
            fixed: statusResult.updatedApplications,
          });
        } catch (err: any) {
          sendEvent('error', { message: err instanceof Error ? err.message : 'Placement re-indexing failed' });
        } finally {
          cleanup();
        }
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Content-Encoding': 'none',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  try {
    const statusResult = await performReprocess(userId);

    // Trigger calendar reconciliation in background
    import('@/lib/calendar/google-sync')
      .then(({ reconcileUserGoogleCalendar }) => reconcileUserGoogleCalendar(userId))
      .catch((cErr) => console.warn('[Reprocess Route] Calendar reconcile warning:', cErr));

    return NextResponse.json({
      success: true,
      updatedApplications: statusResult.updatedApplications,
      neoPatDrivesCount: statusResult.neoPatDrivesCount,
      collegeCircularsLinked: statusResult.collegeCircularsLinked,
      collegeCircularsDiscarded: statusResult.collegeCircularsDiscarded,
      fixed: statusResult.updatedApplications,
    });
  } catch (err) {
    console.error('Reprocess failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Placement re-indexing failed' },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
