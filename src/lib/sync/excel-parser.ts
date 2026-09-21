import type { gmail_v1 } from 'googleapis';
import * as XLSX from 'xlsx';
import type { ParsedAttachment } from '@/lib/gmail/client';
import { searchRollNumberInWorkbook } from './xlsx-matcher';

export interface ExcelMatchResult {
  matched: boolean;
  scanStatus: 'matched' | 'no_match' | 'failed';
  filename: string;
  matchedNeoId: string | null;
  details: string | null;
  venueOrRoom: string | null;
  /** True only if the match was in an actual shortlist file (not an applied/eligible/opt-in list) */
  isActualShortlist: boolean;
}

/**
 * Determines if a filename is an actual shortlist (for next round) vs
 * just an applied/eligible/opt-in list that any registered student appears in.
 *
 * Applied/opt-in lists confirm "you applied" but do NOT mean "you are shortlisted".
 * Examples of applied lists:  "applied list", "opt-in list", "eligible students", "registered"
 * Examples of shortlists:     "shortlist", "test shortlist", "selection list"
 */
export function classifyExcelFile(filename: string): 'shortlist' | 'applied_list' | 'other' {
  const f = filename.toLowerCase();

  // --- Applied/opt-in/eligible list patterns (do NOT count as shortlisted) ---
  if (
    /applied[_\s-]*list|opt[_\s-]*in[_\s-]*list|opt_in|eligible[_\s-]*student|registered[_\s-]*student|registration[_\s-]*list|applied[_\s-]*candidate|applied[_\s-]*student/i.test(
      f
    )
  ) {
    return 'applied_list';
  }

  // --- Actual shortlist patterns ---
  if (/shortlist|selection[_\s-]*list|test[_\s-]*shortlist|selected[_\s-]*student|shortlisted/i.test(f)) {
    return 'shortlist';
  }

  return 'other';
}

/**
 * Downloads and scans Excel/CSV attachments for a candidate's Neo ID or Registration No.
 *
 * Priority order:
 *   1. Actual shortlist files (shortlist, selection-list, test-shortlist)
 *   2. Applied/eligible/opt-in list files
 *   3. Other Excel files
 *
 * A match in an applied-list file means "you registered/applied" — NOT shortlisted.
 * A match in a shortlist file means "you are shortlisted for the next round" — shortlisted.
 *
 * @param gmail Gmail API client
 * @param messageId Gmail Message ID
 * @param attachments List of attachments on the email
 * @param userNeoId User's configured Neo ID (e.g. alphanumeric candidate registration ID)
 * @param userEmail User's email (e.g. student email address)
 */
export async function scanExcelAttachmentsForNeoId(
  gmail: gmail_v1.Gmail,
  messageId: string,
  attachments: ParsedAttachment[],
  userNeoId: string | null,
  userEmail: string,
  /**
   * True when the email subject/body itself announces a shortlist (e.g. "Shortlisted Candidates",
   * "Test is Scheduled"). In this context, even Excel files without "shortlist" in their filename
   * should be treated as actual shortlists — CDC doesn't always name files consistently.
   */
  isShortlistContext: boolean = false
): Promise<ExcelMatchResult | null> {
  const excelAttachments = attachments.filter((att) =>
    /\.(xlsx|xls|csv)$/i.test(att.filename)
  );

  if (excelAttachments.length === 0) {
    return null;
  }

  // Identifiers to search for
  const searchTokens: string[] = [];
  if (userNeoId && userNeoId.length >= 4) {
    searchTokens.push(userNeoId.toUpperCase().trim());
  }

  // Extract reg number from email (e.g. "23BCE10472")
  const regMatch = userEmail.match(/([0-9]{2}[a-z]{3}[0-9]{4,5})/i);
  if (regMatch && regMatch[1]) {
    searchTokens.push(regMatch[1].toUpperCase().trim());
  }

  // Include user email address
  if (userEmail && userEmail.includes('@')) {
    searchTokens.push(userEmail.toLowerCase().trim());
    searchTokens.push(userEmail.toUpperCase().trim());
  }

  if (searchTokens.length === 0) {
    return null;
  }

  // Sort: scan actual shortlist files first, then applied lists, then others
  // This way if found in a shortlist, we return early with isActualShortlist=true
  const PRIORITY = { shortlist: 0, applied_list: 1, other: 2 } as const;
  const sorted = [...excelAttachments].sort((a, b) => {
    return PRIORITY[classifyExcelFile(a.filename)] - PRIORITY[classifyExcelFile(b.filename)];
  });

  let appliedListMatch: ExcelMatchResult | null = null;
  let scanFailed = false;

  for (const att of sorted) {
    const fileType = classifyExcelFile(att.filename);

    try {
      const res = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: att.attachmentId,
      });

      if (!res.data.data) {
        scanFailed = true;
        continue;
      }

      const buffer = Buffer.from(res.data.data, 'base64url');

      for (const token of searchTokens) {
        const match = searchRollNumberInWorkbook(buffer, token);

        if (match.parseError) {
          scanFailed = true;
          continue;
        }

        if (match.isMatched) {
          // Check for venue / room / lab in additional extracted data
          let roomOrVenue: string | null = null;
          if (match.additionalData) {
            for (const [k, v] of Object.entries(match.additionalData)) {
              if (/venue|room|hall|lab|place|location/i.test(k) || /prp|sjt|mb|tt|anna|channa|lc\s*\d+/i.test(v)) {
                roomOrVenue = `${k}: ${v}`;
                break;
              }
            }
          }

          // A file is an actual shortlist / participant list if:
          // (a) its filename says "shortlist", OR
          // (b) the email itself announces a shortlist or scheduled round (test, interview, assessment, PPT)
          // CRITICAL: An applied / opt-in list is NEVER an actual shortlist, even if attached to a test/round announcement!
          const isActualShortlist =
            fileType === 'shortlist' || (isShortlistContext && fileType !== 'applied_list');

          const result: ExcelMatchResult = {
            matched: true,
            scanStatus: 'matched',
            filename: att.filename,
            matchedNeoId: match.matchedValue || token,
            details: `Matched in ${att.filename} (${match.matchedSheet}!${match.matchedCell})${
              match.detectedIdColumnName ? ` [${match.detectedIdColumnName}]` : ''
            }${roomOrVenue ? ` - ${roomOrVenue}` : ''}`,
            venueOrRoom: roomOrVenue,
            isActualShortlist,
          };

          if (result.isActualShortlist) {
            // Best possible result (confirmed candidate shortlist) — return immediately
            return result;
          } else {
            // Applied list match — record it but keep checking other attachments for an actual shortlist
            if (!appliedListMatch) {
              appliedListMatch = result;
            }
          }
        }
      }
    } catch (err) {
      console.error(`Failed to scan attachment ${att.filename}:`, err);
      scanFailed = true;
    }
  }

  // Preserve a valid applied-list match, but expose any failed sibling scan.
  if (appliedListMatch) {
    return scanFailed
      ? { ...appliedListMatch, scanStatus: 'failed' }
      : appliedListMatch;
  }

  if (scanFailed) {
    return {
      matched: false,
      scanStatus: 'failed',
      filename: '',
      matchedNeoId: null,
      details: null,
      venueOrRoom: null,
      isActualShortlist: false,
    };
  }

  return {
    matched: false,
    scanStatus: 'no_match',
    filename: '',
    matchedNeoId: null,
    details: null,
    venueOrRoom: null,
    isActualShortlist: false,
  };
}
