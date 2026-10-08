/**
 * College attachment parse-status vocabulary.
 *
 * The shared College archive extracts roster rows from spreadsheets
 * (`xlsx` / `xls` / `csv`) and JD text from text-layer PDFs (see `pdf-parser.ts`).
 * Every other attachment format falls into one of two terminal, deliberately
 * *non-retryable* buckets so that the archive never reports them as transient
 * parser failures and never re-downloads them on later worker passes:
 *
 *   - `ignored`  — images. Nothing in the product consumes them (not a roster, not a
 *                  JD), so they are recorded for inventory fidelity and then dropped.
 *   - `deferred` — formats we may parse in a future feature (DOC / DOCX JD
 *                  extraction, PDF OCR). Keep the row, never retry it now.
 *
 * `error` is reserved for a genuinely transient fetch/parse failure on a supported
 * workbook or PDF, which a later worker pass is expected to retry.
 */
export type AttachmentParseStatus = 'pending' | 'processing' | 'complete' | 'error' | 'deferred' | 'ignored';

export type TerminalUnsupportedStatus = 'deferred' | 'ignored';

export const IMAGE_ATTACHMENT_PATTERN = /\.(png|jpe?g|gif|bmp|webp|tiff?|svg|heic|heif|ico)$/i;
export const WORKBOOK_ATTACHMENT_PATTERN = /\.(xlsx|xls|csv)$/i;

export const IGNORED_IMAGE_ATTACHMENT_ERROR =
  'Image attachment ignored: no consumer in this system (not a roster or JD).';
export const DEFERRED_ATTACHMENT_ERROR =
  'Unsupported attachment format; deferred (JD parsing not implemented yet).';
export const TRANSIENT_ATTACHMENT_ERROR =
  'Attachment fetch or parser failed; retry on a later worker pass.';

/** True when the shared archive can extract roster rows from this attachment. */
export function isSupportedWorkbookAttachment(filename: string): boolean {
  return WORKBOOK_ATTACHMENT_PATTERN.test(filename || '');
}

/** True when the format has no consumer anywhere in the product (images). */
export function isIgnoredAttachment(filename: string): boolean {
  return IMAGE_ATTACHMENT_PATTERN.test(filename || '');
}

/**
 * Classifies a non-workbook attachment into its terminal status. Images are ignored
 * outright; everything else is deferred for a future, format-specific parser.
 */
export function classifyUnsupportedAttachment(filename: string): {
  status: TerminalUnsupportedStatus;
  error: string;
} {
  return isIgnoredAttachment(filename)
    ? { status: 'ignored', error: IGNORED_IMAGE_ATTACHMENT_ERROR }
    : { status: 'deferred', error: DEFERRED_ATTACHMENT_ERROR };
}

/** True when the row already records this exact terminal unsupported classification. */
export function isTerminalUnsupportedRow(
  row: { parse_status?: string | null; parse_error?: string | null } | null | undefined,
  classification: { status: TerminalUnsupportedStatus; error: string }
): boolean {
  return Boolean(row && row.parse_status === classification.status && (row.parse_error || '') === classification.error);
}
