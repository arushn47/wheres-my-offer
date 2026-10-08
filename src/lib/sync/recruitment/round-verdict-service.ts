import type { createAdminClient } from '@/lib/supabase/admin';
import { getEvidenceMessageText, isQuotedReply } from '../extraction/body';
import { loadUserCandidateIdentity, getStrongIdentityTokens, matchesCandidateText, matchesCandidateRow } from '../identity/user-identity';
import { resolveRoundVerdicts, statusForRoundVerdict, type RoundEvidence, type RoundVerdict } from './round-verdict';
import { currentMutationLease, assertMutationLease } from '../mutation-lease';
import { sendNotification, type CreateNotificationParams } from '@/lib/notifications/service';
import { personalPlacementEvidence, hasPublishedShortlistContext, inlineShortlistRoster, isOpenPptInvitation } from './placement-evidence';
import { loadCandidateRosters } from '../attachments/roster-lookup';

type Admin = ReturnType<typeof createAdminClient>;
export interface VerdictEmail {
  id: string; subject?: string | null; body_text?: string | null; body_snippet?: string | null;
  received_at?: string | null; college_email_id?: string | null; canonical_email_id?: string | null;
  sender?: string | null;
}

/** Reads only circulars already resolved to this drive by the caller. */
export async function calculateDriveRoundVerdicts(supabase: Admin, userId: string, driveId: string, emails: VerdictEmail[]): Promise<RoundVerdict[]> {
  const identity = await loadUserCandidateIdentity(supabase, userId);
  const circulars = emails.filter((email) => email.college_email_id || email.canonical_email_id || (email as any).sender_email || (!email.sender && email.id) ||
    /noreply\.cdcinfo@vitstudent\.ac\.in/i.test(email.sender || '') && /test\s+link|password|passkey|assessment\s+link|you.*(?:selected|shortlisted)|your.*(?:offer|reject)|congratulations|regret.*inform/i.test(email.body_text || email.body_snippet || ''));
  const ids = Array.from(new Set(circulars.map((email) => email.college_email_id || email.canonical_email_id || email.id)));
  const indexedRosters = await loadCandidateRosters(supabase,ids,getStrongIdentityTokens(identity));
  const attachments: Array<{ college_email_id: string; filename: string; content_hash: string | null; parse_status: string; extracted_rows: RoundEvidence['rosters'][number]['extractedRows'] }> = [];
  for (let offset = 0; !indexedRosters && offset < ids.length; offset += 100) {
    const { data, error } = await supabase.from('college_attachments')
      .select('college_email_id,filename,content_hash,parse_status,extracted_rows').in('college_email_id', ids.slice(offset, offset + 100));
    if (error) throw error;
    attachments.push(...(data || []));
  }
  const sheets: Array<{ college_email_id: string; source_url: string; parse_status: string; content_hash: string | null; college_sheet_snapshots: { extracted_rows: RoundEvidence['rosters'][number]['extractedRows'] } | null }> = [];
  for (let offset = 0; !indexedRosters && offset < ids.length; offset += 100) {
    const { data, error } = await supabase.from('college_sheet_sources').select('college_email_id,source_url,parse_status,content_hash,college_sheet_snapshots(extracted_rows)').in('college_email_id', ids.slice(offset, offset + 100));
    if (error) throw error;
    sheets.push(...(data || []) as unknown as typeof sheets);
  }
  const { data: matches, error } = await supabase.from('candidate_matches')
    .select('college_email_id,email_id,matched_value,match_type,matched_round_type,evidence').eq('user_id', userId).eq('placement_drive_id', driveId);
  if (error) throw error;
  const evidence: RoundEvidence[] = [];
  for (const email of circulars) {
    const ref = email.college_email_id || email.canonical_email_id || email.id;
    const subject = email.subject || '';
    const raw = email.body_text || email.body_snippet || '';
    const body = getEvidenceMessageText({ subject, bodyPlain: raw, bodyHtml: '', bodySnippet: '' });
    const rosters: RoundEvidence['rosters'] = indexedRosters
      ? indexedRosters.filter(roster=>roster.collegeEmailId===ref && /\.(xlsx|xls|csv)$/i.test(roster.filename))
      : attachments.filter((attachment) => attachment.college_email_id === ref && /\.(xlsx|xls|csv)$/i.test(attachment.filename))
      .map((attachment) => ({ filename: attachment.filename, collegeEmailId: ref, contentHash: attachment.content_hash, parseStatus: attachment.parse_status, extractedRows: attachment.extracted_rows }));
    for (const sheet of sheets.filter((sheet) => sheet.college_email_id === ref)) {
      rosters.push({ filename: 'Google Sheet shortlist.csv', collegeEmailId: ref, contentHash: sheet.content_hash, parseStatus: sheet.parse_status, extractedRows: sheet.college_sheet_snapshots?.extracted_rows || null });
    }
    if (isQuotedReply(subject) && rosters.length === 0) continue;
    // Legacy sheet matches must carry a strong identity, not a common-name hit.
    const sourceMatches = (matches || []).filter((match) => match.college_email_id === ref);
    const sheetMatch = !(indexedRosters ? indexedRosters.some(roster=>roster.collegeEmailId===ref && roster.sourceKind==='sheet') : sheets.some((sheet) => sheet.college_email_id === ref)) && sourceMatches.some((match) => match.college_email_id === ref &&
      /Google Sheet/i.test(match.matched_value || '') &&
      matchesCandidateRow((match.matched_value || '').split(/[:,]/).map((cell: string) => cell.trim()), identity).matched);
    const isPersonalOfficial = !email.college_email_id && !email.canonical_email_id && /noreply\.cdcinfo@vitstudent\.ac\.in/i.test(email.sender || '');
    const personalEvidence = isPersonalOfficial ? personalPlacementEvidence(subject, body) : { invitation: false };
    const outcome = personalEvidence.outcome;
    const personalInvitation = personalEvidence.invitation;
    const openInvitation = /(?:applied|registered)\s+(?:students|candidates)/i.test(`${subject}\n${body}`) && /tests?\.mettl\.com|test\s+link|assessment\s+link/i.test(body) && !/shortlist/i.test(`${subject}\n${body}`);
    const openPpt = isOpenPptInvitation(subject, body);
    const pptOnlySubject = /\bppt\b|pre[\s-]*placement\s+talk/i.test(subject) && !/test|assessment|interview|game|\bgd\b|next\s+round|selection\s+process/i.test(subject);
    evidence.push({ emailId: ref, subject, body, receivedAt: email.received_at || '', rosters, outcome, roundTypeOverride: openPpt || pptOnlySubject ? 'ppt' : undefined, snapshotHashes: sourceMatches.flatMap((match) => match.evidence?.contentHash ? [match.evidence.contentHash] : []), directInvitation: personalInvitation || openInvitation || openPpt,
      // Inline tables must pass the row outcome check; a waitlisted ID is not shortlisted.
      directMatch: sheetMatch || (!inlineShortlistRoster(subject,body) && hasPublishedShortlistContext(subject,body) && !/waitlist|not\s+(?:selected|shortlisted)|rejected/i.test(body) && matchesCandidateText(body, identity).matched) });
  }
  return resolveRoundVerdicts(evidence, getStrongIdentityTokens(identity));
}

