import * as XLSX from 'xlsx';

export interface MatchResult {
  isMatched: boolean;
  matchedSheet: string | null;
  matchedCell: string | null;
  matchedValue: string | null;
  totalRowsScanned: number;
  detectedIdColumnName: string | null;
  detectedHeaderRowIndex: number | null;
  usedFastPath: boolean;
  parseError?: string | null;
  additionalData?: Record<string, string>; // e.g. Name, Branch, CGPA, Section/Group
}

/**
 * Normalizes roll numbers by stripping whitespace, hyphens, non-breaking spaces, and casing.
 * e.g., " 23 bce 10472 " -> "23BCE10472"
 */
export function normalizeStudentId(id: string | number | null | undefined): string {
  if (id === null || id === undefined) return '';
  return id
    .toString()
    .replace(/[\u00A0\s\-_.]/g, '')
    .toUpperCase()
    .trim();
}

/**
 * Common University Registration Number Patterns:
 * - VIT format: 2 digits (Year) + 2-4 letters (Branch/School) + 4-6 digits (Serial)
 *   e.g. 23BCE10472, 21MIS0124, 22BEE0056, 23BCN10023
 */
export const STUDENT_ID_PATTERN = /^\d{2}[A-Z]{2,4}\d{4,6}$/;

/**
 * Determines scan priority for workbook tabs so that official Shortlist tabs take
 * precedence over Waitlist or Applied tabs if a student is listed in multiple sheets.
 */
function getSheetPriority(sheetName: string): number {
  const n = sheetName.toLowerCase();
  if (/shortlist|selected|final[_\s-]*list|shortlisted/i.test(n)) return 0;
  if (/interview|test[_\s-]*shortlist|assessment/i.test(n)) return 1;
  if (/waitlist|waiting|alternate|reserve/i.test(n)) return 2;
  if (/applied|eligible|opt[_\s-]*in|registered/i.test(n)) return 3;
  return 4;
}

/**
 * Validates that if a buffer has a ZIP signature (PK\x03\x04), it contains an
 * End of Central Directory record (PK\x05\x06) to prevent parser hangs on truncated files.
 */
function isCompleteZip(buf: Buffer): boolean {
  if (!buf || buf.length < 22) return false;
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    const maxCommentLength = 65535;
    const searchLimit = Math.min(buf.length, maxCommentLength + 22);
    for (let i = buf.length - 22; i >= buf.length - searchLimit; i--) {
      if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
        return true;
      }
    }
    return false;
  }
  return true; // Plaintext / CSV / TSV
}

/**
 * Scans an in-memory XLSX buffer and searches for target student roll number(s).
 * 
 * Production safeguards:
 * 1. Safe Parse: Catches corrupt or password-protected buffers without throwing.
 * 2. Tab Priority: Deterministically scans Shortlisted/Selected tabs before Waitlist/Applied tabs.
 * 3. Confidence Floor: Requires >= 3 hits and >= 25% non-blank sample density before locking to a column.
 * 4. Two-Tier Execution: Uses O(N) single-column fast path when confident; falls back to full sheet scan when sparse.
 * 5. Section Header Tracking: Inherits section banner rows (e.g. "VIT Bhopal Morning Batch") into candidate metadata.
 */
