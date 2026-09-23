import { createHash } from 'node:crypto';
import { htmlToCanonicalText } from '@/lib/sync/body';

export const CANONICAL_IDENTITY_VERSION = 2;
export const APPROVED_COLLEGE_SENDER = 'vitlions2027@vitbhopal.ac.in';

export function isApprovedCanonicalSender(senderEmail: string | null | undefined): boolean {
  return (senderEmail || '').trim().toLowerCase() === APPROVED_COLLEGE_SENDER;
}

export function normalizeRfcMessageId(messageId: string | null | undefined): string | null {
  const value = (messageId || '').trim().replace(/^<|>$/g, '').trim().toLowerCase();
  return value || null;
}

export function normalizeCanonicalSubject(subject: string | null | undefined): string {
  return (subject || '')
    .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function normalizeCanonicalBody(body: string | null | undefined): string {
  return (body || '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function computeCanonicalContentKey(
  senderEmail: string,
  subject: string,
  body: string
): string {
  const identity = [
    CANONICAL_IDENTITY_VERSION,
    senderEmail.trim().toLowerCase(),
    normalizeCanonicalSubject(subject),
    normalizeCanonicalBody(body),
  ].join('||');
  return createHash('sha256').update(identity).digest('hex');
}

export function computeCanonicalMetadataKey(senderEmail: string, subject: string, snippet: string): string {
  return computeCanonicalContentKey(senderEmail, subject, snippet);
}

export function canonicalBodyFromEmail(bodyPlain: string, bodyHtml: string, bodySnippet: string): string {
  const plain = bodyPlain?.trim() || '';
  const html = htmlToCanonicalText(bodyHtml);
  return normalizeCanonicalBody(plain || html || bodySnippet || '');
}

export interface CanonicalEmailCacheRow {
  id: string;
  content_key: string;
  message_id: string | null;
  sender_email: string;
  subject: string;
  body_text: string | null;
  body_snippet: string | null;
  classification: string | null;
  classification_confidence: number | null;
  parsed_company_name: string | null;
  parsed_drive_numbers: string[] | null;
  parsed_job_details: Record<string, unknown> | null;
  parsed_events: unknown[] | null;
  processing_status: string;
  identity_version: number;
  has_attachments: boolean | null;
  metadata_key?: string | null;
}

export function canReuseCanonicalBody(row: CanonicalEmailCacheRow | null): row is CanonicalEmailCacheRow {
  return Boolean(
    row &&
    row.processing_status === 'complete' &&
    row.identity_version === CANONICAL_IDENTITY_VERSION &&
    row.body_text &&
    row.has_attachments === false
  );
}
