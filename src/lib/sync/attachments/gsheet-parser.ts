/**
 * Parser for Google Sheets pubhtml shortlists sent by CDC / Placement Office.
 */

export interface GSheetMatchResult {
  extractedRows?: Array<{ sheetName: string; rows: string[][] }>;
  sourceUrl?: string;
  contentHash?: string;
  fetchedAt?: string;
  rowNumber?: number;
  matched: boolean;
  sheetName: string;
  details: string;
  matchedValue: string;
  slot?: string;
  eventDate?: Date;
}

const MONTH_MAP: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Extracts Google Sheets URLs from email body text.
 */
export function extractGoogleSheetUrls(text: string): string[] {
  if (!text) return [];
  const urls: string[] = [];
  const regex = /https:\/\/docs\.google\.com\/spreadsheets\/d\/(?:e\/)?[a-zA-Z0-9_\-]+(?:\/[^\s<>"]*)?/gi;
  let m;
  while ((m = regex.exec(text)) !== null) {
    let url = m[0].replace(/[.,;:>)]+$/, '');
    if (url.includes('/edit')) {
      url = url.replace(/\/edit.*$/, '/pubhtml');
    } else if (!url.includes('/pubhtml') && !url.includes('/export')) {
      url = url.replace(/\/$/, '') + '/pubhtml';
    }
    if (!urls.includes(url)) {
      urls.push(url);
    }
  }
  return urls;
}

/**
 * Parses date from sheet title or cell context (e.g. "7th Sept", "8 Sept 2026").
 */
function parseDateFromText(text: string): Date | null {
  const m = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|september|oct|nov|dec)(?:\s*(\d{4}))?/i);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthKey = m[2].toLowerCase();
  const month = MONTH_MAP[monthKey];
  if (month === undefined) return null;
  const year = m[3] ? parseInt(m[3], 10) : 2026;
  return new Date(year, month, day);
}

