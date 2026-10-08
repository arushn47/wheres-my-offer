import { createAdminClient } from '@/lib/supabase/admin';
import { extractJobDetails } from '@/lib/sync/extraction/events';

// ============================================
// Types
// ============================================

export interface CircularRoleEntry {
  emailId?: string;
  companyBaseName: string;
  role: string;
  track: string;
  resolvedCompanyName: string;
  sourceDate: Date;
  subject: string;
}

export interface DriveResolutionResult {
  id?: string;
  driveNumber: string;
  companyBaseName: string;
  resolvedRole: string;
  resolvedCompanyName: string;
  resolvedVia: 'timing_correlation' | 'direct_role_text' | 'manual_review' | 'historical_rule';
  confidence: 'high' | 'medium' | 'low' | 'needs_review';
  timeDiffSeconds?: number | null;
  candidateCircularId?: string | null;
  notes?: string | null;
}

// Known distinct tracks that warrant company specialization
const DISTINCT_TRACK_PATTERNS: Array<{
  track: string;
  pattern: RegExp;
  cleanTrackName: string;
}> = [
  { track: 'sdet', pattern: /\b(?:sdet|software\s+development\s+engineer\s+in\s+test|test\s+engineer)\b/i, cleanTrackName: 'SDET' },
  { track: 'sre', pattern: /\b(?:sre|site\s+reliability\s+engineer|reliability)\b/i, cleanTrackName: 'SRE' },
  { track: 'sap', pattern: /\b(?:sap)\b/i, cleanTrackName: 'SAP' },
  { track: 'gds', pattern: /\b(?:gds|global\s+delivery\s+services)\b/i, cleanTrackName: 'GDS' },
  { track: 'aerospace', pattern: /\b(?:aerospace)\b/i, cleanTrackName: 'Aerospace' },
  { track: 'technology solutions', pattern: /\b(?:technology\s+solutions(?:\s+lab)?)\b/i, cleanTrackName: 'Technology Solutions Lab' },
];

/**
 * Extracts distinct track or role information from circular text.
 */
export function extractTrackOrRole(
  fullText: string,
  companyBaseName: string
): { role: string; track: string; resolvedCompanyName: string } | null {
  const lowerText = fullText.toLowerCase();

  // 1. Check for specific IS&T track pattern (e.g. Apple: "IS&T — 1. IS&T SDET Intern", "IS&T SRE Intern")
  const istMatch = fullText.match(/IS&T\s*[-–—:]*\s*(?:\d+[\.\)]\s*)?IS&T\s+([A-Za-z]+)\s+Intern/i);
  if (istMatch && istMatch[1]) {
    const trackName = istMatch[1].toUpperCase();
    return {
      role: `IS&T ${trackName} Intern`,
      track: trackName,
      resolvedCompanyName: `${companyBaseName} ${trackName}`.trim(),
    };
  }

  // 2. Check for known distinctive tracks (SDET, SRE, SAP, GDS, Aerospace, etc.)
  for (const { track, pattern, cleanTrackName } of DISTINCT_TRACK_PATTERNS) {
    if (pattern.test(lowerText)) {
      let resolvedComp = `${companyBaseName} ${cleanTrackName}`.trim();
      // Special naming overrides
      if (/honeywell/i.test(companyBaseName) && cleanTrackName === 'Technology Solutions Lab') {
        resolvedComp = 'Honeywell Technology Solutions Lab';
      } else if (/honeywell/i.test(companyBaseName) && cleanTrackName === 'Aerospace') {
        resolvedComp = 'Honeywell Aerospace';
      } else if (/ey|ernst/i.test(companyBaseName) && cleanTrackName === 'GDS') {
        resolvedComp = 'EY GDS';
      } else if (/ey|ernst/i.test(companyBaseName) && cleanTrackName === 'SAP') {
        resolvedComp = 'EY SAP';
      }

      return {
        role: cleanTrackName,
        track,
        resolvedCompanyName: resolvedComp,
      };
    }
  }

  // 3. Fallback to jobDetails role if explicitly extracted
  const jobDetails = extractJobDetails(fullText);
  if (jobDetails.role) {
    const roleLower = jobDetails.role.toLowerCase();
    for (const { track, pattern, cleanTrackName } of DISTINCT_TRACK_PATTERNS) {
      if (pattern.test(roleLower)) {
        return {
          role: jobDetails.role,
          track,
          resolvedCompanyName: `${companyBaseName} ${cleanTrackName}`.trim(),
        };
      }
    }
  }

  return null;
}