export async function commitDriveRoundVerdicts(supabase: Admin, userId: string, driveId: string, companyName: string, verdicts: RoundVerdict[], status: string, suppressNotifications = false, events?: Array<Record<string, unknown>>): Promise<void> {
  const lease = currentMutationLease();
  if (!lease || lease.userId !== userId) throw new Error('Round decision commit requires the user lease');
  await assertMutationLease();
  let current = verdicts.at(-1);
  const lastPresentIdx = verdicts.findLastIndex(v => v.eligible && v.state === 'verified_present');
  if (lastPresentIdx >= 0) {
    const subsequent = verdicts.slice(lastPresentIdx + 1);
    const firstElimination = subsequent.find(v => !v.eligible && v.state === 'verified_absent' && v.finalNegative);
    if (firstElimination) current = firstElimination;
  } else {
    const firstElimination = verdicts.find(v => !v.eligible && v.state === 'verified_absent' && v.finalNegative);
    if (firstElimination) current = firstElimination;
  }
  for (const verdict of verdicts) {
    const isCurrent = verdict === current;
    const isRecent = Date.now() - new Date(verdict.sourceReceivedAt).getTime() < 48 * 60 * 60 * 1000;
    const notification: CreateNotificationParams | null = isCurrent && verdict.eligible && !verdict.openInvitation && !['withdrawn','declined'].includes(status) && isRecent && !suppressNotifications ? {
      userId, placementDriveId: driveId, type: verdict.outcome === 'selected' ? 'status_change' : 'shortlist_match',
      title: verdict.outcome === 'selected' ? `Selected: ${companyName}` : `Shortlisted: ${companyName} — ${verdict.roundType === 'game' ? 'Game round' : verdict.roundKey}`,
      body: verdict.outcome === 'selected' ? 'Your personal placement email confirms selection.' : 'Your identifier matched the published list for this round.',
      dedupeKey: `round:${userId}:${driveId}:${verdict.roundKey}:${verdict.rosterKey}:present`,
    } : null;
    const { error } = await supabase.rpc('commit_round_verdict', {
      p_user_id: userId, p_run_id: lease.runId, p_drive_id: driveId, p_verdict: verdict,
      p_status: isCurrent ? status : statusForRoundVerdict(verdict, 'applied'), p_is_current: isCurrent, p_notification: notification,
      p_events: isCurrent ? events || null : null,
    });
    if (error) throw error;
  }
  if (!suppressNotifications) await dispatchRoundNotificationOutbox(supabase, userId);
}