const gsheetCache = new Map<string, { value: GSheetMatchResult; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

/**
 * Scans a Google Sheet pubhtml link for the candidate's identifiers.
 */
import {
  buildCandidateIdentity,
  matchesCandidateRow,
  type UserCandidateIdentity,
} from '@/lib/sync/identity/user-identity';
import { isNonShortlistRoster, isPositiveRosterRow } from './roster-policy';
import { createHash } from 'node:crypto';

export async function scanGoogleSheetForCandidate(
  pubhtmlUrl: string,
  userEmail: string,
  userNeoId: string | null,
  userName?: string | null,
  candidateIdentity?: UserCandidateIdentity
): Promise<GSheetMatchResult | null> {
  try {
    const source = new URL(pubhtmlUrl);
    if (source.protocol !== 'https:' || source.hostname !== 'docs.google.com' || source.port || source.username || source.password || !source.pathname.startsWith('/spreadsheets/d/')) return null;
  } catch { return null; }
  const identity = candidateIdentity || buildCandidateIdentity({
    emails: [userEmail],
    neoId: userNeoId,
    name: userName,
  });

  const cacheKey = `${pubhtmlUrl}::${identity.emails.join(',')}::${identity.neoId || ''}::${identity.regNo || ''}::${identity.fullName || ''}`;
  const cached = gsheetCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  gsheetCache.delete(cacheKey);
  if (gsheetCache.size > 200) gsheetCache.delete(gsheetCache.keys().next().value!);
  const cacheResult = (value: GSheetMatchResult) => gsheetCache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(pubhtmlUrl, { signal: controller.signal, redirect: 'error' });
    clearTimeout(timeout);
    if (!res.ok) {
      return null;
    }
    const html = await res.text();

    // Check for dynamic sheet tabs
    const sheetRegex = /items\.push\({\s*name:\s*"([^"]+)",\s*pageUrl:\s*"([^"]+)",\s*gid:\s*"([^"]+)"/g;
    let match;
    const sheets: Array<{ name: string; pageUrl: string; gid: string }> = [];
    while ((match = sheetRegex.exec(html)) !== null) {
      sheets.push({
        name: match[1],
        pageUrl: match[2].replace(/\\x3d/g, '=').replace(/\\/g, ''),
        gid: match[3],
      });
    }

    const sheetsToScan = sheets.length > 0 ? sheets : [{ name: 'Shortlist', pageUrl: pubhtmlUrl, gid: '0' }];

    const extractedRows: Array<{ sheetName: string; rows: string[][] }> = [];
    let incomplete = false;
    let parsedTable = false;
    for (const s of sheetsToScan) {
      if (isNonShortlistRoster(s.name)) continue;
      let sheetHtml = html;
      if (sheets.length > 0 && s.pageUrl !== pubhtmlUrl) {
        try {
          const tabCtrl = new AbortController();
          const tabTimeout = setTimeout(() => tabCtrl.abort(), 6000);
          let tabUrl: URL;
          try {
            tabUrl = new URL(s.pageUrl, pubhtmlUrl);
          } catch {
            incomplete = true; continue;
          }
          if (tabUrl.protocol !== 'https:' || tabUrl.hostname !== 'docs.google.com') {
            incomplete = true; continue;
          }
          const sRes = await fetch(tabUrl, { signal: tabCtrl.signal, redirect: 'error' });
          clearTimeout(tabTimeout);
          if (!sRes.ok) { incomplete = true; continue; }
          sheetHtml = await sRes.text();
        } catch {
          incomplete = true;
          continue;
        }
      }
      if (!/<table\b/i.test(sheetHtml)) { incomplete = true; continue; }
      parsedTable = true;

      {
        // Parse actual table rows with cells to inspect allocation columns
        const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let trMatch;
        const rows: string[][] = [];
        while ((trMatch = trRegex.exec(sheetHtml)) !== null) {
          const cells: string[] = [];
          const tdRegex = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
          let tdMatch;
          while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
            cells.push(tdMatch[1].replace(/<[^>]+>/g, '').trim());
          }
          if (cells.some(Boolean)) {
            rows.push(cells);
          }
        }

        extractedRows.push({ sheetName: s.name, rows });
        if (!rows.length) { incomplete = true; continue; }

        // Identify header row with allocation columns (Venue, Seat, Room, Lab, Slot)
        const headerRow = rows.find((r) =>
          r.some((c) => /venue|seat|room|lab|hall|slot/i.test(c))
        );

        const allocationColIndices: number[] = [];
        if (headerRow) {
          headerRow.forEach((c, idx) => {
            if (/venue|seat|room|lab|hall|slot/i.test(c)) {
              allocationColIndices.push(idx);
            }
          });
        }

        // Search for user's row using universal candidate identity
        let matchedRowInfo: { row: string[]; matchedValue: string } | null = null;
        for (const row of rows) {
          const m = matchesCandidateRow(row, identity);
          if (m.matched && isPositiveRosterRow(row, headerRow)) {
            matchedRowInfo = { row, matchedValue: m.matchedValue };
            break;
          }
        }

        if (matchedRowInfo) {
          const userRow = matchedRowInfo.row;
          // If the sheet has allocation columns (Venue, Seat, etc.), the student MUST have a non-empty allocation!
          // Placement cell often includes all applied students but only assigns venue/seat to shortlisted students.
          if (allocationColIndices.length > 0) {
            const hasAssignedAllocation = allocationColIndices.some((idx) => {
              const val = userRow[idx];
              return val && val.trim().length > 0 && !/^[-–—\s#N\/A]+$/i.test(val.trim());
            });

            if (!hasAssignedAllocation) {
              // Row exists in master applicant list, but venue/seat is blank -> NOT shortlisted!
              continue;
            }
          }

          const slotCell = userRow.find((c) => /slot\s*\d+/i.test(c));
          const slot = slotCell ? slotCell.match(/slot\s*\d+/i)?.[0] : undefined;
          const eventDate = parseDateFromText(s.name) || parseDateFromText(userRow.join(' ')) || undefined;

          const resObj: GSheetMatchResult = {
            extractedRows,
            sourceUrl: pubhtmlUrl,
            contentHash: createHash('sha256').update(sheetHtml).digest('hex'),
            fetchedAt: new Date().toISOString(),
            rowNumber: rows.indexOf(userRow) + 1,
            matched: true,
            sheetName: s.name,
            details: `Matched in Google Sheet (${s.name}): ${userRow.filter(Boolean).join(', ')}`,
            matchedValue: matchedRowInfo.matchedValue,
            slot,
            eventDate,
          };
          cacheResult(resObj);
          return resObj;
        }
      }
    }

    if (incomplete || !parsedTable) return null;
    const noMatch: GSheetMatchResult = { extractedRows, matched: false, sheetName: '', details: '', matchedValue: '', sourceUrl: pubhtmlUrl, contentHash: createHash('sha256').update(html).digest('hex'), fetchedAt: new Date().toISOString() };
    cacheResult(noMatch);
    return noMatch;
  } catch (err) {
    console.error('Error scanning Google Sheet:', err);
    return null;
  }
}
