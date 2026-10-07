import { buildExtractionProvenance } from './extraction-provenance';
import { loadUserCandidateIdentity } from '@/lib/sync/user-identity';
import { isCompanySubjectMatch as matchesCompanySubject, loadRecalculationScope, loadSelectedCanonicalBodies, type RecalculationCircularMetadata } from './recalculation-scope';
import { createAdminClient } from '@/lib/supabase/admin';
import { withQueryMetrics } from '@/lib/supabase/query-metrics';
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
import { isShortlistMatchEvidence } from '@/lib/sync/participation-evidence';
import {
  buildCircularCatalog,
  loadAllDriveResolutions,
  resolveDriveByTimingCorrelation,
} from '@/lib/sync/drive-correlator';
import { pickRegistrationDeadline } from '@/lib/sync/events';
import { classifyShortlistEmail, extractExplicitOrdinal, parseRecruitmentProcess, buildAnnouncedProcessToken, extractAnnouncedRoundsFromEmails } from '@/lib/sync/round-identity';
import { normalizeDriveNumber } from '@/lib/drive-number';
import { withUserMutationLease, assertMutationLease } from '@/lib/sync/mutation-lease';
import { getEvidenceMessageText, isQuotedReply } from '@/lib/sync/body';
import { calculateDriveRoundVerdicts, commitDriveRoundVerdicts, reconcileDriveEvents, dispatchCalendarRemovals, dispatchRoundNotificationOutbox } from '@/lib/sync/round-verdict-service';
import { statusForRoundVerdict, roundEventNumbers } from '@/lib/sync/round-verdict';
import { extractScopedEvents } from '@/lib/sync/scoped-events';
import { isOpenPptInvitation } from '@/lib/sync/placement-evidence';
import { getCurrentRoundDecision, resolveRecruitmentStatus, isRoundEventEligible } from '@/lib/sync/round-status';
import {
  getStartOfRegistrationDate,
  isCircularAllowedByScheduledDate,
  parseScheduledDate,
} from '@/lib/sync/drive-temporal-boundary';



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
export async function recalculateApplicationStatuses(...args: Parameters<typeof recalculateApplicationStatusesUnlocked>) {
  return withQueryMetrics('recalculation', () => withUserMutationLease(args[0], () => recalculateApplicationStatusesUnlocked(...args)));
}