/**
 * Builds a dynamic in-memory catalog of `company -> role -> sourceDate` from circular emails.
 */
export function buildCircularCatalog(
  emails: Array<{
    id?: string | null;
    subject?: string | null;
    sender?: string | null;
    body_snippet?: string | null;
    body_plain?: string | null;
    received_at?: string | Date | null;
  }>
): Map<string, CircularRoleEntry[]> {
  const catalog = new Map<string, CircularRoleEntry[]>();

  for (const email of emails) {
    const subject = email.subject || '';
    const body = email.body_plain || email.body_snippet || '';
    const fullText = `${subject}\n${body}`;
    const receivedDate = email.received_at ? new Date(email.received_at) : new Date();

    // Check which known base company is referenced
    // e.g. Apple, Honeywell, Zluri, EY
    const baseCompanies = ['Apple', 'Honeywell', 'Zluri', 'EY'];
    for (const base of baseCompanies) {
      const baseRegex = new RegExp(`\\b${base}\\b`, 'i');
      if (baseRegex.test(subject) || baseRegex.test(body)) {
        const trackInfo = extractTrackOrRole(fullText, base);
        if (trackInfo) {
          const entry: CircularRoleEntry = {
            emailId: email.id || undefined,
            companyBaseName: base,
            role: trackInfo.role,
            track: trackInfo.track,
            resolvedCompanyName: trackInfo.resolvedCompanyName,
            sourceDate: receivedDate,
            subject,
          };

          const key = base.toLowerCase();
          if (!catalog.has(key)) {
            catalog.set(key, []);
          }
          catalog.get(key)!.push(entry);
        }
      }
    }
  }

  // Sort each company's catalog chronologically
  for (const entries of catalog.values()) {
    entries.sort((a, b) => a.sourceDate.getTime() - b.sourceDate.getTime());
  }

  return catalog;
}

/**
 * Loads all pre-resolved drive records from the DB into a quick lookup Map.
 */
export async function loadAllDriveResolutions(
  supabase: ReturnType<typeof createAdminClient>
): Promise<Map<string, DriveResolutionResult>> {
  const map = new Map<string, DriveResolutionResult>();

  try {
    const { data, error } = await supabase
      .from('drive_resolutions')
      .select('*');

    if (error) {
      console.warn('Could not load drive_resolutions:', error.message);
      return map;
    }

    for (const row of data || []) {
      map.set(row.drive_number, {
        id: row.id,
        driveNumber: row.drive_number,
        companyBaseName: row.company_base_name,
        resolvedRole: row.resolved_role,
        resolvedCompanyName: row.resolved_company_name,
        resolvedVia: row.resolved_via,
        confidence: row.confidence,
        timeDiffSeconds: row.time_diff_seconds,
        candidateCircularId: row.candidate_circular_id,
        notes: row.notes,
      });
    }
  } catch (err) {
    console.warn('loadAllDriveResolutions failed:', err);
  }

  return map;
}

/**
 * Resolves a drive_number to its specific role/track using timing correlation against circulars.
 * Persists the resolution into `drive_resolutions` table so it is never recomputed.
 */
