import type { ParsedEmail } from '@/lib/gmail/client';
import { extractEvents, extractJobDetails, type ExtractedEvent } from '@/lib/sync/events';
import { createAdminClient } from '@/lib/supabase/admin';
import { isInactiveStatus } from '@/lib/stages';
import { deriveEventEndTime } from '@/lib/event-duration';

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

/**
 * Checks if the user's Neo ID or identity is mentioned in an email (subject, plain body, or HTML table).
 */
export function checkNeoIdMatch(
  text: string,
  userNeoId: string | null,
  userEmail: string
): { matched: boolean; matchedValue: string | null } {
  if (!text) return { matched: false, matchedValue: null };

  // Strip recipient email addresses, mailto links, and headers to prevent matching user's own email
  const sanitizedText = text
    .replace(/[a-zA-Z0-9._%+-]+@vit(?:student|bhopal|chennai|vellore)?\.[a-zA-Z0-9.-]+/gi, ' ')
    .replace(/[a-zA-Z0-9._%+-]+@gmail\.com/gi, ' ')
    .replace(/mailto:[^\s>]+/gi, ' ')
    .replace(/to:\s*[^\n]+/gi, ' ')
    .replace(/from:\s*[^\n]+/gi, ' ')
    .toUpperCase();

  // 1. Check user's explicitly configured Neo ID (e.g. alphanumeric registration ID)
  // Uses strict word-boundary regex to avoid false positives from partial substring matches.
  // Retains 0/O and 1/I fuzzy matching to handle OCR scan / CDC font rendering artefacts.
  if (userNeoId && userNeoId.trim().length >= 4) {
    const cleanNeoId = userNeoId.trim().toUpperCase();
    const regex = new RegExp(`\\b${cleanNeoId}\\b`);
    const matchesDirect = regex.test(sanitizedText);
    const matchesFlexible = new RegExp(
      `\\b${cleanNeoId.replace(/[0O]/g, '[0O]').replace(/[1I]/g, '[1I]')}\\b`
    ).test(sanitizedText);

    if (matchesDirect || matchesFlexible) {
      return { matched: true, matchedValue: cleanNeoId };
    }
  }

  // 2. Check registration number pattern (e.g. "23BCE10472")
  // VIT branch codes are exactly 3 letters (BCE, CSE, MIS, etc.)
  const regMatch = userEmail.match(/([0-9]{2}[a-z]{3}[0-9]{4,5})/i);
  if (regMatch && regMatch[1]) {
    const regNo = regMatch[1].toUpperCase();
    const regRegex = new RegExp(`(?:^|[^A-Z0-9])${regNo}(?:[^A-Z0-9]|$)`, 'i');
    if (regRegex.test(sanitizedText)) {
      return { matched: true, matchedValue: regNo };
    }
  }

  return { matched: false, matchedValue: null };
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
      .eq('user_id', userId)
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    targetDriveId = drive?.id || null;
  }
  if (!targetDriveId) return;

  const subjLower = email.subject.toLowerCase();
  const htmlText = htmlToPlainText(email.bodyHtml);
  const fullText = `${email.subject}\n${email.bodyPlain || ''}\n${htmlText}\n${email.bodySnippet || ''}`;

  const { classifyEmail } = await import('@/lib/sync/classifier');
  const emailClass = classifyEmail(email).classification;

  // Temporal filter removed. Idempotency requires that evaluating an email's effect
  // must depend purely on its own timestamp vs other emails in the transaction,
  // NOT on what currently exists in the DB from a previous sync pass.
  // The holistic status will be correctly converged during the batch recalculation.

  // 0. Early check of existing application status from DB
  const { data: existingApp } = await supabase
    .from('applications')
    .select('status, manual_override, applied_at, location, ctc, role, stipend, notes, status_source_email_at, last_updated, eligibility, branches, cgpa_requirement, backlog_requirement')
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

  // 1. Check for Neo ID match in email body / HTML tables / subject
  const bodyMatch = checkNeoIdMatch(fullText, userNeoId, userEmail);
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

  const hasShortlistAttachment = Boolean(
    email.hasAttachments &&
      email.attachments.some((a) =>
        /shortlist|selection[_\s-]*list|test[_\s-]*shortlist|selected[_\s-]*student/i.test(a.filename)
      )
  );

  const isExplicitShortlistNotice =
    /shortlist|selection\s+list|selected\s+candidates|shortlisted\s+students|shortlist\s+for|candidates\s+shortlisted/i.test(
      subjLower
    ) ||
    // Body patterns — order matters: more specific first
    /find\s+the\s+below\s+shortlist|below\s+is\s+the\s+shortlist|attached\s+list\s+of\s+shortlisted|shortlist\s+for\s+next\s+round/i.test(
      fullText
    ) ||
    // "attached shortlisted students/candidates list" (word "shortlisted" between "attached" and "students")
    /attached\s+(?:(?:updated|final|revised)\s+)?shortlisted\s+(?:students?|candidates?)(?:\s+list)?/i.test(fullText) ||
    // "attached students/candidates list" (no qualifier — generic attachment shortlist)
    /attached\s+(?:students?|candidates?)\s+list/i.test(fullText) ||
    // "shortlisted students/candidates list" anywhere in body (e.g. Gmail snippet)
    /shortlisted\s+(?:students?|candidates?)\s+list/i.test(fullText);

  const isShortlistEmail = (hasShortlistAttachment || isExplicitShortlistNotice) && !isAppliedOrOptInRoster;

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
    email.attachments.length > 0 &&
    isAttachmentRelevant
  ) {
    const { scanExcelAttachmentsForNeoId } = await import('@/lib/sync/excel-parser');
    const excelMatch = await scanExcelAttachmentsForNeoId(
      gmail,
      email.gmailMessageId,
      email.attachments,
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
      const gMatch = await scanGoogleSheetForCandidate(gUrl, userEmail, userNeoId);
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

  if (isEliminationEmail && matchType === 'email_body') {
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

  if (isNeoMatched) {
    // Only record genuine shortlist matches (never applied/opt-in rosters)
    const { error: candidateMatchError } = await supabase.from('candidate_matches').insert({
      user_id: userId,
      email_id: emailDbId,
      placement_drive_id: targetDriveId,
      neo_id: userNeoId || userEmail,
      match_type: matchType,
      matched_value: matchDetail || email.subject.slice(0, 100),
      confidence: 'high',
    });
    if (candidateMatchError && candidateMatchError.code !== '23505') {
      throw candidateMatchError;
    }
  }

  // 3. Extract Events (PPT, Test, Interview) with Deduplication
  // Hoist extractedEvents so the status computation block can reference it
  const extractedEvents = extractEvents(email);
  if (gsheetEventToAdd) {
    extractedEvents.push(gsheetEventToAdd);
  }

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
    for (const event of extractedEvents) {
      // RULE: For tests, interviews, and PPTs: ONLY add to user's schedule if candidate is shortlisted or actively participating!
      const currentAppStatus = existingApp?.status || 'not_applied';
      const isEliminated = isInactiveStatus(currentAppStatus);
      const isTestOrInterview = ['online_test', 'coding_test', 'technical_interview', 'hr_interview', 'final_interview'].includes(event.eventType);

      if (isEliminated && !isNeoMatched) {
        continue; // Do not add events for companies where user is withdrawn, rejected, or eliminated
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

      // Check if duplicate event exists for this company + event_type on the same calendar day
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

      let eventQuery = supabase
        .from('events')
        .select('id, start_time, venue, mode')
        .eq('user_id', userId)
        .eq('placement_drive_id', targetDriveId)
        .eq('event_type', event.eventType);

      if (startOfDay && endOfDay) {
        eventQuery = eventQuery.gte('start_time', startOfDay).lte('start_time', endOfDay);
      } else if (startTimeIso) {
        eventQuery = eventQuery.eq('start_time', startTimeIso);
      }

      const { data: existingEvents } = await eventQuery.limit(1);

      if (existingEvents && existingEvents.length > 0) {
        // Event for this day/test already exists — refine details
        const updatePayload: Record<string, unknown> = {};
        if (startTimeIso && event.hasExplicitTime) {
          updatePayload.start_time = startTimeIso;
        }
        if (event.endTime && event.hasExplicitTime) updatePayload.end_time = event.endTime.toISOString();
        if (event.venue && event.venue !== 'Campus / Offline') updatePayload.venue = event.venue;
        if (event.mode && event.mode !== 'unknown') updatePayload.mode = event.mode;

        if (Object.keys(updatePayload).length > 0) {
          await supabase
            .from('events')
            .update(updatePayload)
            .eq('id', existingEvents[0].id);
        }
      } else {
        // Clean up title
        const { data: compRec } = await supabase.from('companies').select('name').eq('id', companyId).single();
        const displayComp = compRec?.name || email.subject.replace(/^(?:fwd|re|fw)\s*:\s*/i, '').slice(0, 40);
        const finalTitle = `${displayComp} - ${event.title}`;

        // Insert new unique event into DB
        const { data: insertedEvt } = await supabase
          .from('events')
          .insert({
            user_id: userId,
            placement_drive_id: targetDriveId,
            source_email_id: emailDbId,
            event_type: event.eventType,
            title: finalTitle,
            start_time: startTimeIso,
            end_time: event.endTime ? event.endTime.toISOString() : null,
            venue: event.venue,
            mode: event.mode,
            confidence: event.confidence,
          })
          .select('id')
          .single();

        // Trigger Event Scheduled Notification (Web Push + In-App)
        // Note: Google Calendar reconciliation runs holistically after sync to guarantee
        // only confirmed, eligible events are pushed and any cancelled/withdrawn events are purged.
        if (insertedEvt) {
          const { notifyEventScheduled } = await import('@/lib/notifications/service');
          const { data: comp } = await supabase.from('companies').select('name').eq('id', companyId).single();
          const compName = comp?.name || 'Drive';
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
        }
      }
    }
  }

  // 4. Extract Job Details (Role, CTC, Stipend, Location)
  const jobDetails = extractJobDetails(fullText);

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

  // 5. Compute updated application status
  const emailReceivedTime = email.receivedAt ? new Date(email.receivedAt).getTime() : Date.now();
  const appliedTime = existingApp?.applied_at ? new Date(existingApp.applied_at).getTime() : null;
  // If email was received before the user registered (with a 2-minute clock skew grace), it's from a previous round/cycle!
  const isEmailAfterApplication = !appliedTime || emailReceivedTime >= (appliedTime - 2 * 60 * 1000);


  let newStatus: string | null = null;

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
      newStatus = 'rejected';
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
    if (!['not_applied', 'withdrawn', 'declined'].includes(currentStatus)) {
      // Check if this is a post-test round announcement (interview, next round, selection list)
      const isPostTestRound =
        emailClass === 'interview' ||
        /interview\s+(?:is\s+)?scheduled|technical\s+interview|hr\s+interview|final\s+interview|next\s+round\s+of\s+(?:the\s+)?(?:selection\s+process|selection|process|hiring)|selection\s+process\s+is\s+scheduled|physical\s+selection/i.test(subjLower) ||
        (/next\s+round/i.test(subjLower) && (
          /interview|in[\s-]*person|f2f|resumes?|formal\s+dress|blacklisted/i.test(fullText) ||
          !/(?:online\s+)?test|assessment\s*\d|coding\s+test|\bshl\b|\bmettl\b|\bhackerrank\b/i.test(subjLower)
        )) ||
        /selection\s+list|final\s+shortlist|congratulations.*(?:selection\s+list|selects)/i.test(subjLower) ||
        /interview\s+shortlist|shortlist\s+for\s+interview|next\s+round\s+shortlist|shortlisted\s+for\s+next\s+round/i.test(fullText);

      if (isPostTestRound) {
        // Check if user had an actual confirmed shortlist match in the database
        const { data: compMatches } = await supabase
          .from('candidate_matches')
          .select('id, email_id, emails!inner(received_at, placement_drive_id)')
          .eq('user_id', userId)
          .eq('placement_drive_id', targetDriveId);

        const hasConfirmedMatch = compMatches && compMatches.length > 0;

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

        // A candidate can ONLY be rejected if:
        // 1. They were in a previous stage (test_scheduled / interview_scheduled)
        // 2. They don't have a test scheduled in the future!
        // 3. The current email was received AFTER their test shortlist match email
        const latestMatchTime = compMatches?.reduce((max, m: any) => {
          const t = m.emails?.received_at ? new Date(m.emails.received_at).getTime() : 0;
          return Math.max(max, t);
        }, 0) || 0;

        const isEmailAfterTestMatch = !latestMatchTime || emailReceivedTime >= (latestMatchTime - 5 * 60 * 1000);

        if (hasConfirmedMatch && ['test_scheduled', 'interview_scheduled'].includes(currentStatus) && !hasFutureTestEvent && isEmailAfterTestMatch) {
          // User was in the test/interview and was eliminated in a subsequent round
          newStatus = 'rejected';
        } else if (hasConfirmedMatch && hasFutureTestEvent) {
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
      const { data: toDelete } = await supabase
        .from('events')
        .select('id, gcal_event_id')
        .eq('user_id', userId)
        .eq('placement_drive_id', targetDriveId)
        .neq('event_type', 'ppt');

      if (toDelete && toDelete.length > 0) {
        const { deleteEventFromGoogleCalendar } = await import('@/lib/calendar/google-sync');
        for (const ev of toDelete) {
          if (ev.gcal_event_id) {
            const deleted = await deleteEventFromGoogleCalendar({ userId, companyName: '', eventId: ev.gcal_event_id });
            if (!deleted) return;
          }
        }
      }

      await supabase
        .from('events')
        .delete()
        .eq('user_id', userId)
        .eq('placement_drive_id', targetDriveId)
        .neq('event_type', 'ppt');
    } else if (['withdrawn', 'declined', 'rejected'].includes(newStatus)) {
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
      }

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

  // Extract and populate registration deadline on application
  const regDeadlineEvt = extractedEvents.find((e) => e.eventType === 'registration_deadline' && e.startTime);
  if (regDeadlineEvt && regDeadlineEvt.startTime) {
    appUpdate.registration_deadline = regDeadlineEvt.startTime.toISOString();
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

  if (isRecentEmail && isDriveDiscoveryEmail && isInitialApplication) {
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