async function recalculateApplicationStatusesUnlocked(
  userId: string,
  onProgress?: (p: { step: number; totalSteps: number; message: string }) => void,
  options?: {
    deepGSheetScan?: boolean;
    skipGSheetScan?: boolean;
    targetPlacementDriveIds?: string[];
    recalculateStatusesFromRemainingEvidence?: boolean;
    suppressNotifications?: boolean;
    skipBodyRecovery?: boolean;
    preloadedCanonicalMap?: Map<string, string>;
    preloadedCollegeEmails?: any[];
  }
): Promise<{ updatedCount: number; results: Array<{ company: string; status: string; role?: string | null; ctc?: string | null }> }> {
  const supabase = createAdminClient();
  const sourceScope = options?.targetPlacementDriveIds?.length
    ? await loadRecalculationScope(supabase, userId, options.targetPlacementDriveIds)
    : null;

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

  const candidateIdentity = await loadUserCandidateIdentity(supabase, userId);
  const userNeoId = candidateIdentity.neoId || userData?.neo_id || null;
  const userEmail = candidateIdentity.personalEmail || candidateIdentity.emails[0] || userData?.email || '';

  if (!userEmail) return { updatedCount: 0, results: [] };

  // Preload college_emails by RFC message ID for rows whose foreign-key link is missing.
  const canonicalByMsgId = new Map<string, string>();
  if (options?.preloadedCanonicalMap) {
    for (const [k, v] of options.preloadedCanonicalMap) canonicalByMsgId.set(k, v);
  }

  // Purge any irrelevant spam personal emails first
  if (!options?.targetPlacementDriveIds?.length) {
    await supabase.from('personal_emails').delete().eq('user_id', userId).eq('classification', 'irrelevant');
  }

  // Fetch all emails for this user (paginated)
  const rawEmailChunks: any[] = [];
  const pageSize = 1000;
  let page = 0;
  while (true) {
    const { data: chunk, error: chunkErr } = await supabase
      .from('personal_emails')
      .select<string>(sourceScope
        ? 'id, subject, sender, body_snippet, gmail_account_id, gmail_message_id, canonical_email_id, college_email_id, rfc_message_id, classification, placement_drive_id, received_at, assignment_state, assignment_source'
        : 'id, subject, sender, body_snippet, gmail_account_id, gmail_message_id, canonical_email_id, college_email_id, college_emails!personal_emails_college_email_id_fkey(body_text), rfc_message_id, classification, placement_drive_id, received_at, assignment_state, assignment_source')
      .eq('user_id', userId)
      .order('received_at', { ascending: true })
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (chunkErr) {
      if (sourceScope) throw chunkErr;
      console.error('[recalculateApplicationStatuses] Error loading personal_emails:', chunkErr);
      break;
    }
    if (!chunk || chunk.length === 0) break;
    rawEmailChunks.push(...chunk);
    if (chunk.length < pageSize) break;
    page++;
  }

  // Preserve the light catalog for identity/link checks, but hydrate only evidence
  // that can be consumed by a selected drive. Never classify unrelated bodies.
  const selectedPersonalEmails = sourceScope ? rawEmailChunks.filter(email => sourceScope.includesPersonal(email)) : rawEmailChunks;
  if (sourceScope) {
    const bodies = await loadSelectedCanonicalBodies(supabase, selectedPersonalEmails.flatMap(email => email.college_email_id ? [email.college_email_id] : []));
    for (const email of selectedPersonalEmails) {
      if (email.college_email_id && bodies.has(email.college_email_id)) email.college_emails = { body_text: bodies.get(email.college_email_id) };
    }
  }

  // Targeted RFC lookup: only query college_emails for RFC message IDs that lack foreign-key canonical bodies
  if (!options?.preloadedCanonicalMap && selectedPersonalEmails.length > 0) {
    const missingRfcIds = Array.from(new Set(
      selectedPersonalEmails
        .filter((e) => {
          const canonical = Array.isArray(e.college_emails) ? e.college_emails[0] : e.college_emails;
          return !canonical?.body_text && Boolean(e.rfc_message_id);
        })
        .map((e) => e.rfc_message_id.toLowerCase().trim())
    ));

    if (missingRfcIds.length > 0) {
      for (let from = 0; from < missingRfcIds.length; from += 200) {
        const { data: canonicalsWithBody } = await supabase
          .from('college_emails')
          .select('id, message_id, body_text')
          .in('message_id', missingRfcIds.slice(from, from + 200));

        for (const c of canonicalsWithBody || []) {
          const text = c.body_text || '';
          if (text && c.message_id && !canonicalByMsgId.has(c.message_id.toLowerCase().trim())) {
            canonicalByMsgId.set(c.message_id.toLowerCase().trim(), text);
          }
        }
      }
    }
  }

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
  }> = rawEmailChunks.map((email: any) => {
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
  });

  if (!options?.skipBodyRecovery) {
    const recoveredBodies = await recoverTruncatedEmailBodies(sourceScope ? allEmails.filter(email => sourceScope.includesPersonal(email)) : allEmails);
    for (const email of allEmails) {
      const recoveredBody = recoveredBodies.get(email.id);
      if (recoveredBody) email.body_snippet = recoveredBody;
    }
  }

  // Also fetch college broadcast circulars (shared college_emails table)
  const allCollegeEmails: Array<{
    id: string;
    subject: string | null;
    sender: string | null;
    body_snippet: string | null;
    body_text?: string | null;
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

  if (options?.preloadedCollegeEmails) {
    allCollegeEmails.push(...options.preloadedCollegeEmails);
  } else {
    let clgPage = 0;
    while (true) {
      const { data: cChunk, error: cErr } = await supabase
        .from('college_emails')
        .select<string>(sourceScope
          ? 'id, subject, sender_email, received_at, created_at, classification, parsed_company_name, parsed_drive_numbers'
          : 'id, subject, sender_email, received_at, created_at, body_text, classification, parsed_company_name, parsed_drive_numbers')
        .order('received_at', { ascending: true })
        .range(clgPage * pageSize, (clgPage + 1) * pageSize - 1)
        .returns<RecalculationCircularMetadata[]>();

      if (cErr) {
        if (sourceScope) throw cErr;
        console.error('[recalculateApplicationStatuses] Error loading college_emails:', cErr);
        break;
      }
      if (!cChunk || cChunk.length === 0) break;

      const selectedBodies = sourceScope
        ? await loadSelectedCanonicalBodies(supabase, cChunk.filter(email => sourceScope.includesCircular(email)).map(email => email.id))
        : null;

      for (const ce of cChunk) {
        const body = selectedBodies ? selectedBodies.get(ce.id) : (ce as any).body_text;
        let classification = ce.classification;
        const dynamicClass = (!selectedBodies || selectedBodies.has(ce.id)) ? classifyEmail({
          subject: ce.subject || '',
          bodySnippet: body ? body.slice(0, 500) : '',
          bodyPlain: body || '',
          sender: ce.sender_email || '',
          senderEmail: ce.sender_email || '',
        } as any).classification : null;

        if (dynamicClass && dynamicClass !== 'unclassified' && dynamicClass !== ce.classification) {
          classification = dynamicClass;

        }

        allCollegeEmails.push({
          id: ce.id,
          subject: ce.subject || null,
          sender: ce.sender_email,
          received_at: ce.received_at || ce.created_at,
          body_snippet: body ? body.slice(0, 500) : '',
          body_text: body || '',
          classification,
          parsed_company_name: ce.parsed_company_name,
          parsed_drive_numbers: ce.parsed_drive_numbers || [],
          placement_drive_id: null,
          college_email_id: ce.id,
          canonical_email_id: ce.id,
          assignment_source: 'college_broadcast',
          has_canonical_body: Boolean(body?.length > 200),
        });
      }

      if (cChunk.length < pageSize) break;
      clgPage++;
    }
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
    if (cm.placement_drive_id && isShortlistMatchEvidence({
      matchType: cm.match_type,
      matchedValue: cm.matched_value,
      matchedRoundType: cm.matched_round_type,
    })) {
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

  // When no explicit target is given, restrict to drives this user is actually connected to.
  // A drive is "relevant" if the user has at least one linked email OR an existing application for it.
  // This avoids iterating all 100+ global drives for a user who only tracks ~10-20 of them.
  const userRelevantDriveIds = new Set<string>([
    ...emailsByDriveId.keys(),
    ...appsByDriveId.keys(),
  ]);

  const drivesToProcess = targetDriveSet
    ? allDrives.filter((d) => targetDriveSet.has(d.id))
    : allDrives.filter((d) => userRelevantDriveIds.has(d.id));

  // Precompute authoritative minimum allowed registration date for every drive to process.
  // Rule: Only emails received on or after the calendar date of the drive's NeoPAT
  // registration announcement (or created_at) can affect this drive.
  const driveMinAllowedTimeMap = new Map<string, number>();
  const driveIdsToQuery = drivesToProcess.map((d) => d.id);
  if (driveIdsToQuery.length > 0) {
    const { data: neopatEmails } = await supabase
      .from('personal_emails')
      .select('placement_drive_id, received_at')
      .in('placement_drive_id', driveIdsToQuery)
      .or('sender.ilike.%noreply.cdcinfo@vitstudent.ac.in%,classification.in.(registration,registration_confirmation),subject.ilike.%eligible%,subject.ilike.%registration%')
      .not('received_at', 'is', null)
      .order('received_at', { ascending: true });

    const earliestByDrive = new Map<string, string>();
    for (const ne of neopatEmails || []) {
      if (ne.placement_drive_id && !earliestByDrive.has(ne.placement_drive_id) && ne.received_at) {
        earliestByDrive.set(ne.placement_drive_id, ne.received_at);
      }
    }

    for (const d of drivesToProcess) {
      const regAt = earliestByDrive.get(d.id) || d.created_at;
      if (regAt) {
        const dDate = new Date(regAt);
        if (!isNaN(dDate.getTime())) {
          driveMinAllowedTimeMap.set(d.id, getStartOfRegistrationDate(dDate).getTime());
        }
      }
    }
  }

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

        const driveMinAllowedTime = driveMinAllowedTimeMap.get(drive.id) || 0;
        const driveEmails = (emailsByDriveId.get(drive.id) || []).filter((e) => {
          if (driveMinAllowedTime > 0 && e.received_at) {
            return new Date(e.received_at).getTime() >= driveMinAllowedTime;
          }
          return true;
        });
        const driveExcluded = driveExclusionsMap.get(drive.id);

        // 1. Include college email set as source on drive (strictly guarded by registration date boundary)
        if ((drive as any).source_college_email_id) {
          const ce = collegeEmailById.get((drive as any).source_college_email_id);
          if (ce && (!driveExcluded || !driveExcluded.has(ce.id))) {
            const ceTime = ce.received_at ? new Date(ce.received_at).getTime() : 0;
            if (driveMinAllowedTime === 0 || ceTime >= driveMinAllowedTime) {
              if (isCircularAllowedByScheduledDate(ce.subject, driveMinAllowedTime, 7, ce.body_text || ce.body_snippet)) {
                if (!driveEmails.some((existing) => existing.id === ce.id)) {
                  driveEmails.push(ce as any);
                }
              }
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
            const ceTime = ce.received_at ? new Date(ce.received_at).getTime() : 0;
            if (driveMinAllowedTime > 0 && ceTime > 0 && ceTime < driveMinAllowedTime) continue;
            if (!isCircularAllowedByScheduledDate(ce.subject, driveMinAllowedTime, 7, ce.body_text || ce.body_snippet)) continue;
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
            const ceTime = ce.received_at ? new Date(ce.received_at).getTime() : 0;
            if (driveMinAllowedTime > 0 && ceTime > 0 && ceTime < driveMinAllowedTime) continue;
            if (!isCircularAllowedByScheduledDate(ce.subject, driveMinAllowedTime, 7, ce.body_text || ce.body_snippet)) continue;
            if (!driveEmails.some((existing) => existing.id === ce.id)) {
              driveEmails.push(ce as any);
            }
          }
        }

        const isCompanySubjectMatch = (subject: string): boolean => matchesCompanySubject(subject, comp, drive);

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
        const siblingDrives = allDrives.filter((d) => d.company_id === drive.company_id && d.id !== drive.id);
        const thisDriveNumbers = [drive.drive_number, drive.normalized_drive_number]
          .map((n) => normalizeDriveNumber(n))
          .filter((n): n is string => Boolean(n));
        const siblingDriveNumbers = new Set<string>(
          siblingDrives
            .flatMap((d) => [d.drive_number, d.normalized_drive_number])
            .map((n) => normalizeDriveNumber(n))
            .filter((n): n is string => Boolean(n))
        );

        // Precompute sibling email thread signatures: if any circular has a drive number matching a sibling,
        // any other circular sharing the exact normalized subject belongs to that sibling thread.
        const siblingSubjectSet = new Set<string>();
        for (const ce of allCollegeEmails) {
          const ceNums = (ce.parsed_drive_numbers || [])
            .map((n: string) => normalizeDriveNumber(n))
            .filter((n): n is string => Boolean(n));
          if (ceNums.some((n) => siblingDriveNumbers.has(n)) && !ceNums.some((n) => thisDriveNumbers.includes(n))) {
            const cleanSub = (ce.subject || '').toLowerCase().replace(/^(?:re|fwd|fw)\s*:\s*/gi, '').trim();
            if (cleanSub) siblingSubjectSet.add(cleanSub);
          }
        }

        for (const ce of allCollegeEmails) {
          if (ce.classification === 'irrelevant' || !ce.subject || !ce.received_at) continue;
          if (driveExcluded && driveExcluded.has(ce.id)) continue;
          const eTime = new Date(ce.received_at).getTime();
          if (driveMinAllowedTime > 0 && eTime < driveMinAllowedTime) continue;
          if (!isCircularAllowedByScheduledDate(ce.subject, driveMinAllowedTime, 7, ce.body_text || ce.body_snippet)) continue;

          // Sibling drive boundary checks:
          const ceDriveNums = (ce.parsed_drive_numbers || [])
            .map((n: string) => normalizeDriveNumber(n))
            .filter((n): n is string => Boolean(n));
          if (ceDriveNums.length > 0) {
            const matchesThis = ceDriveNums.some((n) => thisDriveNumbers.includes(n));
            const matchesSibling = ceDriveNums.some((n) => siblingDriveNumbers.has(n));
            if (matchesSibling && !matchesThis) {
              continue; // Explicitly belongs to a sibling drive of the same company
            }
          }

          // Thread boundary check: if this circular's thread subject was established by a sibling drive
          const normCeSub = (ce.subject || '').toLowerCase().replace(/^(?:re|fwd|fw)\s*:\s*/gi, '').trim();
          if (normCeSub && siblingSubjectSet.has(normCeSub)) {
            const matchesThis = ceDriveNums.some((n) => thisDriveNumbers.includes(n));
            if (!matchesThis) {
              continue; // Belongs to a sibling drive's email thread (e.g. "Re: Infosys next round 28th Sept onwards")
            }
          }

          // Category/Role discrimination if circular explicitly targets sibling role/profile
          // E.g. Infosys DSE & Specialist Programmer (Drive 1078) vs Regular Offer (Drive 1338)
          const subLower = (ce.subject || '').toLowerCase();
          const isDriveRegular = (drive.category || '').toLowerCase().includes('regular') || (drive.role || '').toLowerCase().includes('regular');
          const isDriveSuperDream = (drive.category || '').toLowerCase().includes('super') || (drive.category || '').toLowerCase().includes('dream');
          const isCeDseOrSpe = /\bdse\b|\bspe\b|specialist\s+programmer/i.test(subLower);
          const isCeRegular = /regular\s+offer/i.test(subLower);

          if (isDriveRegular && isCeDseOrSpe) continue;
          if (isDriveSuperDream && isCeRegular) continue;

          if (isCompanySubjectMatch(ce.subject) || (ce.parsed_company_name && isFuzzyCompanyMatch(comp.name, ce.parsed_company_name))) {
            if (!driveEmails.some(existing => existing.id === ce.id)) {
              driveEmails.push(ce as any);
            }
          }
        }

        if (driveEmails.length === 0) return;
        await assertMutationLease();
        for (const email of driveEmails) {
          if (!userPersonalEmailIdSet.has(email.id)) {
            email.body_snippet = getEvidenceMessageText({ subject: email.subject || '', bodyPlain: (email as { body_text?: string }).body_text || email.body_snippet || '', bodyHtml: '', bodySnippet: '' });
          }
        }

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

        // 0. Scan broadcast circulars (college emails) for candidate matches (email body direct matches and Google Sheets)
        // NEVER scan personal transactional emails!
        for (const email of companyEmails) {
          if (isQuotedReply(email.subject || '')) continue;
          if (userPersonalEmailIdSet.has(email.id) || (!email.college_email_id && !email.canonical_email_id && !email.sender)) {
            continue;
          }
          const emailText = `${email.subject || ''}\n${email.body_snippet || ''}`;
          const isRelevantCandidateEmail =
            /shortlist|selection|selected|test\s+shortlist|interview\s+shortlist|shortlisted\s+candidates|selected\s+candidates/i.test(
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

          // Check direct Neo ID or Reg No match in email body
          const { checkNeoIdMatch } = await import('@/lib/sync/status-engine');
          const bodyMatch = checkNeoIdMatch(emailText, userNeoId, userEmail, candidateIdentity.name, candidateIdentity);
          if (bodyMatch.matched) {
            matchedEmailIds.add(email.id);
            const isShortlistNotice = /shortlist|selection|selected|result/i.test(email.subject || '');
            const round = classifyShortlistEmail(email.subject || '', emailText) ?? (
              /interview/i.test(email.subject || '')
                ? 'interview'
                : /selection\s*list|final\s*selection|offer/i.test(email.subject || '')
                  ? 'selected'
                  : 'test'
            );
            const isCollegeRef = Boolean(email.college_email_id || email.canonical_email_id || (email as any).sender_email);
            const insertPayload: any = {
              user_id: userId,
              placement_drive_id: drive.id,
              neo_id: userNeoId || userEmail,
              match_type: 'email_body',
              matched_round_type: isShortlistNotice ? round : null,
              matched_value: `Found ${bodyMatch.matchedValue} in email body selection list`,
              confidence: 'high',
            };
            if (isCollegeRef) {
              insertPayload.college_email_id = email.id;
            } else {
              insertPayload.email_id = email.id;
            }
            const { error: insertError } = await supabase.from('candidate_matches').insert(insertPayload);
            if (insertError && insertError.code !== '23505') {
              throw insertError;
            }
          }
        }

        if (!options?.skipGSheetScan) {
          const { extractGoogleSheetUrls, scanGoogleSheetForCandidate } = await import('@/lib/sync/gsheet-parser');

          for (const email of companyEmails) {
            if (isQuotedReply(email.subject || '')) continue;
            const emailText = `${email.subject || ''}\n${(email as any).body_text || ''}\n${email.body_snippet || ''}`;
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
            if (!options?.deepGSheetScan && (alreadyMatched || matchedEmailIds.has(email.id))) continue;

            const gUrls = extractGoogleSheetUrls(emailText);
            for (const gUrl of gUrls) {
              const gMatch = await scanGoogleSheetForCandidate(gUrl, userEmail, userNeoId, candidateIdentity.name, candidateIdentity);
              const collegeRef = email.college_email_id || email.canonical_email_id;
              if (collegeRef) {
                const { persistSheetSnapshot } = await import('./sheet-snapshots');
                await persistSheetSnapshot(supabase, collegeRef, gUrl, gMatch);
              }
              if (gMatch && gMatch.matched) {
                matchedEmailIds.add(email.id);
                const matchExists = (candidateMatches || []).some(
                  (cm) => {
                    const match = cm as unknown as { email_id: string | null; college_email_id: string | null };
                    return match.email_id === email.id || match.college_email_id === email.id;
                  }
                );
                if (!matchExists) {
                  const isCollegeRef = Boolean(email.college_email_id || email.canonical_email_id || (email as any).sender_email);
                  const round = classifyShortlistEmail(email.subject || '', emailText) ?? 'test';
                  const insertPayload: any = {
                    user_id: userId,
                    placement_drive_id: drive.id,
                    neo_id: userNeoId || userEmail,
                    match_type: 'xlsx_cell',
                    matched_round_type: round,
                    matched_value: gMatch.details,
                    evidence: { matchedIdentity: gMatch.matchedValue, sourceUrl: gMatch.sourceUrl, contentHash: gMatch.contentHash, fetchedAt: gMatch.fetchedAt, sheetName: gMatch.sheetName, rowNumber: gMatch.rowNumber },
                    confidence: 'high',
                  };
                  if (isCollegeRef) {
                    insertPayload.college_email_id = email.id;
                  } else {
                    insertPayload.email_id = email.id;
                  }
                  const { error: candidateMatchError } = await supabase.from('candidate_matches').insert(insertPayload);
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
                  // A roster date alone does not provide an exact assessment time.
                  gsheetEventsForCompany.push({
                    eventType,
                    title,
                    startTime,
                    venue: 'Campus / Offline',
                    mode: 'online',
                    confidence: 'high',
                    hasExplicitTime: false,
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
          if (driveMinAllowedTime > 0 && eTime < driveMinAllowedTime) return false;
          if (!isCircularAllowedByScheduledDate(e.subject, driveMinAllowedTime, 7, (e as any).body_text || e.body_snippet)) return false;
          if (nextDriveStartDate && eTime >= nextDriveStartDate.getTime() - 5 * 60 * 1000) return false;
          return true;
        });

        const mainEmailText = mainCircularEmail ? `${mainCircularEmail.subject || ''}\n${(mainCircularEmail as any).body_text || mainCircularEmail.body_snippet || ''}` : '';
        const mainJobDetails = extractJobDetails(mainEmailText);

        const combinedEmailText = activeDriveEmails
          .map((e) => `${e.subject || ''}\n${(e as any).body_text || e.body_snippet || ''}`)
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
          const isWithdrawalEmail = (
            e.classification === 'withdrawal' ||
            e.classification === 'decline' ||
            /registration.*withdrawn|your registration.*withdrawn|declined\s+drive/i.test(full) ||
            /confirmation.*drive\s+registration\s+update.*withdrawn/i.test(full)
          );
          if (!isWithdrawalEmail) return false;

          // Drive-number specificity check: if the email body explicitly names a drive number
          // AND it does NOT match this drive's number, this withdrawal email belongs to a
          // sibling drive of the same company — do not count it here.
          const thisDriveId = (drive as any).id as string | undefined;
          const thisDriveNum = (drive as any).drive_number as string | undefined;

          // Primary check: use the pre-assigned placement_drive_id on the email row
          const emailAssignedDriveId = (e as any).placement_drive_id as string | undefined;
          if (emailAssignedDriveId && thisDriveId && emailAssignedDriveId !== thisDriveId) {
            return false; // withdrawal belongs to a different drive (e.g. sibling of same company)
          }

          // Secondary check: if no pre-assignment, look for explicit drive number in the snippet
          if (!emailAssignedDriveId && thisDriveNum) {
            const driveNumPattern = /pat-pl-\d{4}-\d+/gi;
            const mentionedDriveNums = (e.body_snippet || '').match(driveNumPattern) || [];
            if (mentionedDriveNums.length > 0) {
              const normalized = thisDriveNum.toLowerCase();
              const matchesThisDrive = mentionedDriveNums.some(
                (n) => n.toLowerCase() === normalized
              );
              if (!matchesThisDrive) return false;
            }
          }

          // Temporal guard: withdrawal must not predate this drive's earliest known email.
          // e.g. an Aug 18 withdrawal cannot be for a drive whose first email was Sep 17.
          if (driveMinAllowedTime > 0 && e.received_at) {
            const wTime = new Date(e.received_at).getTime();
            if (wTime < driveMinAllowedTime) return false;
          }

          return true;
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

          // Check dynamic classification
          const isClassifiedAsTest =
            e.classification === 'test' ||
            classifyEmail({
              subject: e.subject || '',
              bodySnippet: e.body_snippet || '',
              bodyPlain: e.body_snippet || '',
              sender: (e as any).sender || '',
              senderEmail: (e as any).sender || '',
            } as any).classification === 'test';

          // 1. Explicit scheduling phrase in subject or direct test links
          const isExplicitSubjectSchedule =
            /(?:online\s+)?(?:test|assessment|exam)\s+(?:is\s+)?(?:scheduled|rescheduled)|(?:online\s+)?(?:test|assessment|exam)\s+(?:schedule|time|timing|slot)|revised\s+test\s+time/i.test(s) ||
            /test\s+link|assessment\s+link|exam\s+link/i.test(s);

          if (isExplicitSubjectSchedule) {
            return true;
          }

          // 2. Direct test platform link or explicit test session in body
          const hasDirectPlatformOrSlot =
            /(?:tests?\.mettl\.com|app\.mettl\.com|hackerrank\.com|hackerearth\.com|codility\.com|shl\.com|amcat\.in|cocubes\.com)/i.test(full) ||
            /test\s*\d*\s*[:\-]\s*\d{1,2}:\d{2}|attempt\s+the\s+test|attend\s+the\s+test|fresh\s+link\s+for\s+test|test\s+today/i.test(full);

          if (isClassifiedAsTest && !isRegistrationCircular(e)) {
            return true;
          }

          if (hasDirectPlatformOrSlot && !isRegistrationCircular(e)) {
            return true;
          }

          // 3. Registration circulars, opt-in Google Forms, or mandatory registration emails
          if (
            isRegistrationCircular(e) ||
            /super\s*dream.*registration|dream.*registration|placement\s+registration|internship\s+registration/i.test(s) ||
            (/forms\.gle|google\s+form|registration\s+link|register\s+(?:in|on)\s+the\s+(?:below\s+)?link|mandatory\s+.*registration/i.test(full) && !hasDirectPlatformOrSlot)
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

        // Distinguish pre-test screening shortlists (shortlists published for Test 1 before it occurs)
        // from post-test round shortlists (Round 2, Game Round, Technical Interview, or Next Round).
        const earliestTestEmailTime = testEmails.reduce((min, e) => {
          const t = e.received_at ? new Date(e.received_at).getTime() : Infinity;
          return Math.min(min, t);
        }, Infinity);

        const isPostTestRoundShortlist = (e: { subject?: string | null; body_snippet?: string | null; received_at?: string | null }) => {
          const s = e.subject || '';
          const b = e.body_snippet || '';
          const full = `${s} ${b}`;
          if (/next\s+round|game\s+round|gamified|round\s*2|test\s*2|second\s+round/i.test(full)) return true;
          const classifiedRound = classifyShortlistEmail(s, full);
          if (classifiedRound === 'test_r2' || classifiedRound === 'interview' || classifiedRound === 'selected') return true;
          return false;
        };

        const latestTestEmailTime = testEmails.reduce(
          (max, e) => Math.max(max, e.received_at ? new Date(e.received_at).getTime() : 0),
          0
        );

        const preTestShortlistEmails = testShortlistEmails.filter((e) => {
          if (latestTestEmailTime > 0 && e.received_at) {
            const t = new Date(e.received_at).getTime();
            if (t > latestTestEmailTime) return false;
          }
          return !isPostTestRoundShortlist(e);
        });
        const postTestShortlistEmails = testShortlistEmails.filter((e) => !preTestShortlistEmails.includes(e));

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

        const roundForMatchedEmail = (emailOrId: string | { id: string; college_email_id?: string | null; canonical_email_id?: string | null }, round: 'test' | 'interview' | 'selected') => {
          const ids = typeof emailOrId === 'string'
            ? [emailOrId]
            : [emailOrId.id, emailOrId.college_email_id, emailOrId.canonical_email_id].filter(Boolean) as string[];
          return (candidateMatches || []).some((m) => {
            const match = m as unknown as { email_id: string | null; college_email_id: string | null; matched_round_type?: string | null; match_type?: string };
            const mRef = match.email_id || match.college_email_id;
            return mRef && ids.includes(mRef) &&
              (match.matched_round_type === round || (match.matched_round_type == null && round === 'test')) &&
              match.match_type !== 'xlsx_applied_list';
          });
        };

        const sortedSelectionEmails = [...selectionEmails].sort(
          (a, b) => (a.received_at ? new Date(a.received_at).getTime() : 0) - (b.received_at ? new Date(b.received_at).getTime() : 0)
        );
        let isMatchedInSelectionList = sortedSelectionEmails.some((e) => roundForMatchedEmail(e as any, 'selected'));
        if (!isMatchedInSelectionList) {
          const driveMatches = candidateMatchesByDriveId.get(drive.id) || [];
          isMatchedInSelectionList = driveMatches.some(
            (m) => m.matched_round_type === 'selected' && m.match_type !== 'xlsx_applied_list'
          );
        }

        const sortedNextRoundEmails = [...nextRoundEmails].sort(
          (a, b) => (a.received_at ? new Date(a.received_at).getTime() : 0) - (b.received_at ? new Date(b.received_at).getTime() : 0)
        );
        let isMatchedInNextRound = sortedNextRoundEmails.some((e) => roundForMatchedEmail(e as any, 'interview'));
        if (!isMatchedInNextRound) {
          const driveMatches = candidateMatchesByDriveId.get(drive.id) || [];
          isMatchedInNextRound = driveMatches.some(
            (m) =>
              ['interview', 'interview_r2', 'gd'].includes(m.matched_round_type) &&
              m.match_type !== 'xlsx_applied_list'
          );
        }

        const hasCompanyCandidateMatch = activeDriveEmails.some((e) => matchedEmailIds.has(e.id));

        const sortedTestShortlists = [...testShortlistEmails].sort(
          (a, b) => (a.received_at ? new Date(a.received_at).getTime() : 0) - (b.received_at ? new Date(b.received_at).getTime() : 0)
        );

        let isMatchedInTest = false;
        if (sortedTestShortlists.length > 0) {
          const latestTestShortlistEmail = sortedTestShortlists[sortedTestShortlists.length - 1];
          isMatchedInTest = roundForMatchedEmail(latestTestShortlistEmail as any, 'test');
        }
        if (!isMatchedInTest) {
          isMatchedInTest =
            testShortlistEmails.some((e) => roundForMatchedEmail(e as any, 'test')) ||
            testEmails.some((e) => roundForMatchedEmail(e as any, 'test'));
        }
        if (!isMatchedInTest) {
          const driveMatches = candidateMatchesByDriveId.get(drive.id) || [];
          isMatchedInTest = driveMatches.some(
            (m) =>
              (m.matched_round_type === 'test' || m.matched_round_type === 'test_r2' || m.matched_round_type == null) &&
              m.match_type !== 'xlsx_applied_list'
          );
        }
        // A personal test invitation email (e.g. Goldman Sachs direct link) or an open test announcement
        // addressed to all registered/applied students with direct test link (e.g. Axxela Mettl link) establishes
        // test participation when NO explicit pre-test shortlist roster (Excel/attachment) exists for this drive.
        // If an explicit shortlist was published (e.g. Work India, BlackRock, ValueLabs), only candidates actually in that shortlist were shortlisted.
        const hasOpenTestInvitation = testEmails.some((e) => {
          if (!isAfterRegistration(e)) return false;
          const full = `${e.subject || ''} ${e.body_snippet || ''}`.toLowerCase();
          const hasDirectTestLink = /tests?\.mettl\.com|hackerrank\.com\/test|codility\.com\/c\/|assessment\.shl\.com|hackerearth\.com\/challenges\/test|assessment\.glider\.ai|xobin\.com|hirepro\.in|testgorilla\.com|myamcat\.com/i.test(full);
          const hasGenericTestLink = /https?:\/\/[^\s]+/i.test(full) && /test\s*link|assessment\s*link|exam\s*link/i.test(full);
          const isAddressedToApplied = /applied\s+(?:students?|candidates?)|all\s+applied|registered\s+students/i.test(full);
          const hasActionableTestLink = hasDirectTestLink || (isAddressedToApplied && hasGenericTestLink);
          return hasActionableTestLink && !/shortlist|shortlisted/i.test(e.subject || '');
        });

        if (!isMatchedInTest && hasConfirmedRegistration && preTestShortlistEmails.length === 0 && (hasDirectPersonalTestInvitation || hasOpenTestInvitation)) {
          isMatchedInTest = true;
        }


        const extractedByEmail = activeDriveEmails.map((e) => ({
          e,
          events: extractScopedEvents({
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
          }, comp.name, (remainingCompanies || []).map((company) => company.name)).map((evt) => ({
            ...evt,
            // Stamp every extracted event with its source circular (when this email IS a
            // canonical college broadcast). The live sync path already records
            // events.college_email_id; reprocess previously kept it only for the
            // registration-deadline winner, so every other rebuilt event lost its
            // circular link on each reprocess — severing the exact evidence the
            // shortlist-verification scanner uses to attribute rosters to drives.
            _collegeEmailId:
              (e as { college_email_id?: string | null }).college_email_id ||
              (e as { canonical_email_id?: string | null }).canonical_email_id ||
              null,
          })),
        }));

        const allExtractedEvents = [
          ...extractedByEmail.flatMap((x) => x.events),
          ...gsheetEventsForCompany,
        ];

        const existingApp = appsByDriveId.get(drive.id) || null;

        const deadlineWinner = pickRegistrationDeadline(
          extractedByEmail.flatMap(({ e, events }) =>
            events.map((event) => ({
              event,
              e,
              isCollege: !isPersonalNeoPatEmail(e),
              receivedAt: new Date(e.received_at || 0),
            }))
          )
        );

        const finalRegDeadline = deadlineWinner?.event.startTime
          ? deadlineWinner.event.startTime.toISOString()
          : (existingApp?.registration_deadline || null);

        const hasPptEvent = activeDriveEmails.some(e => isAfterRegistration(e) &&
          (/ppt|pre[\s-]*placement/i.test(e.subject || '') && matchedShortlistEmailIds.has(e.id) ||
            isOpenPptInvitation(e.subject || '', (e as any).body_text || e.body_snippet || '')));


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

          const latestNextRoundTime = nextRoundEmails.reduce((max, e) => {
            const t = e.received_at ? new Date(e.received_at).getTime() : 0;
            return Math.max(max, t);
          }, 0);
          const earliestSubsequentSelectionTime = subsequentSelectionEmails.reduce((min, e) => {
            const t = e.received_at ? new Date(e.received_at).getTime() : Infinity;
            return Math.min(min, t);
          }, Infinity);

          // In multi-campus drives (e.g. Infosys across Vellore, Chennai, AP, Bhopal),
          // other campuses often complete interviews first, releasing interim selection lists
          // (e.g. batch-1, batch-2) while Bhopal's interview round is still scheduled/ongoing.
          // Never mark shortlisted candidates as rejected if interview circulars were sent
          // after/concurrently with selection emails, or state interview dates are future/pending.
          const hasStaggeredCampusInterviews =
            (latestNextRoundTime > 0 && earliestSubsequentSelectionTime < Infinity && latestNextRoundTime >= earliestSubsequentSelectionTime) ||
            nextRoundEmails.some((e) => {
              const full = `${e.subject || ''} ${e.body_snippet || ''}`.toLowerCase();
              return /from\s+\d{1,2}(?:st|nd|rd|th)?\s+[a-z]+\s+onwards|dates\s+for\s+interview\s+are\s+not\s+confirmed|interview.*will\s+happen\s+soon/i.test(full);
            });

          if (!hasUpcomingInterviewEvent && !hasStaggeredCampusInterviews && subsequentSelectionEmails.length > 0) {
            computedStatus = 'rejected';
            // User was interviewed (matched in next-round / interview shortlist) but a
            // selection list came out afterwards without them → Interviewed · Not Selected
            computedRejectionNote = 'Interviewed · Not Selected';
          } else if (!hasUpcomingInterviewEvent && interviewTime > 0 && interviewTime < Date.now()) {
            computedStatus = 'shortlisted';
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
          const latestTestEmailTime = testEmails.reduce(
            (max, e) => Math.max(max, e.received_at ? new Date(e.received_at).getTime() : 0),
            0
          );
          const testTime = latestTestEventTime || testMatchTime || latestTestEmailTime;

          const referenceTestTime = testTime > 0 ? testTime : testMatchTime;
          const isMatchedInPostTestRound = postTestShortlistEmails.some((e) =>
            roundForMatchedEmail(e as any, 'test') || roundForMatchedEmail(e as any, 'interview')
          );
          const subsequentPostTestEmails = [
            ...nextRoundEmails,
            ...postTestShortlistEmails,
          ].filter((e) => {
            const t = e.received_at ? new Date(e.received_at).getTime() : 0;
            return referenceTestTime > 0 ? t > (referenceTestTime + 30 * 60 * 1000) : t > 0;
          });

          if (!hasUpcomingTestEvent && (subsequentPostTestEmails.length > 0 || (postTestShortlistEmails.length > 0 && !isMatchedInPostTestRound))) {
            computedStatus = 'rejected';
            // User was shortlisted for the test (matched in test email) but a post-test
            // round email came without them → Eliminated in Test Round
            computedRejectionNote = 'Eliminated in Test Round';
          } else if (!hasUpcomingTestEvent && selectionEmails.some((e) =>
            Boolean(e.received_at && new Date(e.received_at).getTime() > referenceTestTime + 30 * 60 * 1000))) {
            computedStatus = 'rejected';
            computedRejectionNote = 'Eliminated in Test Round';
          } else if (!hasUpcomingTestEvent && testTime > 0 && testTime < Date.now()) {
            // A completed test is not a rejection. Only an explicit result or a
            // later shortlist/selection round can establish elimination.
            computedStatus = 'test_completed';
          } else {
            computedStatus = 'test_scheduled';
          }
        } else if (hasConfirmedRegistration) {
          if (preTestShortlistEmails.length > 0) {
            // An explicit pre-test shortlist was published and candidate was not in it
            computedStatus = 'not_shortlisted';
          } else if (selectionEmails.length > 0 || nextRoundEmails.length > 0 || postTestShortlistEmails.length > 0) {
            // A subsequent round was published after an open test round.
            // Only mark as 'Eliminated in Test Round' if the candidate was CONFIRMED to have
            // sat the test (isMatchedInTest). A company-wide test announcement email in the
            // inbox is NOT evidence the candidate personally took the test — it's a broadcast.
            // Without a positive ID match in the test round, keep not_shortlisted.
            if (isMatchedInTest) {
              const testEvents = allExtractedEvents.filter(
                (e) => ['online_test', 'coding_test'].includes(e.eventType) && e.startTime
              );
              const hasUpcomingTestEvent = testEvents.some((e) => Boolean(e.startTime && e.startTime.getTime() > Date.now()));
              if (!hasUpcomingTestEvent) {
                computedStatus = 'rejected';
                computedRejectionNote = 'Eliminated in Test Round';
              } else {
                computedStatus = 'test_scheduled';
              }
            } else {
              // No confirmed test participation → genuinely not shortlisted
              computedStatus = 'not_shortlisted';
            }

          } else if (testEmails.length > 0) {
            const testEvents = allExtractedEvents.filter(
              (e) => ['online_test', 'coding_test'].includes(e.eventType) && e.startTime
            );
            const hasUpcomingTestEvent = testEvents.some((e) => Boolean(e.startTime && e.startTime.getTime() > Date.now()));
            const latestTestEventTime = testEvents.reduce(
              (max, e) => Math.max(max, e.startTime ? e.startTime.getTime() : 0),
              0
            );

            if (!hasUpcomingTestEvent && latestTestEventTime > 0 && latestTestEventTime < Date.now()) {
              computedStatus = 'test_completed';
            } else {
              computedStatus = 'test_scheduled';
            }
          } else if (hasPptEvent) {
            computedStatus = 'ppt_scheduled';
          } else {
            computedStatus = 'applied';
          }
        } else {
          // Candidate NEVER confirmed registration and is not withdrawn!
          // A candidate who never applied CANNOT be shortlisted, tested, or eliminated!
          const now = Date.now();
          const regDeadlineTime = finalRegDeadline ? new Date(finalRegDeadline).getTime() : 0;
          if (regDeadlineTime > now) {
            computedStatus = 'registration_open';
          } else {
            computedStatus = 'not_applied';
          }
        }



        // GUARD: Reprocess only has access to email subjects + body snippets — it cannot
        // re-scan Excel attachments. The archive scanner (and the live sync status-engine)
        // CAN scan rosters and write not_shortlisted directly onto applications. Without
        // this guard, reprocess would overwrite that verdict back to test_scheduled/applied
        // on every cron cycle. Preserve not_shortlisted unless the user's own emails show
        // concrete positive evidence of shortlisting (a personal match in a roster).
        const hasPositiveCandidateEvidence = isMatchedInTest || isMatchedInNextRound || isMatchedInSelectionList ||
          (candidateMatchesByDriveId.get(drive.id) || []).length > 0;

        const hasDriveShortlistEvidence =
          testShortlistEmails.length > 0 ||
          testEmails.length > 0 ||
          nextRoundEmails.length > 0 ||
          selectionEmails.length > 0 ||
          activeDriveEmails.some((e) =>
            /shortlist|selection\s*list|selected\s*(?:candidates|students)|test\s*schedule/i.test(
              `${e.subject || ''} ${e.body_snippet || ''}`
            )
          );

        if (
          !existingApp?.manual_override &&
          !options?.recalculateStatusesFromRemainingEvidence &&
          existingApp?.status === 'not_shortlisted' &&
          ['test_scheduled', 'ppt_scheduled', 'applied'].includes(computedStatus) &&
          !hasPositiveCandidateEvidence &&
          hasDriveShortlistEvidence
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
        const isPhantomNotShortlisted =
          !existingApp?.manual_override &&
          (existingApp?.status === 'not_shortlisted' || existingApp?.status === 'rejected') &&
          (!hasConfirmedRegistration || (computedStatus === 'applied' && !hasDriveShortlistEvidence) || computedStatus === 'not_applied' || computedStatus === 'registration_open');

        const isPhantomRejection =
          (!existingApp?.manual_override &&
          existingApp?.status === 'rejected' &&
          computedStatus === 'not_shortlisted') ||
          isPhantomNotShortlisted;

        const isEvidenceBackedTerminal =
          ['rejected', 'selected', 'offer_received'].includes(computedStatus) &&
          hasPriorCandidateEvidence;
        const monotonicStatus = existingApp?.manual_override
          ? existingApp.status
          : (!options?.recalculateStatusesFromRemainingEvidence && !isPhantomRejection && existingApp?.status && computedPriority < existingPriority && !isEvidenceBackedTerminal)
            ? existingApp.status
            : computedStatus;

        let finalStatus = monotonicStatus;
        const roundVerdicts = await calculateDriveRoundVerdicts(supabase, userId, drive.id, activeDriveEmails);
        const currentRoundVerdict = getCurrentRoundDecision(roundVerdicts) as (typeof roundVerdicts)[number] | undefined;
        const roundNumbers = roundEventNumbers(roundVerdicts);
        if (currentRoundVerdict && !existingApp?.manual_override) {
          if (!currentRoundVerdict.finalNegative) computedRejectionNote = null;
          // Missing/unparsed rosters cannot prove elimination or reset earlier verified progress.
          let verdictBaseline = computedStatus;
          if (currentRoundVerdict.state === 'deferred' && hasConfirmedRegistration) {
            const priorMatch = roundVerdicts.slice(0,-1).findLast(verdict => verdict.eligible);
            verdictBaseline = priorMatch ? statusForRoundVerdict(priorMatch, 'applied') : hasPptEvent ? 'ppt_scheduled' : 'applied';
          }
          finalStatus = statusForRoundVerdict(currentRoundVerdict, verdictBaseline, false, roundVerdicts);
          if (currentRoundVerdict.eligible && !['withdrawn','declined','selected','offer_received'].includes(finalStatus)) {
            const sourceEvents = extractedByEmail.filter(({ e }) => currentRoundVerdict.evaluations.some((scan) => scan.emailId === (e.college_email_id || e.canonical_email_id || e.id) && scan.state === 'verified_present')).flatMap(({ events }) => events).filter(event => isRoundEventEligible(currentRoundVerdict, event.eventType));
            const nextEvent = sourceEvents.find((event) => event.hasExplicitTime && event.startTime && event.startTime.getTime() > Date.now());
            if (nextEvent) {
              finalStatus = /interview/.test(nextEvent.eventType) ? 'interview_scheduled' : /test/.test(nextEvent.eventType) ? 'test_scheduled' : finalStatus;
            } else {
              const pastTestEvent = sourceEvents.find((event) => /test/.test(event.eventType) && event.startTime && event.startTime.getTime() < Date.now());
              const pastPptEvent = sourceEvents.find(event => event.eventType === 'ppt' && event.startTime && (event.endTime || new Date(event.startTime.getTime()+90*60000)).getTime() <= Date.now());
              const pastInterviewEvent = sourceEvents.find((event) => /interview/.test(event.eventType) && event.startTime && event.startTime.getTime() < Date.now());
              if (pastInterviewEvent) {
                finalStatus = 'interview_completed';
              } else if (pastTestEvent) {
                finalStatus = 'test_completed';
              } else if (pastPptEvent && currentRoundVerdict.roundType === 'ppt') {
                finalStatus = 'ppt_completed';
              }
            }
          }
        }

        if (currentRoundVerdict && !existingApp?.manual_override && currentRoundVerdict.state === 'verified_absent') {
          const displayed = resolveRecruitmentStatus(finalStatus, roundVerdicts);
          computedRejectionNote = displayed === 'rejected_test' ? 'Eliminated in Test Round'
            : displayed === 'rejected_interview' ? 'Interviewed · Not Selected'
            : displayed === 'not_shortlisted_post_ppt' ? 'eliminated_at:post_ppt' : null;
        }

        let finalRole = existingApp?.manual_override ? existingApp.role : extractedJob.role;
        finalRole = cleanRoleTitle(finalRole);

        // Travel/venue instructions evolve over the drive lifecycle. Prefer the newest
        // active email that explicitly states a venue/mode, rather than freezing the
        // value from the original registration circular.
        const newestFirstTravelTexts = [...activeDriveEmails]
          .sort((a, b) => new Date(b.received_at || 0).getTime() - new Date(a.received_at || 0).getTime())
          .map((email) => `${email.subject || ''}\n${(email as any).body_text || email.body_snippet || ''}`);
        const travelReq = extractLatestTravelRequirement(newestFirstTravelTexts) ||
          (mainEmailText ? extractTravelRequirement(mainEmailText) : null) ||
          extractTravelRequirement(combinedEmailText);
        const recognizedTravelNote = /^(?:bhopal|bhopal_lab|online|vellore|chennai|ap|respective_campus)$/i;
        const existingTravel = existingApp?.notes
          ? existingApp.notes.split('\n').map((l: string) => l.trim()).find((l: string) => recognizedTravelNote.test(l)) || null
          : null;
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

        // Extract announced recruitment process from circulars (e.g. Test 1, Test 2, Game Round, Interview)
        let announcedRounds = mainEmailText ? parseRecruitmentProcess(mainEmailText) : null;
        if (!announcedRounds && collegeCompanyEmails.length > 0) {
          for (const cEmail of collegeCompanyEmails) {
            const text = `${cEmail.subject || ''}\n${(cEmail as any).body_text || cEmail.body_snippet || ''}`;
            announcedRounds = parseRecruitmentProcess(text);
            if (announcedRounds) break;
          }
        }
        if (!announcedRounds && combinedEmailText) {
          announcedRounds = parseRecruitmentProcess(combinedEmailText);
        }
        if (!announcedRounds && collegeCompanyEmails.length > 0) {
          announcedRounds = extractAnnouncedRoundsFromEmails(collegeCompanyEmails);
        }

        const announcedProcessToken = announcedRounds
          ? buildAnnouncedProcessToken(announcedRounds)
          : (existingApp?.notes?.split('\n').find((l: string) => l.trim().startsWith('announced_process:')) || null);

        // Build the final notes value:
        // - For manual override: preserve existing notes verbatim, adding announced process if not present.
        // - For computed rejection states: the rejection context note is the authoritative first line;
        //   travel mode (if known) is appended as a second line so it isn't lost.
        // - Otherwise: travel note is used as-is.
        // - Announced process token is preserved / appended across all application records.
        let finalNotes: string | null;
        if (existingApp?.manual_override) {
          const previousNotes = existingApp?.notes || '';
          let baseNotes = shouldRefreshTravelMode && travelReq
            ? refreshTravelModeNote(previousNotes, travelReq)
            : previousNotes;
          if (announcedProcessToken && !baseNotes.includes('announced_process:')) {
            baseNotes = baseNotes ? `${baseNotes}\n${announcedProcessToken}` : announcedProcessToken;
          }
          finalNotes = baseNotes || null;
        } else {
          const noteParts: string[] = [];
          if (computedRejectionNote) {
            noteParts.push(computedRejectionNote);
            if (finalTravel) noteParts.push(finalTravel);
          } else if (finalTravel) {
            noteParts.push(finalTravel);
          }
          if (announcedProcessToken && !noteParts.some((p) => p.startsWith('announced_process:'))) {
            noteParts.push(announcedProcessToken);
          }
          finalNotes = noteParts.length > 0 ? noteParts.join('\n') : null;
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



        const appPayload: Record<string, any> = {
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
          applied_at: hasConfirmedRegistration
            ? (registrationEmails[0]?.received_at ? new Date(registrationEmails[0].received_at).toISOString() : (existingApp?.applied_at || new Date().toISOString()))
            : null,
          last_updated: new Date().toISOString(),
        };

        if (!existingApp?.manual_override) appPayload.extraction_evidence = buildExtractionProvenance(activeDriveEmails, {role:finalRole,ctc:finalCtc,stipend:finalStipend,location:workLocation,eligibility:appPayload.eligibility,branches:appPayload.branches,cgpa_requirement:appPayload.cgpa_requirement,backlog_requirement:appPayload.backlog_requirement});
        if (appPayload.extraction_evidence && deadlineWinner) appPayload.extraction_evidence.registration_deadline = {value:finalRegDeadline,sourceEmailId:deadlineWinner.e.college_email_id || deadlineWinner.e.canonical_email_id || deadlineWinner.e.id,sourceReceivedAt:deadlineWinner.e.received_at,parserVersion:3,confidence:deadlineWinner.event.hasExplicitTime?'high':'date_only'};

        // Enrich placement_drives with the latest extracted job metadata from all linked circulars
        // (regardless of whether this specific user applied to this drive or not)
        await supabase.from('placement_drives').update({
          extraction_evidence: appPayload.extraction_evidence || undefined,
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
        const hasCandidateMatch = userCandidateMatches.some((match) =>
          isShortlistMatchEvidence({
            matchType: match.match_type,
            matchedValue: match.matched_value,
            matchedRoundType: match.matched_round_type,
          })
        );

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

        // The status transition is committed with its verdict and event diff below.
        if (currentRoundVerdict && existingApp?.id && !existingApp.manual_override) {
          delete appPayload.status;
          delete appPayload.status_source;
          delete appPayload.status_confidence;
          delete appPayload.status_source_email_at;
        }
        await assertMutationLease();
        const applicationWrite = existingApp?.id
          ? await supabase.from('applications').update(appPayload).eq('id', existingApp.id)
          : await supabase.from('applications').insert(appPayload);
        if (applicationWrite.error) throw applicationWrite.error;


        const driveFieldUpdates: Record<string, any> = {};
        if (finalRole && !drive.role) driveFieldUpdates.role = finalRole;
        if (workLocation && !drive.location) driveFieldUpdates.location = workLocation;
        if (finalCtc && !drive.ctc) driveFieldUpdates.ctc = finalCtc;
        if (finalStipend && !drive.stipend) driveFieldUpdates.stipend = finalStipend;
        if (Object.keys(driveFieldUpdates).length > 0) {
          await supabase.from('placement_drives').update(driveFieldUpdates).eq('id', drive.id);
        }

        const manualEvents = manualEventsByDriveId.get(drive.id) || [];

        const eventsToInsert: Array<Record<string, unknown>> = [];

        const isOptedOut = ['declined', 'withdrawn'].includes(finalStatus);

        {
          const sortedEmails = [...activeDriveEmails].sort((a, b) => {
            const tA = a.received_at ? new Date(a.received_at).getTime() : 0;
            const tB = b.received_at ? new Date(b.received_at).getTime() : 0;
            return tA - tB;
          });

          const latestEventsByType = new Map<string, any>();
          for (const e of sortedEmails) {
            const sourceRef = e.college_email_id || e.canonical_email_id || e.id;
            const sourceVerdict = roundVerdicts.find((verdict) => verdict.eligible && verdict.evaluations.some((scan) => scan.emailId === sourceRef && scan.state === 'verified_present'));
            const sourceOrdinal = extractExplicitOrdinal(e.subject || '', e.body_snippet || '');
            const sourceRoundType = classifyShortlistEmail(e.subject || '', e.body_snippet || '');
            const establishedNumber = sourceRoundType === 'game' ? 50 : sourceOrdinal?.roundNumber || (sourceRoundType === 'test_r2' || sourceRoundType === 'interview_r2' ? 2 : null);
            const establishedEvent = establishedNumber ? latestEventsByType.get((/interview/.test(sourceRoundType || '') ? 'technical_interview' : 'online_test') + ':' + establishedNumber) : null;
            const evts = extractScopedEvents({
              gmailMessageId: e.id,
              establishedRoundDate: establishedEvent?.startTime || null,
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
            }, comp.name, (remainingCompanies || []).map((company) => company.name));

            for (const rawEvt of evts) {
              if (/test|interview|ppt|group_discussion/.test(rawEvt.eventType) && !isRoundEventEligible(sourceVerdict, rawEvt.eventType)) continue;
              const evt = {
                ...rawEvt,
                _sourceReceivedAt: e.received_at || null,
              _collegeEmailId:
                  (e as { college_email_id?: string | null }).college_email_id ||
                  (e as { canonical_email_id?: string | null }).canonical_email_id ||
                  null,
              };
              if (!evt.startTime || !evt.hasExplicitTime) continue;
              if (isOptedOut && evt.startTime.getTime()>Date.now()) continue;
              if (evt.eventType === 'registration_deadline') continue;

              const ordinal = extractExplicitOrdinal(e.subject || '', e.body_snippet || '');
              const sourceRound = classifyShortlistEmail(e.subject || '', e.body_snippet || '');
              const eventRound = (sourceVerdict && roundNumbers.get(sourceVerdict.roundKey)) || (sourceRound === 'game' ? 50 : ordinal?.roundNumber || (sourceRound === 'test_r2' || sourceRound === 'interview_r2' ? 2 : 1));
              const normalizedType =
                evt.eventType === 'coding_test' || evt.eventType === 'online_test'
                  ? 'online_test'
                  : evt.eventType;
              const normalizedKey = `${normalizedType}:${eventRound}`;
              Object.assign(evt, { _roundNumber: eventRound, _roundLabel: ordinal?.roundLabel || (sourceRound === 'game' ? 'Game round' : null), _roundKey: sourceVerdict?.roundKey || null });
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

          if (deadlineWinner) {
            latestEventsByType.set('registration_deadline', {
              ...deadlineWinner.event,
              _collegeEmailId: deadlineWinner.isCollege
                ? ((deadlineWinner.e as { college_email_id?: string | null }).college_email_id ||
                  (deadlineWinner.e as { canonical_email_id?: string | null }).canonical_email_id ||
                  null)
                : null,
            });
          }

          for (const gEvt of currentRoundVerdict?.eligible ? gsheetEventsForCompany.filter((event) => event.hasExplicitTime) : []) {
            latestEventsByType.set('online_test', {
              eventType: gEvt.eventType,
              title: gEvt.title,
              startTime: gEvt.startTime,
              endTime: null,
              venue: gEvt.venue,
              mode: gEvt.mode,
              confidence: gEvt.confidence,
              hasExplicitTime: gEvt.hasExplicitTime,
              _collegeEmailId: null,
            });
          }

          const manualEventTypes = new Set(
            (manualEvents || []).map((m) =>
              m.event_type === 'coding_test' ? 'online_test' : m.event_type
            )
          );


          const emittedEventIdentity = new Set<string>();
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
              finalStatus === 'not_applied' &&
              normalizedKey !== 'ppt' &&
              normalizedKey !== 'registration_deadline'
            ) {
              continue;
            }

            if (
              finalStatus === 'not_shortlisted' && evt.startTime.getTime()>Date.now() &&
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

            const emittedKey = `${evt.eventType}:${evt.startTime.toISOString()}`;
            if (emittedEventIdentity.has(emittedKey)) continue;
            emittedEventIdentity.add(emittedKey);

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
              round_number: evt._roundNumber || 1,
              round_label: evt._roundLabel || null,
              round_key: evt._roundKey || null,
              college_email_id: evt._collegeEmailId ?? null,
              source_email_received_at: evt._sourceReceivedAt || null,
              extraction_evidence: {parserVersion:3,sourceEmailId:evt._collegeEmailId || null,sourceReceivedAt:evt._sourceReceivedAt || null,roundKey:evt._roundKey || null,hasExplicitTime:evt.hasExplicitTime || false},
            });
          }

        }
        if (currentRoundVerdict) {
          await commitDriveRoundVerdicts(supabase, userId, drive.id, comp.name, roundVerdicts, finalStatus, Boolean(options?.suppressNotifications), eventsToInsert);
        } else {
          // Parser corrections can remove a bogus decision (e.g. an eligibility invitation
          // previously classified as an offer). It must stop driving the UI and alert outbox.
          const obsolete = await supabase.from('round_verdicts').update({ is_current: false })
            .eq('user_id', userId).eq('placement_drive_id', drive.id).eq('is_current', true);
          if (obsolete.error) throw obsolete.error;
          await reconcileDriveEvents(supabase, userId, drive.id, eventsToInsert);
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

  await dispatchCalendarRemovals(supabase, userId);
  console.log(`[recalculateApplicationStatuses] User ${userId}: holistic calculation updated ${updatedAppsCount} applications.`);
  return { updatedCount: updatedAppsCount, results: applicationResults };
}

/**
 * Phase 5: Catches up any notifications for recent placement drives, events, or shortlists
 * that were missed due to sync errors, extraction bugs, or transient failures.
 *
 * Safety Guards:
 * - Age Guard: ONLY inspects drives / emails received within the last 48 hours or events scheduled in the future / last 24h.
 * - Deduplication Guard: Checks against existing dedupe_keys in the notifications table. Already-sent alerts are never repeated.
 * - Category & Stage Guard: Adheres to user notification preferences and candidate elimination stages.
 */
export async function catchUpMissingNotifications(
  supabase: any,
  userId: string
): Promise<{ newDrivesNotified: number; eventsNotified: number; shortlistsNotified: number }> {
  let newDrivesNotified = 0;
  let eventsNotified = 0;
  let shortlistsNotified = 0;

  const now = Date.now();
  const maxEmailAgeMs = 48 * 60 * 60 * 1000; // 48 hours
  const recentThresholdIso = new Date(now - maxEmailAgeMs).toISOString();

  // 1. Fetch user candidate identity (Neo ID / registration number)
  const candidateIdentity = await loadUserCandidateIdentity(supabase, userId);
  const userNeoId = candidateIdentity.neoId || candidateIdentity.emails[0] || '';

  // 2. Fetch user's active applications
  const { data: userApps } = await supabase
    .from('applications')
    .select('id, placement_drive_id, status, role, ctc, stipend, location, notes, category')
    .eq('user_id', userId);

  if (!userApps || userApps.length === 0) {
    return { newDrivesNotified, eventsNotified, shortlistsNotified };
  }

  const driveIds = userApps.map((a: any) => a.placement_drive_id).filter(Boolean);
  if (driveIds.length === 0) {
    return { newDrivesNotified, eventsNotified, shortlistsNotified };
  }

  // 3. Fetch placement drives & company names
  const { data: placementDrives } = await supabase
    .from('placement_drives')
    .select('id, drive_name, company_id, created_at, source_college_email_id')
    .in('id', driveIds);

  const drivesMap = new Map<string, any>((placementDrives || []).map((d: any) => [d.id, d]));
  const companyIds = Array.from(
    new Set((placementDrives || []).map((d: any) => d.company_id).filter(Boolean))
  );

  const { data: companies } = await supabase
    .from('companies')
    .select('id, name')
    .in('id', companyIds);

  const companyMap = new Map<string, any>((companies || []).map((c: any) => [c.id, c.name]));

  // 4. Pre-fetch all existing notification dedupe_keys for this user
  const { data: existingNotifs } = await supabase
    .from('notifications')
    .select('dedupe_key')
    .eq('user_id', userId);

  const existingDedupeKeys = new Set(
    (existingNotifs || []).map((n: any) => n.dedupe_key).filter(Boolean)
  );

  const { notifyNewDrive, notifyEventScheduled, notifyShortlistMatch } = await import(
    '@/lib/notifications/service'
  );
  const { getDriveMode } = await import('@/lib/utils');

  // 5. Evaluate each tracked drive for missing notifications
  for (const app of userApps as any[]) {
    const driveId = app.placement_drive_id;
    const drive: any = drivesMap.get(driveId);
    if (!drive) continue;

    const companyName = (drive.company_id && companyMap.get(drive.company_id)) || drive.drive_name || 'Placement Drive';

    // A. Check for missing New Drive notification
    const newDriveDedupeKey = `new_drive:${userId}:${driveId}`;
    if (!existingDedupeKeys.has(newDriveDedupeKey)) {
      // Check personal emails for this drive
      const { data: pEmail } = await supabase
        .from('personal_emails')
        .select('id, received_at')
        .eq('user_id', userId)
        .eq('placement_drive_id', driveId)
        .gte('received_at', recentThresholdIso)
        .order('received_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let isRecent = Boolean(pEmail);
      let sourceEmailId = pEmail?.id;

      if (!isRecent && drive.source_college_email_id) {
        const { data: cEmail } = await supabase
          .from('college_emails')
          .select('id, received_at')
          .eq('id', drive.source_college_email_id)
          .gte('received_at', recentThresholdIso)
          .maybeSingle();

        if (cEmail) {
          isRecent = true;
          sourceEmailId = cEmail.id;
        }
      }

      if (!isRecent && drive.created_at && now - new Date(drive.created_at).getTime() <= maxEmailAgeMs) {
        isRecent = true;
      }

      if (isRecent) {
        const driveMode = getDriveMode(app.notes as string);
        await notifyNewDrive({
          userId,
          placementDriveId: driveId,
          companyName,
          role: app.role || null,
          ctc: app.ctc || null,
          stipend: app.stipend || null,
          location: app.location || null,
          driveMode,
          category: app.category || null,
          sourceEmailId,
        });
        existingDedupeKeys.add(newDriveDedupeKey);
        newDrivesNotified++;
      }
    }

    // B. Check for missing Event notifications
    const { data: driveEvents } = await supabase
      .from('events')
      .select('id, event_type, title, start_time, venue, mode')
      .eq('user_id', userId)
      .eq('placement_drive_id', driveId);

    for (const evt of (driveEvents || []) as any[]) {
      if (!evt.start_time) continue;
      if (evt.event_type === 'registration_deadline') continue;

      const evtStartMs = new Date(evt.start_time).getTime();
      const isUpcomingOrRecent = evtStartMs >= now - 24 * 60 * 60 * 1000;
      if (!isUpcomingOrRecent) continue;

      const dateKey = new Date(evt.start_time).toISOString();
      const eventDedupeKey = `event:${userId}:${driveId}:${evt.id || evt.event_type}:${dateKey}:${(evt.venue || '').trim().toLowerCase()}`;

      if (!existingDedupeKeys.has(eventDedupeKey)) {
        await notifyEventScheduled({
          userId,
          placementDriveId: driveId,
          companyName,
          eventType: evt.event_type,
          startTime: new Date(evt.start_time),
          venue: evt.venue,
          eventId: evt.id,
          candidateConfirmed: ['shortlisted', 'test_scheduled', 'interview_scheduled'].includes(app.status),
        });
        existingDedupeKeys.add(eventDedupeKey);
        eventsNotified++;
      }
    }

  }
  // Only committed, current, round-specific transitions can be replayed.
  await dispatchRoundNotificationOutbox(supabase, userId);

  return { newDrivesNotified, eventsNotified, shortlistsNotified };
}

export async function performReprocess(...args: Parameters<typeof performReprocessUnlocked>) {
  return withQueryMetrics('reprocess', () => withUserMutationLease(args[0], () => performReprocessUnlocked(...args)));
}

async function performReprocessUnlocked(
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

  // Purge any irrelevant spam personal emails first
  await supabase
    .from('personal_emails')
    .delete()
    .eq('user_id', userId)
    .eq('classification', 'irrelevant');

  // 2. Fetch ALL stored emails for this user with automatic pagination.
  // Full content lives in college_emails after body_snippet was capped at 500 chars.
  const rawReprocessEmails: any[] = [];
  const pageSize = 1000;
  let page = 0;
  while (true) {
    const { data: chunk, error: chunkErr } = await supabase
      .from('personal_emails')
      .select('id, subject, sender, body_snippet, gmail_account_id, gmail_message_id, canonical_email_id, college_email_id, is_relevant, college_emails!personal_emails_college_email_id_fkey(body_text), rfc_message_id, classification, placement_drive_id, received_at, assignment_state, assignment_source')
      .eq('user_id', userId)
      .order('received_at', { ascending: true })
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (chunkErr) {
      console.error('[performReprocess] Error loading personal_emails:', chunkErr);
      break;
    }
    if (!chunk || chunk.length === 0) break;
    rawReprocessEmails.push(...chunk);
    if (chunk.length < pageSize) break;
    page++;
  }

  // Targeted RFC lookup: only query college_emails for RFC message IDs that lack foreign-key canonical bodies
  const bodyByMessageId = new Map<string, string>();
  if (rawReprocessEmails.length > 0) {
    const missingRfcIds = Array.from(new Set(
      rawReprocessEmails
        .filter((e) => {
          const canonical = Array.isArray(e.college_emails) ? e.college_emails[0] : e.college_emails;
          return !canonical?.body_text && Boolean(e.rfc_message_id);
        })
        .map((e) => e.rfc_message_id.toLowerCase().trim())
    ));

    if (missingRfcIds.length > 0) {
      for (let from = 0; from < missingRfcIds.length; from += 200) {
        const { data: canonicalBodies } = await supabase
          .from('college_emails')
          .select('message_id, body_text')
          .in('message_id', missingRfcIds.slice(from, from + 200));

        for (const canonical of canonicalBodies || []) {
          const key = canonical.message_id?.toLowerCase().trim();
          const text = canonical.body_text;
          if (key && text && !bodyByMessageId.has(key)) bodyByMessageId.set(key, text);
        }
      }
    }
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
    has_canonical_body?: boolean;
  }> = rawReprocessEmails.map((email: any) => {
    const canonical = Array.isArray(email.college_emails) ? email.college_emails[0] : email.college_emails;
    let fullBody = canonical?.body_text ||
      (email.rfc_message_id ? bodyByMessageId.get(email.rfc_message_id.toLowerCase().trim()) : null) || null;
    const hasCanonicalBody = Boolean(fullBody && fullBody.length > 500);
    if (!fullBody) {
      fullBody = email.body_snippet || '';
    }
    return { ...email, body_snippet: fullBody, has_canonical_body: hasCanonicalBody };
  });

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
      .select('id, subject, sender_email, received_at, created_at, body_text, classification, parsed_company_name, parsed_drive_numbers')
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
      body_snippet: ce.body_text ? ce.body_text.slice(0, 500) : '',
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
      } else {
        // Refresh aliases if newly supported patterns (e.g. root brand stem) are missing
        const generatedAliases = extractCompanyAliases(companyName, comp.name, driveName);
        if (driveNumber && !generatedAliases.includes(driveNumber.toLowerCase())) {
          generatedAliases.push(driveNumber.toLowerCase());
        }
        const existingAliases = comp.aliases || [];
        const missingAliases = generatedAliases.filter((a) => !existingAliases.includes(a));
        if (missingAliases.length > 0) {
          const updatedAliases = [...existingAliases, ...missingAliases];
          comp.aliases = updatedAliases;
          companiesToUpdate.set(comp.id, { ...(companiesToUpdate.get(comp.id) || {}), aliases: updatedAliases });
          for (const a of missingAliases) {
            companiesByName.set(a.toLowerCase(), comp);
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
    .select('placement_drive_id, match_type, matched_value, matched_round_type')
    .eq('user_id', userId);

  const userAllowedDriveIds = new Set<string>(validDriveIdSet);
  for (const cm of (userCandidateMatches || [])) {
    if (
      cm.placement_drive_id &&
      isShortlistMatchEvidence({
        matchType: cm.match_type,
        matchedValue: cm.matched_value,
        matchedRoundType: cm.matched_round_type,
      })
    ) {
      userAllowedDriveIds.add(cm.placement_drive_id);
    }
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
          // Also check aliases and root stem
          const aliasesToCheck = [
            ...(comp.aliases || []),
            comp.name.replace(/\s+(?:research|analytics|technologies|technology|services|service|solutions|solution|consulting|group|capital|systems|system|labs|lab)\b/gi, '').replace(/\s*(?:&|and)\s*$/i, '').trim(),
          ];
          for (const alias of aliasesToCheck) {
            if (!alias || alias.length < 4 || isInvalidCompanyName(alias)) continue;
            const aEscaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(`(?:^|[^a-z0-9])${aEscaped}(?:[^a-z0-9]|$)`, 'i').test(subjectLower)) {
              matchedCompId = cId;
              break;
            }
          }
          if (matchedCompId) break;
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
            if (isCircularAllowedByScheduledDate(subject, dStart?.getTime(), 7, (email as any).body_text || bodySnippet)) {
              matchedDriveId = compDrives[0].id;
            }
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
          // and reject circulars with scheduled date in distant past
          const eligibleDrives = candidateDrives.filter((d: any) => {
            const dStart = driveDateMap.get(d.id);
            if (!dStart) return true;
            if (dStart.getTime() > emailDate.getTime() + graceMs) return false;
            return isCircularAllowedByScheduledDate(subject, dStart.getTime(), 7, (email as any).body_text || bodySnippet);
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

      const isRegCircular = classification.classification === 'registration' || /registration/i.test(subject);
      const dStart = targetDriveObj ? driveDateMap.get(targetDriveObj.id) : null;
      const withinDateBoundary = !dStart || emailDate.getTime() >= (dStart.getTime() - 24 * 60 * 60 * 1000);
      if (targetDriveObj && !targetDriveObj.source_college_email_id && isRegCircular && withinDateBoundary) {
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



  // Reuse parsed canonical College attachments for only this user's evidenced
  // drives. Never rescan an individual College Gmail inbox during user reprocess.
  try {
    const { scanSharedCollegeCandidateMatches } = await import('@/lib/sync/attachment-scanner');
    await scanSharedCollegeCandidateMatches(supabase, userId);
  } catch (scanErr) {
    console.warn('[performReprocess] Shared shortlist scan non-critical error:', scanErr);
  }

  // 6. Phase 4: Recalculate Stage Progression & Events for Official NeoPAT Drives
  const phase4Res = await recalculateApplicationStatuses(
  userId,
  onProgress,
  {
    suppressNotifications: true,
  }
);
  const updatedAppsCount = phase4Res.updatedCount;
  const applicationResults = phase4Res.results || [];
  onProgress?.({ step: 5, totalSteps: 5, message: 'Drive statuses updated. Checking catch-up notifications…' });

  // 7. Phase 5: Catch-up notifications for recent un-notified drives, events, and shortlists
  let catchUpStats = { newDrivesNotified: 0, eventsNotified: 0, shortlistsNotified: 0 };
  try {
    catchUpStats = await catchUpMissingNotifications(supabase, userId);
    if (catchUpStats.newDrivesNotified > 0 || catchUpStats.eventsNotified > 0 || catchUpStats.shortlistsNotified > 0) {
      console.log(`[performReprocess] User ${userId}: caught up missing notifications:`, catchUpStats);
    }
  } catch (notifErr: any) {
    console.warn('[performReprocess] Catch-up notifications non-critical warning:', notifErr.message);
  }

  return {
    success: true,
    message: `Successfully re-indexed: ${validDriveIdSet.size} official NeoPAT drives tracked`,
    neoPatDrivesCount: validDriveIdSet.size,
    deletedNonNeoPatCompanies: [],
    collegeCircularsLinked: collegeLinkedCount,
    collegeCircularsDiscarded: collegeDiscardedCount,
    updatedApplications: updatedAppsCount,
    results: applicationResults,
    catchUpNotifications: catchUpStats,
  };
}

