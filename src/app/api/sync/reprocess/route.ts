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
import { extractDriveNumber, extractEvents, extractJobDetails, extractTravelRequirement } from '@/lib/sync/events';
import { isFuzzyCompanyMatch } from '@/lib/sync/engine';
import {
  buildCircularCatalog,
  loadAllDriveResolutions,
  resolveDriveByTimingCorrelation,
} from '@/lib/sync/drive-correlator';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

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
 * standalone — called from the sync engine after all pages complete to correct any
 * status errors from incremental per-email processing.
 */
export async function recalculateApplicationStatuses(
  userId: string,
  onProgress?: (p: { step: number; totalSteps: number; message: string }) => void,
  options?: { deepGSheetScan?: boolean }
): Promise<{ updatedCount: number; results: Array<{ company: string; status: string; role?: string | null; ctc?: string | null }> }> {
  const supabase = createAdminClient();

  onProgress?.({
    step: 5,
    totalSteps: 5,
    message: `Recalculating application stages, CTCs & calendar events for official drives…`,
  });

  const { data: userData } = await supabase
    .from('users')
    .select('neo_id, email, name')
    .eq('id', userId)
    .single();

  const userNeoId = userData?.neo_id || null;
  const userEmail = userData?.email || '';

  if (!userEmail) return { updatedCount: 0, results: [] };

  // Fetch all emails for this user (paginated)
  const allEmails: Array<{
    id: string;
    subject: string | null;
    sender: string | null;
    body_snippet: string | null;
    classification: string | null;
    company_id: string | null;
    received_at: string | null;
  }> = [];

  const pageSize = 1000;
  let page = 0;
  while (true) {
    const { data: chunk, error: chunkErr } = await supabase
      .from('emails')
      .select('id, subject, sender, body_snippet, classification, company_id, received_at')
      .eq('user_id', userId)
      .order('received_at', { ascending: true })
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (chunkErr || !chunk || chunk.length === 0) break;
    allEmails.push(...chunk);
    if (chunk.length < pageSize) break;
    page++;
  }

  if (allEmails.length === 0) return { updatedCount: 0, results: [] };

  // Run comprehensive company deduplication pass before status calculation
  try {
    const { deduplicateUserCompanies } = await import('@/lib/sync/dedup');
    await deduplicateUserCompanies(supabase, userId);
  } catch (dedupErr) {
    console.warn('[recalculateApplicationStatuses] Pre-calculation dedup warning:', dedupErr);
  }

  const { data: remainingCompanies } = await supabase
    .from('companies')
    .select('id, name, drive_number')
    .eq('user_id', userId);

  if (!remainingCompanies || remainingCompanies.length === 0) return { updatedCount: 0, results: [] };

  // Deduplicate rogue companies ending with UG/PG or duplicate names if base company exists
  for (const c of remainingCompanies) {
    if (/\b(?:ug|pg)\b/i.test(c.name)) {
      const baseName = c.name.replace(/\s+(?:ug|pg)\b.*$/i, '').trim();
      const baseComp = remainingCompanies.find(
        (other) => other.id !== c.id && other.name.toLowerCase() === baseName.toLowerCase()
      );
      if (baseComp) {
        await supabase.from('emails').update({ company_id: baseComp.id }).eq('company_id', c.id);
        await supabase.from('applications').delete().eq('company_id', c.id);
        await supabase.from('events').delete().eq('company_id', c.id);
        await supabase.from('notifications').delete().eq('company_id', c.id);
        await supabase.from('companies').delete().eq('id', c.id);
        c.id = baseComp.id;
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
    .select('id, match_type, email_id, matched_value')
    .eq('user_id', userId);

  const emailsByCompanyId = new Map<string, typeof allEmails>();
  for (const e of allEmails) {
    if (e.company_id) {
      const list = emailsByCompanyId.get(e.company_id) || [];
      list.push(e);
      emailsByCompanyId.set(e.company_id, list);
    }
  }

  let updatedAppsCount = 0;
  const applicationResults: Array<{ company: string; status: string; role?: string | null; ctc?: string | null }> = [];

  const uniqueCompanies = Array.from(new Map(remainingCompanies.map((c) => [c.id, c])).values());

  for (let cIdx = 0; cIdx < uniqueCompanies.length; cIdx++) {
    const comp = uniqueCompanies[cIdx];
    const companyEmails = emailsByCompanyId.get(comp.id) || [];
    if (companyEmails.length === 0) continue;

    if (cIdx % 5 === 0 || cIdx === uniqueCompanies.length - 1) {
      onProgress?.({
        step: 5,
        totalSteps: 5,
        message: `Recalculating application stages, CTCs & calendar events (${cIdx + 1} / ${uniqueCompanies.length})…`,
      });
    }

    const emailIds = new Set(companyEmails.map((e) => e.id));
    const matchedEmailIds = new Set(
      (candidateMatches || [])
        .filter((cm) => emailIds.has((cm as unknown as { email_id: string }).email_id))
        .map((cm) => (cm as unknown as { email_id: string }).email_id)
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
          (cm) => (cm as unknown as { email_id: string }).email_id === email.id
        );
        if (alreadyMatched) continue;

        const gUrls = extractGoogleSheetUrls(emailText);
        for (const gUrl of gUrls) {
          const gMatch = await scanGoogleSheetForCandidate(gUrl, userEmail, userNeoId, userData?.name);
          if (gMatch && gMatch.matched) {
            matchedEmailIds.add(email.id);
            const matchExists = (candidateMatches || []).some(
              (cm) => (cm as unknown as { email_id: string }).email_id === email.id
            );
            if (!matchExists) {
              await supabase.from('candidate_matches').insert({
                user_id: userId,
                email_id: email.id,
                neo_id: userNeoId || userEmail,
                match_type: 'xlsx_cell',
                matched_value: gMatch.details,
                confidence: 'high',
              });
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
    const isPersonalNeoPatEmail = (e: { sender?: string | null }) =>
      /noreply\.cdcinfo@vitstudent\.ac\.in/i.test(e.sender || '');
    const collegeCompanyEmails = chronologicalCompanyEmails.filter((e) => !isPersonalNeoPatEmail(e));

    const isRegistrationCircular = (e: { subject?: string | null; body_snippet?: string | null }) => {
      const text = `${e.subject || ''}\n${e.body_snippet || ''}`;
      return (
        (/name\s+of\s+the\s+company/i.test(text) && /category/i.test(text)) ||
        /super\s*dream.*registration|dream.*registration|placement\s+registration|internship\s+registration/i.test(
          e.subject || ''
        )
      );
    };

    const mainCircularEmail =
      collegeCompanyEmails.find((e) => {
        const text = `${e.subject || ''}\n${e.body_snippet || ''}`;
        return (
          /name\s+of\s+the\s+company/i.test(text) &&
          /eligibility\s+criteria/i.test(text) &&
          /category/i.test(text)
        );
      }) ||
      collegeCompanyEmails.find((e) =>
        /super\s*dream.*registration|dream.*registration|placement\s+registration|internship\s+registration|offer\s+registration/i.test(e.subject || '')
      ) ||
      collegeCompanyEmails.find((e) =>
        /date\s+of\s+visit/i.test(e.body_snippet || '') || /registration/i.test(e.subject || '')
      ) ||
      collegeCompanyEmails[0] || chronologicalCompanyEmails[0];

    const registrationCirculars = collegeCompanyEmails.filter(isRegistrationCircular);
    registrationCirculars.sort(
      (a, b) => new Date(a.received_at || 0).getTime() - new Date(b.received_at || 0).getTime()
    );
    const driveRegistrationEmail = registrationCirculars[0] || mainCircularEmail;
    const driveStartDate = driveRegistrationEmail?.received_at
      ? new Date(driveRegistrationEmail.received_at)
      : null;

    const activeDriveEmails = chronologicalCompanyEmails.filter((e) =>
      !driveStartDate || new Date(e.received_at || 0).getTime() >= driveStartDate.getTime()
    );
    const personalCompanyEmails = chronologicalCompanyEmails.filter(isPersonalNeoPatEmail);
    activeDriveEmails.push(...personalCompanyEmails);

    const mainEmailText = `${mainCircularEmail.subject || ''}\n${mainCircularEmail.body_snippet || ''}`;
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
    };

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

    const withdrawalEmails = companyEmails.filter((e) => {
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

    const registrationEmails = companyEmails.filter((e) => {
      const subj = (e.subject || '').toLowerCase();
      const full = `${subj} ${e.body_snippet || ''}`.toLowerCase();
      const isPersonalNeoPat = /noreply\.cdcinfo@vitstudent\.ac\.in/i.test(e.sender || '');
      const driveMatches = !comp.name.match(/sdet|sre|sap|gds|aerospace/i) ||
        !comp.drive_number || new RegExp(comp.drive_number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(`${e.subject || ''} ${e.body_snippet || ''}`);
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
      /interview\s+(?:is\s+)?scheduled|technical\s+interview|hr\s+interview|final\s+interview|interview\s+shortlist|shortlist\s+for\s+interview|shortlisted\s+for\s+(?:the\s+)?interview/i;
    const nextRoundEmails = activeDriveEmails.filter((e) => {
      if (!isAfterRegistration(e)) return false;
      const subj = e.subject || '';
      const body = e.body_snippet || '';
      const full = `${subj} ${body}`;
      if (nextRoundPattern.test(subj)) return true;
      if (/next\s+round/i.test(subj)) {
        // Only classify as nextRound (interview) if it DOES NOT describe a test/assessment
        return !/test|assessment|coding|exam|shl|mettl|hackerrank|aptitude/i.test(full);
      }
      return false;
    });

    const isInterviewOrSelectionEmail = (e: { subject?: string | null; body_snippet?: string | null }) => {
      return nextRoundPattern.test(e.subject || '') || selectionListPattern.test(e.subject || '');
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
        /online\s+test\s*[:\-–—]?\s*\d+\s*(?:mins?|minutes?)/i.test(full) &&
        !/(?:test|assessment)\s+(?:is\s+)?scheduled\s+(?:on|for)|\bon\s+\d{1,2}[-/.]\d{1,2}/i.test(full)
      ) {
        return false;
      }

      // 4. If email explicitly states date will be informed later and has no test date
      if (
        /date\s+of\s+visit\s*[:\-–—]?\s*will\s+be\s+informed|will\s+be\s+informed\s+later/i.test(full) &&
        !/(?:test|assessment)\s+(?:is\s+)?scheduled\s+(?:on|for)|\bon\s+\d{1,2}[-/.]\d{1,2}/i.test(full)
      ) {
        return false;
      }

      // 5. Positive body test schedule triggers
      const hasBodySchedule =
        /(?:online\s+)?(?:test|assessment|exam)\s+(?:is\s+)?scheduled\s+(?:on|for)/i.test(b) ||
        /(?:online\s+)?(?:test|assessment|exam)\s+on\s+\d{1,2}[-/.]\d{1,2}/i.test(b) ||
        /test\s+will\s+be\s+conducted\s+on\s+\d{1,2}/i.test(b) ||
        /test\s+link\s*[:\-–—]|assessment\s+link\s*[:\-–—]|login\s+window|test\s+window\s*[:\-–—]|test\s+credentials/i.test(b) ||
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
        .map((m) => (m as unknown as { email_id: string }).email_id)
        .filter(Boolean)
    );

    const sortedSelectionEmails = [...selectionEmails].sort(
      (a, b) => (a.received_at ? new Date(a.received_at).getTime() : 0) - (b.received_at ? new Date(b.received_at).getTime() : 0)
    );
    const isMatchedInSelectionList = sortedSelectionEmails.some((e) => matchedShortlistEmailIds.has(e.id));

    const sortedNextRoundEmails = [...nextRoundEmails].sort(
      (a, b) => (a.received_at ? new Date(a.received_at).getTime() : 0) - (b.received_at ? new Date(b.received_at).getTime() : 0)
    );
    const isMatchedInNextRound = sortedNextRoundEmails.some((e) => matchedShortlistEmailIds.has(e.id));

    const hasCompanyCandidateMatch = activeDriveEmails.some((e) => matchedEmailIds.has(e.id));

    const sortedTestShortlists = [...testShortlistEmails].sort(
      (a, b) => (a.received_at ? new Date(a.received_at).getTime() : 0) - (b.received_at ? new Date(b.received_at).getTime() : 0)
    );

    let isMatchedInTest = false;
    if (sortedTestShortlists.length > 0) {
      const latestTestShortlistEmail = sortedTestShortlists[sortedTestShortlists.length - 1];
      isMatchedInTest = matchedShortlistEmailIds.has(latestTestShortlistEmail.id);
    }
    if (!isMatchedInTest) {
      isMatchedInTest =
        testShortlistEmails.some((e) => matchedShortlistEmailIds.has(e.id)) ||
        testEmails.some((e) => matchedShortlistEmailIds.has(e.id));
    }
    // FALLBACK: A candidate_match may have been stored as 'xlsx_applied_list' when the
    // email body clearly indicates a shortlist (e.g. "Please find the attached shortlisted
    // students list") but the filename lacked "shortlist" (e.g. "apex test 22-08-2026.xlsx").
    // matchedEmailIds includes ALL match_types; testShortlistEmails is independently derived
    // from body content — so if any match exists for a confirmed shortlist email, trust it.
    if (!isMatchedInTest) {
      isMatchedInTest = testShortlistEmails.some((e) => matchedEmailIds.has(e.id));
    }
    if (hasDirectPersonalTestInvitation) {
      isMatchedInTest = true;
    }

    const hasGSheetTestEvent = gsheetEventsForCompany.some((g) => g.eventType === 'online_test');
    if (hasGSheetTestEvent) {
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
    // - 'rejected' + 'Eliminated in Test Round' note  → rejected_test (wrote test, failed)
    // - 'rejected' + 'Interviewed · Not Selected' note → rejected_interview (interviewed, not selected)
    // - 'not_shortlisted'                              → not shortlisted for test (pre-test screening)
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
      if (subsequentSelectionEmails.length > 0) {
        computedStatus = 'rejected';
        // User was interviewed (matched in next-round / interview shortlist) but a
        // selection list came out afterwards without them → Interviewed · Not Selected
        computedRejectionNote = 'Interviewed · Not Selected';
      } else {
        computedStatus = 'interview_scheduled';
      }
    } else if (isMatchedInTest) {
      const testMatchTime = Math.max(latestPositiveMatchEmailTime, latestGsheetTime);
      const hasUpcomingTestEvent = allExtractedEvents.some((e) => {
        const isTest = ['online_test', 'coding_test'].includes(e.eventType);
        return isTest && e.startTime && e.startTime.getTime() > Date.now();
      });
      const subsequentPostTestEmails = [...selectionEmails, ...nextRoundEmails].filter((e) => {
        const t = e.received_at ? new Date(e.received_at).getTime() : 0;
        return t > (testMatchTime + 30 * 60 * 1000);
      });
      if (!hasUpcomingTestEvent && subsequentPostTestEmails.length > 0) {
        computedStatus = 'rejected';
        // User was shortlisted for the test (matched in test email) but a post-test
        // round email came without them → Eliminated in Test Round
        computedRejectionNote = 'Eliminated in Test Round';
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
          // No match in test emails → likely a general schedule announcement without
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

    const { data: existingApp } = await supabase
      .from('applications')
      .select('status, manual_override, role, ctc, stipend, location, notes, applied_at')
      .eq('user_id', userId)
      .eq('company_id', comp.id)
      .single();

    // GUARD: Reprocess only has access to email subjects + body snippets — it cannot
    // re-scan Excel attachments. The live sync (status-engine) CAN scan attachments and
    // correctly marks candidates as not_shortlisted when their ID is absent from a
    // shortlist Excel. Without this guard, reprocess would overwrite a sync-computed
    // not_shortlisted back to test_scheduled/applied every 15 min cron cycle.
    // Preserve not_shortlisted unless there is concrete positive evidence of shortlisting.
    if (
      !existingApp?.manual_override &&
      existingApp?.status === 'not_shortlisted' &&
      ['test_scheduled', 'ppt_scheduled', 'applied'].includes(computedStatus) &&
      !isMatchedInTest &&
      !isMatchedInNextRound &&
      !isMatchedInSelectionList
    ) {
      computedStatus = 'not_shortlisted';
    }

    const finalStatus = existingApp?.manual_override ? existingApp.status : computedStatus;

    let finalRole = existingApp?.manual_override ? existingApp.role : extractedJob.role;
    if (finalRole && (
      /\byou\s*(?:are|have|re)\b|dear\s|greetings|eligible|registr|for the candidate|reserve a position|expect them/i.test(finalRole) ||
      /^(?:focuses on|includes|details\b|we would like|the role|job description)\b/i.test(finalRole.trim()) ||
      /^(?:super\s+dream|dream|regular)(?:\s+(?:internship|offer|placement|drive))?$/i.test(finalRole.trim())
    )) {
      finalRole = null;
    }

    const travelReq = extractTravelRequirement(mainEmailText) || extractTravelRequirement(combinedEmailText);
    const existingTravel = existingApp?.notes ? existingApp.notes.split('\n')[0]?.trim() : null;
    const hasCampusLabEvent = allExtractedEvents.some((e) => /campus\s*\/\s*offline|\blc\s*\d+\b|\blab\b/i.test(e.venue || ''));
    const hasOnlineEvent = allExtractedEvents.some((e) => e.mode === 'online' || /online|virtual/i.test(e.venue || ''));

    let finalTravel = existingApp?.manual_override ? (existingApp?.notes || null) : travelReq;
    if (!finalTravel) {
      if (hasCampusLabEvent) finalTravel = 'bhopal';
      else if (hasOnlineEvent) finalTravel = 'online';
      else if (existingTravel && ['bhopal', 'bhopal_lab', 'online', 'vellore', 'chennai', 'ap'].includes(existingTravel)) {
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
      finalNotes = existingApp?.notes || null;
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
        /^(?:vit\s+)?(?:vellore|chennai|bhopal)(?:\s+campus)?$/i.test(workLocation.trim()))
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

    await supabase.from('applications').upsert(
      {
        user_id: userId,
        company_id: comp.id,
        status: finalStatus,
        status_source: existingApp?.manual_override ? 'manual_override' : 'sync_reprocess',
        status_confidence: 'high',
        manual_override: Boolean(existingApp?.manual_override),
        role: finalRole,
        category: finalCategory,
        ctc: finalCtc,
        stipend: finalStipend,
        location: workLocation || null,
        notes: finalNotes,
        applied_at: (registrationEmails[0]?.received_at ? new Date(registrationEmails[0].received_at) : (driveStartDate || (existingApp?.applied_at ? new Date(existingApp.applied_at) : new Date()))).toISOString(),
        last_updated: new Date().toISOString(),
      },
      { onConflict: 'user_id,company_id' }
    );

    const { data: manualEvents } = await supabase
      .from('events')
      .select('*')
      .eq('user_id', userId)
      .eq('company_id', comp.id)
      .eq('manual_override', true);

    await supabase
      .from('events')
      .delete()
      .eq('user_id', userId)
      .eq('company_id', comp.id)
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

      for (const evt of Array.from(latestEventsByType.values())) {
        const normalizedKey =
          evt.eventType === 'coding_test' || evt.eventType === 'online_test'
            ? 'online_test'
            : evt.eventType;

        if (manualEventTypes.has(normalizedKey)) {
          continue;
        }

        if (finalStatus === 'not_shortlisted' && normalizedKey !== 'ppt') {
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

        await supabase.from('events').insert({
          user_id: userId,
          company_id: comp.id,
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
    }

    updatedAppsCount++;
    applicationResults.push({
      company: comp.name,
      status: finalStatus,
      role: finalRole,
      ctc: extractedJob.ctc,
    });
  }

  console.log(`[recalculateApplicationStatuses] User ${userId}: holistic calculation updated ${updatedAppsCount} applications.`);
  return { updatedCount: updatedAppsCount, results: applicationResults };
}

export async function performReprocess(
  userId: string,
  onProgress?: (p: { step: number; totalSteps: number; message: string }) => void
) {
  const supabase = createAdminClient();

  onProgress?.({
    step: 1,
    totalSteps: 5,
    message: 'Cleaning recipient matches & fetching stored circulars…',
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

  // 2. Fetch ALL stored emails for this user with automatic pagination
  const emails: Array<{
    id: string;
    subject: string | null;
    sender: string | null;
    body_snippet: string | null;
    classification: string | null;
    company_id: string | null;
    received_at: string | null;
  }> = [];

  const pageSize = 1000;
  let page = 0;
  while (true) {
    const { data: chunk, error: chunkErr } = await supabase
      .from('emails')
      .select('id, subject, sender, body_snippet, classification, company_id, received_at')
      .eq('user_id', userId)
      .order('received_at', { ascending: true })
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (chunkErr || !chunk || chunk.length === 0) break;
    emails.push(...chunk);
    if (chunk.length < pageSize) break;
    page++;
  }

  if (emails.length === 0) {
    return { success: true, message: 'No emails found to reprocess', fixed: 0 };
  }

  // Separate emails into NeoPAT emails (noreply.cdcinfo@vitstudent.ac.in) and College circulars
  const isNeoPatSender = (sender: string) => /noreply\.cdcinfo@vitstudent\.ac\.in/i.test(sender);

  const neoPatEmails = emails.filter((e) => isNeoPatSender(e.sender || ''));
  // Process NeoPAT circulars chronologically so registration & eligibility emails establish drive identity
  neoPatEmails.sort((a, b) => new Date(a.received_at || 0).getTime() - new Date(b.received_at || 0).getTime());
  const collegeEmails = emails.filter((e) => !isNeoPatSender(e.sender || ''));

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
    message: `Analyzing ${neoPatEmails.length} official NeoPAT drives & resolving track numbers…`,
  });

  // Pre-load all existing user companies into memory to avoid thousands of slow DB roundtrips
  const { data: initialDbCompanies } = await supabase
    .from('companies')
    .select('id, name, aliases, drive_number, drive_name, updated_at')
    .eq('user_id', userId);

  const cachedCompanies: Array<{
    id: string;
    name: string;
    aliases: string[];
    drive_number: string | null;
    drive_name: string | null;
    activeDriveDate: Date;
  }> = (initialDbCompanies || []).map((c) => {
    const cleanAliases = extractCompanyAliases(c.name, c.name, c.drive_name);
    if (c.drive_number && !cleanAliases.includes(c.drive_number.toLowerCase())) {
      cleanAliases.push(c.drive_number.toLowerCase());
    }
    return {
      id: c.id,
      name: c.name,
      aliases: cleanAliases.map((a: string) => a.toLowerCase()),
      drive_number: c.drive_number || null,
      drive_name: c.drive_name || null,
      activeDriveDate: new Date(c.updated_at || 0),
    };
  });

  const validCompanyMap = new Map<string, { id: string; canonicalName: string; activeDriveDate: Date }>();
  const driveNumberToCompanyMap = new Map<string, { id: string; canonicalName: string; activeDriveDate: Date }>();
  const validCompanyIdSet = new Set<string>();
  const emailUpdates: Array<{ id: string; company_id: string | null; classification: string; is_relevant: boolean }> = [];

  const companiesToUpdate = new Map<string, { aliases?: string[]; drive_number?: string; drive_name?: string | null; name?: string }>();
  const driveResolutionsToUpsert = new Map<string, any>();

  // Sanitize cached company names with legacy drive suffixes (e.g. "Euler Motors (1170)")
  for (const c of cachedCompanies) {
    if (/\s*\(\d+\)\s*$/.test(c.name)) {
      const cleanName = c.name.replace(/\s*\(\d+\)\s*$/, '').trim();
      c.name = cleanName;
      companiesToUpdate.set(c.id, { ...(companiesToUpdate.get(c.id) || {}), name: cleanName });
    }
  }

  // Synchronize freshly sanitized aliases to DB to wipe out poisoned legacy aliases
  for (const c of cachedCompanies) {
    companiesToUpdate.set(c.id, {
      ...(companiesToUpdate.get(c.id) || {}),
      aliases: c.aliases,
    });
  }

  // Populate maps from initial companies
  for (const c of cachedCompanies) {
    const compObj = { id: c.id, canonicalName: c.name, activeDriveDate: c.activeDriveDate };
    validCompanyMap.set(c.name.toLowerCase(), compObj);
    for (const a of c.aliases) {
      validCompanyMap.set(a.toLowerCase(), compObj);
    }
    if (c.drive_number) {
      driveNumberToCompanyMap.set(c.drive_number, compObj);
    }
  }

  for (let idx = 0; idx < neoPatEmails.length; idx++) {
    const email = neoPatEmails[idx];
    if (idx % 30 === 0 || idx === neoPatEmails.length - 1) {
      onProgress?.({
        step: 2,
        totalSteps: 5,
        message: `Analyzing official NeoPAT drives (${idx + 1}/${neoPatEmails.length})…`,
      });
    }

    const subject = email.subject || '';
    const sender = email.sender || '';
    const bodySnippet = email.body_snippet || '';
    const emailDate = email.received_at ? new Date(email.received_at) : new Date();
    const fullEmailText = `${subject}\n${bodySnippet}`;
    const driveNumber = extractDriveNumber(fullEmailText);
    const driveNameMatch = fullEmailText.match(/Drive Name:\s*([^.\n\r]+)/i);
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

    // If this NeoPAT email has a drive number and was identified with a base company (like 'Apple' or 'Honeywell'),
    // run timing correlation against circular catalog to resolve specific track (e.g. Apple SDET vs Apple SRE)
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
      let comp: { id: string; canonicalName: string; activeDriveDate: Date } | undefined;

      // 1. Primary Identity Anchor: Check if drive_number matches an already established company
      if (driveNumber && driveNumberToCompanyMap.has(driveNumber)) {
        comp = driveNumberToCompanyMap.get(driveNumber);
      }

      // 1.5 Check if an existing company in memory has this drive_number directly
      if (!comp && driveNumber) {
        const existingDriveComp = cachedCompanies.find(
          (c) => c.drive_number?.toLowerCase() === driveNumber.toLowerCase()
        );
        if (existingDriveComp) {
          comp = { id: existingDriveComp.id, canonicalName: existingDriveComp.name, activeDriveDate: emailDate };
          driveNumberToCompanyMap.set(driveNumber, comp);
        }
      }

      // 2. Name-based lookup if no drive_number match
      if (!comp) {
        if (driveNumber) {
          const existing = validCompanyMap.get(normalized.toLowerCase());
          if (existing) {
            let boundToAnother = false;
            for (const [dNum, cObj] of driveNumberToCompanyMap.entries()) {
              if (cObj.id === existing.id && dNum !== driveNumber) {
                boundToAnother = true;
                break;
              }
            }
            if (!boundToAnother) {
              comp = existing;
            }
          }
        } else {
          comp = validCompanyMap.get(normalized.toLowerCase());
        }
      }

      if (!comp && !driveNumber) {
        for (const [validKey, cObj] of validCompanyMap.entries()) {
          if (normalized.split(/\s+/).length === 1 && cObj.canonicalName.split(/\s+/).length > 2) {
            continue;
          }
          if (isFuzzyCompanyMatch(validKey, normalized) || isFuzzyCompanyMatch(cObj.canonicalName, normalized)) {
            comp = cObj;
            break;
          }
        }
      }

      if (!comp) {
        // In-memory check against existing DB companies
        const existingComp = cachedCompanies.find((c) => c.name.toLowerCase() === normalized.toLowerCase());
        let boundToAnother = false;
        if (existingComp && driveNumber) {
          for (const [dNum, cObj] of driveNumberToCompanyMap.entries()) {
            if (cObj.id === existingComp.id && dNum !== driveNumber) {
              boundToAnother = true;
              break;
            }
          }
        }

        if (existingComp && !boundToAnother) {
          comp = { id: existingComp.id, canonicalName: normalized, activeDriveDate: emailDate };
        } else {
          // Check aliases in memory
          const aliasMatch = !driveNumber
            ? cachedCompanies.find((c) => c.aliases.includes(normalized.toLowerCase()))
            : null;

          if (aliasMatch) {
            comp = { id: aliasMatch.id, canonicalName: normalized, activeDriveDate: emailDate };
            aliasMatch.name = normalized;
            companiesToUpdate.set(aliasMatch.id, { name: normalized });
          } else {
            // Check existing companies with fuzzy match in memory
            let dbFuzzyMatch: (typeof cachedCompanies)[0] | null = null;
            for (const uc of cachedCompanies) {
              if (isFuzzyCompanyMatch(uc.name, normalized)) {
                let ucBoundToAnother = false;
                if (driveNumber) {
                  for (const [dNum, cObj] of driveNumberToCompanyMap.entries()) {
                    if (cObj.id === uc.id && dNum !== driveNumber) {
                      ucBoundToAnother = true;
                      break;
                    }
                  }
                }
                if (!ucBoundToAnother) {
                  dbFuzzyMatch = uc;
                  break;
                }
              }
            }

            if (dbFuzzyMatch) {
              const chosenCanonical = normalized.length > dbFuzzyMatch.name.length ? normalized : dbFuzzyMatch.name;
              comp = { id: dbFuzzyMatch.id, canonicalName: chosenCanonical, activeDriveDate: emailDate };
              if (chosenCanonical !== dbFuzzyMatch.name) {
                dbFuzzyMatch.name = chosenCanonical;
                companiesToUpdate.set(dbFuzzyMatch.id, { name: chosenCanonical });
              }
            } else {
              // Create new legitimate NeoPAT company in DB
              const generatedAliases = extractCompanyAliases(companyName, normalized);
              if (driveNumber && !generatedAliases.includes(driveNumber.toLowerCase())) {
                generatedAliases.push(driveNumber.toLowerCase());
              }

              let { data: newComp, error: insertError } = await supabase
                .from('companies')
                .insert({
                  user_id: userId,
                  name: normalized,
                  aliases: generatedAliases,
                  drive_number: driveNumber || null,
                  drive_name: driveName || null,
                })
                .select('id, name')
                .single();

              if (insertError) {
                if (insertError.code === '23505') {
                  // Unique constraint violation — NEVER create a suffixed name.
                  // Look up the existing company by drive_number, then by name.
                  let existingId: string | null = null;
                  if (driveNumber) {
                    const { data: driveOwner } = await supabase
                      .from('companies')
                      .select('id, name')
                      .eq('user_id', userId)
                      .eq('drive_number', driveNumber)
                      .maybeSingle();
                    if (driveOwner) {
                      existingId = driveOwner.id;
                      newComp = driveOwner;
                    }
                  }
                  if (!existingId) {
                    const { data: nameOwner } = await supabase
                      .from('companies')
                      .select('id, name')
                      .eq('user_id', userId)
                      .eq('name', normalized)
                      .maybeSingle();
                    if (nameOwner) {
                      existingId = nameOwner.id;
                      newComp = nameOwner;
                    }
                  }
                }
              }

              if (newComp) {
                comp = { id: newComp.id, canonicalName: newComp.name, activeDriveDate: emailDate };
                cachedCompanies.push({
                  id: newComp.id,
                  name: newComp.name,
                  aliases: generatedAliases.map((a) => a.toLowerCase()),
                  drive_number: driveNumber || null,
                  drive_name: driveName || null,
                  activeDriveDate: emailDate,
                });
              }
            }
          }
        }
      } else {
        if (emailDate > comp.activeDriveDate) {
          comp.activeDriveDate = emailDate;
        }
      }

      if (comp) {
        validCompanyMap.set(comp.canonicalName.toLowerCase(), comp);
        validCompanyMap.set(normalized.toLowerCase(), comp);
        const aliases = extractCompanyAliases(companyName, comp.canonicalName);
        if (driveNumber && !aliases.includes(driveNumber.toLowerCase())) {
          aliases.push(driveNumber.toLowerCase());
        }
        for (const alias of aliases) {
          if (!validCompanyMap.has(alias.toLowerCase())) {
            validCompanyMap.set(alias.toLowerCase(), comp);
          }
        }
        if (driveNumber) {
          driveNumberToCompanyMap.set(driveNumber, comp);

          const existingUpdates = companiesToUpdate.get(comp.id) || {};
          companiesToUpdate.set(comp.id, {
            ...existingUpdates,
            aliases,
            drive_number: driveNumber,
            ...(driveName ? { drive_name: driveName } : {}),
          });

          driveResolutionsToUpsert.set(driveNumber, {
            drive_number: driveNumber,
            company_base_name: cleanCompanyName(companyName),
            resolved_role: comp.canonicalName,
            resolved_company_name: comp.canonicalName,
            resolved_via: 'direct_role_text',
            confidence: 'high',
            updated_at: new Date().toISOString(),
          });
        }
        validCompanyIdSet.add(comp.id);

        emailUpdates.push({
          id: email.id,
          company_id: comp.id,
          classification: classification.classification,
          is_relevant: true,
        });
      }
    } else {
      emailUpdates.push({
        id: email.id,
        company_id: null,
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

  // Flush queued drive_resolutions in a single batch
  if (driveResolutionsToUpsert.size > 0) {
    await supabase
      .from('drive_resolutions')
      .upsert(Array.from(driveResolutionsToUpsert.values()), { onConflict: 'drive_number' });
  }

  // 4. Phase 2: Purge ANY Company in DB that is NOT in the Official NeoPAT List
  onProgress?.({
    step: 3,
    totalSteps: 5,
    message: `Verified ${validCompanyIdSet.size} official NeoPAT drives. Purging non-NeoPAT entries…`,
  });

  const { data: currentDbCompanies } = await supabase
    .from('companies')
    .select('id, name')
    .eq('user_id', userId);

  const deletedCompanyNames: string[] = [];
  const invalidCompIds = (currentDbCompanies || [])
    .filter((comp) => !validCompanyIdSet.has(comp.id))
    .map((comp) => {
      deletedCompanyNames.push(comp.name);
      return comp.id;
    });

  if (invalidCompIds.length > 0) {
    await supabase.from('events').delete().eq('user_id', userId).in('company_id', invalidCompIds);
    await supabase.from('applications').delete().eq('user_id', userId).in('company_id', invalidCompIds);
    await supabase.from('notifications').delete().eq('user_id', userId).in('company_id', invalidCompIds);
    await supabase.from('companies').delete().eq('user_id', userId).in('id', invalidCompIds);
  }

  // 5. Phase 3: Match College Emails against Official NeoPAT Companies ONLY
  onProgress?.({
    step: 4,
    totalSteps: 5,
    message: `Matching ${collegeEmails.length} college circulars, test links & shortlists…`,
  });

  let collegeLinkedCount = 0;
  let collegeDiscardedCount = 0;

  for (const email of collegeEmails) {
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
    let matchedCompanyId: string | null = null;

    // 1. Primary Identity Anchor: Drive Number match
    if (driveNumber && driveNumberToCompanyMap.has(driveNumber)) {
      matchedCompanyId = driveNumberToCompanyMap.get(driveNumber)!.id;
    } else if (companyName) {
      const normalized = normalizeCompanyName(companyName).toLowerCase();

      // 2. Identify candidate matches across valid NeoPAT companies
      const uniqueComps = Array.from(new Map(Array.from(validCompanyMap.values()).map(c => [c.id, c])).values());
      const exactMatches = uniqueComps.filter(c => c.canonicalName.toLowerCase() === normalized);
      const fuzzyMatches = uniqueComps.filter(c => isFuzzyCompanyMatch(c.canonicalName, companyName));

      const candidateComps = exactMatches.length > 0 ? exactMatches : fuzzyMatches;

      if (candidateComps.length === 1) {
        matchedCompanyId = candidateComps[0].id;
      } else if (candidateComps.length > 1) {
        // If multiple drives match (e.g. July Zluri vs Sept Zluri SDET, or Apple SDET vs Apple SRE),
        // pick the drive whose active cycle is chronologically closest to this circular
        candidateComps.sort(
          (a, b) =>
            Math.abs(a.activeDriveDate.getTime() - emailDate.getTime()) -
            Math.abs(b.activeDriveDate.getTime() - emailDate.getTime())
        );
        matchedCompanyId = candidateComps[0].id;
      }
    }

    // 4. Reverse Search fallback: ONLY if no company was extracted at all from the email
    // (If an email was already confidently identified as another company like "Altair Engineering",
    // do NOT hijack it to a different company like "Siemens" just because the word appears in parentheses!)
    if (!matchedCompanyId && !companyName) {
      // Strip parenthetical corporate affiliations (e.g. "(A Siemens Company)", "(A Subsidiary of ...)")
      const sanitizedSubject = subject.replace(/\((?:a|an|the)?\s*[^)]*?(?:company|group|subsidiary|division)[^)]*\)/gi, ' ');
      const subjectLower = sanitizedSubject.toLowerCase();
      // Sort valid companies by canonical name length descending to match longest first
      const knownCompanies = Array.from(validCompanyMap.values()).sort((a, b) => b.canonicalName.length - a.canonicalName.length);
      
      for (const comp of knownCompanies) {
        if (comp.canonicalName.length < 4 || isInvalidCompanyName(comp.canonicalName)) continue; // Skip short or generic names
        const escaped = comp.canonicalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i');
        if (regex.test(subjectLower)) {
          matchedCompanyId = comp.id;
          break;
        }
      }
    }

    if (matchedCompanyId) {
      emailUpdates.push({
        id: email.id,
        company_id: matchedCompanyId,
        classification: classification.classification,
        is_relevant: true,
      });
      collegeLinkedCount++;
    } else {
      emailUpdates.push({
        id: email.id,
        company_id: null,
        classification: classification.classification,
        is_relevant: false,
      });
      collegeDiscardedCount++;
    }
  }

  // Fast Batch Update emails in grouped chunks
  const groupedUpdates = new Map<string, string[]>();
  for (const u of emailUpdates) {
    const key = `${u.company_id || 'null'}|${u.classification}|${u.is_relevant}`;
    if (!groupedUpdates.has(key)) groupedUpdates.set(key, []);
    groupedUpdates.get(key)!.push(u.id);
  }

  for (const [key, ids] of groupedUpdates.entries()) {
    const [compIdStr, cls, isRelStr] = key.split('|');
    const compId = compIdStr === 'null' ? null : compIdStr;
    const isRel = isRelStr === 'true';

    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await supabase
        .from('emails')
        .update({
          company_id: compId,
          classification: cls as any,
          is_relevant: isRel,
        })
        .in('id', chunk);
    }
  }

  // 6. Phase 4: Recalculate Stage Progression & Events for Official NeoPAT Companies
  const phase4Res = await recalculateApplicationStatuses(userId, onProgress);
  const updatedAppsCount = phase4Res.updatedCount;
  const applicationResults = phase4Res.results || [];

  return {
    success: true,
    message: `Successfully re-indexed: ${validCompanyIdSet.size} official NeoPAT drives tracked`,
    neoPatDrivesCount: validCompanyIdSet.size,
    deletedNonNeoPatCompanies: deletedCompanyNames,
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
    const stream = new ReadableStream({
      async start(controller) {
        let isClosed = false;
        const sendEvent = (event: string, data: unknown) => {
          if (isClosed) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            isClosed = true;
          }
        };

        const heartbeat = setInterval(() => {
          if (isClosed) return;
          try {
            controller.enqueue(encoder.encode(`: keep-alive\n\n`));
          } catch {
            isClosed = true;
          }
        }, 2000);

        try {
          sendEvent('start', { message: 'Analyzing placement archive & re-indexing drives…' });

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
          clearInterval(heartbeat);
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
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
  return POST(req);
}
