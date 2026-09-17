import {
  createGmailClient,
  fetchMessageIds,
  fetchMessageDetail,
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
import { extractDriveNumber, extractAllDriveNumbers } from '@/lib/sync/events';
import {
  buildCircularCatalog,
  loadAllDriveResolutions,
  resolveDriveByTimingCorrelation,
  type CircularRoleEntry,
  type DriveResolutionResult,
} from '@/lib/sync/drive-correlator';
import { createAdminClient } from '@/lib/supabase/admin';

// ============================================
// Sync Progress Types & Constants
// ============================================

export const PAGE_SIZE = 150;

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

// Known NeoPAT/CDC senders that always pass (no keyword check needed)
export const TRUSTED_PLACEMENT_SENDERS = [
  'noreply.cdcinfo@vitstudent.ac.in',
  'vitlions2027@vitbhopal.ac.in',
];

// Known non-placement senders to always skip (Google, Microsoft notifications, social media, etc.)
export const BLOCKED_SENDERS = /noreply-accounts@google|no-reply@accounts\.google|noreply@github|notifications@github|@linkedin\.com|@facebookmail|@discord|@slack|noreply@medium|noreply@.*\.zoom\.us|security-noreply|account-security|password.*reset|verify.*email|do-not-reply@|mailer-daemon/i;

/**
 * Returns true if the sender should bypass the `isPlacementRelevant` keyword filter.
 *
 * Personal accounts: only exact known CDC/NeoPAT addresses bypass the keyword gate.
 * Domain-wide @vitstudent.ac.in trust is intentionally removed — if the domain hosts
 * IT helpdesk, library notices, or other non-placement traffic, those would otherwise
 * get silently classified as placement-relevant. Unknown senders on the domain still
 * fall through to the isPlacementRelevant keyword check in the caller.
 *
 * College accounts: use the same explicit allowlist (no change).
 */
export const isTrustedSender = (senderEmail: string, isPersonal: boolean) =>
  TRUSTED_PLACEMENT_SENDERS.includes(senderEmail.toLowerCase());

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
    .select('*')
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
    .select('*')
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
  }
): Promise<SingleMessageResult> {
  const result: SingleMessageResult = {
    emailsProcessed: 0,
    newEmails: 0,
    newCompanies: 0,
    skippedDuplicates: 0,
    errors: [],
  };

  const { supabase, userId, account, gmail, fetchMessageMetadata, isPersonal, existingInDb, deps } = ctx;

  if (existingInDb.has(msgId)) {
    result.skippedDuplicates++;
    ctx.liveTracker.skippedDuplicates++;
    ctx.liveTracker.processedMessages++;
    return result;
  }

  try {
    const t0 = Date.now();

    // Stage 1: Cheap metadata inspection
    let shouldFetchFull = true;
    const metadata = await withQuotaBackoff(() => fetchMessageMetadata(gmail, msgId));
    const t1 = Date.now();
    const subj = metadata.subject.toLowerCase();
    const senderLower = metadata.senderEmail.toLowerCase();

    // A. Always block known non-placement senders
    if (BLOCKED_SENDERS.test(senderLower)) {
      shouldFetchFull = false;
    }
    // B. Always allow trusted CDC/NeoPAT senders
    else if (isTrustedSender(senderLower, isPersonal)) {
      shouldFetchFull = true;
    }
    // C. For all other senders, require placement keywords in subject
    else {
      const isPlacementRelevant =
        /shortlist|selection|online\s+test|coding\s+test|assessment|interview|ppt|pre-placement|super\s+dream|dream\s+core|registration|internship|placement\s+drive|campus\s+drive|hiring|cdc\s+info|candidate\s+information|offer|joining|onboarding/i.test(
          subj
        );
      if (!isPlacementRelevant) {
        shouldFetchFull = false;
      }
    }

    if (!shouldFetchFull) {
      ctx.liveTracker.processedMessages++;
      return result;
    }

    // Stage 2: Full message detail & attachments
    const parsedEmail = await withQuotaBackoff(() => fetchMessageDetail(gmail, msgId));
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
    const driveNumber = extractDriveNumber(fullEmailText);
    const driveNameMatch = fullEmailText.match(/Drive Name:\s*([^.\n\r]+)/i);
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

      companyId = await upsertCompany(supabase, userId, companyName, isNeoPatEmail, driveNumber, driveName);

      if (companyId) {
        const { count } = await supabase
          .from('emails')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', companyId);

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
          .eq('company_id', companyId)
          .single();

        if (!currentApp) {
          // Use upsert with ignoreDuplicates so concurrent processSingleMessage calls
          // for the same company (e.g. two emails in the same batch) don't race-crash.
          // The first call wins; subsequent calls on the same (user_id, company_id) are no-ops.
          await supabase.from('applications').upsert({
            user_id: userId,
            company_id: companyId,
            status: 'not_applied',
            status_source: isPersonal ? 'neopat_personal_email' : 'college_email_announcement',
            status_confidence: 'high',
            status_source_email_at: parsedEmail.receivedAt.toISOString(),
            last_updated: new Date().toISOString(),
          }, { onConflict: 'user_id,company_id', ignoreDuplicates: true });
        }
      }
    }
    const t4 = Date.now();

    // Insert email into DB
    const { data: insertedEmail, error: insertError } = await supabase
      .from('emails')
      .insert({
        user_id: userId,
        gmail_account_id: account.id,
        company_id: companyId,
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
        is_processed: true,
        is_relevant: classification.classification !== 'irrelevant',
        processed_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (insertError) {
      if (insertError.code === '23505') {
        result.skippedDuplicates++;
        ctx.liveTracker.skippedDuplicates++;
      } else {
        result.errors.push(insertError.message);
      }
    } else {
      result.newEmails++;
      ctx.liveTracker.newEmails++;

      // Stage 5: Status engine (with hard 8s timeout — prevents AI retry loops from stalling a page)
      if (companyId && insertedEmail) {
        const { processEmailForEventsAndStatus } = await import(
          '@/lib/sync/status-engine'
        );
        const runStatusEngine = async () => {
          await Promise.race([
            processEmailForEventsAndStatus(
              supabase,
              userId,
              companyId as string,
              parsedEmail,
              insertedEmail.id,
              deps.userNeoId,
              account.email,
              gmail
            ),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('ai_timeout')), 8000)
            ),
          ]);
        };

        const existingLock = deps.companyLocks.get(companyId) || Promise.resolve();
        const newLock = existingLock.then(runStatusEngine).catch(statusErr => {
          const errMsg = statusErr instanceof Error ? statusErr.message : String(statusErr);
          if (errMsg === 'ai_timeout') {
            console.warn(`[processSingleMessage] Status engine timed out for msg ${msgId} ("${parsedEmail.subject.slice(0, 60)}") — skipped to protect sync budget.`);
          } else {
            console.error(`[processSingleMessage] Status engine error for msg ${msgId}:`, statusErr);
          }
        });
        deps.companyLocks.set(companyId, newLock);
        await newLock;
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
  }

  return result;
}

