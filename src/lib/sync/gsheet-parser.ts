/**
 * Parser for Google Sheets pubhtml shortlists sent by CDC / Placement Office.
 */

export interface GSheetMatchResult {
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

const gsheetCache = new Map<string, GSheetMatchResult | null>();

/**
 * Scans a Google Sheet pubhtml link for the candidate's identifiers.
 */
export async function scanGoogleSheetForCandidate(
  pubhtmlUrl: string,
  userEmail: string,
  userNeoId: string | null,
  userName?: string | null
): Promise<GSheetMatchResult | null> {
  const cacheKey = `${pubhtmlUrl}::${userEmail}::${userNeoId}`;
  if (gsheetCache.has(cacheKey)) {
    return gsheetCache.get(cacheKey) || null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(pubhtmlUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      gsheetCache.set(cacheKey, null);
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

    const emailLower = (userEmail || '').toLowerCase().trim();
    const neoIdUpper = (userNeoId || '').toUpperCase().trim();
    const regMatch = (userEmail || '').match(/([0-9]{2}[a-z]{3}[0-9]{4,5})/i);
    const regNo = regMatch ? regMatch[1].toUpperCase().trim() : '';
    const nameParts = (userName || '').trim().split(/\s+/).filter(Boolean);

    for (const s of sheetsToScan) {
      let sheetHtml = html;
      if (sheets.length > 0 && s.pageUrl !== pubhtmlUrl) {
        try {
          const tabCtrl = new AbortController();
          const tabTimeout = setTimeout(() => tabCtrl.abort(), 6000);
          let tabUrl: URL;
          try {
            tabUrl = new URL(s.pageUrl, pubhtmlUrl);
          } catch {
            continue;
          }
          if (tabUrl.protocol !== 'https:' || tabUrl.hostname !== 'docs.google.com') {
            continue;
          }
          const sRes = await fetch(tabUrl, { signal: tabCtrl.signal, redirect: 'error' });
          clearTimeout(tabTimeout);
          if (!sRes.ok) continue;
          sheetHtml = await sRes.text();
        } catch {
          continue;
        }
      }

      const hasEmail = emailLower && sheetHtml.toLowerCase().includes(emailLower);
      const hasNeoId = neoIdUpper && neoIdUpper.length >= 4 && sheetHtml.toUpperCase().includes(neoIdUpper);
      const hasRegNo = regNo && regNo.length >= 7 && sheetHtml.toUpperCase().includes(regNo);
      let hasName = false;
      if (nameParts.length >= 2) {
        hasName = sheetHtml.includes(nameParts[0]) && sheetHtml.includes(nameParts[nameParts.length - 1]);
      }

      if (hasEmail || hasNeoId || hasRegNo || hasName) {
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

        // Search for user's row
        const userRow = rows.find((r) => {
          return r.some((c) => {
            const cl = c.toLowerCase();
            const cu = c.toUpperCase();
            if (emailLower && cl === emailLower) return true;
            if (neoIdUpper && neoIdUpper.length >= 4 && cu === neoIdUpper) return true;
            if (regNo && regNo.length >= 7 && cu === regNo) return true;
            if (nameParts.length >= 2 && c.includes(nameParts[0]) && c.includes(nameParts[nameParts.length - 1])) {
              return true;
            }
            return false;
          });
        });

        if (userRow) {
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
            matched: true,
            sheetName: s.name,
            details: `Matched in Google Sheet (${s.name}): ${userRow.filter(Boolean).join(', ')}`,
            matchedValue: emailLower || neoIdUpper || regNo || userName || '',
            slot,
            eventDate,
          };
          gsheetCache.set(cacheKey, resObj);
          return resObj;
        }
      }
    }

    const noMatch: GSheetMatchResult = { matched: false, sheetName: '', details: '', matchedValue: '' };
    gsheetCache.set(cacheKey, noMatch);
    return noMatch;
  } catch (err) {
    console.error('Error scanning Google Sheet:', err);
    gsheetCache.set(cacheKey, null);
    return null;
  }
}
