import { describe, expect, it } from 'vitest';
import {
  CANONICAL_IDENTITY_VERSION,
  canReuseCanonicalBody,
  computeCanonicalContentKey,
  isApprovedCanonicalSender,
  normalizeRfcMessageId,
  normalizeCanonicalBody,
} from './canonical-email';

describe('Phase D canonical email identity', () => {
  it('reuses one identity for normalized copies of the same approved college broadcast', () => {
    const a = computeCanonicalContentKey('vitlions2027@vitbhopal.ac.in', 'Deloitte Registration', 'Hello\r\nWorld');
    const b = computeCanonicalContentKey('VITLIONS2027@VITBHOPAL.AC.IN', 'Re: Deloitte Registration', ' Hello\nWorld ');
    expect(a).toBe(b);
  });

  it('does not merge messages that differ after the old 500-character boundary', () => {
    const prefix = 'x'.repeat(600);
    expect(computeCanonicalContentKey('vitlions2027@vitbhopal.ac.in', 'Same', `${prefix}A`))
      .not.toBe(computeCanonicalContentKey('vitlions2027@vitbhopal.ac.in', 'Same', `${prefix}B`));
  });

  it('normalizes RFC Message-ID and rejects personal canonicalization', () => {
    expect(normalizeRfcMessageId(' <ABC@example.com> ')).toBe('abc@example.com');
    expect(isApprovedCanonicalSender('vitlions2027@vitbhopal.ac.in')).toBe(true);
    expect(isApprovedCanonicalSender('noreply.cdcinfo@vitstudent.ac.in')).toBe(false);
  });

  it('requires complete body canonical content before cache reuse regardless of attachments', () => {
    expect(canReuseCanonicalBody({
      id: '1', content_key: 'k', message_id: null, sender_email: 'vitlions2027@vitbhopal.ac.in',
      subject: 'Subject', body_text: 'body', body_snippet: 'body', classification: null,
      classification_confidence: null, parsed_company_name: null, parsed_drive_numbers: null,
      parsed_job_details: null, parsed_events: null, processing_status: 'complete',
      identity_version: CANONICAL_IDENTITY_VERSION, has_attachments: false,
    })).toBe(true);
    expect(canReuseCanonicalBody({
      id: '2', content_key: 'k', message_id: null, sender_email: 'vitlions2027@vitbhopal.ac.in',
      subject: 'Subject', body_text: 'body', body_snippet: 'body', classification: null,
      classification_confidence: null, parsed_company_name: null, parsed_drive_numbers: null,
      parsed_job_details: null, parsed_events: null, processing_status: 'complete',
      identity_version: CANONICAL_IDENTITY_VERSION, has_attachments: true,
    })).toBe(true);
  });

  it('keeps body normalization deterministic without storing user-specific data', () => {
    expect(normalizeCanonicalBody('  Shared\r\n\r\n content  ')).toBe('Shared\n\n content');
  });

  it('keeps separate user receipts conceptually independent from shared identity', () => {
    const key = computeCanonicalContentKey('vitlions2027@vitbhopal.ac.in', 'Shared', 'Body');
    expect(key).toBe(computeCanonicalContentKey('vitlions2027@vitbhopal.ac.in', 'Shared', 'Body'));
    expect('user-a-receipt').not.toBe('user-b-receipt');
  });

  it('does not reuse a canonical row whose metadata key differs', () => {
    const bodyKey = computeCanonicalContentKey('vitlions2027@vitbhopal.ac.in', 'Shared', 'Body');
    const metadataKey = computeCanonicalContentKey('vitlions2027@vitbhopal.ac.in', 'Shared', 'Different snippet');
    expect(bodyKey).not.toBe(metadataKey);
  });

  it('supports a full-body fallback when RFC Message-ID is absent', () => {
    expect(normalizeRfcMessageId(null)).toBeNull();
    expect(computeCanonicalContentKey('vitlions2027@vitbhopal.ac.in', 'Shared', 'Body')).toHaveLength(64);
  });

  it('does not allow incomplete or errored canonical rows to become cache hits', () => {
    const base = {
      id: '1', content_key: 'k', message_id: 'm', sender_email: 'vitlions2027@vitbhopal.ac.in',
      subject: 'Subject', body_text: 'body', body_snippet: 'body', classification: null,
      classification_confidence: null, parsed_company_name: null, parsed_drive_numbers: null,
      parsed_job_details: null, parsed_events: null, identity_version: CANONICAL_IDENTITY_VERSION,
      has_attachments: false,
    };
    expect(canReuseCanonicalBody({ ...base, processing_status: 'processing' })).toBe(false);
    expect(canReuseCanonicalBody({ ...base, processing_status: 'complete', body_text: null })).toBe(false);
  });

  it('allows attachment-bearing messages to reuse canonical body', () => {
    const base = {
      id: '1', content_key: 'k', message_id: 'm', sender_email: 'vitlions2027@vitbhopal.ac.in',
      subject: 'Shortlist', body_text: 'body', body_snippet: 'body', classification: 'shortlist',
      classification_confidence: 1, parsed_company_name: 'Example', parsed_drive_numbers: null,
      parsed_job_details: null, parsed_events: null, processing_status: 'complete',
      identity_version: CANONICAL_IDENTITY_VERSION,
    };
    expect(canReuseCanonicalBody({ ...base, has_attachments: true })).toBe(true);
  });
});
