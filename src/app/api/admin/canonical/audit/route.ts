import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { CANONICAL_IDENTITY_VERSION, normalizeRfcMessageId } from '@/lib/sync/canonical/canonical-email';
import { CANONICAL_PARSER_VERSION } from '@/lib/sync/canonical/canonical-email';
import { isShortlistMatchEvidence } from '@/lib/sync/recruitment/participation-evidence';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 1000;
const SAMPLE_SIZE = 25;

async function readAll<T>(
  label: string,
  queryFactory: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await queryFactory(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to audit ${label}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

export async function GET() {
  try {
    await requireAdmin();
  } catch (error) {
    const authError = error as Error & { status?: number };
    return NextResponse.json(
      { error: authError.message || 'Unauthorized' },
      { status: authError.status || 401 }
    );
  }

  const supabase = createAdminClient();

  try {
    const [collegeEmails, attachments, applications, personalEmails, candidateMatches, drives, companies, users, accounts] = await Promise.all([
      readAll('shared College archive', (from, to) => supabase
        .from('college_emails')
        .select('id, subject, sender_email, body_text, body_snippet, message_id, identity_version, parser_version, processing_status, classification, parsed_company_name, parsed_job_details, parsed_events, has_attachments, received_at')
        .range(from, to)),
      readAll('shared College attachments', (from, to) => supabase
        .from('college_attachments')
        .select('id, college_email_id, filename, size_bytes, parse_status, extracted_rows, content_hash')
        .range(from, to)),
      readAll('user applications', (from, to) => supabase
        .from('applications')
        .select('user_id, placement_drive_id, status, manual_override, status_source')
        .range(from, to)),
      readAll('user Personal-email evidence', (from, to) => supabase
        .from('personal_emails')
        .select('user_id, placement_drive_id')
        .not('placement_drive_id', 'is', null)
        .range(from, to)),
      readAll('user shortlist evidence', (from, to) => supabase
        .from('candidate_matches')
        .select('user_id, placement_drive_id, match_type, matched_value, matched_round_type')
        .not('placement_drive_id', 'is', null)
        .range(from, to)),
      readAll('shared placement drives', (from, to) => supabase
        .from('placement_drives')
        .select('id, company_id, drive_number')
        .range(from, to)),
      readAll('shared companies', (from, to) => supabase
        .from('companies')
        .select('id, name')
        .range(from, to)),
      readAll('user profiles', (from, to) => supabase
        .from('users')
        .select('id, email')
        .range(from, to)),
      readAll('connected College inboxes', (from, to) => supabase
        .from('gmail_accounts')
        .select('id, user_id, email, account_type, is_connected')
        .eq('account_type', 'college')
        .eq('is_connected', true)
        .range(from, to)),
    ]);

    const archive = {
      total: collegeEmails.length,
      bodyTextMissing: 0,
      bodyTextShort: 0,
      messageIdMissing: 0,
      outdatedIdentityVersion: 0,
      outdatedParserVersion: 0,
      classificationMissing: 0,
      parsedCompanyMissing: 0,
      parsedJobDetailsMissing: 0,
      parsedEventsMissing: 0,
      receivedAtMissing: 0,
      processingStatusCounts: {} as Record<string, number>,
      staleSamples: [] as Array<{ id: string; subject: string; reasons: string[] }>,
    };

    for (const row of collegeEmails) {
      const reasons: string[] = [];
      if (!row.body_text) {
        archive.bodyTextMissing++;
        reasons.push('body_text_missing');
      } else if (row.body_text.length <= 500) {
        archive.bodyTextShort++;
        reasons.push('body_text_short');
      }
      if (!normalizeRfcMessageId(row.message_id)) {
        archive.messageIdMissing++;
        reasons.push('message_id_missing');
      }
      if ((row.identity_version || 0) < CANONICAL_IDENTITY_VERSION) {
        archive.outdatedIdentityVersion++;
        reasons.push('identity_version_outdated');
      }
      if ((row.parser_version || 0) < CANONICAL_PARSER_VERSION) {
        archive.outdatedParserVersion++;
        reasons.push('parser_version_outdated');
      }
      if (!row.classification) {
        archive.classificationMissing++;
        reasons.push('classification_missing');
      }
      if (!row.parsed_company_name) {
        archive.parsedCompanyMissing++;
        reasons.push('parsed_company_missing');
      }
      if (!row.parsed_job_details) {
        archive.parsedJobDetailsMissing++;
        reasons.push('parsed_job_details_missing');
      }
      if (!row.parsed_events) {
        archive.parsedEventsMissing++;
        reasons.push('parsed_events_missing');
      }
      if (!row.received_at) {
        archive.receivedAtMissing++;
        reasons.push('received_at_missing');
      }
      archive.processingStatusCounts[row.processing_status] =
        (archive.processingStatusCounts[row.processing_status] || 0) + 1;
      if (reasons.length > 0 && archive.staleSamples.length < SAMPLE_SIZE) {
        archive.staleSamples.push({ id: row.id, subject: row.subject, reasons });
      }
    }

    const attachmentStatusCounts: Record<string, number> = {};
    const attachmentsMissingExtractedRows = attachments.filter((attachment) => !attachment.extracted_rows).length;
    const attachmentsMissingContentHash = attachments.filter((attachment) => !attachment.content_hash).length;
    for (const attachment of attachments) {
      attachmentStatusCounts[attachment.parse_status] = (attachmentStatusCounts[attachment.parse_status] || 0) + 1;
    }

    const personalEvidencePairs = new Set(
      personalEmails
        .filter((email) => email.user_id && email.placement_drive_id)
        .map((email) => `${email.user_id}|${email.placement_drive_id}`)
    );
    const shortlistEvidencePairs = new Set(
      candidateMatches
        .filter((match) => match.user_id && match.placement_drive_id && isShortlistMatchEvidence({
          matchType: match.match_type,
          matchedValue: match.matched_value,
          matchedRoundType: match.matched_round_type,
        }))
        .map((match) => `${match.user_id}|${match.placement_drive_id}`)
    );
    const userById = new Map(users.map((user) => [user.id, user.email]));
    const companyById = new Map(companies.map((company) => [company.id, company.name]));
    const driveById = new Map(drives.map((drive) => [drive.id, drive]));
    const unsupportedApplications = applications.filter((application) => {
      if (application.manual_override) return false;
      const pair = `${application.user_id}|${application.placement_drive_id}`;
      return !personalEvidencePairs.has(pair) && !shortlistEvidencePairs.has(pair);
    });

    return NextResponse.json({
      dryRun: true,
      generatedAt: new Date().toISOString(),
      archive: {
        ...archive,
        attachmentCount: attachments.length,
        attachmentStatusCounts,
        attachmentsMissingExtractedRows,
        attachmentsMissingContentHash,
      },
      onboarding: {
        connectedCollegeInboxCount: accounts.length,
        connectedCollegeInboxEmails: accounts.map((account) => account.email),
      },
      userTracking: {
        applicationCount: applications.length,
        unsupportedNonManualApplicationCount: unsupportedApplications.length,
        unsupportedSamples: unsupportedApplications.slice(0, SAMPLE_SIZE).map((application) => {
          const drive = driveById.get(application.placement_drive_id);
          return {
            userEmail: userById.get(application.user_id) || null,
            company: drive ? companyById.get(drive.company_id) || null : null,
            driveNumber: drive?.drive_number || null,
            status: application.status,
            statusSource: application.status_source,
          };
        }),
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Admin Canonical Audit API] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to audit the shared College archive' },
      { status: 500 }
    );
  }
}
