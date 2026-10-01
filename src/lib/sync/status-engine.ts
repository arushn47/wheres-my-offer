import {
  buildCandidateIdentity,
  matchesCandidateText,
  loadUserCandidateIdentity,
  type UserCandidateIdentity,
} from '@/lib/sync/user-identity';
import type { ParsedEmail } from '@/lib/gmail/client';
import { extractEvents, extractJobDetails, extractAllDriveNumbers, type ExtractedEvent } from '@/lib/sync/events';
import { createAdminClient } from '@/lib/supabase/admin';
import { isInactiveStatus } from '@/lib/stages';
import { deriveEventEndTime } from '@/lib/event-duration';
import { CANONICAL_IDENTITY_VERSION, CANONICAL_PARSER_VERSION, isApprovedCanonicalSender } from '@/lib/sync/canonical-email';
import {
  hasUserPlacementEvidence,
  isConfirmedShortlistEvidence,
  isShortlistMatchEvidence,
} from '@/lib/sync/participation-evidence';
import { evaluateCachedShortlistRosters } from '@/lib/sync/shortlist-verification';
import { removeDriveEvents } from '@/lib/sync/drive-events';
import { shouldReplaceRegistrationDeadline } from '@/lib/sync/events';
import { mergePdfJobDetails } from '@/lib/sync/pdf-parser';
import {
  type RoundType,
  classifyShortlistEmail,
  extractExplicitPredecessor,
  getPredecessorRequirement,
  buildEliminationToken,
  extractExplicitOrdinal,
  isRescheduleEmail,
  parseRecruitmentProcess,
  buildAnnouncedProcessToken,
} from '@/lib/sync/round-identity';

// existingApp select: add `registration_deadline`
/**
 * Converts HTML email content to clean plain text so table cells, divs, and paragraphs
 * containing Neo IDs or text are fully searchable.
 *
 * IMPORTANT: td/th cells are separated by spaces (not pipes). Using pipes causes adjacent
 * columns to merge Neo IDs into invalid strings like `Name|23BCE1234`, which breaks
 * word-boundary regex checks and causes false-negative ID misses in shortlist tables.
 */
