import { createHash } from 'node:crypto';
import { getEvidenceMessageText, isQuotedReply } from './body';
import { classifyShortlistEmail, extractExplicitOrdinal, type RoundType } from './round-identity';
import { evaluateCachedShortlistRosters, type CachedRosterInput, type ShortlistVerificationState } from './shortlist-verification';
import { isNonShortlistRoster } from './roster-policy';
import { parseDateTimeWithConfidence } from './events';
import { hasPublishedShortlistContext, inlineShortlistRoster } from './placement-evidence';

export const ROUND_DECISION_VERSION = 4;
export { statusForRoundVerdict, roundEventNumbers } from './round-status';

export interface RoundEvidence {
  emailId: string;
  subject: string;
  body: string;
  receivedAt: string;
  rosters: Array<CachedRosterInput & { contentHash?: string | null }>;
  /** Only an exact identity match in an applicable list or a direct personal invitation. */
  directMatch?: boolean;
  directInvitation?: boolean;
  scheduledAt?: string | null;
  snapshotHashes?: string[];
  outcome?: 'selected' | 'rejected';
  roundTypeOverride?: RoundType;
}

export interface RoundVerdict {
  roundKey: string;
  roundType: RoundType | null;
  state: ShortlistVerificationState;
  outcome?: 'selected' | 'rejected';
  pptIncluded?: boolean;
  openInvitation?: boolean;
  eligible: boolean;
  finalNegative: boolean;
  reason: 'matched' | 'partial_list_absence' | 'complete_list_absence' | 'verification_pending';
  sourceEmailId: string;
  sourceReceivedAt: string;
  rosterKey: string;
  parserVersion: number;
  evaluations: Array<{ emailId: string; state: ShortlistVerificationState; rosterKey: string }>;
}

export function roundEvidenceKey(evidence: RoundEvidence): string {
  const text = getEvidenceMessageText({ subject: evidence.subject, bodyPlain: evidence.body, bodyHtml: '', bodySnippet: '' });
  const round = evidence.roundTypeOverride || (evidence.outcome ? 'result:' + evidence.outcome : classifyShortlistEmail(evidence.subject, text) || 'unknown');
  if (round === 'game') return 'game';
  const ordinal = extractExplicitOrdinal(evidence.subject, text);
  if (ordinal) return `${round.replace(/_r2$/, '')}:${ordinal.roundNumber}`;
  if (round === 'test_r2' || round === 'interview_r2') return `${round.replace(/_r2$/, '')}:2`;
  // Dated next-round lists cannot inherit a preceding generic test match.
  const parsedDate = parseDateTimeWithConfidence(`${evidence.subject}\n${text}`, new Date(evidence.receivedAt)).date;
  const date = evidence.scheduledAt?.slice(0, 10) || (parsedDate ? new Date(parsedDate.getTime() + 330 * 60_000).toISOString().slice(0, 10) : null);
  return date ? `${round}:${date.toLowerCase()}` : round;
}

export function canonicalRosterKey(evidence: RoundEvidence): string {
  const urls = getEvidenceMessageText({ subject: evidence.subject, bodyPlain: evidence.body, bodyHtml: '', bodySnippet: '' })
    .match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/(?:e\/)?[\w-]+/g) || [];
  const identities = evidence.rosters.map((roster) => roster.contentHash ||
    createHash('sha256').update(JSON.stringify(roster.extractedRows || [evidence.emailId, roster.filename])).digest('hex'));
  return createHash('sha256').update(JSON.stringify([roundEvidenceKey(evidence), /supplementary|additional\s+list/i.test(evidence.subject + evidence.body) ? 'supplementary' : /revised|updated|replac|final\s+(?:shortlist|list)/i.test(evidence.subject + evidence.body) ? 'replacement' : 'original', [...new Set([...urls, ...identities, ...(evidence.snapshotHashes || [])])].sort(), identities.length ? null : evidence.body])).digest('hex');
}