export async function resolveDriveByTimingCorrelation(
  supabase: ReturnType<typeof createAdminClient>,
  driveNumber: string,
  companyBaseName: string,
  neoPatDate: Date,
  circularCatalog: Map<string, CircularRoleEntry[]>,
  cachedResolutions?: Map<string, DriveResolutionResult>
): Promise<DriveResolutionResult | null> {
  // 1. Check cached in-memory map if provided
  if (cachedResolutions && cachedResolutions.has(driveNumber)) {
    return cachedResolutions.get(driveNumber)!;
  }

  // 2. Check DB directly
  try {
    const { data: existing } = await supabase
      .from('drive_resolutions')
      .select('*')
      .eq('drive_number', driveNumber)
      .single();

    if (existing) {
      const res: DriveResolutionResult = {
        id: existing.id,
        driveNumber: existing.drive_number,
        companyBaseName: existing.company_base_name,
        resolvedRole: existing.resolved_role,
        resolvedCompanyName: existing.resolved_company_name,
        resolvedVia: existing.resolved_via,
        confidence: existing.confidence,
        timeDiffSeconds: existing.time_diff_seconds,
        candidateCircularId: existing.candidate_circular_id,
        notes: existing.notes,
      };
      if (cachedResolutions) {
        cachedResolutions.set(driveNumber, res);
      }
      return res;
    }
  } catch {
    // Continue to correlation
  }

  // 3. Find candidates from dynamic circular catalog within ±72 hour window
  const candidates = circularCatalog.get(companyBaseName.toLowerCase()) || [];
  if (candidates.length === 0) {
    return null;
  }

  const WINDOW_MS = 72 * 60 * 60 * 1000; // 72 hours
  const neoTime = neoPatDate.getTime();

  // Find all circulars within correlation window
  const inWindow = candidates
    .map((c) => ({
      ...c,
      timeDiffMs: Math.abs(c.sourceDate.getTime() - neoTime),
    }))
    .filter((c) => c.timeDiffMs <= WINDOW_MS)
    .sort((a, b) => a.timeDiffMs - b.timeDiffMs);

  if (inWindow.length === 0) {
    return null;
  }

  // 4. Ambiguity Guard:
  // If there are circulars for multiple different tracks/roles, check if they are ambiguously close in time
  const distinctTracks = Array.from(new Set(inWindow.map((c) => c.track)));
  if (distinctTracks.length > 1) {
    const closestPerTrack = distinctTracks.map((t) => inWindow.find((c) => c.track === t)!);
    closestPerTrack.sort((a, b) => a.timeDiffMs - b.timeDiffMs);

    const first = closestPerTrack[0];
    const second = closestPerTrack[1];

    // If both tracks are within 24 hours of the NeoPAT date AND within 12 hours of each other,
    // it's genuinely ambiguous — flag for review rather than guessing
    if (second.timeDiffMs <= 24 * 60 * 60 * 1000 && Math.abs(second.timeDiffMs - first.timeDiffMs) < 12 * 60 * 60 * 1000) {
      const ambiguousResult: DriveResolutionResult = {
        driveNumber,
        companyBaseName,
        resolvedRole: first.role,
        resolvedCompanyName: first.resolvedCompanyName,
        resolvedVia: 'timing_correlation',
        confidence: 'needs_review',
        timeDiffSeconds: Math.round(first.timeDiffMs / 1000),
        candidateCircularId: first.emailId || null,
        notes: `Ambiguous timing between ${first.resolvedCompanyName} (${Math.round(first.timeDiffMs / 60000)}m) and ${second.resolvedCompanyName} (${Math.round(second.timeDiffMs / 60000)}m)`,
      };

      await persistResolution(supabase, ambiguousResult);
      if (cachedResolutions) cachedResolutions.set(driveNumber, ambiguousResult);
      return ambiguousResult;
    }
  }

  // 5. Clean resolution: closest candidate wins
  const winner = inWindow[0];
  const timeDiffSec = Math.round(winner.timeDiffMs / 1000);

  const cleanResult: DriveResolutionResult = {
    driveNumber,
    companyBaseName,
    resolvedRole: winner.role,
    resolvedCompanyName: winner.resolvedCompanyName,
    resolvedVia: 'timing_correlation',
    confidence: timeDiffSec <= 48 * 3600 ? 'high' : 'medium',
    timeDiffSeconds: timeDiffSec,
    candidateCircularId: winner.emailId || null,
    notes: `Timing correlation matched to circular "${winner.subject.slice(0, 60)}" (Δ ${Math.round(timeDiffSec / 60)} min)`,
  };

  await persistResolution(supabase, cleanResult);
  if (cachedResolutions) cachedResolutions.set(driveNumber, cleanResult);
  return cleanResult;
}

/**
 * Persists a resolved drive mapping into the `drive_resolutions` table.
 */
async function persistResolution(
  supabase: ReturnType<typeof createAdminClient>,
  res: DriveResolutionResult
): Promise<void> {
  try {
    const payload = {
      drive_number: res.driveNumber,
      company_base_name: res.companyBaseName,
      resolved_role: res.resolvedRole,
      resolved_company_name: res.resolvedCompanyName,
      resolved_via: res.resolvedVia,
      confidence: res.confidence,
      time_diff_seconds: res.timeDiffSeconds || null,
      candidate_circular_id: res.candidateCircularId || null,
      notes: res.notes || null,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('drive_resolutions')
      .upsert(payload, { onConflict: 'drive_number' });

    if (error) {
      // If foreign key violation on candidate_circular_id (e.g. test UUID or wiped email), retry without it
      if (error.code === '23503' && res.candidateCircularId) {
        await supabase.from('drive_resolutions').upsert(
          { ...payload, candidate_circular_id: null },
          { onConflict: 'drive_number' }
        );
      } else {
        console.warn(`Failed to persist drive resolution for ${res.driveNumber}:`, error.message);
      }
    }
  } catch (err) {
    console.warn(`Failed to persist drive resolution for ${res.driveNumber}:`, err);
  }
}