function htmlToPlainText(html: string | undefined | null): string {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(tr|p|div|li)>/gi, '\n')
    .replace(/<(td|th)[^>]*>/gi, '   ') // spaces instead of pipes — prevents `Name|23BCE1234` ID merging
    .replace(/<\/?[a-z][a-z0-9]*[^<>]*>/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// RoundType is imported from round-identity.ts; ShortlistRound is kept as an alias
// for backward compatibility with any remaining references in this file.
type ShortlistRound = RoundType;

/**
 * Checks if the user's Neo ID or identity is mentioned in an email (subject, plain body, or HTML table).
 */
export function checkNeoIdMatch(
  text: string,
  userNeoId: string | null,
  userEmail: string,
  userName?: string | null,
  candidateIdentity?: UserCandidateIdentity
): { matched: boolean; matchedValue: string | null } {
  if (!text) return { matched: false, matchedValue: null };

  const identity = candidateIdentity || buildCandidateIdentity({
    neoId: userNeoId,
    emails: [userEmail],
    name: userName,
  });

  return matchesCandidateText(text, identity);
}

/**
 * Processes an email to extract events, job details, and update application status.
 *
 * @param supabase Admin client
 * @param userId User UUID
 * @param companyId Company UUID
 * @param email Parsed email
 * @param emailDbId DB UUID of the inserted email
 * @param userNeoId User's configured Neo ID
 * @param userEmail User's email
 */
export async function processEmailForEventsAndStatus(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  companyId: string,
  email: ParsedEmail,
  emailDbId: string,
  userNeoId: string | null,
  userEmail: string,
  placementDriveId?: string | null,
  gmail?: import('googleapis').gmail_v1.Gmail,
  mode?: string
) {
  let targetDriveId = placementDriveId || null;
  if (!targetDriveId) {
    const { data: drive } = await supabase
      .from('placement_drives')
      .select('id')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    targetDriveId = drive?.id || null;
  }
  if (!targetDriveId) return;
  let hasNotifiedEvent = false;

  const subjLower = email.subject.toLowerCase();
  const htmlText = htmlToPlainText(email.bodyHtml);
  const fullText = `${email.subject}\n${email.bodyPlain || ''}\n${htmlText}\n${email.bodySnippet || ''}`;

  const { classifyEmail } = await import('@/lib/sync/classifier');
  const emailClass = classifyEmail(email).classification;
  const isCollegeBroadcast = isApprovedCanonicalSender(email.senderEmail || email.sender);

  // Temporal filter removed. Idempotency requires that evaluating an email's effect
  // must depend purely on its own timestamp vs other emails in the transaction,
  // NOT on what currently exists in the DB from a previous sync pass.
  // The holistic status will be correctly converged during the batch recalculation.

  // 0. Early check of existing application status from DB
  const { data: existingApp } = await supabase
    .from('applications')
    .select('status, manual_override, applied_at, location, work_mode, ctc, role, stipend, notes, status_source_email_at, last_updated, eligibility, branches, cgpa_requirement, backlog_requirement, registration_deadline')
    .eq('user_id', userId)
    .eq('placement_drive_id', targetDriveId)
    .maybeSingle();

  const currentStatus = existingApp?.status || 'not_applied';
  const isOptedOut = currentStatus === 'withdrawn' || currentStatus === 'declined';
  const isNotApplied = currentStatus === 'not_applied';

  const isConfirmation =
    emailClass === 'registration_confirmation' ||
    /confirmed:\s*your\s+registration/i.test(subjLower) ||
    /registration\s+(confirmed|successful|received)/i.test(fullText) ||
    /successfully\s+registered|thank\s+you\s+for\s+(registering|applying)/i.test(fullText) ||
    /confirms?\s+(that\s+)?(you(r|'re)|your)\s+(successful\s+)?(registration|application)/i.test(fullText);

  const candidateIdentity = await loadUserCandidateIdentity(supabase, userId);

  // 1. Check for Neo ID match in email body / HTML tables / subject
  const bodyMatch = isCollegeBroadcast
    ? checkNeoIdMatch(fullText, userNeoId, userEmail, candidateIdentity.name, candidateIdentity)
    : { matched: false, matchedValue: null, matchLocation: null };
  let isNeoMatched = bodyMatch.matched;
  let isInAppliedList = false; // Matched in an applied/opt-in list (NOT a shortlist)
  let matchDetail: string | null = bodyMatch.matchedValue
    ? `Found ${bodyMatch.matchedValue} in email body selection list`
    : null;
  let matchType = 'email_body';

  // Compute isShortlistEmail early — needed both for attachment scanning context (below)
  // and for status computation logic further down.
  const isAppliedOrOptInRoster =
    /attached\s+(?:(?:final|updated|revised)\s+)?(?:applied|opt[\s-]*in|registered)\s+(?:students?|candidates?)\s+list|opt[\s-]*in\s+list/i.test(fullText) &&
    !/shortlist|shortlisted/i.test(subjLower);

  const isAppliedRosterFilename = (filename: string) =>
    /applied[_\s-]*list|opt[_\s-]*in[_\s-]*list|opt_in|eligible[_\s-]*student|registered[_\s-]*student|registration[_\s-]*list|applied[_\s-]*(?:student|candidate)/i.test(filename);
  const hasShortlistAttachment = Boolean(
    email.hasAttachments &&
    email.attachments.some((attachment) =>
      /shortlist|selection[_\s-]*list|test[_\s-]*shortlist|selected[_\s-]*student|shortlisted/i.test(attachment.filename) &&
      !isAppliedRosterFilename(attachment.filename)
    )
  );
  const hasUncachedRelevantExcelAttachment = email.attachments.some((attachment) =>
    /\.(xlsx|xls|csv)$/i.test(attachment.filename) &&
    !(attachment.parseStatus === 'complete' && attachment.extractedRows?.length)
  );
  const isSelectionOrResultNotice =
    emailClass === 'result' ||
    /selection\s*list|selected\s*candidates|final\s*selection|results?\s+announced|declared\s+the\s+results?/i.test(subjLower);

  const isExplicitShortlistNotice =
    emailClass === 'shortlist' ||
    isSelectionOrResultNotice ||
    /shortlist|selected\s+candidates|shortlisted\s+students|shortlist\s+for|candidates\s+shortlisted/i.test(
      subjLower
    ) ||
    // Body patterns — order matters: more specific first
    /find\s+the\s+(?:below\s+)?shortlist|below\s+is\s+the\s+shortlist|attached\s+list\s+of\s+shortlisted|shortlist\s+for\s+next\s+round/i.test(
      fullText
    ) ||
    // "attached shortlisted students/candidates list" (word "shortlisted" between "attached" and "students")
    /attached\s+(?:(?:updated|final|revised)\s+)?(?:shortlisted|selected)\s+(?:students?|candidates?)(?:\s+list)?/i.test(fullText) ||
    // "attached students/candidates list" (no qualifier — generic attachment shortlist)
    /attached\s+(?:students?|candidates?)\s+list/i.test(fullText) ||
    // "shortlisted students/candidates list" anywhere in body (e.g. Gmail snippet)
    /(?:shortlisted|selected)\s+(?:students?|candidates?)(?:\s+list)?/i.test(fullText);

  const hasCachedRelevantAttachment = email.attachments.some((attachment) => {
    if (!attachment.extractedRows?.length || attachment.parseStatus !== 'complete') return false;
    if (!/\.(xlsx|xls|csv)$/i.test(attachment.filename) || isAppliedRosterFilename(attachment.filename)) return false;
    return hasShortlistAttachment || isExplicitShortlistNotice ||
      /(?:online\s+)?(?:test|assessment|exam)\s+(?:is\s+)?(?:scheduled|shortlist|list)|interview\s+(?:is\s+)?(?:scheduled|shortlist|list)/i.test(subjLower);
  });
  const isShortlistEmail =
    (hasShortlistAttachment || isExplicitShortlistNotice || hasCachedRelevantAttachment) &&
    !isAppliedOrOptInRoster;
  const identityTokens = [
    userNeoId || '',
    userEmail.match(/([0-9]{2}[a-z]{3}[0-9]{4,5})/i)?.[1] || '',
    userEmail,
  ].filter(Boolean);
  const cachedRosterEvaluation = isCollegeBroadcast
    ? evaluateCachedShortlistRosters({
      rosters: email.attachments.map((attachment) => ({
        filename: attachment.filename,
        collegeEmailId: email.canonicalEmailId || emailDbId,
        parseStatus: attachment.parseStatus,
        extractedRows: attachment.extractedRows,
      })),
      shortlistContext: isShortlistEmail,
      identityTokens,
    })
    : null;
  const announcedRound = classifyShortlistEmail(email.subject, fullText);
  const emailExplicitPredecessor = extractExplicitPredecessor(email.subject, fullText);
  // predecessorTypes: the matched_round_type values that must exist for a meaningful elimination.
  // null → predecessor check is conditional on text evidence not found → use conservative path.
  // [] → no predecessor required (first competitive round).
  // [...] → query candidate_matches for these types.
  const predecessorTypes = getPredecessorRequirement(announcedRound, emailExplicitPredecessor);
  // Keep previousRound as a compat alias (used by the hasPreviousRoundMatch query below)
  const previousRound: RoundType | null =
    predecessorTypes && predecessorTypes.length > 0 ? predecessorTypes[0] : null;

  // Body-level ID matches in application/registration rosters are not
  // candidate participation evidence. This must run before status promotion.
  if (isAppliedOrOptInRoster && isNeoMatched) {
    isNeoMatched = false;
    isInAppliedList = true;
    matchType = 'xlsx_applied_list';
    matchDetail = matchDetail || 'Candidate found in applied/registered roster';
  }

  // 2. Scan Excel attachments whenever the email contains a shortlist/test/candidate list.
  // CRITICAL: Even if a student previously withdrew or opted out on NeoPAT, CDC often fails to
  // purge them from the database roster and still includes them in the official test shortlist (e.g. EY GDS).
  // If their Neo ID is present in the shortlist, they ARE shortlisted and must be notified!
  const isAttachmentRelevant =
    /shortlist|selection|eligible|candidate|student|list|test|assessment|interview|ppt|schedule|result|round|score/i.test(
      subjLower
    ) ||
    /shortlist|selection list|eligible candidates|attendance/i.test(fullText) ||
    email.attachments.some((a) =>
      /shortlist|selection|eligible|candidate|student|list|test|assessment|interview|schedule|result/i.test(
        a.filename
      )
    );

  if (
    !isNeoMatched &&
    gmail &&
    email.hasAttachments &&
    hasUncachedRelevantExcelAttachment &&
    isAttachmentRelevant
  ) {
    const { scanExcelAttachmentsForNeoId } = await import('@/lib/sync/excel-parser');
    const excelMatch = await scanExcelAttachmentsForNeoId(
      gmail,
      email.gmailMessageId,
      email.attachments.filter((attachment) =>
        /\.(xlsx|xls|csv)$/i.test(attachment.filename) &&
        !(attachment.parseStatus === 'complete' && attachment.extractedRows?.length)
      ),
      userNeoId,
      userEmail,
      isShortlistEmail  // Pass shortlist context so unnamed Excel files get correct classification
    );

    if (excelMatch && excelMatch.matched) {
      if (excelMatch.isActualShortlist) {
        // Matched in a real shortlist file → candidate is shortlisted
        isNeoMatched = true;
        matchType = 'xlsx_cell';
        matchDetail = excelMatch.details;
      } else {
        // Matched in an applied/opt-in list — confirms application/registration roster.
        // It does NOT qualify as a confirmed test/interview shortlist if an actual shortlist exists or is issued later.
        isInAppliedList = true;
        matchType = 'xlsx_applied_list';
        matchDetail = excelMatch.details;
      }
    }
  }

  // 2b. Check Google Sheets pubhtml shortlists in email text
  let gsheetEventToAdd: ExtractedEvent | null = null;
  if (!isNeoMatched) {
    const { extractGoogleSheetUrls, scanGoogleSheetForCandidate } = await import('@/lib/sync/gsheet-parser');
    const gUrls = extractGoogleSheetUrls(fullText);
    for (const gUrl of gUrls) {
      const gMatch = await scanGoogleSheetForCandidate(gUrl, userEmail, userNeoId, candidateIdentity.name, candidateIdentity);
      if (gMatch && gMatch.matched) {
        isNeoMatched = true;
        matchType = 'xlsx_cell';
        matchDetail = gMatch.details;
        if (gMatch.eventDate) {
          const isPpt = /ppt|pre[\s-]*placement/i.test(subjLower);
          const isInterview = /interview/i.test(subjLower);
          const eventType = isPpt ? 'ppt' : isInterview ? 'technical_interview' : 'online_test';
          const title = isPpt
            ? 'Pre-Placement Talk (PPT)'
            : isInterview
              ? 'Interview'
              : `Online Assessment${gMatch.slot ? ` (${gMatch.slot})` : ''}`;

          const startTime = new Date(gMatch.eventDate);
          startTime.setHours(gMatch.slot && /slot\s*2/i.test(gMatch.slot) ? 14 : 9, 0, 0, 0);
          gsheetEventToAdd = {
            eventType,
            title,
            startTime,
            endTime: null,
            venue: 'Campus / Offline',
            mode: 'online',
            confidence: 'high',
            hasExplicitTime: true,
          };
        }
        break;
      }
    }
  }

  // Downgrade body-text Neo ID matches inside elimination/rejection emails.
  // A Neo ID match inside a rejection-list body means "you were in the applicant
  // pool that got eliminated," not "you're confirmed for the next stage."
  const isEliminationEmail =
    emailClass === 'result' &&
    /not\s+selected|regret\s+to\s+inform|unfortunately|could\s+not\s+be\s+selected|not\s+shortlisted/i.test(fullText);

  if (isEliminationEmail) {
    isNeoMatched = false;
  }

  // Check direct personal test invitation received by user (e.g. from NeoPAT noreply.cdcinfo)
  const isPersonalNeoPatSender =
    /noreply\.cdcinfo@vitstudent\.ac\.in|vit\s*-\s*soft\s*skill\s*assessments/i.test(email.sender || '');
  const hasPersonalTestCredentials =
    isPersonalNeoPatSender &&
    (/test\s*link|assessment\s*link|login\s*window|exam\s*link|password|passkey/i.test(fullText) || emailClass === 'test');
  if (hasPersonalTestCredentials && !isNeoMatched) {
    isNeoMatched = true;
    matchType = 'email_body';
    matchDetail = 'Direct personal test invitation received from NeoPAT';
  }
  if (isEliminationEmail) isNeoMatched = false;

  // Resolve cached shared workbooks before the evidence gate and match insert.
  // Otherwise the first fan-out pass sees only an empty body match, returns, and
  // never persists the exact NeoID match found in the canonical attachment.
  // Resolved sheet+row location is hoisted so the candidate_matches insert below
  // can persist it for the drive UI.
  let rosterMatchLocation: string | null = null;
  if (!isNeoMatched && isCollegeBroadcast && cachedRosterEvaluation?.state === 'verified_present' && cachedRosterEvaluation.matchingRoster) {
    const filename = cachedRosterEvaluation.matchingRoster.filename;
    isNeoMatched = true;
    isInAppliedList = false;
    matchType = 'xlsx_cell';
    // Resolve the exact sheet+row inside the matched workbook so the drive UI can
    // show "Sheet1, row 14" instead of a bare filename.
    try {
      const { scanSharedCollegeAttachmentsForNeoId } = await import('@/lib/sync/excel-parser');
      const precise = await scanSharedCollegeAttachmentsForNeoId(
        supabase,
        email.canonicalEmailId || emailDbId,
        userNeoId,
        userEmail,
        isShortlistEmail
      );
      rosterMatchLocation = precise?.details && precise.details !== `Matched in ${filename}` ? precise.details : null;
    } catch {
      rosterMatchLocation = null;
    }
    matchDetail = rosterMatchLocation || `Matched in ${filename}`;
  }

  if (!isCollegeBroadcast && !isNeoMatched && email.hasAttachments && email.attachments.some((attachment) => attachment.extractedRows?.length)) {
    const { scanSharedCollegeAttachmentsForNeoId } = await import('@/lib/sync/excel-parser');
    const cachedResult = await scanSharedCollegeAttachmentsForNeoId(
      supabase,
      email.canonicalEmailId || emailDbId,
      userNeoId,
      userEmail,
      isShortlistEmail
    );
    if (cachedResult?.matched) {
      if (cachedResult.isActualShortlist) {
        isNeoMatched = true;
        matchType = 'xlsx_cell';
        matchDetail = cachedResult.details;
      } else {
        isInAppliedList = true;
        matchType = 'xlsx_applied_list';
        matchDetail = cachedResult.details;
      }
    }
  }

  const hasConfirmedCollegeShortlistMatch = isConfirmedShortlistEvidence({
    isCollegeBroadcast,
    isNeoMatched,
    isShortlistEmail,
    isInAppliedList,
    isEliminationEmail,
  });

  if (isCollegeBroadcast) {
    const [
      { count: personalDriveEmailCount, error: personalEvidenceError },
      { data: existingEvidenceApp, error: applicationEvidenceError },
      { data: existingCandidateMatches, error: candidateEvidenceError },
    ] = await Promise.all([
      supabase
        .from('personal_emails')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('placement_drive_id', targetDriveId),
      supabase
        .from('applications')
        .select('status, manual_override')
        .eq('user_id', userId)
        .eq('placement_drive_id', targetDriveId)
        .maybeSingle(),
      supabase
        .from('candidate_matches')
        .select('match_type, matched_value, matched_round_type')
        .eq('user_id', userId)
        .eq('placement_drive_id', targetDriveId),
    ]);

    if (personalEvidenceError) throw personalEvidenceError;
    if (applicationEvidenceError) throw applicationEvidenceError;
    if (candidateEvidenceError) throw candidateEvidenceError;

    const hasStoredShortlistMatch = (existingCandidateMatches || []).some((match) =>
      isShortlistMatchEvidence({
        matchType: match.match_type,
        matchedValue: match.matched_value,
        matchedRoundType: match.matched_round_type,
      })
    );

    const hasUserEvidence = hasUserPlacementEvidence({
      hasPersonalDriveEvidence: (personalDriveEmailCount || 0) > 0,
      hasConfirmedShortlistMatch: hasConfirmedCollegeShortlistMatch || hasStoredShortlistMatch,
      manualOverride: Boolean(existingApp?.manual_override || existingEvidenceApp?.manual_override),
    });

    // Shared College announcements enrich global catalog data only. Stop before
    // any user-scoped matches, events, application writes, or notifications unless
    // this student has Personal-email, actual shortlist, or manual evidence.
    if (!hasUserEvidence) return;
  }

  // Shortlist verdicts are written directly to applications.status by the archive
  // scanner (roster-absence) and below (roster-presence). No separate tracking state.

  if (isNeoMatched && isCollegeBroadcast && hasConfirmedCollegeShortlistMatch) {
    // Only record genuine shortlist matches (never applied/opt-in rosters)
    const matchPayload: any = {
      user_id: userId,
      placement_drive_id: targetDriveId,
      neo_id: userNeoId || userEmail,
      match_type: matchType,
      matched_round_type: (isShortlistEmail || hasPersonalTestCredentials) ? announcedRound : null,
      matched_value: matchDetail || email.subject.slice(0, 100),
      confidence: 'high',
    };
    if (rosterMatchLocation) matchPayload.match_location = rosterMatchLocation;
    if (isCollegeBroadcast) {
      matchPayload.college_email_id = emailDbId;
    } else {
      matchPayload.email_id = emailDbId;
    }

    const { error: candidateMatchError } = await supabase.from('candidate_matches').insert(matchPayload);
    if (candidateMatchError?.code === '23505' && announcedRound &&
      (isShortlistEmail || hasPersonalTestCredentials)) {
      const matchQuery = supabase.from('candidate_matches')
        .update({ matched_round_type: announcedRound })
        .eq('user_id', userId)
        .eq('placement_drive_id', targetDriveId)
        .eq('match_type', matchType);

      if (isCollegeBroadcast) {
        matchQuery.eq('college_email_id', emailDbId);
      } else {
        matchQuery.eq('email_id', emailDbId);
      }

      const { error: tagError } = await matchQuery;
      if (tagError) throw tagError;
    } else if (candidateMatchError) {
      throw candidateMatchError;
    }
  }

  // 3. Extract Events (PPT, Test, Interview) with Deduplication
  // Hoist extractedEvents so the status computation block can reference it
  const extractedEvents = extractEvents(email);
  if (gsheetEventToAdd) {
    extractedEvents.push(gsheetEventToAdd);
  }
  const regDeadlineEvt = extractedEvents.find(
    (e) => e.eventType === 'registration_deadline' && e.startTime
  );

  const isBroadcastOptOutNotice =
    /who\s+(?:wish|want)\s+to\s+opt|if\s+you\s+(?:wish|want)\s+to\s+opt|opt[\s-]*out\s+(?:form|link|google|portal)|voluntary\s+withdrawal\s+only|forms\.gle/i.test(fullText);

  const isWithdrawn =
    !isNeoMatched &&
    !isBroadcastOptOutNotice && (
      existingApp?.status === 'withdrawn' ||
      existingApp?.status === 'declined' ||
      emailClass === 'withdrawal' ||
      emailClass === 'decline' ||
      // General withdrawal patterns
      /registration.*(?:has\s+been\s+)?withdrawn|declined\s+(?:the\s+)?(?:placement\s+)?drive/i.test(fullText) ||
      // NeoPAT-specific: "Confirmation: X Drive Registration Update" + body says withdrawn
      (/confirmation.*drive\s+registration\s+update/i.test(subjLower) && /withdrawn/i.test(fullText)) ||
      // NeoPAT body: "your registration for the following placement drive has been withdrawn"
      /your\s+registration\s+for\s+the\s+following\s+placement\s+drive\s+has\s+been\s+withdrawn/i.test(fullText)
    );


  if (isWithdrawn) {
    // Delete any previously inserted events for this drive if user has withdrawn
    const { data: toDelete } = await supabase
      .from('events')
      .select('id, gcal_event_id')
      .eq('user_id', userId)
      .eq('placement_drive_id', targetDriveId);

    if (toDelete && toDelete.length > 0) {
      const { deleteEventFromGoogleCalendar } = await import('@/lib/calendar/google-sync');
      for (const ev of toDelete) {
        if (ev.gcal_event_id) {
          const deleted = await deleteEventFromGoogleCalendar({ userId, companyName: '', eventId: ev.gcal_event_id });
          if (!deleted) return;
        }
      }
    }

    await supabase.from('events').delete().eq('user_id', userId).eq('placement_drive_id', targetDriveId);
  } else {
    const isVerifiedAbsent =
      !existingApp?.manual_override &&
      !isNeoMatched &&
      (
        existingApp?.status === 'not_shortlisted' ||
        (isCollegeBroadcast && cachedRosterEvaluation?.state === 'verified_absent')
      );

    for (const event of extractedEvents) {
      const isDeadlineEvent = event.eventType === 'registration_deadline';

      if (isVerifiedAbsent && !isDeadlineEvent) continue;

      // RULE: For tests, interviews, and PPTs: ONLY add to user's schedule if candidate is shortlisted or actively participating!
      const currentAppStatus = existingApp?.status || 'not_applied';
      const isEliminated = isInactiveStatus(currentAppStatus);
      const isTestOrInterview = ['online_test', 'coding_test', 'technical_interview', 'hr_interview', 'final_interview'].includes(event.eventType);

      if (isEliminated && !isNeoMatched && !isDeadlineEvent) {
        continue;
      }

      if ((isTestOrInterview || isShortlistEmail) && !isNeoMatched) {
        // User was not found in the shortlist/test email.
        // If they are 'applied' or 'ppt_scheduled', we still schedule the event so they can
        // see the round is happening (it will show as not_shortlisted after reprocess).
        // Only hard-skip if user is already in a terminal elimination state.
        const currentStatus = existingApp?.status || 'not_applied';
        const isAppliedOrPpt = ['applied', 'ppt_scheduled', 'shortlisted'].includes(currentStatus);
        if (!isAppliedOrPpt) {
          continue;
        }
      }

      // ── Round identity: extract explicit ordinal + reschedule detection ──────
      const emailReceivedAt = email.receivedAt
        ? (typeof email.receivedAt === 'string' ? email.receivedAt : new Date(email.receivedAt).toISOString())
        : null;
      const emailSubjectForOrdinal = email.subject || '';
      const emailBodyForOrdinal   = fullText.slice(0, 800);
      const isReschedule = !isDeadlineEvent && isRescheduleEmail(emailSubjectForOrdinal, emailBodyForOrdinal);
      const explicitOrdinal = isDeadlineEvent
        ? null
        : extractExplicitOrdinal(emailSubjectForOrdinal, emailBodyForOrdinal);
      const explicitRoundNumber = explicitOrdinal?.roundNumber ?? null;
      const explicitRoundLabel  = explicitOrdinal?.roundLabel  ?? null;

      // ── Fetch all sibling events for round number reconciliation ─────────────
      // Siblings = all events for the same (drive, event_type) regardless of round.
      // We only re-rank unlabeled siblings (round_label IS NULL).
      // Labeled siblings (round_label IS NOT NULL) have authoritative explicit ordinals.
      type SiblingEvent = { id: string; round_number: number; round_label: string | null; source_email_received_at: string | null; is_rescheduled: boolean };
      let siblings: SiblingEvent[] = [];
      if (!isDeadlineEvent) {
        const { data: siblingData } = await supabase
          .from('events')
          .select('id, round_number, round_label, source_email_received_at, is_rescheduled')
          .eq('user_id', userId)
          .eq('placement_drive_id', targetDriveId)
          .eq('event_type', event.eventType);
        siblings = (siblingData || []) as SiblingEvent[];
      }

      // ── AssignRoundNumber algorithm ──────────────────────────────────────────
      // Determines round_number for the new/updated event and reconciles siblings.
      // Step 1: Explicit ordinal wins absolutely.
      // Step 2-4: Unlabeled events are ranked by source_email_received_at ASC.
      let assignedRoundNumber = 1;
      if (!isDeadlineEvent) {
        if (explicitRoundNumber !== null) {
          // Explicit ordinal: trust it directly.
          assignedRoundNumber = explicitRoundNumber;
        } else {
          // Unlabeled: rank by source_email_received_at ASC among unlabeled siblings.
          const unlabeledSiblings = siblings.filter((s) => s.round_label === null);
          // Build augmented set: existing unlabeled siblings + the new email's received_at.
          const augmented: { receivedAt: string | null; existingId?: string }[] = [
            ...unlabeledSiblings.map((s) => ({
              receivedAt: s.source_email_received_at,
              existingId: s.id,
            })),
            { receivedAt: emailReceivedAt },  // the incoming event (no existingId)
          ];
          // Sort by receivedAt ASC (null → treated as very large = last).
          augmented.sort((a, b) => {
            if (!a.receivedAt && !b.receivedAt) return 0;
            if (!a.receivedAt) return 1;
            if (!b.receivedAt) return -1;
            return a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0;
          });
          // Explicit-labeled siblings occupy certain slot numbers; skip those.
          const labeledSlots = new Set(siblings.filter((s) => s.round_label !== null).map((s) => s.round_number));
          let nextSlot = 1;
          const availableSlots: number[] = [];
          while (availableSlots.length < augmented.length) {
            if (!labeledSlots.has(nextSlot)) availableSlots.push(nextSlot);
            nextSlot++;
          }
          // Find the rank of the new event (no existingId) in the sorted list.
          const newEventIdx = augmented.findIndex((a) => a.existingId === undefined);
          assignedRoundNumber = availableSlots[newEventIdx] ?? 1;

          // Step 5: Reconcile existing unlabeled siblings whose stored round_number changed.
          const siblingsToReconcile: { id: string; newRound: number }[] = [];
          for (let i = 0; i < augmented.length; i++) {
            const entry = augmented[i];
            if (!entry.existingId) continue;  // this is the new event; skip
            const siblingStoredRound = siblings.find((s) => s.id === entry.existingId)?.round_number;
            if (siblingStoredRound !== availableSlots[i]) {
              siblingsToReconcile.push({ id: entry.existingId, newRound: availableSlots[i] });
            }
          }
          // Reconcile in two passes to avoid UNIQUE constraint conflicts:
          // Pass 1: move conflicting siblings to a temporary negative round (–round_number).
          // Pass 2: assign the correct round numbers.
          // Actually: use large temp numbers (1000+) to avoid conflicts during swap.
          for (const rec of siblingsToReconcile) {
            await supabase
              .from('events')
              .update({ round_number: 1000 + siblingsToReconcile.indexOf(rec) })
              .eq('id', rec.id);
          }
          for (const rec of siblingsToReconcile) {
            await supabase
              .from('events')
              .update({ round_number: rec.newRound })
              .eq('id', rec.id);
          }
        }
      }

      // Check if duplicate event exists for this company + event_type on the same calendar day.
      // For reschedule emails: match by round_number (not calendar day) since the date is changing.
      const startTimeIso = event.startTime ? event.startTime.toISOString() : null;
      const startOfDay = event.startTime
        ? new Date(
          event.startTime.getFullYear(),
          event.startTime.getMonth(),
          event.startTime.getDate()
        ).toISOString()
        : null;
      const endOfDay = event.startTime
        ? new Date(
          event.startTime.getFullYear(),
          event.startTime.getMonth(),
          event.startTime.getDate(),
          23,
          59,
          59,
          999
        ).toISOString()
        : null;

      // For reschedule emails, match by round_number. For normal emails, match by date-window.
      let existingEvents: { id: string; start_time: string | null; venue: string | null; mode: string | null; college_email_id: string | null }[] | null = null;
      if (isReschedule && siblings.length > 0) {
        // Identify the event row this reschedule is targeting (by round_number).
        const targetSibling = siblings.find((s) => s.round_number === assignedRoundNumber) ?? siblings[0];
        existingEvents = [{
          id: targetSibling.id,
          start_time: null,
          venue: null,
          mode: null,
          college_email_id: null,
        }];
      } else if (!isDeadlineEvent) {
        let eventQuery = supabase
          .from('events')
          .select('id, start_time, venue, mode, college_email_id')
          .eq('user_id', userId)
          .eq('placement_drive_id', targetDriveId)
          .eq('event_type', event.eventType);

        if (startOfDay && endOfDay) {
          eventQuery = eventQuery
            .gte('start_time', startOfDay)
            .lte('start_time', endOfDay);
        } else if (startTimeIso) {
          eventQuery = eventQuery.eq('start_time', startTimeIso);
        } else if (!event.startTime) {
          eventQuery = eventQuery.is('start_time', null);
        }
        const { data } = await eventQuery.limit(1);
        existingEvents = data as typeof existingEvents;
      } else {
        // Deadline events: use old logic
        let eventQuery = supabase
          .from('events')
          .select('id, start_time, venue, mode, college_email_id')
          .eq('user_id', userId)
          .eq('placement_drive_id', targetDriveId)
          .eq('event_type', event.eventType);
        const { data } = await eventQuery.limit(1);
        existingEvents = data as typeof existingEvents;
      }

      const { data: compRec } = await supabase.from('companies').select('name').eq('id', companyId).single();
      const displayComp = compRec?.name || email.subject.replace(/^(?:fwd|re|fw)\s*:\s*/i, '').slice(0, 40);
      const finalTitle = `${displayComp} - ${event.title}`;

      const eventInsertPayload: any = {
        user_id: userId,
        placement_drive_id: targetDriveId,
        event_type: event.eventType,
        title: finalTitle,
        start_time: startTimeIso,
        end_time: event.endTime ? event.endTime.toISOString() : null,
        venue: event.venue,
        mode: event.mode,
        confidence: event.confidence,
        college_email_id: isCollegeBroadcast ? emailDbId : null,
        // Round identity columns
        round_number: isDeadlineEvent ? 1 : assignedRoundNumber,
        round_label: isDeadlineEvent ? null : explicitRoundLabel,
        source_email_received_at: isDeadlineEvent ? null : emailReceivedAt,
        is_rescheduled: isReschedule,
      };

      if (existingEvents && existingEvents.length > 0) {
        const updatePayload: Record<string, unknown> = {};

        if (isDeadlineEvent) {
          if (shouldReplaceRegistrationDeadline(existingEvents[0], event, isCollegeBroadcast)) {
            updatePayload.start_time = startTimeIso;
            updatePayload.end_time = event.endTime
              ? event.endTime.toISOString()
              : null;

            if (isCollegeBroadcast) {
              updatePayload.college_email_id = emailDbId;
            }
          }
        } else if (isReschedule) {
          // Reschedule: update start_time (and end_time if provided) but NEVER touch
          // source_email_received_at or round_number — the round identity was established
          // by the original announcement email.
          if (startTimeIso) {
            updatePayload.start_time = startTimeIso;
          }
          if (event.endTime) {
            updatePayload.end_time = event.endTime.toISOString();
          }
          if (event.venue && event.venue !== 'Campus / Offline') {
            updatePayload.venue = event.venue;
          }
          updatePayload.is_rescheduled = true;
        } else {
          if (startTimeIso && event.hasExplicitTime) {
            updatePayload.start_time = startTimeIso;
          }

          if (event.endTime && event.hasExplicitTime) {
            updatePayload.end_time = event.endTime.toISOString();
          }

          if (event.venue && event.venue !== 'Campus / Offline') {
            updatePayload.venue = event.venue;
          }

          if (event.mode && event.mode !== 'unknown') {
            updatePayload.mode = event.mode;
          }
        }

        if (Object.keys(updatePayload).length > 0) {
          await supabase
            .from('events')
            .update(updatePayload)
            .eq('id', existingEvents[0].id);
        }
      } else {
        const { data: insertedEvt } = await supabase
          .from('events')
          .insert(eventInsertPayload)
          .select('id')
          .single();

        // Trigger Event Scheduled Notification (Web Push + In-App)
        // Note: Google Calendar reconciliation runs holistically after sync to guarantee
        // only confirmed, eligible events are pushed and any cancelled/withdrawn events are purged.
        if (insertedEvt) {
          const { notifyEventScheduled } = await import('@/lib/notifications/service');

          const { data: comp } = await supabase
            .from('companies')
            .select('name')
            .eq('id', companyId)
            .single();

          const compName = comp?.name || 'Drive';

          const holdNotification =
            isCollegeBroadcast &&
            isShortlistEmail &&
            !isNeoMatched &&
            !isDeadlineEvent;

          if (!holdNotification) {
            await notifyEventScheduled({
              userId,
              placementDriveId: targetDriveId,
              companyName: compName,
              eventType: event.eventType,
              startTime: event.startTime || null,
              venue: event.venue,
              eventId: insertedEvt.id,
              candidateConfirmed: isNeoMatched,
            });

            hasNotifiedEvent = true;
          }
        }
      }
    }
  }

  // 4. Extract Job Details (Role, CTC, Stipend, Location)
  // PDF JD attachments already parsed into the shared archive fill any field the
  // email body left empty (classic "CTC / JD in attached PDF" circulars).
  const jobDetails = mergePdfJobDetails(extractJobDetails(fullText), email.attachments);

  // 4b. Tier 2 AI Fallback Gating & Reconciliation
  const { extractDriveNumber } = await import('@/lib/sync/events');
  const driveNum = extractDriveNumber(fullText);

  const { data: compRecord } = await supabase
    .from('companies')
    .select('name')
    .eq('id', companyId)
    .single();

  const tier1Summary = {
    companyName: compRecord?.name || null,
    classification: emailClass,
    ctc: jobDetails.ctc || null,
    stipend: jobDetails.stipend || null,
    eventsCount: extractedEvents.length,
    driveNumber: driveNum,
    rawMatchedFields: {
      ctc_raw: jobDetails.ctc || '',
    },
  };

  const existingDriveState = existingApp
    ? {
      companyId,
      canonicalName: compRecord?.name || '',
      ctc: existingApp.ctc || null,
      status: isNeoMatched ? 'shortlisted' : (existingApp.status || 'unknown'),
    }
    : null;

  const { shouldInvokeAiFallback, reconcileCompensation } = await import('@/lib/sync/ai-gating');
  const gating = shouldInvokeAiFallback(tier1Summary, existingDriveState);

  let isAiFlaggedForReview = false;
  let aiReviewNotes: string | null = null;

  if (gating.shouldInvoke) {
    const { executeAiPlacementExtraction } = await import('@/lib/sync/ai-fallback');
    const aiRes = await executeAiPlacementExtraction(
      email.subject,
      fullText,
      email.receivedAt ? new Date(email.receivedAt) : new Date()
    );

    if (aiRes.success && aiRes.data) {
      const ai = aiRes.data;

      // Reconcile CTC
      if (ai.ctc) {
        const recon = reconcileCompensation(existingApp?.ctc || null, jobDetails.ctc || null, ai.ctc);
        if (recon.action === 'update' || (recon.action === 'preserve' && !existingApp?.ctc)) {
          jobDetails.ctc = recon.acceptedCtc || jobDetails.ctc;
        } else if (recon.action === 'flag_for_review') {
          isAiFlaggedForReview = true;
          aiReviewNotes = `[NEEDS REVIEW] AI detected alternative CTC: ${ai.ctc} vs existing ${existingApp?.ctc}`;
        }
      }

      // Reconcile Stipend
      if (ai.stipend && !jobDetails.stipend) {
        jobDetails.stipend = ai.stipend;
      }

      // Reconcile Events if Tier 1 found 0 events but AI verified scheduled round with quote
      if (extractedEvents.length === 0 && ai.events.length > 0) {
        for (const aiEvt of ai.events) {
          if (aiEvt.isScheduled && aiEvt.startTime) {
            extractedEvents.push({
              eventType: aiEvt.eventType as any,
              title: aiEvt.title,
              startTime: new Date(aiEvt.startTime),
              endTime: null,
              venue: aiEvt.venue,
              hasExplicitTime: true,
              mode: 'unknown',
              confidence: 'high',
            });
          }
        }
      }

      if (!ai.isSanityCheckPassed) {
        isAiFlaggedForReview = true;
        aiReviewNotes = (aiReviewNotes ? `${aiReviewNotes}\n` : '') + `[NEEDS REVIEW] AI sanity failure: ${ai.sanityFailureReasons.join('; ')}`;
      }
    }
  }

  // Read matches for all predecessor round types required by this announcement.
  // predecessorTypes === null → conditional on text evidence not found → conservative (hasPreviousRoundMatch = false).
  // predecessorTypes === [] → no predecessor required (first competitive round) → hasPreviousRoundMatch irrelevant.
  // predecessorTypes === ['test', ...] → query for those specific round types.
  let hasPreviousRoundMatch = false;
  if (predecessorTypes !== null && predecessorTypes.length > 0) {
    const { data: previousMatches, error: previousMatchError } = await supabase
      .from('candidate_matches')
      .select('id, emails!inner(received_at)')
      .eq('user_id', userId)
      .eq('placement_drive_id', targetDriveId)
      .in('matched_round_type', predecessorTypes)
      .neq('match_type', 'xlsx_applied_list');
    if (previousMatchError) throw previousMatchError;
    hasPreviousRoundMatch = (previousMatches || []).some((match) => {
      const source = match.emails as unknown as { received_at: string | null };
      return Boolean(source?.received_at &&
        new Date(source.received_at).getTime() < new Date(email.receivedAt).getTime());
    });
  }

  // 5. Compute updated application status
  const emailReceivedTime = email.receivedAt ? new Date(email.receivedAt).getTime() : Date.now();
  const appliedTime = existingApp?.applied_at ? new Date(existingApp.applied_at).getTime() : null;
  // If email was received before the user registered (with a 2-minute clock skew grace), it's from a previous round/cycle!
  const isEmailAfterApplication = !appliedTime || emailReceivedTime >= (appliedTime - 2 * 60 * 1000);


  let newStatus: string | null = null;
  let hasConfirmedShortlistMatch = false;

  if (existingApp?.manual_override && !isNeoMatched) {
    // User has manually set their status — preserve it UNLESS there is fresh
    // concrete positive evidence (found in an actual shortlist/interview/selection
    // Excel or body match) that proves they are in a higher stage.
    newStatus = null;
  } else if (existingApp?.manual_override && isNeoMatched) {
    // Manual override exists, but a NeoPAT match confirms they are actively
    // progressing — allow the engine to compute the correct new status below.
    // Fall through to the isNeoMatched block.
  }

  if (isNeoMatched) {
    // Candidate is confirmed in an actual shortlist / test / interview Excel, GSheet, or body match
    const isRejectionLanguage =
      emailClass === 'result' &&
      /not\s+selected|regret|unfortunately|could\s+not\s+be\s+selected/i.test(subjLower + ' ' + fullText);

    const isTestCompletedShortlist =
      /test\s+shortlisted|shortlisted\s+based\s+on\s+(?:the\s+)?test|assessment\s+shortlisted|already\s+completed\s+(?:the\s+)?(?:assessment|test)|location\s+preference/i.test(subjLower + ' ' + fullText);

    if (isRejectionLanguage) {
      newStatus = hasPreviousRoundMatch ? 'rejected' : 'not_shortlisted';
    } else if (/final\s*selection|offer\s*(?:letter|release)|congratulations.*(?:final|offer)/i.test(subjLower) || (/selection\s*list/i.test(subjLower) && !/interview|ppt|test/i.test(subjLower))) {
      newStatus = 'selected';
    } else if (
      /interview/i.test(subjLower) ||
      /next\s+round\s+of\s+(?:the\s+)?(?:selection\s+process|selection|process|hiring)|selection\s+process\s+is\s+scheduled|physical\s+selection/i.test(subjLower) ||
      (/next\s+round/i.test(subjLower) && (
        /attend\s+(?:the\s+)?interview|interview\s+(?:process|schedule|round)|shortlisted\s+for\s+interview/i.test(fullText) ||
        !/(?:online\s+)?test|assessment\s*\d|coding\s+test|\bshl\b|\bmettl\b|\bhackerrank\b/i.test(subjLower)
      ))
    ) {
      newStatus = 'interview_scheduled';
    } else if (isTestCompletedShortlist) {
      // The test round is already complete! Candidate completed the test and is in the post-test form / preference stage.
      newStatus = 'test_completed';
    } else if (/online\s+test|coding\s+test|assessment|test/i.test(subjLower) || /next\s+round/i.test(subjLower) || (matchDetail?.includes('Google Sheet') && !/ppt|pre[\s-]*placement/i.test(subjLower))) {
      const hasPastTest = extractedEvents.some((e) => {
        if (!['online_test', 'coding_test'].includes(e.eventType) || !e.startTime) return false;
        const endTime = e.endTime || deriveEventEndTime(e.eventType, e.title, e.startTime);
        return Boolean(endTime) && endTime!.getTime() <= Date.now();
      });
      newStatus = hasPastTest ? 'test_completed' : 'test_scheduled';
    } else if (/ppt|pre[\s-]*placement/i.test(subjLower)) {
      newStatus = 'ppt_scheduled';
    } else {
      newStatus = 'shortlisted';
    }
  } else if (isWithdrawn) {
    // A. Withdrawal / Opt-Out (always highest priority unless candidate matched in shortlist)
    newStatus = 'withdrawn';
  } else if (existingApp?.status === 'withdrawn' || existingApp?.status === 'declined') {
  } else if (isInAppliedList) {
    // C. Found in an applied/opt-in list — confirms application but does NOT mean shortlisted
    const current = existingApp?.status || 'not_applied';
    if (current === 'not_applied' || current === 'not_shortlisted') {
      newStatus = 'applied';
    }
  } else if (isConfirmation) {
    // D. NeoPAT registration confirmation emails:
    // "Confirmed: Your Registration for EY Placement Drive"
    // When a new registration confirmation arrives, it resets status back to applied
    const current = existingApp?.status || 'not_applied';
    if (
      (current === 'not_applied' || current === 'unknown' || current === 'not_shortlisted' || isEmailAfterApplication) &&
      !['ppt_scheduled', 'ppt_completed', 'shortlisted', 'test_scheduled', 'test_ongoing', 'test_completed', 'interview_scheduled', 'interview_completed', 'selected', 'offer', 'offer_received'].includes(current)
    ) {
      newStatus = 'applied';
    }
  } else if (
    // E. A shortlist was officially released but candidate was NOT in it
    isShortlistEmail &&
    isEmailAfterApplication
  ) {
    // RULE: Only downgrade if candidate actually APPLIED or was in the process!
    // Do NOT downgrade companies where the user never applied or has opted out / withdrawn.
    const currentStatus = existingApp?.status || 'not_applied';
    if (!['not_applied', 'registration_open', 'withdrawn', 'declined'].includes(currentStatus)) {
      // Check if this is a post-test round announcement (interview, next round, selection list, results)
      const isPostTestRound =
        emailClass === 'interview' ||
        emailClass === 'result' ||
        /interview\s+(?:is\s+)?scheduled|technical\s+interview|hr\s+interview|final\s+interview|next\s+round\s+of\s+(?:the\s+)?(?:selection\s+process|selection|process|hiring)|selection\s+process\s+is\s+scheduled|physical\s+selection/i.test(subjLower) ||
        (/next\s+round/i.test(subjLower) && (
          /interview|in[\s-]*person|f2f|resumes?|formal\s+dress|blacklisted/i.test(fullText) ||
          !/(?:online\s+)?test|assessment\s*\d|coding\s+test|\bshl\b|\bmettl\b|\bhackerrank\b/i.test(subjLower)
        )) ||
        /selection\s+list|final\s+shortlist|congratulations.*(?:selection\s+list|selects)/i.test(subjLower) ||
        /interview\s+shortlist|shortlist\s+for\s+interview|next\s+round\s+shortlist|shortlisted\s+for\s+next\s+round/i.test(fullText);

      if (isPostTestRound) {
        hasConfirmedShortlistMatch = hasPreviousRoundMatch;

        // Check if there is an upcoming test event for this company that hasn't happened yet
        const { data: upcomingEvents } = await supabase
          .from('events')
          .select('start_time, event_type')
          .eq('user_id', userId)
          .eq('placement_drive_id', targetDriveId)
          .in('event_type', ['online_test', 'coding_test']);

        const hasFutureTestEvent = upcomingEvents?.some((ev) => {
          if (!ev.start_time) return false;
          return new Date(ev.start_time).getTime() > Date.now();
        });

        if (hasPreviousRoundMatch && !hasFutureTestEvent) {
          newStatus = 'rejected';
        } else if (hasPreviousRoundMatch && hasFutureTestEvent) {
          // Candidate still has an upcoming test scheduled!
          newStatus = 'test_scheduled';
        } else {
          newStatus = 'not_shortlisted';
        }
      } else {
        // It is a test or screening shortlist email (e.g. initial test shortlist or updated test shortlist)
        // If the candidate was not found in this shortlist, they did NOT qualify for the test!
        newStatus = 'not_shortlisted';
      }
    }
  } else if (
    // F. Event found in email — upgrade status for registered candidates
    extractedEvents.length > 0 ||
    /(?:online\s+)?(?:test|assessment|exam)\s+(?:is\s+)?(?:scheduled|rescheduled)|(?:online\s+)?(?:test|assessment|exam)\s+schedule|test\s+link|assessment\s+link/i.test(subjLower)
  ) {
    const current = existingApp?.status || 'not_applied';
    const hasExplicitTestScheduleInSubject =
      /(?:online\s+)?(?:test|assessment|exam)\s+(?:is\s+)?(?:scheduled|rescheduled)|(?:online\s+)?(?:test|assessment|exam)\s+schedule|test\s+link|assessment\s+link/i.test(subjLower);
    const hasTest =
      extractedEvents.some((e) => ['online_test', 'coding_test'].includes(e.eventType) && e.startTime !== null) ||
      hasExplicitTestScheduleInSubject;
    const hasPpt = extractedEvents.some((e) => /ppt/i.test(e.eventType));

    if (hasTest && isNeoMatched && ['applied', 'ppt_scheduled'].includes(current)) {
      const hasPastTest = extractedEvents.some((e) => {
        if (!['online_test', 'coding_test'].includes(e.eventType) || !e.startTime) return false;
        const endTime = e.endTime || deriveEventEndTime(e.eventType, e.title, e.startTime);
        return Boolean(endTime) && endTime!.getTime() <= Date.now();
      });
      newStatus = hasPastTest ? 'test_completed' : 'test_scheduled';
    } else if (hasPpt && current === 'applied') {
      newStatus = 'ppt_scheduled';
    }
  }

  // Persist the elapsed test transition instead of deriving it only in the UI.
  if (
    (!newStatus || newStatus === 'test_scheduled') &&
    ['test_scheduled', 'test_ongoing'].includes(newStatus || existingApp?.status || '') &&
    extractedEvents.some((event) => {
      if (!['online_test', 'coding_test'].includes(event.eventType) || !event.startTime) return false;
      const endTime = event.endTime || deriveEventEndTime(event.eventType, event.title, event.startTime);
      return Boolean(endTime) && endTime!.getTime() <= Date.now();
    })
  ) {
    newStatus = 'test_completed';
  }

  // College absence is only a valid negative when the matching cached roster
  // was successfully parsed and checked for this exact user's identifiers.
  // Missing/unparsed/deferred rosters leave the current status untouched.
  if (isCollegeBroadcast && newStatus === 'not_shortlisted') {
    newStatus = null;
  }


  // ─── RECENCY GUARD FOR OUT-OF-ORDER PAGES ──────────────────────────────────
  // If an older page processes an email received EARLIER than the email that established
  // the current application status, do NOT allow the older email to overwrite status!
  // This guarantees that Page 0 (recent) is never corrupted by background passes of Pages 1, 2, etc.
  const currentStatusSourceTime = existingApp?.status_source_email_at
    ? new Date(existingApp.status_source_email_at).getTime()
    : null;
  const thisEmailTime = email.receivedAt ? new Date(email.receivedAt).getTime() : null;
  const isOlderThanCurrentStatus = Boolean(
    currentStatusSourceTime && thisEmailTime && thisEmailTime < currentStatusSourceTime
  );

  if (newStatus && isOlderThanCurrentStatus) {
    // Suppress status updates from older historical emails
    newStatus = null;
  }

  // ─── STATUS PRIORITY GUARD ──────────────────────────────────────────────────
  // Never allow a weaker status signal to overwrite a stronger existing status.
  // e.g. a "registration" broadcast email must not flip "shortlisted" → "applied"
  if (newStatus && existingApp?.status && newStatus !== existingApp.status) {
    const STATUS_PRIORITY: Record<string, number> = {
      unknown: 0,
      not_applied: 1,
      applied: 2,
      ppt_scheduled: 3,
      ppt_completed: 4,
      shortlisted: 5,
      test_scheduled: 6,
      test_ongoing: 6,
      test_completed: 7,
      interview_scheduled: 8,
      interview_completed: 9,
      offer_received: 10,
      selected: 11,
      // Terminal states — always allowed to be set (withdrawal, rejection, etc.)
      not_shortlisted: 12,
      declined: 12,
      withdrawn: 13,
      rejected: 13,
      rejected_test: 13,
      rejected_interview: 13,
    };
    const existingPriority = STATUS_PRIORITY[existingApp.status] ?? 0;
    const newPriority = STATUS_PRIORITY[newStatus] ?? 0;

    // If the new status has lower priority than existing AND existing is NOT terminal,
    // block the downgrade. Terminal states (withdrawn, rejected, not_shortlisted) are
    // always allowed to be applied.
    const isTerminal = (s: string) => ['withdrawn', 'declined', 'rejected', 'not_shortlisted', 'rejected_test', 'rejected_interview'].includes(s);

    // EXCEPTION: A positive Excel/body match (isNeoMatched) is concrete evidence the candidate
    // IS participating. It must be allowed to override a previous 'not_shortlisted' or 'withdrawn' determination,
    // which was either an absence-of-evidence signal or an earlier NeoPAT opt-out that the CDC subsequently shortlisted anyway.
    // e.g. "Test Scheduled" email + user found in shortlist Excel → test_scheduled/test_completed should win.
    const isConfirmedParticipation =
      isNeoMatched &&
      (existingApp?.status === 'not_shortlisted' || existingApp?.status === 'withdrawn') &&
      ['shortlisted', 'test_scheduled', 'test_completed', 'interview_scheduled', 'ppt_scheduled'].includes(newStatus);

    if (!isTerminal(newStatus) && newPriority < existingPriority && !isConfirmedParticipation) {
      newStatus = null; // Block the downgrade
    }
  }

  // Build application update payload
  const appUpdate: Record<string, unknown> = {
    user_id: userId,
    placement_drive_id: targetDriveId,
    // If manual_override was cleared by a neoMatch, refresh last_updated
    last_updated: (existingApp?.manual_override && !isNeoMatched && existingApp?.last_updated) ? existingApp.last_updated : new Date().toISOString(),
  };
  if (existingApp?.manual_override && !isNeoMatched) {
    // Preserve manual override only when neoMatch did NOT compute a new status
    appUpdate.manual_override = true;
  } else if (existingApp?.manual_override && isNeoMatched && newStatus) {
    // neoMatch found concrete evidence — clear the manual override so future syncs work normally
    appUpdate.manual_override = false;
  }

  const { extractTravelRequirement } = await import('@/lib/sync/events');
  const travelReq = extractTravelRequirement(fullText);
  let resolvedLocation = jobDetails.location || existingApp?.location || null;
  if (resolvedLocation && /^(?:vit\s+(?:vellore|chennai|bhopal|ap)(?:\s+campus)?|(?:vellore|chennai|bhopal|ap)\s+campus)$/i.test(resolvedLocation.trim())) {
    resolvedLocation = null;
  }

  // Only update fields from older emails if not already populated on existingApp
  if (jobDetails.role && (!existingApp?.role || !isOlderThanCurrentStatus)) appUpdate.role = jobDetails.role;
  if (jobDetails.ctc && (!existingApp?.ctc || !isOlderThanCurrentStatus)) appUpdate.ctc = jobDetails.ctc;
  if (jobDetails.stipend && (!existingApp?.stipend || !isOlderThanCurrentStatus)) appUpdate.stipend = jobDetails.stipend;
  if (resolvedLocation && (!existingApp?.location || !isOlderThanCurrentStatus)) appUpdate.location = resolvedLocation;
  if (jobDetails.workMode && (!existingApp?.work_mode || !isOlderThanCurrentStatus)) appUpdate.work_mode = jobDetails.workMode;
  if (jobDetails.eligibility && (!existingApp?.eligibility || !isOlderThanCurrentStatus)) appUpdate.eligibility = jobDetails.eligibility;
  if (jobDetails.branches && jobDetails.branches.length > 0 && (!existingApp?.branches || !isOlderThanCurrentStatus)) appUpdate.branches = jobDetails.branches;
  if (jobDetails.cgpaRequirement && (!existingApp?.cgpa_requirement || !isOlderThanCurrentStatus)) appUpdate.cgpa_requirement = jobDetails.cgpaRequirement;
  if (jobDetails.backlogRequirement && (!existingApp?.backlog_requirement || !isOlderThanCurrentStatus)) appUpdate.backlog_requirement = jobDetails.backlogRequirement;

  if (existingApp?.manual_override) {
    // If the user manually set a note (e.g. "Eliminated in Test Round" or "Interviewed · Not Selected"),
    // strictly preserve it!
    if (existingApp.notes) {
      appUpdate.notes = existingApp.notes;
    }
  } else {
    // Accumulate notes: travel requirement + AI review flags occupy the same column.
    // Build them separately and join so neither overwrites the other.
    const noteParts: string[] = [];
    if (newStatus === 'rejected' && hasConfirmedShortlistMatch && announcedRound) {
      // Write structured elimination token so getEffectiveStage() can derive
      // the human-readable label at read time without guessing.
      // Format: "eliminated_at:<roundType>" on its own line.
      noteParts.push(buildEliminationToken(announcedRound));
    } else if (newStatus === 'rejected' && hasConfirmedShortlistMatch) {
      // announcedRound is null (ambiguous) — fall back to legacy prose for compatibility
      if (['interview_scheduled', 'interview_completed'].includes(currentStatus)) {
        noteParts.push('Interviewed · Not Selected');
      } else {
        noteParts.push('Eliminated in Test Round');
      }
    }
    const prevTravel = existingApp?.notes?.split('\n')[0]?.trim();
    const isEstablishedPhysical = ['vellore', 'chennai', 'ap', 'bhopal', 'bhopal_lab'].includes(prevTravel || '');

    if (travelReq) {
      // If the existing drive mode is an established physical campus/lab requirement,
      // a subsequent virtual event (like a virtual PPT or online test) shouldn't downgrade it to 'online'
      if (travelReq === 'online' && isEstablishedPhysical) {
        noteParts.push(prevTravel!);
      } else {
        noteParts.push(travelReq);
      }
    } else if (prevTravel && ['vellore', 'chennai', 'ap', 'bhopal', 'bhopal_lab', 'online'].includes(prevTravel)) {
      noteParts.push(prevTravel);
    }
    const announcedProcess = parseRecruitmentProcess(fullText);
    if (announcedProcess) {
      noteParts.push(buildAnnouncedProcessToken(announcedProcess));
    } else {
      const existingProcessToken = existingApp?.notes?.split('\n').find((l: string) => l.trim().startsWith('announced_process:'));
      if (existingProcessToken) {
        noteParts.push(existingProcessToken);
      }
    }

    if (isAiFlaggedForReview && aiReviewNotes) noteParts.push(aiReviewNotes);
    if (noteParts.length > 0) appUpdate.notes = noteParts.join('\n');
  }

  if (newStatus) {
    appUpdate.status = newStatus;
    appUpdate.status_source_email_at = email.receivedAt ? new Date(email.receivedAt).toISOString() : new Date().toISOString();
    if (newStatus === 'applied' && !existingApp?.applied_at) {
      appUpdate.applied_at = email.receivedAt ? new Date(email.receivedAt).toISOString() : new Date().toISOString();
    }
    appUpdate.status_confidence = isAiFlaggedForReview ? 'low' : 'high';
    // AI review notes are already included in appUpdate.notes above (with travelReq), skip double-append

    // If candidate withdrew, declined, or was not shortlisted/rejected, purge scheduled events from DB and Google Calendar
    if (newStatus === 'not_shortlisted') {
      await removeDriveEvents(
        supabase,
        userId,
        targetDriveId,
        {
          excludeTypes: ['registration_deadline'],
          onlyUnfinished: true,
        }
      );
    } else if (['withdrawn', 'declined', 'rejected'].includes(newStatus)) {
      const isTestEliminatedWithMatch = newStatus === 'rejected' && hasConfirmedShortlistMatch;
      let deleteQuery = supabase
        .from('events')
        .select('id, gcal_event_id')
        .eq('user_id', userId)
        .eq('placement_drive_id', targetDriveId);

      if (isTestEliminatedWithMatch) {
        // Preserve historical test and ppt events so stages can display "Eliminated in Test Round"
        deleteQuery = deleteQuery.not('event_type', 'in', '("online_test","coding_test","ppt")');
      }

      const { data: toDelete } = await deleteQuery;

      if (toDelete && toDelete.length > 0) {
        const { deleteEventFromGoogleCalendar } = await import('@/lib/calendar/google-sync');
        for (const ev of toDelete) {
          if (ev.gcal_event_id) {
            const deleted = await deleteEventFromGoogleCalendar({ userId, companyName: '', eventId: ev.gcal_event_id });
            if (!deleted) return;
          }
        }
      }

      if (isTestEliminatedWithMatch) {
        await supabase
          .from('events')
          .delete()
          .eq('user_id', userId)
          .eq('placement_drive_id', targetDriveId)
          .not('event_type', 'in', '("online_test","coding_test","ppt")');
      } else {
        await supabase.from('events').delete().eq('user_id', userId).eq('placement_drive_id', targetDriveId);
      }
    }

    // Only notify if canonical status actually changed!
    if (newStatus !== existingApp?.status) {
      const { notifyStatusChange, notifyShortlistMatch } = await import('@/lib/notifications/service');
      const { data: comp } = await supabase.from('companies').select('name').eq('id', companyId).single();
      const companyName = comp?.name || 'Company';

      if (isNeoMatched && (matchType === 'excel_attachment' || newStatus === 'shortlisted')) {
        await notifyShortlistMatch({
          userId,
          placementDriveId: targetDriveId,
          companyName,
          neoId: userNeoId || userEmail,
          emailSubject: email.subject,
          sourceEmailId: emailDbId,
        });
      } else if (hasNotifiedEvent && ['test_scheduled', 'interview_scheduled', 'ppt_scheduled'].includes(newStatus)) {
        // Event was already notified with exact schedule & venue; avoid duplicate status ping
      } else {
        await notifyStatusChange({
          userId,
          placementDriveId: targetDriveId,
          companyName,
          oldStatus: existingApp?.status || null,
          newStatus,
          sourceEmailId: emailDbId,
        });
      }
    }
  }

  // Extract and populate registration deadline on application
  if (
    regDeadlineEvt?.startTime &&
    (isCollegeBroadcast || !existingApp?.registration_deadline)
  ) {
    appUpdate.registration_deadline =
      regDeadlineEvt.startTime.toISOString();
  }

  // If this is a newly discovered company drive from a recent email, notify the candidate
  const emailAgeMs = email.receivedAt ? Date.now() - new Date(email.receivedAt).getTime() : 0;
  const isRecentEmail = emailAgeMs <= 48 * 60 * 60 * 1000;
  const isDriveDiscoveryEmail =
    ['registration', 'job_announcement', 'drive_announcement'].includes(emailClass) ||
    Boolean(regDeadlineEvt) ||
    Boolean(jobDetails.ctc || jobDetails.role);
  const isInitialApplication = !existingApp || existingApp.status === 'not_applied';

  // Safely persist application
  const { data: existingAppRow } = await supabase
    .from('applications')
    .select('id')
    .eq('user_id', userId)
    .eq('placement_drive_id', targetDriveId)
    .maybeSingle();

  if (existingAppRow?.id) {
    const { error: applicationError } = await supabase.from('applications').update(appUpdate).eq('id', existingAppRow.id);
    if (applicationError && applicationError.code !== '23505') {
      throw applicationError;
    }
  } else {
    const { error: applicationError } = await supabase.from('applications').insert(appUpdate);
    if (applicationError && applicationError.code !== '23505') {
      throw applicationError;
    }
  }

  if (isRecentEmail && isDriveDiscoveryEmail && isInitialApplication && isCollegeBroadcast) {
    const { notifyNewDrive } = await import('@/lib/notifications/service');
    const { getDriveMode } = await import('@/lib/utils');
    const driveMode = getDriveMode(appUpdate.notes as string);
    await notifyNewDrive({
      userId,
      placementDriveId: targetDriveId,
      companyName: compRecord?.name || 'New Placement Drive',
      role: (appUpdate.role as string) || jobDetails.role || null,
      ctc: (appUpdate.ctc as string) || jobDetails.ctc || null,
      stipend: (appUpdate.stipend as string) || jobDetails.stipend || null,
      location: (appUpdate.location as string) || resolvedLocation || null,
      driveMode,
      category: (appUpdate.category as string) || null,
      sourceEmailId: emailDbId,
    });
  }
}

