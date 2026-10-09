import { cleanRoleTitle, extractJobDetails } from '@/lib/sync/extraction/events';
import { cleanLocationString } from './locations';

export interface CachedPdfAttachment {
  filename?: string | null;
  parseStatus?: string | null;
  extractedRows?: unknown;
}

/**
 * PDF attachment parsing for the shared College archive.
 *
 * College circulars commonly carry the drive's JD / compensation sheet as a PDF
 * while the email body only says "details in attachment". Text-layer PDFs are
 * extracted here so CTC, role, stipend, location and eligibility can be derived
 * from the attachment exactly like they are from email bodies.
 *
 * The extracted text is stored in `college_attachments.extracted_rows` as
 * `[{ sheetName: 'pdf_text', rows: [<page text>...] }]` — the same JSONB column
 * workbooks use — so no schema migration is required. Every shortlist-roster
 * consumer (`evaluateCachedShortlistRosters`, `excel-parser.ts`) filters by
 * `.xlsx/.xls/.csv` extensions, so PDF rows can never be mistaken for a roster.
 *
 * Scanned/image-only PDFs yield little or no text; they are recorded as
 * `deferred` (future OCR), never as a transient `error`.
 */

export const PDF_ATTACHMENT_PATTERN = /\.pdf$/i;

/** Max characters of PDF text persisted per attachment (jsonb hygiene). */
const MAX_PDF_TEXT_CHARS = 200_000;

export function isPdfAttachment(filename: string): boolean {
  return PDF_ATTACHMENT_PATTERN.test(filename || '');
}

/** Wraps extracted PDF page text in the workbook-shaped row payload. */
export function pdfRowsFromText(pages: string[]): Array<{ sheetName: string; rows: unknown[][] }> {
  const trimmedPages = pages
    .map((page) => page.replace(/\u0000/g, '').trim())
    .filter((page) => page.length > 0);
  return [{ sheetName: 'pdf_text', rows: trimmedPages.map((page) => [page.slice(0, MAX_PDF_TEXT_CHARS)]) }];
}

/** Extracts text from PDF bytes, page by page. Throws on unreadable/corrupt PDFs. */
export async function extractPdfText(bytes: Buffer): Promise<string[]> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  // unpdf returns string for single-page PDFs and string[] otherwise.
  const pages = Array.isArray(text) ? text : [text];
  return pages.map((page) => page.replace(/\u0000/g, ''));
}

export interface PdfParseResult {
  extractedRows: Array<{ sheetName: string; rows: unknown[][] }> | null;
  parseStatus: 'complete' | 'deferred' | 'error';
  parseError: string | null;
}

/** Reuse completed PDF text already present in this circular's attachment cache. */
export function getCachedPdfText(attachments: Array<CachedPdfAttachment | undefined> | undefined): string {
  let text = '';
  for (const attachment of attachments || []) {
    if (!attachment || !isPdfAttachment(attachment.filename || '')) continue;
    if (attachment.parseStatus !== 'complete' || !Array.isArray(attachment.extractedRows)) continue;
    for (const sheet of attachment.extractedRows as Array<{ rows?: unknown[][] }>) {
      if (!Array.isArray(sheet?.rows)) continue;
      for (const row of sheet.rows) {
        if (!Array.isArray(row)) continue;
        for (const cell of row) {
          if (typeof cell === 'string' && cell.length) text += `\n${cell}`;
          if (text.length >= MAX_PDF_TEXT_CHARS) return text.slice(0, MAX_PDF_TEXT_CHARS);
        }
      }
    }
  }
  return text;
}

/** Downloads are handled by the caller; this parses already-fetched PDF bytes. */
export async function parsePdfAttachment(bytes: Buffer): Promise<PdfParseResult> {
  try {
    const pages = await extractPdfText(bytes);
    const joined = pages.join('\n').trim();
    // Scanned PDFs (image-only) produce almost no text — keep them deferred for OCR.
    if (joined.replace(/\s+/g, '').length < 40) {
      return {
        extractedRows: null,
        parseStatus: 'deferred',
        parseError: 'PDF contained no extractable text layer (likely scanned images); deferred.',
      };
    }
    return { extractedRows: pdfRowsFromText(pages), parseStatus: 'complete', parseError: null };
  } catch (error) {
    return {
      extractedRows: null,
      parseStatus: 'error',
      parseError: `PDF text extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Derives job details from every parsed PDF attachment on an email and merges
 * them into body-derived details. Body values always win; PDFs only fill fields
 * the body left null (the classic "CTC / JD in attached PDF" circular).
 * Generic so full `ExtractedJobDetails` inputs keep their complete shape.
 */
export function mergePdfJobDetails<T extends object>(
  bodyDetails: T,
  attachments: Array<CachedPdfAttachment | undefined> | undefined
): T {
  if (!attachments?.length) return bodyDetails;

  const pdfText = getCachedPdfText(attachments);
  if (!pdfText.trim()) return bodyDetails;

  const merged: Record<string, unknown> = { ...(bodyDetails as Record<string, unknown>) };
  if (typeof merged.role === 'string') merged.role = cleanRoleTitle(merged.role);
  if (typeof merged.location === 'string' && cleanLocationString(merged.location) === 'Not Specified') merged.location = null;
  const pdfDetails = extractJobDetails(pdfText.slice(0, MAX_PDF_TEXT_CHARS));
  for (const field of ['role', 'ctc', 'stipend', 'location', 'eligibility', 'cgpaRequirement', 'backlogRequirement'] as const) {
    if (!merged[field] && pdfDetails[field]) {
      merged[field] = pdfDetails[field];
    }
  }
  return merged as T;
}