export async function reconcileDriveEvents(supabase: Admin, userId: string, driveId: string, events: Array<Record<string, unknown>>): Promise<void> {
  const lease = currentMutationLease();
  if (!lease || lease.userId !== userId) throw new Error('Event reconciliation requires the user lease');
  const { error } = await supabase.rpc('reconcile_drive_events', { p_user_id: userId, p_run_id: lease.runId, p_drive_id: driveId, p_events: events });
  if (error) throw error;
}

export async function dispatchCalendarRemovals(supabase: Admin, userId: string): Promise<void> {
  const { data, error } = await supabase.from('calendar_removal_outbox').select('id,gcal_event_id').eq('user_id', userId).is('completed_at', null);
  if (error) throw error;
  const { deleteEventFromGoogleCalendar } = await import('@/lib/calendar/google-sync');
  for (const row of data || []) {
    if (await deleteEventFromGoogleCalendar({ userId, companyName: '', eventId: row.gcal_event_id })) {
      const { error } = await supabase.from('calendar_removal_outbox').update({ completed_at: new Date().toISOString() }).eq('id', row.id);
      if (error) throw error;
    }
  }
}

export async function dispatchRoundNotificationOutbox(supabase: Admin, userId: string): Promise<void> {
  const { data, error } = await supabase.from('decision_notification_outbox')
    .select('id,decision_id,payload,round_verdicts!inner(is_current,verdict)').eq('user_id', userId).is('delivered_at', null);
  if (error) throw error;
  for (const row of data || []) {
    const decision = Array.isArray(row.round_verdicts) ? row.round_verdicts[0] : row.round_verdicts;
    if (!decision?.is_current || !decision.verdict?.eligible) continue;
    const result = await sendNotification({ ...row.payload, decisionId: row.decision_id } as CreateNotificationParams);
    if (result.complete) {
      const { error } = await supabase.from('decision_notification_outbox').update({ delivered_at: new Date().toISOString() }).eq('id', row.id);
      if (error) throw error;
    }
  }
}