export function searchRollNumberInWorkbook(
  fileBuffer: Buffer,
  targetStudentId: string
): MatchResult {
  const normalizedTarget = normalizeStudentId(targetStudentId);
  if (!normalizedTarget) {
    return {
      isMatched: false,
      matchedSheet: null,
      matchedCell: null,
      matchedValue: null,
      totalRowsScanned: 0,
      detectedIdColumnName: null,
      detectedHeaderRowIndex: null,
      usedFastPath: false,
    };
  }

  // Pre-validate ZIP archive structure to prevent hangs on truncated/corrupted files
  if (!isCompleteZip(fileBuffer)) {
    return {
      isMatched: false,
      matchedSheet: null,
      matchedCell: null,
      matchedValue: null,
      totalRowsScanned: 0,
      detectedIdColumnName: null,
      detectedHeaderRowIndex: null,
      usedFastPath: false,
      parseError: 'Corrupt or truncated ZIP archive (missing End of Central Directory)',
    };
  }

  // 1. Safe Workbook Parsing (non-throwing)
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(fileBuffer, {
      type: 'buffer',
      cellDates: false,
      raw: true, // Prevents ReDoS in custom date formatters
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      isMatched: false,
      matchedSheet: null,
      matchedCell: null,
      matchedValue: null,
      totalRowsScanned: 0,
      detectedIdColumnName: null,
      detectedHeaderRowIndex: null,
      usedFastPath: false,
      parseError: `Failed to parse workbook: ${errMsg}`,
    };
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    return {
      isMatched: false,
      matchedSheet: null,
      matchedCell: null,
      matchedValue: null,
      totalRowsScanned: 0,
      detectedIdColumnName: null,
      detectedHeaderRowIndex: null,
      usedFastPath: false,
    };
  }

  // 2. Deterministic Tab Priority Ordering
  const sortedSheetNames = [...workbook.SheetNames].sort((a, b) => {
    return getSheetPriority(a) - getSheetPriority(b);
  });

  let totalRows = 0;

  for (const sheetName of sortedSheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet || !worksheet['!ref']) continue;

    // Convert sheet to array of rows (header: 1 gives a 2D array: row[col])
    const rows = XLSX.utils.sheet_to_json<any[]>(worksheet, {
      header: 1,
      blankrows: false,
      defval: '',
    });

    if (rows.length === 0) continue;
    totalRows += rows.length;

    // -------------------------------------------------------------
    // 3. Detect ID Column & First Data Row using Pattern Density
    // -------------------------------------------------------------
    const sampleLimit = Math.min(rows.length, 50);
    const colMatchCount: Record<number, number> = {};
    let nonBlankSampleRows = 0;
    let firstDataRowIndex = -1;

    for (let r = 0; r < sampleLimit; r++) {
      const row = rows[r];
      if (!Array.isArray(row) || row.every((c) => c === '' || c === null || c === undefined)) {
        continue;
      }
      nonBlankSampleRows++;

      for (let c = 0; c < row.length; c++) {
        const val = normalizeStudentId(row[c]);
        if (STUDENT_ID_PATTERN.test(val)) {
          colMatchCount[c] = (colMatchCount[c] || 0) + 1;
          if (firstDataRowIndex === -1) {
            firstDataRowIndex = r;
          }
        }
      }
    }

    // Determine the winning column
    let idColumnIndex = -1;
    let maxMatches = 0;
    for (const [colIdxStr, count] of Object.entries(colMatchCount)) {
      const colIdx = parseInt(colIdxStr, 10);
      if (count > maxMatches) {
        maxMatches = count;
        idColumnIndex = colIdx;
      }
    }

    // Confidence Floor: Require at least 3 hits AND at least 25% of non-blank sampled rows
    const isColumnConfidenceHigh =
      idColumnIndex !== -1 &&
      maxMatches >= 3 &&
      nonBlankSampleRows > 0 &&
      maxMatches / nonBlankSampleRows >= 0.25;

    // -------------------------------------------------------------
    // 4. Dynamic Header Row Detection
    // -------------------------------------------------------------
    let headerRowIndex: number | null = null;
    if (firstDataRowIndex > 0) {
      for (let r = firstDataRowIndex - 1; r >= 0; r--) {
        const candidateRow = rows[r];
        if (!Array.isArray(candidateRow)) continue;
        const nonBlankCells = candidateRow.filter((c) => c !== '' && c !== null && c !== undefined);
        // A true header row has multiple distinct column labels
        if (nonBlankCells.length >= 2) {
          headerRowIndex = r;
          break;
        }
      }
    }

    const headerRow = headerRowIndex !== null ? rows[headerRowIndex] : undefined;
    const detectedIdColName =
      idColumnIndex !== -1 && headerRow && headerRow[idColumnIndex]
        ? String(headerRow[idColumnIndex]).trim()
        : idColumnIndex !== -1
        ? `Col ${XLSX.utils.encode_col(idColumnIndex)}`
        : null;

    // -------------------------------------------------------------
    // 5. Search Execution (with Section Header Tracking)
    // -------------------------------------------------------------
    let currentSectionBanner: string | null = null;
    let shouldScanFullSheet = !isColumnConfidenceHigh;

    if (isColumnConfidenceHigh) {
      // High Confidence Path: Scan ONLY the detected ID column (Fast Path)
      const startRow = firstDataRowIndex !== -1 ? firstDataRowIndex : 0;
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        if (!Array.isArray(row)) continue;

        // Track section separator banners (e.g. single-cell rows like "VIT Bhopal Morning Batch")
        const filledCells = row.filter((c) => c !== '' && c !== null && c !== undefined);
        if (filledCells.length === 1 && typeof filledCells[0] === 'string' && filledCells[0].length > 3) {
          currentSectionBanner = filledCells[0].trim();
        }

        if (r < startRow || row[idColumnIndex] === undefined) continue;

        const cellValue = normalizeStudentId(row[idColumnIndex]);
        if (cellValue === normalizedTarget) {
          const colLetter = XLSX.utils.encode_col(idColumnIndex);
          const additional = extractRowData(headerRow, row);
          if (currentSectionBanner) {
            additional['Section / Group'] = currentSectionBanner;
          }

          return {
            isMatched: true,
            matchedSheet: sheetName,
            matchedCell: `${colLetter}${r + 1}`,
            matchedValue: cellValue,
            totalRowsScanned: totalRows,
            detectedIdColumnName: detectedIdColName,
            detectedHeaderRowIndex: headerRowIndex,
            usedFastPath: true,
            additionalData: additional,
          };
        }
      }

      // The fast path can select a different ID-shaped column than the target.
      // Fall back to the same exact full-sheet scan before moving to another tab.
      currentSectionBanner = null;
      shouldScanFullSheet = true;
    }

    if (shouldScanFullSheet) {
      // Low-confidence path or high-confidence fast-path miss: scan all cells.
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        if (!Array.isArray(row)) continue;

        // Track section separator banners
        const filledCells = row.filter((c) => c !== '' && c !== null && c !== undefined);
        if (filledCells.length === 1 && typeof filledCells[0] === 'string' && filledCells[0].length > 3) {
          currentSectionBanner = filledCells[0].trim();
        }

        for (let c = 0; c < row.length; c++) {
          const cellValue = normalizeStudentId(row[c]);
          if (cellValue === normalizedTarget) {
            const colLetter = XLSX.utils.encode_col(c);
            const colName =
              headerRow && headerRow[c]
                ? String(headerRow[c]).trim()
                : `Col ${colLetter}`;
            const additional = extractRowData(headerRow, row);
            if (currentSectionBanner) {
              additional['Section / Group'] = currentSectionBanner;
            }

            return {
              isMatched: true,
              matchedSheet: sheetName,
              matchedCell: `${colLetter}${r + 1}`,
              matchedValue: cellValue,
              totalRowsScanned: totalRows,
              detectedIdColumnName: colName,
              detectedHeaderRowIndex: headerRowIndex,
              usedFastPath: false,
              additionalData: additional,
            };
          }
        }
      }
    }
  }

  return {
    isMatched: false,
    matchedSheet: null,
    matchedCell: null,
    matchedValue: null,
    totalRowsScanned: totalRows,
    detectedIdColumnName: null,
    detectedHeaderRowIndex: null,
    usedFastPath: false,
  };
}

/**
 * Extracts key-value attributes from the matched candidate's row (e.g. Student Name, Branch, CGPA)
 */
function extractRowData(headerRow: any[] | undefined, matchedRow: any[]): Record<string, string> {
  const data: Record<string, string> = {};
  if (!headerRow || !Array.isArray(headerRow) || !Array.isArray(matchedRow)) return data;

  for (let i = 0; i < headerRow.length; i++) {
    const key = headerRow[i]?.toString().trim();
    const val = matchedRow[i]?.toString().trim();
    if (key && val && key.length < 40 && !/^(?:unnamed|col|\d+)$/i.test(key)) {
      data[key] = val;
    }
  }
  return data;
}
