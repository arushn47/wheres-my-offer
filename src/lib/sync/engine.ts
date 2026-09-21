import {
  createGmailClient,
  fetchMessageIds,
  fetchMessageDetail,
  fetchMessageMetadata,
  getPlacementSearchQuery,
  type GmailAccount,
  type ParsedEmail,
} from '@/lib/gmail/client';
import {
  classifyEmail,
  cleanCompanyName,
  extractCompanyName,
  normalizeCompanyName,
  computeNormalizedKey,
  checkAcronymMatch,
  extractCompanyAliases,
  ENGLISH_STOPWORDS,
  type ClassificationResult,
} from '@/lib/sync/classifier';
import { extractDriveNumber, extractAllDriveNumbers, extractJobDetails, extractEvents } from '@/lib/sync/events';
import {
  buildCircularCatalog,
  loadAllDriveResolutions,
  resolveDriveByTimingCorrelation,
  type CircularRoleEntry,
  type DriveResolutionResult,
} from '@/lib/sync/drive-correlator';
import { createAdminClient } from '@/lib/supabase/admin';
import { getCurrentMessageText } from '@/lib/sync/body';
import { resolvePlacementDrive } from '@/lib/sync/drive-resolution';
import { getLiveApplicationScope } from '@/lib/sync/application-scope';
import { randomUUID, createHash } from 'node:crypto';

// ============================================
// Canonical Email Deduplication (Phase 2C — Shadow Mode)
// ============================================

/**
 * Computes a stable content key for a college broadcast email.
 * Used to deduplicate identical CDC circulars across all users.
 *
 * Key = SHA-256(senderEmail.toLowerCase() + "||" + subject.trim() + "||" + body[:500])
 *
 * ONLY call for college broadcast senders (vitlions2027@vitbhopal.ac.in).
 * Personal NeoPAT emails (noreply.cdcinfo) are never canonicalized.
 */
export function computeContentKey(senderEmail: string, subject: string, bodySnippet: string): string {
  const normalizedSender = (senderEmail || '').toLowerCase().trim();
  const normalizedSubject = (subject || '').trim();
  const bodyPrefix = (bodySnippet || '').slice(0, 500);
  return createHash('sha256')
    .update(`${normalizedSender}||${normalizedSubject}||${bodyPrefix}`)
    .digest('hex');
}

/**
 * Shadow-writes a canonical_emails row for a processed college broadcast email.
 * Failures are silently logged — this never throws or affects the main pipeline.
 * In Phase 2D, we will flip to reading canonical_emails before fetching Gmail bodies.
 */
async function shadowWriteCanonical(
  supabase: ReturnType<typeof createAdminClient>,
  parsedEmail: ParsedEmail,
  emailId: string,
  classification: import('@/lib/sync/classifier').ClassificationResult,
  companyName: string | null,
  account: GmailAccount
): Promise<void> {
  try {
    const bodyText = parsedEmail.bodyPlain || parsedEmail.bodySnippet || '';
    const contentKey = computeContentKey(
      parsedEmail.senderEmail || parsedEmail.sender,
      parsedEmail.subject,
      bodyText
    );

    const canonicalPayload = {
      content_key: contentKey,
      sender_email: (parsedEmail.senderEmail || parsedEmail.sender || '').toLowerCase().trim(),
      subject: parsedEmail.subject,
      body_snippet: bodyText.slice(0, 50000),
      classification: classification.classification,
      classification_confidence: classification.confidence ?? null,
      parsed_company_name: companyName || null,
      processing_status: 'complete' as const,
      updated_at: new Date().toISOString(),
    };

    const { data: canonical, error: upsertError } = await supabase
      .from('canonical_emails')
      .upsert(canonicalPayload, { onConflict: 'content_key', ignoreDuplicates: false })
      .select('id')
      .single();

    if (upsertError) {
      console.warn('[canonical] Shadow upsert failed:', upsertError.message);
      return;
    }

    if (canonical?.id) {
      // Link the per-user emails row to the canonical row
      await supabase
        .from('emails')
        .update({ canonical_email_id: canonical.id })
        .eq('id', emailId);
    }
  } catch (err) {
    // Shadow writes must never crash the main pipeline
    console.warn('[canonical] Shadow write error (non-fatal):', err instanceof Error ? err.message : String(err));
  }
}

// ============================================
// Sync Progress Types & Constants
// ============================================

export const PAGE_SIZE = 50;

/**
 * Total wall-clock budget for a background cron invocation.
 * Set to 270s to leave a 30s margin under maxDuration = 300s.
 * The cron loop processes pages across all accounts until this budget is consumed.
 */
export const CRON_TOTAL_BUDGET_MS = 270_000;

export interface SyncPageRow {
  id: string;
  user_id: string;
  gmail_account_id: string;
  page_index: number;
  message_ids: string[];
  next_offset: number;
  status: 'pending' | 'in_progress' | 'complete';
  created_at?: string;
  updated_at?: string;
}

export interface ProcessPageResult {
  completed: boolean;
  emailsProcessed: number;
  newEmails: number;
  newCompanies: number;
  skippedDuplicates: number;
  errors: string[];
}

export interface SyncProgress {
  phase: 'initializing' | 'fetching' | 'processing' | 'complete' | 'error';
  accountEmail: string;
  accountType: string;
  totalMessages: number;
  processedMessages: number;
  alreadyIndexed?: number;
  remainingMessages?: number;
  isResuming?: boolean;
  newEmails: number;
  newCompanies: number;
  skippedDuplicates: number;
  errors: string[];
  currentSubject?: string;
  isInitialSync?: boolean;
  currentPageIndex?: number;
  totalPagesCount?: number;
  isPage0Complete?: boolean;
}

export interface SyncResult {
  totalEmailsFetched: number;
  totalEmailsProcessed: number;
  newEmails: number;
  newCompanies: number;
  skippedDuplicates: number;
  errors: string[];
  alreadyRunning?: boolean;
  currentPageIndex?: number;
  totalPagesCount?: number;
  isPage0Complete?: boolean;
  hasMorePagesPending?: boolean;
  accounts: {
    email: string;
    accountType: string;
    emailsFetched: number;
    emailsProcessed: number;
    newEmails: number;
    newCompanies: number;
  }[];
}

// Authorized NeoPAT & Placement circular senders
export const TRUSTED_PLACEMENT_SENDERS = [
  'noreply.cdcinfo@vitstudent.ac.in',
  'vitlions2027@vitbhopal.ac.in',
];

// Known non-placement senders to always skip (Google, Microsoft notifications, social media, etc.)
export const BLOCKED_SENDERS = /noreply-accounts@google|no-reply@accounts\.google|noreply@github|notifications@github|@linkedin\.com|@facebookmail|@discord|@slack|noreply@medium|noreply@.*\.zoom\.us|security-noreply|account-security|password.*reset|verify.*email|do-not-reply@|mailer-daemon/i;

/**
 * Strictly verifies whether an incoming email is from an authorized placement sender.
 * - Personal accounts: STRICTLY noreply.cdcinfo@vitstudent.ac.in (master drive notifications).
 * - College accounts: STRICTLY vitlions2027@vitbhopal.ac.in (2027 batch group) OR noreply.cdcinfo@vitstudent.ac.in.
 * Any other sender is completely ignored and dropped in under a millisecond.
 */
export const isTrustedPlacementSender = (senderEmail: string, isPersonal: boolean): boolean => {
  const clean = (senderEmail || '').toLowerCase().trim();
  if (isPersonal) {
    return clean.includes('noreply.cdcinfo@vitstudent.ac.in');
  }
  return (
    clean.includes('vitlions2027@vitbhopal.ac.in') ||
    clean.includes('noreply.cdcinfo@vitstudent.ac.in')
  );
};

export const isTrustedSender = (senderEmail: string, isPersonal: boolean) =>
  isTrustedPlacementSender(senderEmail, isPersonal);