export function isPartialRoster(text: string): boolean {
  return /\blist\s*[-:#]?\s*\d{1,2}\b|\bbatch\s*[-:#]?\s*\d{1,2}\b|partial\s+list|supplementary|additional\s+list|more\s+(?:lists?|candidates?)|first\s+list|remaining\s+shortlisted|remaining\s+(?:students|candidates)|other\s+shortlisted/i.test(text);
}

/** One round's evidence never grants eligibility to another round. */
export function resolveRoundVerdicts(evidence: RoundEvidence[], identityTokens: string[]): RoundVerdict[] {
  const groups = new Map<string, RoundEvidence[]>();
  for (const original of evidence) {
    const item = { ...original, rosters: original.rosters.filter((roster) => !isNonShortlistRoster(roster.filename)) };
    if (isQuotedReply(item.subject) && !item.rosters.length) continue;
    const text = getEvidenceMessageText({ subject: item.subject, bodyPlain: item.body, bodyHtml: '', bodySnippet: '' });
    if (!item.rosters.length && !item.directInvitation && !item.outcome && !/shortlist|selected\s+(?:students|candidates)|selection\s+list/i.test(`${item.subject}\n${text}`)) continue;
    const shortlistContext = hasPublishedShortlistContext(item.subject, text) || item.rosters.some(roster=>/shortlist|selection[\s_-]*list/i.test(roster.filename));
    if (!shortlistContext && !item.directInvitation && !item.directMatch && !item.outcome) continue;
    const inline = inlineShortlistRoster(item.subject, text);
    if (inline) item.rosters.push(inline);
    const key = roundEvidenceKey(item);
    const list = groups.get(key) || [];
    list.push(item);
    groups.set(key, list);
  }
  const verdicts: RoundVerdict[] = [];
  for (const [roundKey, items] of groups) {
    items.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.emailId.localeCompare(b.emailId));
    // Revised/final lists replace older lists in the same round; supplementary lists add to them.
    const snapshots = new Map<string, RoundEvidence>();
    for (const item of items) {
      const snapshotKey = canonicalRosterKey(item);
      if (!snapshots.has(snapshotKey)) snapshots.set(snapshotKey, item);
    }
    const canonicalItems = [...snapshots.values()];
    const replacementIndex = canonicalItems.findLastIndex((item) => /revised|updated|replac|final\s+(?:shortlist|list)/i.test(`${item.subject}\n${item.body}`));
    const active = replacementIndex < 0 ? canonicalItems : canonicalItems.slice(replacementIndex);
    const latest = active[active.length - 1];
    const scans = active.map((item) => ({ item, evaluation: evaluateCachedShortlistRosters({ rosters: item.rosters, shortlistContext: true, identityTokens }) }));
    const result = active.findLast((item) => item.outcome);
    const present = result?.outcome === 'rejected' ? undefined : scans.findLast(({ item, evaluation }) => item.outcome === 'selected' || item.directInvitation || item.directMatch || evaluation.state === 'verified_present');
    const hasVerifiedRosters = scans.some(({ evaluation, item }) => item.rosters.length > 0 && ['verified_present', 'verified_absent'].includes(evaluation.state));
    const incomplete = !result && !present && (
      scans.some(({ evaluation, item }) => !item.directInvitation && !item.directMatch && item.rosters.length > 0 && evaluation.state === 'deferred') ||
      (!hasVerifiedRosters && scans.some(({ evaluation, item }) => !item.directInvitation && !item.directMatch && ['deferred', 'not_published'].includes(evaluation.state)))
    );
    const partial = active.some((item) => isPartialRoster(`${item.subject}\n${item.body}`));
    const source = result || present?.item || latest;
    const state: ShortlistVerificationState = present ? 'verified_present' : incomplete ? 'deferred' : 'verified_absent';
    verdicts.push({
      roundKey, outcome: result?.outcome, roundType: source.roundTypeOverride || classifyShortlistEmail(source.subject, source.body), state,
      pptIncluded: Boolean(present && /\bppt\b|pre[\s-]*placement\s+talk/i.test(source.subject)),
      openInvitation: Boolean(source.directInvitation && source.roundTypeOverride === 'ppt'),
      eligible: Boolean(present), finalNegative: result?.outcome === 'rejected' || state === 'verified_absent' && !partial,
      reason: present ? 'matched' : state === 'deferred' ? 'verification_pending' : partial ? 'partial_list_absence' : 'complete_list_absence',
      sourceEmailId: source.emailId, sourceReceivedAt: latest.receivedAt,
      rosterKey: canonicalRosterKey(source), parserVersion: ROUND_DECISION_VERSION,
      evaluations: items.map((item) => {
        const key = canonicalRosterKey(item);
        const scan = scans.find((scan) => canonicalRosterKey(scan.item) === key);
        return { emailId: item.emailId, state: scan ? (scan.item.outcome === 'selected' || scan.item.directMatch || scan.item.directInvitation ? 'verified_present' : scan.evaluation.state) : 'deferred', rosterKey: key };
      }),
    });
  }
  return verdicts.sort((a, b) => a.sourceReceivedAt.localeCompare(b.sourceReceivedAt));
}