/**
 * Processes a single sync page.
 * Reverses ONLY this page's message_ids (giving oldest-to-newest chronological order within this page),
 * processes each batch of messages concurrently via Promise.allSettled, and respects timeBudgetMs.
 */
export async function processPage(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
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
  // Mark page in_progress
  await supabase
    .from('sync_pages')
    .update({ status: 'in_progress', updated_at: new Date().toISOString() })
    .eq('id', page.id);

  // Messages are already chronologically sorted (oldest-to-newest) in planSyncPages
  const chronoSortedMsgIds = [...page.message_ids];
  const startIndex = page.next_offset || 0;
  const startTime = Date.now();

  const isPersonal = account.account_type === 'personal';
  const isAccountInitialSync = !account.last_history_id;
  const BATCH_SIZE = 5;
  const INTER_BATCH_DELAY_MS = 0;

  const { gmail } = await createGmailClient(account);
  const { fetchMessageMetadata } = await import('@/lib/gmail/client');

  // Pre-check: IDs in this page already in emails table
  const { data: existingRows } = await supabase
    .from('emails')
    .select('gmail_message_id')
    .eq('gmail_account_id', account.id)
    .in('gmail_message_id', chronoSortedMsgIds);

  const existingInDb = new Set((existingRows || []).map((r) => r.gmail_message_id));

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
      await supabase
        .from('sync_pages')
        .update({
          next_offset: i,
          status: 'pending',
          updated_at: new Date().toISOString(),
        })
        .eq('id', page.id);

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
    currentIndex += batch.length;

    // Process batch sequentially to ensure deterministic causal order and eliminate concurrency races
    for (const msgId of batch) {
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
          deps,
          pageIndex: page.page_index,
          totalPagesCount,
          totalMessages: chronoSortedMsgIds.length,
          onProgress,
          liveTracker,
        });

        emailsProcessedCount += singleResult.emailsProcessed;
        newEmailsCount += singleResult.newEmails;
        newCompaniesCount += singleResult.newCompanies;
        skippedDuplicatesCount += singleResult.skippedDuplicates;
        errorsList.push(...singleResult.errors);
      } catch (singleErr) {
        const errMsg = singleErr instanceof Error ? singleErr.message : String(singleErr);
        const isQuota = /quota exceeded|rate.?limit|units.?per.?minute/i.test(errMsg);
        if (!isQuota) {
          errorsList.push(errMsg);
        }
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
    await supabase
      .from('sync_pages')
      .update({
        next_offset: currentIndex,
        updated_at: new Date().toISOString(),
      })
      .eq('id', page.id);

    if (INTER_BATCH_DELAY_MS > 0 && i + BATCH_SIZE < chronoSortedMsgIds.length) {
      await new Promise((r) => setTimeout(r, INTER_BATCH_DELAY_MS));
    }
  }

  // Page exhausted! Mark complete
  await supabase
    .from('sync_pages')
    .update({
      next_offset: chronoSortedMsgIds.length,
      status: 'complete',
      updated_at: new Date().toISOString(),
    })
    .eq('id', page.id);

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

  // 0. Concurrency Guard: In-memory lock (protects within same process)
  if (activeSyncLocks.has(userId)) {
    console.log(`[Sync Engine] In-memory sync lock active for user ${userId}. Gracefully skipping concurrent request.`);
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

  // Check Supabase sync_state table (protects across processes & external 15-min cron)
  try {
    const { data: dbLock } = await supabase
      .from('sync_state')
      .select('is_syncing, updated_at, phase')
      .eq('user_id', userId)
      .single();

    if (dbLock?.is_syncing) {
      const lastUpdated = new Date(dbLock.updated_at || 0).getTime();
      // Active syncs touch updated_at every ~1.5s. If untouched for > 60s, the process was killed/interrupted
      const isStale = Date.now() - lastUpdated > 60 * 1000;
      if (!isStale) {
        console.log(`[Sync Engine] User ${userId} sync is already active in database (phase: ${dbLock.phase}, updated: ${dbLock.updated_at}). Gracefully skipping concurrent invocation.`);
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
      } else {
        console.warn(`[Sync Engine] Stale sync lock found for user ${userId} (>60s untouched, likely cloud timeout/restart). Overriding lock.`);
      }
    }
  } catch {
    // If sync_state table not yet created in Supabase, proceed with in-memory lock
  }

  // Acquire active lock
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
  const persistProgressToDb = (p: SyncProgress, force = false) => {
    activeSyncMap.set(userId, p);
    const now = Date.now();
    if (!force && now - lastDbWriteTime < 1500) return Promise.resolve();
    lastDbWriteTime = now;
    dbWriteChain = dbWriteChain.then(async () => {
      try {
        await supabase.from('sync_state').upsert({
          user_id: userId,
          is_syncing: p.phase !== 'complete' && p.phase !== 'error',
          phase: p.phase,
          account_email: p.accountEmail,
          account_type: p.accountType,
          total_messages: p.totalMessages,
          processed_messages: p.processedMessages,
          new_emails: p.newEmails,
          new_companies: p.newCompanies,
          skipped_duplicates: p.skippedDuplicates,
          current_subject: p.currentSubject || null,
          is_initial_sync: isInitialSync,
          current_page_index: p.currentPageIndex ?? 0,
          total_pages: p.totalPagesCount ?? 1,
          updated_at: new Date().toISOString(),
          completed_at: p.phase === 'complete' ? new Date().toISOString() : null,
          last_error: p.errors.length > 0 ? p.errors[p.errors.length - 1] : null,
        });
      } catch {
        // Gracefully ignore if sync_state table not yet created
      }
    });
    return dbWriteChain;
  };

  const notifyProgress = (p: SyncProgress, forceDb = false) => {
    latestProgress = p;
    p.isInitialSync = isInitialSync;
    onProgress?.(p);
    persistProgressToDb(p, forceDb);
  };

  notifyProgress(latestProgress, true);

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
          .select('*')
          .eq('gmail_account_id', account.id)
          .order('page_index', { ascending: true });

        let pages: SyncPageRow[] = (existingPages || []) as SyncPageRow[];
        let pendingPages = pages.filter((p) => p.status !== 'complete');

        // If no pending pages exist, check Gmail for new messages and plan pages
        if (pendingPages.length === 0) {
          progress.phase = 'fetching';
          notifyProgress(progress);

          let messageIds: string[] = [];
          let nextHistoryId: string | null = null;

          const onFetchBatch = (fetchedCount: number) => {
            progress.totalMessages = fetchedCount;
            notifyProgress({
              ...progress,
              totalMessages: fetchedCount,
            });
          };

          if (account.account_type === 'personal') {
            // Personal account: master records for NeoPAT companies and registrations.
            // There are only ~270 emails across the entire season (~200ms to fetch IDs).
            // Always query all messages from 2026/07/01 so in-memory deduplication catches
            // any missed emails from previous interruptions or history gaps.
            const query = getPlacementSearchQuery('personal');
            messageIds = await fetchMessageIds(gmail, query, 2500, onFetchBatch);
            nextHistoryId = await getProfileHistoryId(gmail);
          } else if (account.last_history_id) {
            const historyResult = await fetchHistoryChanges(gmail, account.last_history_id);
            if (!historyResult.historyExpired) {
              messageIds = historyResult.messageIds;
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
          } else {
            // Fast Pre-Check: Filter out emails already in DB
            let existingSet = new Set<string>();
            if (messageIds.length <= 500) {
              const { data: existingRows } = await supabase
                .from('emails')
                .select('gmail_message_id')
                .eq('gmail_account_id', account.id)
                .in('gmail_message_id', messageIds);
              existingSet = new Set((existingRows || []).map((r) => r.gmail_message_id));
            } else {
              const { data: existingRows } = await supabase
                .from('emails')
                .select('gmail_message_id')
                .eq('gmail_account_id', account.id);
              existingSet = new Set((existingRows || []).map((r) => r.gmail_message_id));
            }

            newMsgIds = messageIds.filter((id) => !existingSet.has(id));
            skippedCount = messageIds.length - newMsgIds.length;

            progress.skippedDuplicates += skippedCount;
            result.skippedDuplicates += skippedCount;

            if (newMsgIds.length > 0) {
              pages = await planSyncPages(supabase, userId, account, newMsgIds);
              pendingPages = pages.filter((p) => p.status !== 'complete');
            } else {
              // No new emails to process
              await supabase
                .from('gmail_accounts')
                .update({
                  last_sync_at: new Date().toISOString(),
                  last_history_id: nextHistoryId || account.last_history_id,
                })
                .eq('id', account.id);
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

            const allDone = refreshedPages && refreshedPages.length > 0 && refreshedPages.every((p) => p.status === 'complete');
            if (allDone) {
              const nextHistId = await getProfileHistoryId(gmail).catch(() => null);
              await supabase
                .from('gmail_accounts')
                .update({
                  last_sync_at: new Date().toISOString(),
                  last_history_id: nextHistId || account.last_history_id,
                })
                .eq('id', account.id);
            }
            result.isPage0Complete = refreshedPages?.find((p: any) => p.page_index === 0)?.status === 'complete';
            result.hasMorePagesPending = !allDone;

          } else {
            // ── FOREGROUND / MANUAL SYNC PATH ────────────────────────────────────────────
            // Loop through all pending pages as long as time budget remains
            let remainingPages = [...pendingPages].sort((a, b) => a.page_index - b.page_index);

            for (const targetPage of remainingPages) {
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

            const allDone = refreshedPages && refreshedPages.length > 0 && refreshedPages.every((p) => p.status === 'complete');
            if (allDone) {
              const nextHistId = await getProfileHistoryId(gmail).catch(() => null);
              await supabase
                .from('gmail_accounts')
                .update({
                  last_sync_at: new Date().toISOString(),
                  last_history_id: nextHistId || account.last_history_id,
                })
                .eq('id', account.id);
            }

            result.isPage0Complete = refreshedPages?.find((p: any) => p.page_index === 0)?.status === 'complete';
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
          .select('id, thread_id, subject, sender, received_at, body_snippet')
          .eq('user_id', userId)
          .is('company_id', null);

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
              .select('thread_id, company_id')
              .eq('user_id', userId)
              .not('thread_id', 'is', null)
              .not('company_id', 'is', null);

            const threadCompanyMap = new Map<string, Set<string>>();
            for (const te of threadLinkedEmails || []) {
              if (te.thread_id && te.company_id) {
                const set = threadCompanyMap.get(te.thread_id) || new Set<string>();
                set.add(te.company_id);
                threadCompanyMap.set(te.thread_id, set);
              }
            }

            // TEMPORAL FILTER: Build Drive Anchor Date map (company_id -> latest Anchor Date)
            // An Anchor Date is the latest received_at of a NeoPAT email or an email containing pat-PL-
            const { data: anchorEmails } = await supabase
              .from('emails')
              .select('company_id, received_at')
              .eq('user_id', userId)
              .not('company_id', 'is', null)
              .or('sender.ilike.%noreply.cdcinfo@vitstudent.ac.in%,body_snippet.ilike.%pat-PL-%');

            const companyAnchorDates = new Map<string, number>();
            for (const ae of anchorEmails || []) {
              if (!ae.company_id || !ae.received_at) continue;
              const time = new Date(ae.received_at).getTime();
              const current = companyAnchorDates.get(ae.company_id) || 0;
              if (time > current) {
                companyAnchorDates.set(ae.company_id, time);
              }
            }

            // B. Build NeoPAT registration timeline map for timing correlation (±24h window)
            const { data: neoPatEmails } = await supabase
              .from('emails')
              .select('company_id, received_at')
              .eq('user_id', userId)
              .not('company_id', 'is', null)
              .ilike('sender', '%noreply.cdcinfo@vitstudent.ac.in%');

            const neoPatTimelines = (neoPatEmails || []).map((ne) => {
              const comp = allUserComps.find((c) => c.id === ne.company_id);
              return {
                companyId: ne.company_id as string,
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
                        .select('body_snippet')
                        .eq('company_id', cand.id)
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
                      .select('body_snippet')
                      .eq('company_id', matched.id)
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
                    const anchorTime = companyAnchorDates.get(matched.id);
                    const emailTime = email.received_at ? new Date(email.received_at).getTime() : 0;
                    if (!anchorTime || emailTime >= anchorTime - 14 * 24 * 60 * 60 * 1000) {
                      matchedCompanyId = matched.id;
                    }
                  }
                }
              }

              // 2. Thread Inheritance (Directionality: only if thread has EXACTLY 1 unique company)
              if (!matchedCompanyId && email.thread_id) {
                const candidateSet = threadCompanyMap.get(email.thread_id);
                if (candidateSet && candidateSet.size === 1) {
                  const candId = Array.from(candidateSet)[0];
                  const anchorTime = companyAnchorDates.get(candId);
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
                    .select('body_snippet')
                    .eq('company_id', candidateCompanyId)
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
                    const anchorTime = companyAnchorDates.get(candidateCompanyId);
                    const emailTime = email.received_at ? new Date(email.received_at).getTime() : 0;
                    if (!anchorTime || emailTime >= anchorTime - 14 * 24 * 60 * 60 * 1000) {
                      matchedCompanyId = candidateCompanyId;
                    }
                  }
                }
                // If > 1 candidates, ambiguous: do not guess!
              }

              if (matchedCompanyId) {
                await supabase
                  .from('emails')
                  .update({ company_id: matchedCompanyId, is_relevant: true })
                  .eq('id', email.id);

                // Register newly linked email to thread map for downstream emails in same pass
                if (email.thread_id) {
                  const set = threadCompanyMap.get(email.thread_id) || new Set<string>();
                  set.add(matchedCompanyId);
                  threadCompanyMap.set(email.thread_id, set);
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
                    userEmail
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

      // 5.4 Automatic Post-Sync Company Deduplication:
      // Merges any duplicate company records caused by subtle naming differences or historical runs.
      try {
        const { deduplicateUserCompanies } = await import('@/lib/sync/dedup');
        const dedupResult = await deduplicateUserCompanies(supabase, userId);
        if (dedupResult.removedCompaniesCount > 0) {
          console.log(`[SyncEngine] Deduplicated ${dedupResult.removedCompaniesCount} company record(s) for user ${userId}`);
        }
      } catch (dedupErr) {
        console.warn('[Post-Sync Dedup] Non-critical error:', dedupErr);
      }

      // 5.5 Holistic Status Recalculation:
      // The incremental per-email status engine can produce wrong statuses because it only
      // sees one email at a time. After all pages are done, re-run the full holistic
      // analysis (same logic as reprocess Phase 4) to correct any status errors.
      try {
        const { recalculateApplicationStatuses } = await import('@/app/api/sync/reprocess/route');
        await recalculateApplicationStatuses(userId);
      } catch (statusRecalcErr) {
        console.warn('[Post-Sync Status Recalc] Non-critical error:', statusRecalcErr);
      }

      // 6. Automatic Google Calendar reconciliation:
      // Only runs if new emails or archive pages were processed
      try {
        const { reconcileUserGoogleCalendar } = await import('@/lib/calendar/google-sync');
        const calResult = await reconcileUserGoogleCalendar(userId);
        console.log(`[Google Calendar Auto-Sync] User ${userId}: ${calResult.message}`);
      } catch (calErr) {
        console.warn('[Google Calendar Auto-Sync] Non-critical reconciliation error:', calErr);
      }

      // Clean up completed initial sync pages so future idle cron runs don't re-trigger
      if (hadCompletedInitialPages) {
        await supabase.from('sync_pages').delete().eq('user_id', userId);
      }
    } else {
      console.log(
        `[SyncEngine] User ${userId} sync run idle: 0 new emails/companies. Skipped circular reconciliation, dedup, status recalculation, and calendar sync (0 egress).`
      );
    }

    return result;
  } finally {
    activeSyncLocks.delete(userId);
    activeSyncMap.delete(userId);
    try {
      await dbWriteChain;
      const isError = result.errors.length > 0 && result.totalEmailsProcessed === 0;
      const isComplete = !result.hasMorePagesPending;
      await supabase.from('sync_state').upsert({
        user_id: userId,
        is_syncing: false,
        phase: isError ? 'error' : (isComplete ? 'complete' : 'pending'),
        total_messages: latestProgress.totalMessages,
        processed_messages: latestProgress.processedMessages,
        new_emails: result.newEmails,
        new_companies: result.newCompanies,
        skipped_duplicates: result.skippedDuplicates,
        is_initial_sync: isInitialSync,
        current_page_index: latestProgress.currentPageIndex ?? 0,
        total_pages: latestProgress.totalPagesCount ?? 1,
        completed_at: isComplete ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
        last_error: result.errors.length > 0 ? result.errors[result.errors.length - 1] : null,
      });
    } catch {
      // Ignore if sync_state table not yet created
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
  allowCreate: boolean = true,
  driveNumber?: string | null,
  driveName?: string | null
): Promise<string | null> {
  const currentLock = userUpsertLocks.get(userId) || Promise.resolve();
  let release: () => void;
  const nextLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  userUpsertLocks.set(userId, currentLock.then(() => nextLock));

  await currentLock;
  try {
    return await doUpsertCompany(supabase, userId, companyName, allowCreate, driveNumber, driveName);
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
  allowCreate: boolean = true,
  driveNumber?: string | null,
  driveName?: string | null
): Promise<string | null> {
  const normalized = normalizeCompanyName(companyName);

  if (!normalized || normalized.length < 2) return null;

  // Helper: learn new aliases and link drive_number to matched company
  const learnAliasesAndDrive = async (compRecord: {
    id: string;
    aliases?: string[] | null;
    drive_number?: string | null;
    drive_name?: string | null;
  }) => {
    const newAliases = extractCompanyAliases(companyName, normalized);
    if (driveNumber && !newAliases.includes(driveNumber.toLowerCase())) {
      newAliases.push(driveNumber.toLowerCase());
    }
    const currentAliases = (compRecord.aliases || []).map((a) => a.toLowerCase());
    const missing = newAliases.filter((a) => !currentAliases.includes(a.toLowerCase()));
    const updates: Record<string, any> = {};
    if (missing.length > 0) {
      updates.aliases = Array.from(new Set([...currentAliases, ...newAliases]));
    }
    if (!compRecord.drive_number && driveNumber) {
      updates.drive_number = driveNumber;
      if (driveName && !compRecord.drive_name) {
        updates.drive_name = driveName;
      }
    }
    if (Object.keys(updates).length > 0) {
      await supabase.from('companies').update(updates).eq('id', compRecord.id);
    }
  };

  // Helper: check if a candidate company is already bound to a DIFFERENT drive number
  const isBoundToOtherDrive = async (candidateCompId: string): Promise<boolean> => {
    if (!driveNumber) return false;
    const { data: boundEmails } = await supabase
      .from('emails')
      .select('body_snippet')
      .eq('company_id', candidateCompId)
      .not('body_snippet', 'is', null)
      .ilike('body_snippet', '%pat-PL-%')
      .limit(5);

    const existingDrives = (boundEmails || [])
      .flatMap((e: { body_snippet: string | null }) => extractAllDriveNumbers(e.body_snippet || ''));

    return existingDrives.length > 0 && !existingDrives.includes(driveNumber);
  };

  // 0. If driveNumber is provided, check if a company already has this driveNumber directly
  if (driveNumber) {
    const { data: driveComp } = await supabase
      .from('companies')
      .select('id, aliases, drive_number, drive_name')
      .eq('user_id', userId)
      .eq('drive_number', driveNumber)
      .maybeSingle();

    if (driveComp?.id) {
      await learnAliasesAndDrive(driveComp);
      return driveComp.id;
    }

    const { data: driveEmail } = await supabase
      .from('emails')
      .select('company_id')
      .eq('user_id', userId)
      .not('company_id', 'is', null)
      .ilike('body_snippet', `%${driveNumber}%`)
      .limit(1)
      .maybeSingle();

    if (driveEmail?.company_id) {
      const { data: matchedComp } = await supabase
        .from('companies')
        .select('id, aliases, drive_number, drive_name')
        .eq('id', driveEmail.company_id)
        .maybeSingle();
      if (matchedComp) {
        await learnAliasesAndDrive(matchedComp);
        return matchedComp.id;
      }
    }
  }

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
      .select('id, aliases, drive_number, drive_name')
      .eq('user_id', userId)
      .eq('name', cand)
      .maybeSingle();

    if (existing && !(await isBoundToOtherDrive(existing.id))) {
      await learnAliasesAndDrive(existing);
      return existing.id;
    }
  }

  // 2. Check aliases match across candidate names
  for (const cand of candidateNames) {
    const { data: aliasMatch } = await supabase
      .from('companies')
      .select('id, aliases, drive_number, drive_name')
      .eq('user_id', userId)
      .contains('aliases', [cand.toLowerCase()])
      .maybeSingle();

    if (aliasMatch && !(await isBoundToOtherDrive(aliasMatch.id))) {
      if (driveNumber && !aliasMatch.drive_number) {
        await supabase.from('companies').update({ drive_number: driveNumber, ...(driveName && !aliasMatch.drive_name ? { drive_name: driveName } : {}) }).eq('id', aliasMatch.id);
      }
      return aliasMatch.id;
    }
  }

  // 3. Dynamic matching against existing user companies
  const { data: userCompanies } = await supabase
    .from('companies')
    .select('id, name, aliases, drive_number, drive_name')
    .eq('user_id', userId);

  if (userCompanies && userCompanies.length > 0) {
    for (const comp of userCompanies) {
      const isMatched = candidateNames.some((cand) => {
        const aliasMatch = (comp.aliases || []).some((a: string) => isFuzzyCompanyMatch(a, cand));
        return isFuzzyCompanyMatch(comp.name, cand) || aliasMatch;
      });
      if (isMatched) {
        if (!(await isBoundToOtherDrive(comp.id))) {
          if (driveNumber && !comp.drive_number) {
            await supabase.from('companies').update({ drive_number: driveNumber, ...(driveName && !comp.drive_name ? { drive_name: driveName } : {}) }).eq('id', comp.id);
            comp.drive_number = driveNumber;
          }
          return comp.id;
        }
      }
    }
  }

  // 4. If no match found and allowCreate is false (e.g. College email), DO NOT create!
  if (!allowCreate) {
    return null;
  }

  // 5. If no match found and allowCreate is true (Personal email), create new company
  const generatedAliases = extractCompanyAliases(companyName, normalized);
  if (driveNumber && !generatedAliases.includes(driveNumber.toLowerCase())) {
    generatedAliases.push(driveNumber.toLowerCase());
  }

  const { data: newCompany, error } = await supabase
    .from('companies')
    .insert({
      user_id: userId,
      name: normalized,
      aliases: generatedAliases,
      drive_number: driveNumber || null,
      drive_name: driveName || null,
    })
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') {
      // Unique constraint violation: either drive_number or name already exists.
      // NEVER create a suffixed name — that just creates duplicates.
      // Strategy: look up by drive_number first (most reliable), then by name.
      if (driveNumber) {
        const { data: driveOwner } = await supabase
          .from('companies')
          .select('id')
          .eq('user_id', userId)
          .eq('drive_number', driveNumber)
          .maybeSingle();
        if (driveOwner?.id) return driveOwner.id;
      }
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