// Retry a Gmail API call with exponential backoff on quota/rate-limit errors
export async function withQuotaBackoff<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  const BACKOFF_DELAYS = [10_000, 30_000, 90_000]; // 10s, 30s, 90s
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isQuota = /quota exceeded|rate.?limit|units.?per.?minute|rateLimitExceeded/i.test(msg);
      if (isQuota && attempt < maxRetries) {
        const delay = BACKOFF_DELAYS[attempt] ?? 90_000;
        console.warn(`Gmail quota hit — backing off ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('withQuotaBackoff: unreachable');
}

/**
 * Plans count-based sync pages for an account.
 * Slices already-deduped newMsgIds (newest-first, straight from Gmail)
 * into fixed pages of PAGE_SIZE.
 */
export async function planSyncPages(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  account: GmailAccount,
  newMsgIds: string[]
): Promise<SyncPageRow[]> {
  // Check if active (pending or in_progress) pages already exist for this account
  const { data: existingPages } = await supabase
    .from('sync_pages')
    .select('id, user_id, gmail_account_id, page_index, message_ids, next_offset, status, created_at, updated_at')
    .eq('gmail_account_id', account.id)
    .order('page_index', { ascending: true });

  const pendingOrActive = (existingPages || []).filter((p) => p.status !== 'complete');
  if (pendingOrActive.length > 0) {
    return existingPages as SyncPageRow[];
  }

  if (!newMsgIds || newMsgIds.length === 0) {
    return [];
  }

  // Reverse newMsgIds (from newest-first to oldest-first) so that historical emails are
  // batched into early pages. This is CRITICAL for deterministic stateful status derivation.
  const chronologicalIds = [...newMsgIds].reverse();

  const pagesToInsert: {
    user_id: string;
    gmail_account_id: string;
    page_index: number;
    message_ids: string[];
    next_offset: number;
    status: 'pending';
  }[] = [];

  for (let i = 0; i < chronologicalIds.length; i += PAGE_SIZE) {
    const pageIndex = Math.floor(i / PAGE_SIZE);
    const slice = chronologicalIds.slice(i, i + PAGE_SIZE);
    pagesToInsert.push({
      user_id: userId,
      gmail_account_id: account.id,
      page_index: pageIndex,
      message_ids: slice,
      next_offset: 0,
      status: 'pending',
    });
  }

  // Delete any old completed pages for this account before inserting new season plan
  await supabase.from('sync_pages').delete().eq('gmail_account_id', account.id);

  const { data: inserted, error } = await supabase
    .from('sync_pages')
    .insert(pagesToInsert)
    .select('id, user_id, gmail_account_id, page_index, message_ids, next_offset, status, created_at, updated_at')
    .order('page_index', { ascending: true });

  if (error) {
    console.error('[planSyncPages] Failed to insert sync pages:', error);
    throw new Error(`Failed to plan sync pages: ${error.message}`);
  }

  return (inserted || []) as SyncPageRow[];
}

// ============================================
// Per-Message Processing (parallelizable unit)
// ============================================

interface SingleMessageResult {
  emailsProcessed: number;
  newEmails: number;
  newCompanies: number;
  skippedDuplicates: number;
  errors: string[];
  retryable: boolean;
}

export interface TargetedMessageRequest {
  emailId: string;
  userId: string;
  companyId: string;
}

interface LiveSyncTracker {
  processedMessages: number;
  newEmails: number;
  newCompanies: number;
  skippedDuplicates: number;
}

/**
 * Processes a single Gmail message: metadata → full detail → classify → upsert company → insert email → status engine.
 * Self-contained so it can be run concurrently via Promise.allSettled inside processPage.
 * Includes per-stage timing instrumentation for diagnosing sync throughput.
 */
async function processSingleMessage(
  msgId: string,
  ctx: {
    supabase: ReturnType<typeof createAdminClient>;
    userId: string;
    account: GmailAccount;
    gmail: any;
    fetchMessageMetadata: (gmail: any, msgId: string) => Promise<any>;
    isPersonal: boolean;
    isAccountInitialSync: boolean;
    existingInDb: Set<string>;
    existingEmailId?: string;
    deps: {
      userNeoId: string | null;
      userEmail: string;
      circularCatalog: Map<string, any[]>;
      persistedResolutions: Map<string, any>;
      driveResolutionsMap: Map<string, string>;
      companyLocks: Map<string, Promise<void>>;
    };
    pageIndex: number;
    totalPagesCount?: number;
    totalMessages: number;
    onProgress?: (progress: SyncProgress) => void;
    liveTracker: LiveSyncTracker;
    prefetchedEmail?: ParsedEmail;
  }
): Promise<SingleMessageResult> {
  const result: SingleMessageResult = {
    emailsProcessed: 0,
    newEmails: 0,
    newCompanies: 0,
    skippedDuplicates: 0,
    errors: [],
    retryable: false,
  };

  const { supabase, userId, account, gmail, fetchMessageMetadata, isPersonal, existingInDb, deps } = ctx;

  if (existingInDb.has(msgId) && !ctx.existingEmailId) {
    result.skippedDuplicates++;
    ctx.liveTracker.skippedDuplicates++;
    ctx.liveTracker.processedMessages++;
    return result;
  }

  try {
    const t0 = Date.now();
    let t1 = t0;

    let parsedEmail: ParsedEmail;
    if (ctx.prefetchedEmail) {
      parsedEmail = ctx.prefetchedEmail;
    } else {
      // Stage 1: Cheap metadata inspection
      let shouldFetchFull = true;
      const metadata = await withQuotaBackoff(() => fetchMessageMetadata(gmail, msgId));
      t1 = Date.now();
      const subj = metadata.subject.toLowerCase();
      const snippet = metadata.snippet.toLowerCase();
      const senderLower = metadata.senderEmail.toLowerCase();

      // STRICT SENDER ENFORCEMENT:
      // Personal: ONLY noreply.cdcinfo@vitstudent.ac.in
      // College: ONLY vitlions2027@vitbhopal.ac.in (+ noreply.cdcinfo@vitstudent.ac.in)
      // Discard all other senders immediately (<1ms) without downloading full body
      if (!isTrustedPlacementSender(senderLower, isPersonal) || BLOCKED_SENDERS.test(senderLower)) {
        shouldFetchFull = false;
      }

      if (!shouldFetchFull) {
        ctx.liveTracker.processedMessages++;
        return result;
      }

      // Stage 2: Full message detail & attachments
      parsedEmail = await withQuotaBackoff(() => fetchMessageDetail(gmail, msgId));
    }
    const t2 = Date.now();

    ctx.onProgress?.({
      phase: 'processing',
      accountEmail: account.email,
      accountType: account.account_type,
      totalMessages: ctx.totalMessages,
      processedMessages: ctx.liveTracker.processedMessages,
      currentPageIndex: ctx.pageIndex,
      totalPagesCount: ctx.totalPagesCount,
      currentSubject: parsedEmail.subject.slice(0, 80),
      newEmails: ctx.liveTracker.newEmails,
      newCompanies: ctx.liveTracker.newCompanies,
      skippedDuplicates: ctx.liveTracker.skippedDuplicates,
      errors: [],
    });

    const fullEmailText = `${parsedEmail.subject}\n${parsedEmail.bodyPlain || parsedEmail.bodySnippet || ''}`;
    const currentEmailText = `${parsedEmail.subject}\n${getCurrentMessageText(parsedEmail)}`;
    const driveNumber = extractDriveNumber(currentEmailText);
    const driveNameMatch = currentEmailText.match(/Drive Name:\s*([^.\n\r]+)/i);
    const driveName = driveNameMatch ? driveNameMatch[1].trim() : null;

    // Stage 3: Classify
    const classification = classifyEmail(parsedEmail, deps.driveResolutionsMap);
    let companyName = classification.companyName;
    const t3 = Date.now();

    // Timing correlation
    if (isPersonal && driveNumber && companyName) {
      const baseClean = cleanCompanyName(companyName);
      if (['Apple', 'Honeywell', 'Zluri', 'EY'].some((b) => b.toLowerCase() === baseClean.toLowerCase())) {
        const resolution = await resolveDriveByTimingCorrelation(
          supabase,
          driveNumber,
          baseClean,
          parsedEmail.receivedAt,
          deps.circularCatalog,
          deps.persistedResolutions
        );
        if (resolution) {
          companyName = resolution.resolvedCompanyName;
          deps.driveResolutionsMap.set(driveNumber, resolution.resolvedCompanyName);
        }
      }
    }

    // College role cataloging
    if (!isPersonal) {
      const baseCompanies = ['Apple', 'Honeywell', 'Zluri', 'EY'];
      for (const base of baseCompanies) {
        if (new RegExp(`\\b${base}\\b`, 'i').test(parsedEmail.subject) || new RegExp(`\\b${base}\\b`, 'i').test(parsedEmail.bodyPlain || parsedEmail.bodySnippet || '')) {
          const { extractTrackOrRole } = await import('@/lib/sync/drive-correlator');
          const trackInfo = extractTrackOrRole(fullEmailText, base);
          if (trackInfo) {
            const key = base.toLowerCase();
            if (!deps.circularCatalog.has(key)) deps.circularCatalog.set(key, []);
            deps.circularCatalog.get(key)!.push({
              emailId: parsedEmail.gmailMessageId,
              companyBaseName: base,
              role: trackInfo.role,
              track: trackInfo.track,
              resolvedCompanyName: trackInfo.resolvedCompanyName,
              sourceDate: parsedEmail.receivedAt,
              subject: parsedEmail.subject,
            });
          }
        }
      }
    }

    let companyId: string | null = null;
    let placementDriveId: string | null = null;
    let driveAssignmentState: string = 'unassigned';
    let driveAssignmentConfidence: string = 'low';
    let driveAssignmentSource: string = 'company_only';
    let applicationScope: ReturnType<typeof getLiveApplicationScope> = {
      kind: 'quarantine',
      companyId: null,
      reason: 'unassigned',
    };
    const isPlacementClassification = !['irrelevant', 'unclassified', 'general'].includes(
      classification.classification
    );

    // Stage 4: Upsert company
    if (companyName && isPlacementClassification) {
      const isNeoPatEmail =
        isPersonal &&
        /noreply\.cdcinfo@vitstudent\.ac\.in/i.test(
          parsedEmail.senderEmail || parsedEmail.sender
        );

      // Resolve organization identity without writing legacy company drive
      // metadata. placement_drives is the canonical opportunity identity.
      companyId = await upsertCompany(supabase, userId, companyName, isNeoPatEmail);

      const driveMetadata = extractJobDetails(currentEmailText);
      const driveDeadline = extractEvents(parsedEmail).find(
        (event) => event.eventType === 'registration_deadline' && event.startTime
      )?.startTime?.toISOString() || null;
      const driveResolution = await resolvePlacementDrive({
        supabase,
        userId,
        companyId,
        driveNumber,
        driveNumbers: extractAllDriveNumbers(currentEmailText),
        driveName,
        role: driveMetadata.role,
        category: driveMetadata.category,
        ctc: driveMetadata.ctc,
        stipend: driveMetadata.stipend,
        location: driveMetadata.location,
        registrationDeadline: driveDeadline,
        eligibility: driveMetadata.eligibility,
        branches: driveMetadata.branches,
        cgpaRequirement: driveMetadata.cgpaRequirement,
        backlogRequirement: driveMetadata.backlogRequirement,
      });
      placementDriveId = driveResolution.placementDriveId;
      driveAssignmentState = driveResolution.state;
      driveAssignmentConfidence = driveResolution.confidence;
      driveAssignmentSource = driveResolution.source;

      if (placementDriveId) {
        await supabase
          .from('placement_drives')
          .update({
            role: driveMetadata.role || undefined,
            category: driveMetadata.category || undefined,
            ctc: driveMetadata.ctc || undefined,
            stipend: driveMetadata.stipend || undefined,
            location: driveMetadata.location || undefined,
            registration_deadline: driveDeadline || undefined,
            eligibility: driveMetadata.eligibility || undefined,
            branches: driveMetadata.branches && driveMetadata.branches.length > 0 ? driveMetadata.branches : undefined,
            cgpa_requirement: driveMetadata.cgpaRequirement || undefined,
            backlog_requirement: driveMetadata.backlogRequirement || undefined,
            updated_at: new Date().toISOString(),
          })
          .eq('id', placementDriveId)
          .eq('user_id', userId)
          .eq('company_id', companyId);
      }

      applicationScope = getLiveApplicationScope({
        companyId,
        placementDriveId,
        assignmentState: driveAssignmentState,
        assignmentConfidence: driveAssignmentConfidence,
      });

      if (applicationScope.kind === 'drive') {
        const { count } = await supabase
          .from('emails')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('placement_drive_id', placementDriveId);

        if (count === 0) {
          result.newCompanies++;
          ctx.liveTracker.newCompanies++;
        }

        // DUAL-WRITE FIX: Baseline initialization only!
        // Do NOT overwrite status with 'withdrawn' or keywords here.
        // Leave all status evaluation, withdrawals, opt-outs, and promotions
        // strictly to processEmailForEventsAndStatus!
        const { data: currentApp } = await supabase
          .from('applications')
          .select('id')
          .eq('user_id', userId)
          .eq('placement_drive_id', applicationScope.placementDriveId)
          .single();

        if (!currentApp) {
          // Use upsert with ignoreDuplicates so concurrent processSingleMessage calls
          // for the same company (e.g. two emails in the same batch) don't race-crash.
          // The first call wins; subsequent calls on the same (user_id, company_id) are no-ops.
          // Drive-scoped records are authoritative for new live emails. Unresolved
          // emails never reach this branch and therefore cannot create legacy state.
          const baseApp = {
            user_id: userId,
            status: 'not_applied',
            status_source: isPersonal ? 'neopat_personal_email' : 'college_email_announcement',
            status_confidence: 'high',
            status_source_email_at: parsedEmail.receivedAt.toISOString(),
            last_updated: new Date().toISOString(),
            role: driveMetadata.role || null,
            category: driveMetadata.category || null,
            ctc: driveMetadata.ctc || null,
            stipend: driveMetadata.stipend || null,
            location: driveMetadata.location || null,
            registration_deadline: driveDeadline || null,
            eligibility: driveMetadata.eligibility || null,
            branches: driveMetadata.branches && driveMetadata.branches.length > 0 ? driveMetadata.branches : null,
            cgpa_requirement: driveMetadata.cgpaRequirement || null,
            backlog_requirement: driveMetadata.backlogRequirement || null,
          };
          
            const { error: applicationInsertError } = await supabase
              .from('applications')
              .insert({
                ...baseApp,
                placement_drive_id: applicationScope.placementDriveId,
              });
            if (applicationInsertError && applicationInsertError.code !== '23505') {
              throw applicationInsertError;
            }
        }
      }
    }
    const t4 = Date.now();

    // Insert email into DB
    const emailPayload = {
        user_id: userId,
        gmail_account_id: account.id,

        gmail_message_id: parsedEmail.gmailMessageId,
        thread_id: parsedEmail.threadId,
        subject: parsedEmail.subject,
        sender: parsedEmail.sender,
        received_at: parsedEmail.receivedAt.toISOString(),
        body_snippet: (parsedEmail.bodyPlain || parsedEmail.bodySnippet || '').slice(
          0,
          !isPersonal && isTrustedSender(parsedEmail.senderEmail || parsedEmail.sender, isPersonal) ? 50000 : 10000
        ),
        classification: classification.classification,
        is_processed: false,
        is_relevant: classification.classification !== 'irrelevant',
        processed_at: null,
        placement_drive_id: placementDriveId,
        assignment_state: driveAssignmentState,
        assignment_confidence: driveAssignmentConfidence,
        assignment_source: driveAssignmentSource,
      };
    const emailWrite = ctx.existingEmailId
      ? await supabase.from('emails').update(emailPayload).eq('id', ctx.existingEmailId).select('id').single()
      : await supabase.from('emails').insert(emailPayload).select('id').single();
    const insertedEmail = emailWrite.data;
    const insertError = emailWrite.error;

      if (insertError) {
        if (insertError.code === '23505') {
          result.skippedDuplicates++;
          ctx.liveTracker.skippedDuplicates++;
        } else {
          result.errors.push(insertError.message);
          result.retryable = true;
        }
    } else {
      result.newEmails++;
      ctx.liveTracker.newEmails++;

      // Stage 5: Status engine (with hard 8s timeout — prevents AI retry loops from stalling a page)
        if (companyId && insertedEmail && applicationScope?.kind === 'drive') {
        if (placementDriveId) {
          await supabase.from('email_drive_links').upsert({
            user_id: userId,
            email_id: insertedEmail.id,
            placement_drive_id: placementDriveId,
            link_type: 'primary',
            confidence: driveAssignmentConfidence,
            assignment_source: driveAssignmentSource,
            is_primary: true,
          }, { onConflict: 'email_id,placement_drive_id,link_type', ignoreDuplicates: true });
          await supabase
            .from('placement_drives')
            .update({ source_email_id: insertedEmail.id })
            .eq('id', placementDriveId)
            .is('source_email_id', null);
        }
        const { processEmailForEventsAndStatus } = await import(
          '@/lib/sync/status-engine'
        );
        const backgroundTask = processEmailForEventsAndStatus(
          supabase,
          userId,
          companyId as string,
          parsedEmail,
          insertedEmail.id,
          deps.userNeoId,
          account.email,
          placementDriveId,
          gmail,
          'drive'
        );

        const runStatusEngine = async () => {
          await Promise.race([
            backgroundTask,
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('ai_timeout')), 25000)
            ),
          ]);
        };

        const operationLockKey = placementDriveId || `legacy:${companyId}`;
        const existingLock = deps.companyLocks.get(operationLockKey) || Promise.resolve();
        
        // The NEXT lock must await the full background task, not just the race, to prevent concurrency if it times out
        const nextLock = existingLock.then(() => backgroundTask.catch(() => {}));
        deps.companyLocks.set(operationLockKey, nextLock);

        // The current message awaits the race (with timeout)
          await existingLock.then(runStatusEngine);
        } else if (insertedEmail) {
          console.info(`[processSingleMessage] Stored ${driveAssignmentState} email ${msgId} without operational mutation.`);
        }

        if (insertedEmail) {
          const { error: processedError } = await supabase
            .from('emails')
            .update({ is_processed: true, processed_at: new Date().toISOString() })
            .eq('id', insertedEmail.id);
          if (processedError) throw processedError;

          // Phase 2C — Shadow write to canonical_emails for college broadcast emails.
          // Personal NeoPAT emails (isPersonal) are never canonicalized — they contain
          // user-specific registration data. Only identical CDC circulars sent to all
          // students qualify.
          if (!isPersonal) {
            // Fire-and-forget: shadow write must never block or throw into the main pipeline
            shadowWriteCanonical(
              supabase,
              parsedEmail,
              insertedEmail.id,
              classification,
              companyName || null,
              account
            ).catch(() => {});
          }
        }
    }

    const t5 = Date.now();
    console.log(
      `[msg ${msgId}] metadata: ${t1 - t0}ms | detail: ${t2 - t1}ms | classify: ${t3 - t2}ms | upsert: ${t4 - t3}ms | status-engine: ${t5 - t4}ms | total: ${t5 - t0}ms`
    );

    result.emailsProcessed++;
    ctx.liveTracker.processedMessages++;
  } catch (emailErr) {
    ctx.liveTracker.processedMessages++;
    const errMsg = emailErr instanceof Error ? emailErr.message : String(emailErr);
    const isQuota = /quota exceeded|rate.?limit|units.?per.?minute/i.test(errMsg);
    if (!isQuota) {
      result.errors.push(errMsg);
    }
    result.retryable = true;
  }

  return result;
}

/**
 * One-time, allowlisted runner for already-indexed messages. It deliberately
 * reuses the production single-message pipeline while updating the verified
 * email row instead of inserting a duplicate.
 */
export async function processAllowlistedExistingMessages(params: {
  userId: string;
  companyId: string;
  emailIds: [string, string];
}): Promise<SingleMessageResult[]> {
  const allowedIds = new Set(params.emailIds);
  if (allowedIds.size !== 2) throw new Error('Exactly two distinct email IDs are required');

  const supabase = createAdminClient();
  const { data: rows, error: emailError } = await supabase
    .from('emails')
    .select('id, user_id, gmail_account_id, gmail_message_id, placement_drive_id')
    .in('id', params.emailIds);
  if (emailError) throw new Error(`Failed to verify target emails: ${emailError.message}`);
  if (!rows || rows.length !== 2 || rows.some((row) =>
    row.user_id !== params.userId || row.placement_drive_id !== params.companyId || !allowedIds.has(row.id)
  )) {
    throw new Error('Allowlisted emails failed user/company ownership verification');
  }

  const accountIds = new Set(rows.map((row) => row.gmail_account_id));
  if (accountIds.size !== 1) throw new Error('Allowlisted emails must use the same Gmail account');
  const { data: account, error: accountError } = await supabase
    .from('gmail_accounts')
    .select('id, email, account_type, access_token_encrypted, refresh_token_encrypted, token_expiry, last_sync_at, last_history_id')
    .eq('id', rows[0].gmail_account_id)
    .eq('user_id', params.userId)
    .eq('is_connected', true)
    .single();
  if (accountError || !account) throw new Error('Verified Gmail account is unavailable or disconnected');

  const { data: user } = await supabase.from('users').select('neo_id, email').eq('id', params.userId).single();
  const { gmail } = await createGmailClient(account as GmailAccount);
  const existingInDb = new Set(rows.map((row) => row.gmail_message_id));
  const companyLocks = new Map<string, Promise<void>>();
  const results: SingleMessageResult[] = [];

  for (const row of rows.sort((a, b) => a.gmail_message_id.localeCompare(b.gmail_message_id))) {
    results.push(await processSingleMessage(row.gmail_message_id, {
      supabase,
      userId: params.userId,
      account: account as GmailAccount,
      gmail,
      fetchMessageMetadata,
      isPersonal: account.account_type === 'personal',
      isAccountInitialSync: false,
      existingInDb,
      deps: {
        userNeoId: user?.neo_id || null,
        userEmail: user?.email || account.email,
        circularCatalog: new Map(),
        persistedResolutions: new Map(),
        driveResolutionsMap: new Map(),
        companyLocks,
      },
      pageIndex: 0,
      totalMessages: 2,
      liveTracker: {
        processedMessages: 0,
        newEmails: 0,
        newCompanies: 0,
        skippedDuplicates: 0,
      },
      existingEmailId: row.id,
    }));
  }
  return results;
}

/**
 * Processes a single sync page.
 * Reverses ONLY this page's message_ids (giving oldest-to-newest chronological order within this page),
 * processes each batch of messages concurrently via Promise.allSettled, and respects timeBudgetMs.
 */
export async function processPage(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  runId: string,
  account: GmailAccount,
  page: SyncPageRow,
  timeBudgetMs: number,
  deps: {
    userNeoId: string | null;
    userEmail: string;
    circularCatalog: Map<string, any[]>;
    persistedResolutions: Map<string, any>;
    driveResolutionsMap: Map<string, string>;
    companyLocks: Map<string, Promise<void>>;
  },
  onProgress?: (progress: SyncProgress) => void,
  initialCounts?: { newEmails: number; newCompanies: number; skippedDuplicates: number },
  globalDeadline?: number,
  totalPagesCount?: number
): Promise<ProcessPageResult> {
  const updateCheckpoint = async (nextOffset: number, status?: SyncPageRow['status']) => {
    if (page.id === 'ephemeral-page') return;
    const { data, error } = await supabase.rpc('update_sync_page_checkpoint', {
      p_user_id: userId,
      p_run_id: runId,
      p_page_id: page.id,
      p_next_offset: nextOffset,
      p_status: status || null,
    });
    if (error || data !== true) {
      throw new Error(error?.message || 'Sync lease no longer owns page checkpoint');
    }
  };

  await updateCheckpoint(page.next_offset || 0, 'in_progress');

  // Messages are already chronologically sorted (oldest-to-newest) in planSyncPages
  const chronoSortedMsgIds = [...page.message_ids];
  const startIndex = page.next_offset || 0;
  const startTime = Date.now();

  const isPersonal = account.account_type === 'personal';
  const isAccountInitialSync = !account.last_history_id;
  const BATCH_SIZE = 8;
  const INTER_BATCH_DELAY_MS = 0;

  const { gmail } = await createGmailClient(account);
  const { fetchMessageMetadata } = await import('@/lib/gmail/client');

  // Pre-check: IDs in this page already in emails table
  const { data: existingRows } = await supabase
    .from('emails')
    .select('id, gmail_message_id, is_processed')
    .eq('gmail_account_id', account.id)
    .in('gmail_message_id', chronoSortedMsgIds);

  const existingInDb = new Set(
    (existingRows || [])
      .filter((r) => r.is_processed)
      .map((r) => r.gmail_message_id)
  );
  const existingEmailIds = new Map(
    (existingRows || [])
      .filter((r) => !r.is_processed)
      .map((r) => [r.gmail_message_id, r.id])
  );

  let emailsProcessedCount = 0;
  let newEmailsCount = 0;
  let newCompaniesCount = 0;
  let skippedDuplicatesCount = 0;
  const errorsList: string[] = [];
  let currentIndex = startIndex;

  const liveTracker: LiveSyncTracker = {
    processedMessages: startIndex,
    newEmails: initialCounts?.newEmails ?? 0,
    newCompanies: initialCounts?.newCompanies ?? 0,
    skippedDuplicates: initialCounts?.skippedDuplicates ?? 0,
  };

  for (let i = startIndex; i < chronoSortedMsgIds.length; i += BATCH_SIZE) {
    const elapsed = Date.now() - startTime;
    const isDeadlineReached = globalDeadline ? Date.now() >= globalDeadline - 3500 : false;

    // Check if time budget or global deadline exceeded before processing next batch
    if ((elapsed >= timeBudgetMs || isDeadlineReached) && i > startIndex) {
      console.log(`[processPage] Time budget/deadline reached for page ${page.page_index} at offset ${i}/${chronoSortedMsgIds.length}. Pausing page.`);
      await updateCheckpoint(i, 'pending');

      return {
        completed: false,
        emailsProcessed: emailsProcessedCount,
        newEmails: newEmailsCount,
        newCompanies: newCompaniesCount,
        skippedDuplicates: skippedDuplicatesCount,
        errors: errorsList,
      };
    }

    const batch = chronoSortedMsgIds.slice(i, i + BATCH_SIZE);

    // Concurrently prefetch metadata and (if placement-relevant) full detail for the entire batch
    const prefetchResults = await Promise.allSettled(
      batch.map(async (msgId) => {
        if (existingInDb.has(msgId) && !existingEmailIds.get(msgId)) {
          return { msgId, isSkippedDup: true, parsedEmail: null };
        }

        const metadata = await withQuotaBackoff(() => fetchMessageMetadata(gmail, msgId));
        const subj = (metadata.subject || '').toLowerCase();
        const snippet = (metadata.snippet || '').toLowerCase();
        const senderLower = (metadata.senderEmail || '').toLowerCase();

        let shouldFetchFull = true;
        // STRICT SENDER ENFORCEMENT:
        if (!isTrustedPlacementSender(senderLower, isPersonal) || BLOCKED_SENDERS.test(senderLower)) {
          shouldFetchFull = false;
        }

        if (!shouldFetchFull) {
          return { msgId, isSkippedDup: false, parsedEmail: null };
        }

        const parsedEmail = await withQuotaBackoff(() => fetchMessageDetail(gmail, msgId));
        return { msgId, isSkippedDup: false, parsedEmail };
      })
    );

    // Process batch sequentially to ensure deterministic causal order and eliminate concurrency races
    for (let batchOffset = 0; batchOffset < batch.length; batchOffset++) {
      const msgId = batch[batchOffset];
      const settled = prefetchResults[batchOffset];

      if (settled.status === 'rejected') {
        const errMsg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        const isQuota = /quota exceeded|rate.?limit|units.?per.?minute/i.test(errMsg);
        if (!isQuota) {
          errorsList.push(errMsg);
        }
        break;
      }

      const item = settled.value;
      if (item.isSkippedDup) {
        skippedDuplicatesCount++;
        liveTracker.skippedDuplicates++;
        liveTracker.processedMessages++;
        currentIndex = i + batchOffset + 1;
        continue;
      }

      if (!item.parsedEmail) {
        liveTracker.processedMessages++;
        currentIndex = i + batchOffset + 1;
        continue;
      }

      try {
        const singleResult = await processSingleMessage(msgId, {
          supabase,
          userId,
          account,
          gmail,
          fetchMessageMetadata,
          isPersonal,
          isAccountInitialSync,
          existingInDb,
          existingEmailId: existingEmailIds.get(msgId),
          deps,
          pageIndex: page.page_index,
          totalPagesCount,
          totalMessages: chronoSortedMsgIds.length,
          onProgress,
          liveTracker,
          prefetchedEmail: item.parsedEmail,
        });

        emailsProcessedCount += singleResult.emailsProcessed;
        newEmailsCount += singleResult.newEmails;
        newCompaniesCount += singleResult.newCompanies;
        skippedDuplicatesCount += singleResult.skippedDuplicates;
        errorsList.push(...singleResult.errors);
        if (singleResult.retryable) {
          break;
        }
        currentIndex = i + batchOffset + 1;
      } catch (singleErr) {
        const errMsg = singleErr instanceof Error ? singleErr.message : String(singleErr);
        const isQuota = /quota exceeded|rate.?limit|units.?per.?minute/i.test(errMsg);
        if (!isQuota) {
          errorsList.push(errMsg);
        }
        break;
      }
    }

    // Emit live aggregated progress after each batch completes
    onProgress?.({
      phase: 'processing',
      accountEmail: account.email,
      accountType: account.account_type,
      totalMessages: chronoSortedMsgIds.length,
      processedMessages: liveTracker.processedMessages,
      currentPageIndex: page.page_index,
      totalPagesCount,
      newEmails: liveTracker.newEmails,
      newCompanies: liveTracker.newCompanies,
      skippedDuplicates: liveTracker.skippedDuplicates,
      errors: errorsList,
    });

    // Persist checkpoint after each batch to survive sudden shutdowns
    await updateCheckpoint(currentIndex);

    if (INTER_BATCH_DELAY_MS > 0 && i + BATCH_SIZE < chronoSortedMsgIds.length) {
      await new Promise((r) => setTimeout(r, INTER_BATCH_DELAY_MS));
    }
  }

  // Page exhausted! Mark complete
  await updateCheckpoint(chronoSortedMsgIds.length, 'complete');

  return {
    completed: true,
    emailsProcessed: emailsProcessedCount,
    newEmails: newEmailsCount,
    newCompanies: newCompaniesCount,
    skippedDuplicates: skippedDuplicatesCount,
    errors: errorsList,
  };
}

// In-memory active sync trackers (active within current Node.js server process)
const activeSyncMap = new Map<string, SyncProgress>();
const activeSyncLocks = new Set<string>();

export function getActiveSyncProgress(userId: string): SyncProgress | null {
  return activeSyncMap.get(userId) || null;
}

export function isUserSyncActive(userId: string): boolean {
  return activeSyncLocks.has(userId);
}

// ============================================
// Sync Engine
// ============================================

/**
 * Runs the full email sync for a user.
 * Fetches emails from all connected Gmail accounts,
 * classifies them, extracts companies, and stores in database.
 *
 * @param userId - The user's UUID
 * @param onProgress - Optional callback for streaming progress updates
 */
export async function runSync(
  userId: string,
  onProgress?: (progress: SyncProgress) => void,
  options?: {
    isBackgroundCron?: boolean;
    timeBudgetMs?: number;
    /** Shared wall-clock deadline (epoch ms) for the entire cron invocation. Stops dispatching new pages once reached. */
    globalDeadline?: number;
  }
): Promise<SyncResult> {
  const supabase = createAdminClient();

  // 1. Get all connected Gmail accounts for this user
  const { data: accounts, error: accountsError } = await supabase
    .from('gmail_accounts')
    .select('id, email, account_type, access_token_encrypted, refresh_token_encrypted, token_expiry, last_sync_at, last_history_id')
    .eq('user_id', userId)
    .eq('is_connected', true);

  if (accountsError) {
    throw new Error(`Failed to fetch Gmail accounts: ${accountsError.message}`);
  }

  const connectedAccounts = (accounts || []) as GmailAccount[];
  const hasPersonal = connectedAccounts.some((a) => a.account_type === 'personal');
  const hasCollege = connectedAccounts.some((a) => a.account_type === 'college');

  // Fetch user's configured Neo ID and email
  const { data: userData } = await supabase
    .from('users')
    .select('neo_id, email')
    .eq('id', userId)
    .single();
  const userNeoId = userData?.neo_id || null;
  const userEmail = userData?.email || '';

  // RULE: Guard sync until user completes all 3 onboarding setup items
  if (!hasPersonal || !hasCollege || !userNeoId) {
    const missing: string[] = [];
    if (!hasPersonal) missing.push('Personal Gmail (for NeoPAT drives)');
    if (!hasCollege) missing.push('College Gmail (for CTC/JDs)');
    if (!userNeoId) missing.push('NeoPAT Registration ID');

    throw new Error(
      `Complete setup to sync: Please add ${missing.join(', ')} in Settings.`
    );
  }

  const runId = randomUUID();
  const { data: rpcAcquired, error: leaseError } = await supabase.rpc('acquire_sync_lease', {
    p_user_id: userId,
    p_run_id: runId,
    p_lease_seconds: 120,
  });

  if (leaseError) {
    throw new Error(`Failed to acquire sync lease: ${leaseError.message}`);
  }

  if (rpcAcquired !== true) {
    return {
      totalEmailsFetched: 0,
      totalEmailsProcessed: 0,
      newEmails: 0,
      newCompanies: 0,
      skippedDuplicates: 0,
      errors: [],
      alreadyRunning: true,
      accounts: [],
    };
  }

  activeSyncLocks.add(userId);

  // Global wall-clock deadline for this entire invocation
  const defaultBudgetMs = options?.isBackgroundCron ? CRON_TOTAL_BUDGET_MS : 45_000;
  const totalBudgetMs = options?.timeBudgetMs ?? defaultBudgetMs;
  const globalDeadline = options?.globalDeadline ?? (Date.now() + totalBudgetMs);

  // Determine if this is an initial discovery sync across any connected account
  const isInitialSync = connectedAccounts.some((a) => !a.last_history_id);

  // Sort accounts so 'personal' is processed FIRST
  // This allows official NeoPAT emails to establish master company records first
  const sortedAccounts = connectedAccounts.sort((a, b) => {
    if (a.account_type === 'personal' && b.account_type !== 'personal') return -1;
    if (a.account_type !== 'personal' && b.account_type === 'personal') return 1;
    return 0;
  });

  const result: SyncResult = {
    totalEmailsFetched: 0,
    totalEmailsProcessed: 0,
    newEmails: 0,
    newCompanies: 0,
    skippedDuplicates: 0,
    errors: [],
    accounts: [],
  };

  let latestProgress: SyncProgress = {
    phase: 'initializing',
    accountEmail: '',
    accountType: '',
    totalMessages: 0,
    processedMessages: 0,
    newEmails: 0,
    newCompanies: 0,
    skippedDuplicates: 0,
    errors: [],
    isInitialSync,
  };
  activeSyncMap.set(userId, latestProgress);

  let lastDbWriteTime = 0;
  let dbWriteChain: Promise<void> = Promise.resolve();
  let leaseLost = false;
  const persistProgressToDb = (p: SyncProgress, force = false) => {
    activeSyncMap.set(userId, p);
    const now = Date.now();
    // Throttle progress persistence to Supabase to every 15s (reduced from 1.5s) to slash DB egress and CPU
    if (!force && now - lastDbWriteTime < 15000) return Promise.resolve();
    lastDbWriteTime = now;
    dbWriteChain = dbWriteChain.then(async () => {
      try {
        const { data, error } = await supabase.rpc('update_sync_lease', {
          p_user_id: userId,
          p_run_id: runId,
          p_lease_seconds: 120,
          p_progress: {
            phase: p.phase,
            accountEmail: p.accountEmail,
            accountType: p.accountType,
            totalMessages: p.totalMessages,
            processedMessages: p.processedMessages,
            newEmails: p.newEmails,
            newCompanies: p.newCompanies,
            skippedDuplicates: p.skippedDuplicates,
            currentSubject: p.currentSubject || null,
            isInitialSync,
            currentPageIndex: p.currentPageIndex ?? 0,
            totalPagesCount: p.totalPagesCount ?? 1,
            lastError: p.errors.length > 0 ? p.errors[p.errors.length - 1] : null,
          },
        });
        if (error || data !== true) {
          leaseLost = true;
          throw new Error(error?.message || 'Sync lease is no longer owned');
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('lease')) {
          leaseLost = true;
          console.error(`[Sync Engine] Sync lease lost for ${userId}:`, error.message);
        }
      }
    });
    return dbWriteChain;
  };

  const notifyProgress = (p: SyncProgress, forceDb = false) => {
    if (leaseLost) throw new Error('Sync lease lost; stopping this run');
    latestProgress = p;
    p.isInitialSync = isInitialSync;
    onProgress?.(p);
    persistProgressToDb(p, forceDb);
  };

  notifyProgress(latestProgress, true);
  const heartbeatTimer = setInterval(() => {
    persistProgressToDb(latestProgress, true).catch((error) => {
      console.error(`[Sync Engine] Lease heartbeat failed for ${userId}:`, error);
    });
  }, 30_000);

  try {
    // Lazy caches for drive resolutions and circular catalog
    // IMPORTANT: These are NOT fetched upfront to prevent burning Supabase egress when sync is idle.
    let persistedResolutions: Map<string, DriveResolutionResult> | null = null;
    let driveResolutionsMap: Map<string, string> | null = null;
    let circularCatalog: Map<string, CircularRoleEntry[]> | null = null;

    const getDriveResolutions = async () => {
      if (persistedResolutions && driveResolutionsMap) {
        return { persistedResolutions, driveResolutionsMap };
      }
      persistedResolutions = await loadAllDriveResolutions(supabase);
      driveResolutionsMap = new Map<string, string>();
      for (const [dNum, r] of persistedResolutions.entries()) {
        driveResolutionsMap.set(dNum, r.resolvedCompanyName);
      }
      return { persistedResolutions, driveResolutionsMap };
    };

    const getCircularCatalog = async () => {
      if (circularCatalog) return circularCatalog;
      // Pre-fetch ONLY the specific base companies needed by buildCircularCatalog
      // This prevents loading all 1,500+ circulars with 50KB bodies on every sync run
      const { data: storedCirculars } = await supabase
        .from('emails')
        .select('id, subject, sender, body_snippet, received_at')
        .eq('user_id', userId)
        .not('sender', 'ilike', '%noreply.cdcinfo@vitstudent.ac.in%')
        .or('subject.ilike.%apple%,subject.ilike.%honeywell%,subject.ilike.%zluri%,subject.ilike.%ey%');

      circularCatalog = buildCircularCatalog(storedCirculars || []);
      return circularCatalog;
    };

    // 2. Process each account using count-based, resumable pages
    for (const account of sortedAccounts) {
      if (leaseLost) throw new Error('Sync lease lost; stopping this run');
      if (Date.now() >= globalDeadline - 4000) {
        console.log(`[SyncEngine] Budget nearing expiry for user ${userId}. Pausing before account ${account.email}.`);
        break;
      }

      const accountResult = {
        email: account.email,
        accountType: account.account_type,
        emailsFetched: 0,
        emailsProcessed: 0,
        newEmails: 0,
        newCompanies: 0,
      };

      const progress: SyncProgress = {
        phase: 'initializing',
        accountEmail: account.email,
        accountType: account.account_type,
        totalMessages: 0,
        processedMessages: 0,
        newEmails: 0,
        newCompanies: 0,
        skippedDuplicates: 0,
        errors: [],
        isInitialSync,
      };

      notifyProgress(progress, true);

      try {
        const { gmail } = await createGmailClient(account);
        const { fetchHistoryChanges, getProfileHistoryId } = await import('@/lib/gmail/history');

        // Check for active or pending pages for this account
        const { data: existingPages } = await supabase
          .from('sync_pages')
          .select('id, user_id, gmail_account_id, page_index, message_ids, next_offset, status, created_at, updated_at')
          .eq('gmail_account_id', account.id)
          .order('page_index', { ascending: true });

        let pages: SyncPageRow[] = (existingPages || []) as SyncPageRow[];
        let pendingPages = pages.filter((p) => p.status !== 'complete');
        let nextHistoryId: string | null = null;

        // If no pending pages exist, check Gmail for new messages and plan pages
        if (pendingPages.length === 0) {
          progress.phase = 'fetching';
          notifyProgress(progress);

          let messageIds: string[] = [];

          const onFetchBatch = (fetchedCount: number) => {
            progress.totalMessages = fetchedCount;
            notifyProgress({
              ...progress,
              totalMessages: fetchedCount,
            });
          };

          if (account.account_type === 'personal') {
            // Personal account: master records for NeoPAT companies and registrations.
            // Use history API if available to achieve zero-egress idle syncs (<200ms).
            if (account.last_history_id) {
              const historyResult = await fetchHistoryChanges(gmail, account.last_history_id);
              if (!historyResult.historyExpired) {
                const deletedIds = new Set(historyResult.deletedMessageIds);
                messageIds = historyResult.messageIds.filter((id) => !deletedIds.has(id));
                nextHistoryId = historyResult.latestHistoryId;
              } else {
                const query = getPlacementSearchQuery('personal');
                messageIds = await fetchMessageIds(gmail, query, 2500, onFetchBatch);
                nextHistoryId = historyResult.latestHistoryId || (await getProfileHistoryId(gmail));
              }
            } else {
              const query = getPlacementSearchQuery('personal');
              messageIds = await fetchMessageIds(gmail, query, 2500, onFetchBatch);
              nextHistoryId = await getProfileHistoryId(gmail);
            }
          } else if (account.last_history_id) {
            const historyResult = await fetchHistoryChanges(gmail, account.last_history_id);
            if (!historyResult.historyExpired) {
              const deletedIds = new Set(historyResult.deletedMessageIds);
              messageIds = historyResult.messageIds.filter((id) => !deletedIds.has(id));
              nextHistoryId = historyResult.latestHistoryId;
            } else {
              const afterDate = account.last_sync_at ? new Date(account.last_sync_at) : undefined;
              const query = getPlacementSearchQuery('college', afterDate);
              const maxLimit = 2500;
              messageIds = await fetchMessageIds(gmail, query, maxLimit, onFetchBatch);
              nextHistoryId = historyResult.latestHistoryId || (await getProfileHistoryId(gmail));
            }
          } else {
            const query = getPlacementSearchQuery('college');
            const maxLimit = 5000;
            messageIds = await fetchMessageIds(gmail, query, maxLimit, onFetchBatch);
            nextHistoryId = await getProfileHistoryId(gmail);
          }

          accountResult.emailsFetched = messageIds.length;

          let newMsgIds: string[] = [];
          let skippedCount = 0;

          if (messageIds.length === 0) {
            // Zero-egress shortcut: no DB check needed when Gmail returned 0 candidate message IDs
            await supabase
              .from('gmail_accounts')
              .update({
                last_sync_at: new Date().toISOString(),
                last_history_id: nextHistoryId || account.last_history_id,
              })
              .eq('id', account.id);

            notifyProgress({
              ...progress,
              phase: 'complete',
              totalMessages: 0,
              processedMessages: 0,
            });
          } else {
            // Fast Pre-Check: Filter out emails already in DB
            let existingSet = new Set<string>();
            if (messageIds.length <= 500) {
              const { data: existingRows } = await supabase
                .from('emails')
                .select('gmail_message_id, is_processed')
                .eq('gmail_account_id', account.id)
                .in('gmail_message_id', messageIds);
              existingSet = new Set(
                (existingRows || [])
                  .filter((r) => r.is_processed)
                  .map((r) => r.gmail_message_id)
              );
            } else {
              const { data: existingRows } = await supabase
                .from('emails')
                .select('gmail_message_id, is_processed')
                .eq('gmail_account_id', account.id);
              existingSet = new Set(
                (existingRows || [])
                  .filter((r) => r.is_processed)
                  .map((r) => r.gmail_message_id)
              );
            }

            newMsgIds = messageIds.filter((id) => !existingSet.has(id));
            skippedCount = messageIds.length - newMsgIds.length;

            progress.skippedDuplicates += skippedCount;
            result.skippedDuplicates += skippedCount;

            if (newMsgIds.length > 0) {
              const isEphemeral = !isInitialSync && newMsgIds.length <= 15;
              if (isEphemeral) {
                pages = [
                  {
                    id: 'ephemeral-page',
                    user_id: userId,
                    gmail_account_id: account.id,
                    page_index: 0,
                    message_ids: newMsgIds,
                    next_offset: 0,
                    status: 'pending',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  },
                ];
                pendingPages = pages;
              } else {
                pages = await planSyncPages(supabase, userId, account, newMsgIds);
                pendingPages = pages.filter((p) => p.status !== 'complete');
              }
            } else {
              // No new emails to process
              await supabase
                .from('gmail_accounts')
                .update({
                  last_sync_at: new Date().toISOString(),
                  last_history_id: nextHistoryId || account.last_history_id,
                })
                .eq('id', account.id);

              notifyProgress({
                ...progress,
                phase: 'complete',
                totalMessages: 0,
                processedMessages: 0,
              });
            }
          }
        }

        // If there are pending pages, process them
        if (pendingPages.length > 0) {
          const totalPagesCount = pages.length;
          const perPageBudgetMs = options?.timeBudgetMs || 45_000;

          // Lazy-load drive resolutions and catalog only when a page is actively being processed
          const { persistedResolutions: pRes, driveResolutionsMap: dMap } = await getDriveResolutions();
          const cCatalog = await getCircularCatalog();

          if (options?.isBackgroundCron) {
            // ── BACKGROUND CRON PATH ──────────────────────────────────────────────────────
            // Loop over ALL pending pages until the global deadline is consumed.
            // Each processPage call gets up to 45s (or whatever remains until deadline).
            // If processPage returns completed: false, it paused mid-page (will resume
            // from next_offset on the following tick) — move on, don't block cron here.
            const globalDeadline = options?.globalDeadline ?? (Date.now() + CRON_TOTAL_BUDGET_MS);

            // Re-fetch pending pages in ascending order (oldest unprocessed first)
            let remainingPages = [...pendingPages].sort((a, b) => a.page_index - b.page_index);

            for (const targetPage of remainingPages) {
              if (leaseLost) throw new Error('Sync lease lost; stopping this run');
              if (Date.now() >= globalDeadline) {
                console.log(`[Cron Sync] Global deadline reached for account ${account.email}. Stopping page loop.`);
                break;
              }

              const targetIndex = targetPage.page_index;
              progress.phase = 'processing';
              progress.currentPageIndex = targetIndex;
              progress.totalPagesCount = totalPagesCount;
              progress.totalMessages = targetPage.message_ids.length;
              progress.processedMessages = targetPage.next_offset || 0;
              notifyProgress(progress, true);

              const budgetForThisPage = Math.min(perPageBudgetMs, globalDeadline - Date.now());
              if (budgetForThisPage <= 0) break;

              const pageRes = await processPage(
                supabase,
                userId,
                runId,
                account,
                targetPage,
                budgetForThisPage,
                {
                  userNeoId,
                  userEmail,
                  circularCatalog: cCatalog,
                  persistedResolutions: pRes,
                  driveResolutionsMap: dMap,
                  companyLocks: new Map<string, Promise<void>>(),
                },
                (pageProg) => {
                  pageProg.currentPageIndex = targetIndex;
                  pageProg.totalPagesCount = totalPagesCount;
                  notifyProgress(pageProg);
                },
                {
                  newEmails: result.newEmails,
                  newCompanies: result.newCompanies,
                  skippedDuplicates: result.skippedDuplicates,
                },
                globalDeadline,
                totalPagesCount
              );

              accountResult.emailsProcessed += pageRes.emailsProcessed;
              accountResult.newEmails += pageRes.newEmails;
              accountResult.newCompanies += pageRes.newCompanies;
              result.newEmails += pageRes.newEmails;
              result.newCompanies += pageRes.newCompanies;
              result.skippedDuplicates += pageRes.skippedDuplicates;
              result.errors.push(...pageRes.errors);
              result.currentPageIndex = targetIndex;
              result.totalPagesCount = totalPagesCount;

              if (!pageRes.completed) {
                // Page hit its own time budget mid-page; next_offset was persisted.
                // Move to the next account — this page will resume on the next cron tick.
                console.log(`[Cron Sync] Page ${targetIndex} paused mid-page for ${account.email}. Advancing to next account.`);
                break;
              }

              console.log(`[Cron Sync] Page ${targetIndex} complete for ${account.email} (${pageRes.emailsProcessed} msgs).`);
            }

            // Update history ID if all pages are now done
            const { data: refreshedPages } = await supabase
              .from('sync_pages')
              .select('status')
              .eq('gmail_account_id', account.id);

            const allDone = (refreshedPages && refreshedPages.length > 0 && refreshedPages.every((p) => p.status === 'complete')) || (pages.length === 1 && pages[0].id === 'ephemeral-page');
            if (allDone) {
              const nextHistId = nextHistoryId || (await getProfileHistoryId(gmail).catch(() => null));
              await supabase
                .from('gmail_accounts')
                .update({
                  last_sync_at: new Date().toISOString(),
                  last_history_id: nextHistId || account.last_history_id,
                })
                .eq('id', account.id);

              notifyProgress({
                ...progress,
                phase: 'complete',
                totalMessages: accountResult.emailsProcessed,
                processedMessages: accountResult.emailsProcessed,
              });
            }
            result.isPage0Complete = refreshedPages?.find((p: any) => p.page_index === 0)?.status === 'complete' || pages[0]?.id === 'ephemeral-page';
            result.hasMorePagesPending = !allDone;

          } else {
            // ── FOREGROUND / MANUAL SYNC PATH ────────────────────────────────────────────
            // Loop through all pending pages as long as time budget remains
            let remainingPages = [...pendingPages].sort((a, b) => a.page_index - b.page_index);

            for (const targetPage of remainingPages) {
              if (leaseLost) throw new Error('Sync lease lost; stopping this run');
              if (Date.now() >= globalDeadline - 4000) {
                console.log(`[Manual Sync] Time budget nearing limit for ${account.email}. Pausing page loop.`);
                break;
              }

              const targetIndex = targetPage.page_index;
              progress.phase = 'processing';
              progress.currentPageIndex = targetIndex;
              progress.totalPagesCount = totalPagesCount;
              progress.totalMessages = targetPage.message_ids.length;
              progress.processedMessages = targetPage.next_offset || 0;
              notifyProgress(progress, true);

              const budgetForThisPage = Math.max(2000, globalDeadline - Date.now() - 3000);
              if (budgetForThisPage <= 0) break;

              const pageRes = await processPage(
                supabase,
                userId,
                runId,
                account,
                targetPage,
                budgetForThisPage,
                {
                  userNeoId,
                  userEmail,
                  circularCatalog: cCatalog,
                  persistedResolutions: pRes,
                  driveResolutionsMap: dMap,
                  companyLocks: new Map<string, Promise<void>>(),
                },
                (pageProg) => {
                  pageProg.currentPageIndex = targetIndex;
                  pageProg.totalPagesCount = totalPagesCount;
                  notifyProgress(pageProg);
                },
                {
                  newEmails: result.newEmails,
                  newCompanies: result.newCompanies,
                  skippedDuplicates: result.skippedDuplicates,
                },
                globalDeadline,
                totalPagesCount
              );

              accountResult.emailsProcessed += pageRes.emailsProcessed;
              accountResult.newEmails += pageRes.newEmails;
              accountResult.newCompanies += pageRes.newCompanies;
              result.newEmails += pageRes.newEmails;
              result.newCompanies += pageRes.newCompanies;
              result.skippedDuplicates += pageRes.skippedDuplicates;
              result.errors.push(...pageRes.errors);
              result.currentPageIndex = targetIndex;
              result.totalPagesCount = totalPagesCount;

              if (!pageRes.completed) {
                // Mid-page budget consumed; next_offset persisted
                break;
              }
            }

            // Check if all pages for this account are now complete
            const { data: refreshedPages } = await supabase
              .from('sync_pages')
              .select('status')
              .eq('gmail_account_id', account.id);

            const allDone = (refreshedPages && refreshedPages.length > 0 && refreshedPages.every((p) => p.status === 'complete')) || (pages.length === 1 && pages[0].id === 'ephemeral-page');
            if (allDone) {
              const nextHistId = nextHistoryId || (await getProfileHistoryId(gmail).catch(() => null));
              await supabase
                .from('gmail_accounts')
                .update({
                  last_sync_at: new Date().toISOString(),
                  last_history_id: nextHistId || account.last_history_id,
                })
                .eq('id', account.id);

              notifyProgress({
                ...progress,
                phase: 'complete',
                totalMessages: accountResult.emailsProcessed,
                processedMessages: accountResult.emailsProcessed,
              });
            }

            result.isPage0Complete = refreshedPages?.find((p: any) => p.page_index === 0)?.status === 'complete' || pages[0]?.id === 'ephemeral-page';
          }
        }
      } catch (accountErr) {
        const errMsg =
          accountErr instanceof Error ? accountErr.message : String(accountErr);
        console.error(`Sync failed for account ${account.email}:`, errMsg);
        progress.phase = 'error';
        progress.errors.push(errMsg);
        result.errors.push(`Account ${account.email}: ${errMsg}`);
        notifyProgress(progress, true);
      }

      result.totalEmailsFetched += accountResult.emailsFetched;
      result.totalEmailsProcessed += accountResult.emailsProcessed;
      result.accounts.push(accountResult);

      if (Date.now() >= globalDeadline - 4000) {
        console.log(`[SyncEngine] Budget consumed for user ${userId}. Finishing current chunk.`);
        break;
      }
    }

    // Check whether any sync_pages across ANY accounts remain pending
    const { data: allPendingPages } = await supabase
      .from('sync_pages')
      .select('status')
      .eq('user_id', userId);

    const hasAnyPending = (allPendingPages || []).some((p) => p.status !== 'complete');
    const hadCompletedInitialPages = (allPendingPages || []).length > 0 && !hasAnyPending;
    result.hasMorePagesPending = hasAnyPending;

    // 5. Circular reconciliation: reconcile unlinked college circulars against user companies
    // IDLE & ARCHIVE GUARD: ONLY run heavy post-sync steps (reconciliation, dedup, status recalc, calendar)
    // when new emails were actually received or initial setup pages just completed.
    // This prevents idle cron runs from downloading thousands of email rows every 15 minutes and exhausting database egress!
    const hasNewData = (result.newEmails > 0 || result.newCompanies > 0 || hadCompletedInitialPages);
    if (!result.hasMorePagesPending && hasNewData) {
      try {
        const { data: unlinkedEmails } = await supabase
          .from('emails')
          .select('id, thread_id, subject, sender, received_at, body_snippet, placement_drive_id')
          .eq('user_id', userId)
          .is('placement_drive_id', null)
          .order('received_at', { ascending: false })
          .limit(30);

        if (unlinkedEmails && unlinkedEmails.length > 0) {
          const { data: allUserComps } = await supabase
            .from('companies')
            .select('id, name, aliases')
            .eq('user_id', userId);

          if (allUserComps && allUserComps.length > 0) {
            // A. Build Thread-to-Company map from confident, already-linked emails
            // Directionality guard: Only inherit if a thread has EXACTLY ONE unique company_id
            const { data: threadLinkedEmails } = await supabase
              .from('emails')
              .select('thread_id, placement_drive_id, placement_drives!inner(company_id)')
              .eq('user_id', userId)
              .not('thread_id', 'is', null)
              .not('placement_drive_id', 'is', null);

            const threadDriveMap = new Map<string, Set<string>>();
            for (const te of threadLinkedEmails || []) {
              const companyId = (te.placement_drives as { company_id?: string } | null)?.company_id;
              if (te.thread_id && companyId) {
                const set = threadDriveMap.get(te.thread_id) || new Set<string>();
                set.add(companyId);
                threadDriveMap.set(te.thread_id, set);
              }
            }

            // TEMPORAL FILTER: Build Drive Anchor Date map (company_id -> latest Anchor Date)
            // An Anchor Date is the latest received_at of a NeoPAT email or an email containing pat-PL-
            const { data: anchorEmails } = await supabase
              .from('emails')
              .select('received_at, placement_drive_id')
              .eq('user_id', userId)
              .not('placement_drive_id', 'is', null)
              .or('sender.ilike.%noreply.cdcinfo@vitstudent.ac.in%,body_snippet.ilike.%pat-PL-%');

            const driveAnchorDates = new Map<string, number>();
            for (const ae of anchorEmails || []) {
              if (!ae.placement_drive_id || !ae.received_at) continue;
              const time = new Date(ae.received_at).getTime();
              const current = driveAnchorDates.get(ae.placement_drive_id) || 0;
              if (time > current) {
                driveAnchorDates.set(ae.placement_drive_id, time);
              }
            }

            // B. Build NeoPAT registration timeline map for timing correlation (±24h window)
            const { data: neoPatEmails } = await supabase
              .from('emails')
              .select('received_at, placement_drive_id')
              .eq('user_id', userId)
              .not('placement_drive_id', 'is', null)
              .ilike('sender', '%noreply.cdcinfo@vitstudent.ac.in%');

            const neoPatTimelines = (neoPatEmails || []).map((ne) => {
              const comp = allUserComps.find((c) => c.id === ne.placement_drive_id);
              return {
                companyId: ne.placement_drive_id as string,
                companyName: comp ? comp.name : '',
                time: new Date(ne.received_at).getTime(),
              };
            }).filter((n) => n.companyName.length > 0);

            const WINDOW_MS = 24 * 60 * 60 * 1000; // ±24h window

            for (const email of unlinkedEmails) {
              let matchedCompanyId: string | null = null;

              // 1. Direct Company Name Extraction Match
              const compName = extractCompanyName(
                email.subject || '',
                email.sender || '',
                email.body_snippet || '',
                email.received_at ? new Date(email.received_at) : undefined
              );

              if (compName) {
                const norm = normalizeCompanyName(compName).toLowerCase();
                const unlinkedDrive = extractDriveNumber(`${email.subject}\n${email.body_snippet || ''}`);

                // Extract parenthetical variants: e.g. "Eternal (Zomato)" -> ["eternal (zomato)", "zomato", "eternal"]
                const parenMatches = Array.from(compName.matchAll(/\(([^)]+)\)/g)).map((m) => m[1].trim().toLowerCase());
                const outsideParen = compName.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
                const searchCandidates = Array.from(new Set([
                  norm,
                  ...parenMatches.filter((p) => p.length >= 2),
                  ...(outsideParen && outsideParen.length >= 2 ? [outsideParen] : []),
                ]));

                const matchedList = allUserComps.filter((c) => {
                  const cLower = c.name.toLowerCase();
                  const cAliases = (c.aliases || []).map((a: string) => a.toLowerCase());
                  return searchCandidates.some((cand) => {
                    return (
                      cLower === cand ||
                      cAliases.includes(cand) ||
                      isFuzzyCompanyMatch(c.name, cand) ||
                      (c.aliases || []).some((a: string) => isFuzzyCompanyMatch(a, cand))
                    );
                  });
                });

                let matched = null;
                if (matchedList.length === 1) {
                  matched = matchedList[0];
                } else if (matchedList.length > 1) {
                  // Ambiguous! Disambiguate using drive number if present
                  if (unlinkedDrive) {
                    for (const cand of matchedList) {
                        const { data: candEmails } = await supabase
                          .from('emails')
                          .select('body_snippet, placement_drives!inner(company_id)')
                          .eq('placement_drives.company_id', cand.id)
                        .not('body_snippet', 'is', null)
                        .ilike('body_snippet', '%pat-PL-%')
                        .limit(5);
                      const drives = (candEmails || []).flatMap((e: { body_snippet: string | null }) => extractAllDriveNumbers(e.body_snippet || ''));
                      if (drives.includes(unlinkedDrive)) {
                        matched = cand;
                        break;
                      }
                    }
                  }
                }

                if (matched) {
                  // If unlinked email carries a drive number, ensure candidate company is not bound to a different drive
                  let driveConflict = false;
                  if (unlinkedDrive) {
                    // Check existing emails for candidate company
                    const { data: cEmails } = await supabase
                      .from('emails')
                      .select('body_snippet, placement_drives!inner(company_id)')
                      .eq('placement_drives.company_id', matched.id)
                      .not('body_snippet', 'is', null)
                      .ilike('body_snippet', '%pat-PL-%')
                      .limit(5);

                    const establishedDrives = (cEmails || []).flatMap((e: { body_snippet: string | null }) =>
                      extractAllDriveNumbers(e.body_snippet || '')
                    );

                    if (establishedDrives.length > 0 && !establishedDrives.includes(unlinkedDrive)) {
                      driveConflict = true;
                    }
                  }

                  if (!driveConflict) {
                    // TEMPORAL FILTER: Only accept if >= Anchor Date - 14 days
                    const anchorTime = driveAnchorDates.get(matched.id);
                    const emailTime = email.received_at ? new Date(email.received_at).getTime() : 0;
                    if (!anchorTime || emailTime >= anchorTime - 14 * 24 * 60 * 60 * 1000) {
                      matchedCompanyId = matched.id;
                    }
                  }
                }
              }

              // 2. Thread Inheritance (Directionality: only if thread has EXACTLY 1 unique company)
              if (!matchedCompanyId && email.thread_id) {
                const candidateSet = threadDriveMap.get(email.thread_id);
                if (candidateSet && candidateSet.size === 1) {
                  const candId = Array.from(candidateSet)[0];
                  const anchorTime = driveAnchorDates.get(candId);
                  const emailTime = email.received_at ? new Date(email.received_at).getTime() : 0;
                  if (!anchorTime || emailTime >= anchorTime - 14 * 24 * 60 * 60 * 1000) {
                    matchedCompanyId = candId;
                  }
                }
              }

              // 3. Same-Day Timing Correlation (Unambiguous only: strictly 1 candidate)
              // Directionality guard: NEVER hijack emails that already have an extracted company name (e.g. Divum, Danfoss)
              // and ONLY match against email subject, NEVER against body_snippet (which contains random branch names & course terms).
              if (!matchedCompanyId && !compName && email.received_at) {
                const emailTime = new Date(email.received_at).getTime();
                const candidates = neoPatTimelines.filter((n) => {
                  if (Math.abs(n.time - emailTime) > WINDOW_MS) return false;
                  return isFuzzyCompanyMatch(n.companyName, email.subject || '');
                });

                const uniqueCandidates = Array.from(new Set(candidates.map((c) => c.companyId)));
                if (uniqueCandidates.length === 1) {
                  const candidateCompanyId = uniqueCandidates[0];

                  // Fix B: If the candidate company already has an established drive number,
                  // require the unlinked email to share that drive number OR pass a strict
                  // normalized-key name match. Prevents stale timing-only re-associations
                  // after a company's identity is already well-anchored.
                    const { data: existingCompEmails } = await supabase
                      .from('emails')
                      .select('body_snippet, placement_drives!inner(company_id)')
                      .eq('placement_drives.company_id', candidateCompanyId)
                    .not('body_snippet', 'is', null)
                    .limit(5);

                  const existingDriveNums = (existingCompEmails || [])
                    .flatMap((e: { body_snippet: string | null }) => extractAllDriveNumbers(e.body_snippet || ''));

                  let timingMatchOk = true;
                  if (existingDriveNums.length > 0) {
                    const emailDriveNums = extractAllDriveNumbers(email.subject || '');
                    if (emailDriveNums.length > 0) {
                      const hasMatchingDrive = emailDriveNums.some((d) => existingDriveNums.includes(d));
                      if (!hasMatchingDrive) {
                        timingMatchOk = false;
                        console.log(`[Timing Correlation] Skipped attach for email "${email.subject}" → company ${candidateCompanyId}: established drive nums [${existingDriveNums.join(',')}] not found in email.`);
                      }
                    }
                  }

                  if (timingMatchOk) {
                    const anchorTime = driveAnchorDates.get(candidateCompanyId);
                    const emailTime = email.received_at ? new Date(email.received_at).getTime() : 0;
                    if (!anchorTime || emailTime >= anchorTime - 14 * 24 * 60 * 60 * 1000) {
                      matchedCompanyId = candidateCompanyId;
                    }
                  }
                }
                // If > 1 candidates, ambiguous: do not guess!
              }

              if (matchedCompanyId) {
                const { data: matchedDrive } = await supabase
                  .from('placement_drives')
                  .select('id')
                  .eq('user_id', userId)
                  .eq('company_id', matchedCompanyId)
                  .order('created_at', { ascending: false })
                  .limit(1)
                  .maybeSingle();
                if (!matchedDrive) continue;

                await supabase
                  .from('emails')
                  .update({
                    placement_drive_id: matchedDrive.id,
                    assignment_state: 'assigned',
                    assignment_confidence: 'medium',
                    assignment_source: 'reconciliation',
                    is_relevant: true,
                  })
                  .eq('id', email.id)
                  .eq('user_id', userId)
                  .is('placement_drive_id', null);

                // Register newly linked email to thread map for downstream emails in same pass
                if (email.thread_id) {
                  const set = threadDriveMap.get(email.thread_id) || new Set<string>();
                  set.add(matchedCompanyId);
                  threadDriveMap.set(email.thread_id, set);
                }

                // Lazy-fetch body_snippet ONLY for this matched email to extract events/CTC
                const { data: fullEmail } = await supabase
                  .from('emails')
                  .select('body_snippet')
                  .eq('id', email.id)
                  .single();
                const emailBodySnippet = fullEmail?.body_snippet || '';

                // Process reconciled circular for Events, CTC, and Roles
                try {
                  const { processEmailForEventsAndStatus } = await import(
                    '@/lib/sync/status-engine'
                  );
                  // Check if this email already has a placement_drive_id from live sync
                  const { data: emailWithDrive } = await supabase
                    .from('emails')
                    .select('placement_drive_id')
                    .eq('id', email.id)
                    .single();
                  const emailPlacementDriveId = emailWithDrive?.placement_drive_id || null;
                  
                  await processEmailForEventsAndStatus(
                    supabase,
                    userId,
                    matchedCompanyId,
                    {
                      gmailMessageId: email.id,
                      threadId: email.thread_id,
                      sender: email.sender || '',
                      senderEmail: email.sender?.match(/<([^>]+)>/)?.[1] || email.sender || '',
                      subject: email.subject || '',
                      receivedAt: email.received_at ? new Date(email.received_at) : new Date(),
                      bodySnippet: emailBodySnippet,
                      bodyPlain: emailBodySnippet,
                      bodyHtml: '',
                      hasAttachments: false,
                      attachments: [],
                      labels: [],
                    },
                    email.id,
                    userNeoId,
                    userEmail,
                    emailPlacementDriveId
                  );
                } catch (err) {
                  console.warn('Failed to process reconciled circular for events:', err);
                }
              }
            }
          }
        }
      } catch (reconcileErr) {
        console.warn('Post-sync circular reconciliation non-critical error:', reconcileErr);
      }

      // 5.4 Holistic Status Recalculation:
      // ONLY run full holistic status recalculation and heavy attachment scanning when initial setup pages just completed!
      // For regular incremental syncs (1-3 emails), statuses and events are already updated incrementally
      // by processEmailForEventsAndStatus during page processing. Running full recalculation over all 1,500+ emails
      // on incremental syncs is what caused 1m 44s runtimes, lease loss, and hundreds of MBs in egress.
      if (hadCompletedInitialPages) {
        const remainingBudgetMs = options?.globalDeadline ? options.globalDeadline - Date.now() : Infinity;
        if (remainingBudgetMs > 30_000) {
          try {
            const { scanAndPersistCandidateMatches } = await import('@/lib/sync/attachment-scanner');
            await scanAndPersistCandidateMatches(supabase, userId);
          } catch (scanErr) {
            console.warn('[Post-Sync Attachment Scan] Non-critical error:', scanErr);
          }

          try {
            const { recalculateApplicationStatuses } = await import('@/app/api/sync/reprocess/route');
            await recalculateApplicationStatuses(userId);
          } catch (statusRecalcErr) {
            console.warn('[Post-Sync Status Recalc] Non-critical error:', statusRecalcErr);
          }
        } else {
          console.log('[Post-Sync] Skipping heavy post-sync recalculation to respect time budget');
        }
      }

      // 6. Automatic Google Calendar reconciliation:
      // Run in background fire-and-forget so it NEVER blocks returning the sync response
      import('@/lib/calendar/google-sync')
        .then(({ reconcileUserGoogleCalendar }) => reconcileUserGoogleCalendar(userId))
        .then((calResult) => console.log(`[Google Calendar Auto-Sync] User ${userId}: ${calResult.message}`))
        .catch((calErr) => console.warn('[Google Calendar Auto-Sync] Non-critical reconciliation error:', calErr));

      // Clean up completed initial sync pages so future idle cron runs don't re-trigger
      if (hadCompletedInitialPages) {
        await supabase.from('sync_pages').delete().eq('user_id', userId);
      }
    } else {
      console.log(
        `[SyncEngine] User ${userId} sync run idle: 0 new emails/companies. Skipped circular reconciliation, dedup, status recalculation, and calendar sync (0 egress).`
      );
    }

    // Reconcile elapsed event statuses in the background
    import('@/lib/sync/event-reconciliation')
      .then(({ reconcileElapsedEventStatuses }) => reconcileElapsedEventStatuses(supabase, userId))
      .then((reconResult) => {
        if (reconResult.updatedCount > 0) {
          console.log(`[SyncEngine] Reconciled ${reconResult.updatedCount} elapsed round(s) for user ${userId}`);
        }
      })
      .catch((reconErr) => console.warn('[SyncEngine] Elapsed events reconciliation non-critical error:', reconErr));

    return result;
  } finally {
    clearInterval(heartbeatTimer);
    activeSyncLocks.delete(userId);
    activeSyncMap.delete(userId);
    try {
      await dbWriteChain.catch(() => {});
    } catch {}
    try {
      const isError = result.errors.length > 0 && result.totalEmailsProcessed === 0;
      const isComplete = !result.hasMorePagesPending;
      try {
        await supabase.rpc('release_sync_lease', {
          p_user_id: userId,
          p_run_id: runId,
          p_phase: isError ? 'error' : (isComplete ? 'complete' : 'pending'),
          p_last_error: result.errors.length > 0 ? result.errors[result.errors.length - 1] : null,
        });
      } catch {}

      // Direct fallback update to guarantee sync_state is ALWAYS marked as finished
      await supabase
        .from('sync_state')
        .update({
          is_syncing: false,
          phase: isError ? 'error' : (isComplete ? 'complete' : 'pending'),
          completed_at: new Date().toISOString(),
          lease_expires_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);
    } catch (cleanupErr) {
      console.error(`[Sync Engine] Error releasing sync lease for ${userId}:`, cleanupErr);
    }
  }
}

// ============================================
// Company Matching Helpers
// ============================================

const GENERIC_MATCH_TOKENS = new Set([
  'pvt', 'ltd', 'limited', 'private', 'inc', 'corp', 'corporation',
  'co', 'company', 'llc', 'llp',
  'super', 'dream', 'regular', 'core', 'internship', 'placement', 'drive',
  'finance', 'financial', 'services', 'service',
  'technologies', 'technology', 'tech', 'solutions', 'solution',
  'consulting', 'consultancy', 'holdings', 'holding',
  'group', 'enterprises', 'enterprise', 'international', 'global',
  'management', 'advisory', 'capital', 'systems', 'system',
  'labs', 'lab', 'analytics', 'industries', 'industry',
  'batch', '2026', '2027', '2028', 'urgent', 'extended', 'deadline',
  'update', 'updated', 'campus', 'hiring', 'recruitment', 'talk', 'test',
  'intelligence', 'intelligent', 'artificial', 'hardware',
  'software', 'india', 'data', 'digital', 'media', 'network', 'networks',
  'security', 'centre', 'center', 'hub', 'engineering', 'products',
  'development', 'research', 'interactive', 'communications', 'communication',
  'design', 'health', 'healthcare', 'energy', 'mobility', 'smart', 'power',
  'cloud', 'retail', 'games', 'game', 'life', 'science', 'sciences', 'part',
  'bank', 'banking', 'small', 'additional', 'selects', 'shortlist',
  'shortlisted', 'candidates', 'students', 'applied', 'round', 'process',
  'portal', 'interview', 'assessment', 'announcement', 'office', 'location',
  'virtual', 'online', 'offline', 'physical', 'associate', 'engineer',
  'intern', 'trainee', 'analyst', 'developer',
  ...ENGLISH_STOPWORDS,
]);

/**
 * Robust fuzzy matcher for company names based on distinctive token overlap.
 * Prevents false matches (e.g. "Kinaxis Super Dream" matching "Superjoin Finance").
 */
export function isFuzzyCompanyMatch(compName: string, targetName: string): boolean {
  let cLower = compName.toLowerCase().trim();
  let tLower = targetName.toLowerCase().trim();

  // Guard: Never merge "EY <Track>" with a non-EY company (e.g. "EY SAP" with "SAP")
  const cHasEy = /\b(?:ey|ernst\s*&\s*young)\b/.test(cLower);
  const tHasEy = /\b(?:ey|ernst\s*&\s*young)\b/.test(tLower);
  if (cHasEy !== tHasEy) {
    return false;
  }

  // Track Token Guard: If either company has a specific technical track token (SAP, GDS, SDET, SRE, Aerospace),
  // they MUST both have the SAME track token to match. A specialized track never merges with another track or bare brand.
  const TRACK_TOKENS = ['sdet', 'sre', 'sap', 'gds', 'aerospace'];
  for (const track of TRACK_TOKENS) {
    const cHasTrack = new RegExp(`\\b${track}\\b`, 'i').test(cLower);
    const tHasTrack = new RegExp(`\\b${track}\\b`, 'i').test(tLower);
    if (cHasTrack !== tHasTrack) {
      return false;
    }
  }

  // Normalize known typos
  cLower = cLower.replace(/\bunthikable\b/g, 'unthinkable');
  tLower = tLower.replace(/\bunthikable\b/g, 'unthinkable');

  if (cLower === tLower) return true;

  // --- Step 0.5: Collapsed alphanumeric match ---
  // Matches "Valuelabs" ↔ "Value Labs", "SquadStack" ↔ "Squad Stack", "BlackRock" ↔ "Black Rock"
  const cAlpha = cLower.replace(/[^a-z0-9]/g, '');
  const tAlpha = tLower.replace(/[^a-z0-9]/g, '');
  if (cAlpha.length >= 3 && tAlpha.length >= 3 && cAlpha === tAlpha) {
    return true;
  }

  // --- Step 1: Normalized-key match ---
  // Strips legal words, removes spaces/punctuation, then compares.
  // This catches: "goldmansachs" == "goldman sachs", "ExxonMobil" == "Exxon Mobil",
  //               "HCL Tech" == "HCL Technologies", "Infosys BPM" == "Infosys"
  const cKey = computeNormalizedKey(compName);
  const tKey = computeNormalizedKey(targetName);
  if (cKey.length >= 3 && tKey.length >= 3 && cKey === tKey) {
    return true;
  }

  // --- Step 1.5: Acronym / Initialism match ---
  // Matches "WTW" ↔ "Willis Towers Watson", "TCS" ↔ "Tata Consultancy Services",
  // parenthetical aliases "(WTW India)", known initialisms, etc.
  if (checkAcronymMatch(cLower, tLower) || checkAcronymMatch(tLower, cLower)) {
    return true;
  }

  // --- Step 2: Distinctive token overlap (handles abbreviations / partial names) ---
  const KNOWN_SHORT_BRANDS = new Set(['ey', 'hp', 'ge', 'bp', 'gs', 'ti', 'de']);
  const cTokens = cLower
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => (w.length >= 3 || KNOWN_SHORT_BRANDS.has(w)) && !GENERIC_MATCH_TOKENS.has(w));

  const tTokens = tLower
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => (w.length >= 3 || KNOWN_SHORT_BRANDS.has(w)) && !GENERIC_MATCH_TOKENS.has(w));

  if (cTokens.length === 0 || tTokens.length === 0) {
    return false;
  }

  const STEM_SYNONYMS: Record<string, string> = {
    tech: 'technologies',
    technology: 'technologies',
    technologies: 'technologies',
    info: 'information',
    information: 'information',
    infosystems: 'information',
    sys: 'systems',
    systems: 'systems',
    sol: 'solutions',
    soln: 'solutions',
    solutions: 'solutions',
  };

  const tokenMatches = (a: string, b: string) => {
    if (a === b) return true;
    if (STEM_SYNONYMS[a] && STEM_SYNONYMS[a] === STEM_SYNONYMS[b]) return true;
    // Allow minor stem variations (e.g. plural s, es) but strictly limit length difference to <= 2
    if (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a))) {
      return Math.abs(a.length - b.length) <= 2;
    }
    return false;
  };

  // If both have 1 token: they must match
  if (cTokens.length === 1 && tTokens.length === 1) {
    return tokenMatches(cTokens[0], tTokens[0]);
  }

  // If one has 1 token and the other has >= 2 tokens:
  // The single token must match the FIRST (primary brand) token of the multi-token company
  if (cTokens.length === 1 && tTokens.length >= 2) {
    return tokenMatches(cTokens[0], tTokens[0]);
  }
  if (tTokens.length === 1 && cTokens.length >= 2) {
    return tokenMatches(tTokens[0], cTokens[0]);
  }

  // Both have >= 2 tokens:
  // Require that the primary first token matches AND all tokens of target exist in comp or vice versa
  const firstTokenMatches = tokenMatches(cTokens[0], tTokens[0]);
  if (!firstTokenMatches) return false;

  const allTargetInComp = tTokens.every((t) => cTokens.some((c) => tokenMatches(c, t)));
  const allCompInTarget = cTokens.every((c) => tTokens.some((t) => tokenMatches(c, t)));

  return allTargetInComp || allCompInTarget;
}

// ============================================
// Company Upsert
// ============================================

/**
 * Creates or retrieves a company by name for a given user.
 * Handles normalization, alias checking, and drive number isolation.
 */
// Sequential mutex for upsertCompany per user to prevent concurrent race duplicates
const userUpsertLocks = new Map<string, Promise<void>>();

async function upsertCompany(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  companyName: string,
  allowCreate: boolean = true
): Promise<string | null> {
  const currentLock = userUpsertLocks.get(userId) || Promise.resolve();
  let release: () => void;
  const nextLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  userUpsertLocks.set(userId, currentLock.then(() => nextLock));

  await currentLock;
  try {
    return await doUpsertCompany(supabase, userId, companyName, allowCreate);
  } finally {
    release!();
  }
}

/**
 * Creates or retrieves a company by name for a given user.
 * Handles normalization, alias checking, and drive number isolation.
 */
async function doUpsertCompany(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  companyName: string,
  allowCreate: boolean = true
): Promise<string | null> {
  const normalized = normalizeCompanyName(companyName);

  if (!normalized || normalized.length < 2) return null;

  // Organization metadata only. Drive identity belongs to placement_drives.
  const learnAliasesAndDrive = async (compRecord: {
    id: string;
    aliases?: string[] | null;
  }) => {
    const newAliases = extractCompanyAliases(companyName, normalized);
    const currentAliases = (compRecord.aliases || []).map((a) => a.toLowerCase());
    const missing = newAliases.filter((a) => !currentAliases.includes(a.toLowerCase()));
    const updates: Record<string, any> = {};
    if (missing.length > 0) {
      updates.aliases = Array.from(new Set([...currentAliases, ...newAliases]));
    }
    if (Object.keys(updates).length > 0) {
      await supabase.from('companies').update(updates).eq('id', compRecord.id);
    }
  };

  // Extract parenthetical variants: e.g. "Eternal (Zomato)" -> ["Eternal (Zomato)", "Zomato", "Eternal"]
  const parenMatches = Array.from(companyName.matchAll(/\(([^)]+)\)/g))
    .map((m) => normalizeCompanyName(m[1].trim()))
    .filter((p) => p.length >= 2);
  const outsideParen = normalizeCompanyName(companyName.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim());
  const candidateNames = Array.from(new Set([
    normalized,
    ...parenMatches,
    ...(outsideParen && outsideParen.length >= 2 ? [outsideParen] : []),
  ]));

  // 1. Check exact name match for this user across candidate names
  for (const cand of candidateNames) {
    const { data: existing } = await supabase
      .from('companies')
      .select('id, aliases')
      .eq('user_id', userId)
      .eq('name', cand)
      .maybeSingle();

    if (existing) {
      await learnAliasesAndDrive(existing);
      return existing.id;
    }
  }

  // 2. Check aliases match across candidate names
  for (const cand of candidateNames) {
    const { data: aliasMatch } = await supabase
      .from('companies')
      .select('id, aliases')
      .eq('user_id', userId)
      .contains('aliases', [cand.toLowerCase()])
      .maybeSingle();

    if (aliasMatch) {
      return aliasMatch.id;
    }
  }

  // 3. Dynamic matching against existing user companies
  const { data: userCompanies } = await supabase
    .from('companies')
    .select('id, name, aliases')
    .eq('user_id', userId);

  if (userCompanies && userCompanies.length > 0) {
    for (const comp of userCompanies) {
      const isMatched = candidateNames.some((cand) => {
        const aliasMatch = (comp.aliases || []).some((a: string) => isFuzzyCompanyMatch(a, cand));
        return isFuzzyCompanyMatch(comp.name, cand) || aliasMatch;
      });
      if (isMatched) {
        return comp.id;
      }
    }
  }

  // 4. If no match found and allowCreate is false (e.g. College email), DO NOT create!
  if (!allowCreate) {
    return null;
  }

  // 5. If no match found and allowCreate is true (Personal email), create new company
  const generatedAliases = extractCompanyAliases(companyName, normalized);

  const { data: newCompany, error } = await supabase
    .from('companies')
    .insert({
      user_id: userId,
      name: normalized,
      aliases: generatedAliases,
    })
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') {
      // Unique constraint violation on the organization name.
      // NEVER create a suffixed name — that just creates duplicates.
      // Fallback: name-based lookup (race condition on name unique constraint)
      const { data: refetch } = await supabase
        .from('companies')
        .select('id')
        .eq('user_id', userId)
        .eq('name', normalized)
        .maybeSingle();
      return refetch?.id || null;
    }
    console.error('Failed to create company:', error);
    return null;
  }

  return newCompany?.id || null;
}

// ============================================
// Helpers
// ============================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
