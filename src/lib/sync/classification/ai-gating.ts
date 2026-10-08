export interface Tier1ExtractionResult {
  companyName: string | null;
  classification: string;
  ctc: string | null;
  stipend: string | null;
  eventsCount: number;
  driveNumber: string | null;
  rawMatchedFields?: Record<string, string>;
}

export interface ExistingDriveState {
  companyId: string;
  canonicalName: string;
  ctc: string | null;
  status: string;
  driveNumber?: string | null;
}

// Short company names that are well-known and unambiguous — don't need AI to clarify
const KNOWN_UNAMBIGUOUS_SHORT_NAMES = new Set([
  'tcs', 'ibm', 'ltm', 'hcl', 'cts', 'ntt', 'sap', 'nec', 'dxc', 'ptc', 'acn',
]);

/**
 * Deterministic Gating Function:
 * Returns TRUE only if Tier 1 produced an incomplete or contradictory result.
 */
export function shouldInvokeAiFallback(
  tier1: Tier1ExtractionResult,
  existingState?: ExistingDriveState | null
): { shouldInvoke: boolean; reason: string | null } {
  // Never invoke on non-placement emails or noise
  if (['irrelevant', 'unclassified', 'general'].includes(tier1.classification)) {
    return { shouldInvoke: false, reason: null };
  }

  // Never waste AI resources on companies where the user has not applied or has opted out / withdrawn
  if (existingState && ['not_applied', 'withdrawn', 'declined'].includes(existingState.status)) {
    return { shouldInvoke: false, reason: null };
  }

  // Trigger 1: Placement email with completely missing Company Name
  if (!tier1.companyName) {
    return { shouldInvoke: true, reason: 'missing_company_name' };
  }

  // Trigger 2: Placement circular with no CTC, no Stipend, and zero extractable events
  const isCircular = tier1.classification === 'jd' || tier1.classification === 'registration';
  if (isCircular && !tier1.ctc && !tier1.stipend && tier1.eventsCount === 0) {
    return { shouldInvoke: true, reason: 'unextracted_circular_metadata' };
  }

  // Trigger 3: State contradiction against an existing verified drive CTC
  if (existingState && existingState.ctc && tier1.ctc && existingState.ctc !== tier1.ctc) {
    // If both specify a drive number and they differ, they are separate distinct tracks (e.g. Infosys SP vs SE), not a contradiction!
    const hasConflictingDriveNumbers =
      existingState.driveNumber &&
      tier1.driveNumber &&
      existingState.driveNumber !== tier1.driveNumber;

    if (!hasConflictingDriveNumbers) {
      return { shouldInvoke: true, reason: 'ctc_state_contradiction' };
    }
  }

  // Trigger 4: Labeled match where the value could not be resolved into a known pattern
  if (tier1.rawMatchedFields?.['ctc_raw'] && !tier1.ctc) {
    return { shouldInvoke: true, reason: 'unparseable_compensation_format' };
  }

  // Trigger 5: Company name resolved, but it's a short ambiguous token (e.g. bare "EY", "3M")
  // with no distinguishing track signal, on a clearly placement-classified email.
  // Well-known short names (TCS, IBM, etc.) are excluded from this check.
  if (
    tier1.companyName &&
    tier1.companyName.length <= 3 &&
    !KNOWN_UNAMBIGUOUS_SHORT_NAMES.has(tier1.companyName.toLowerCase()) &&
    ['registration', 'jd', 'shortlist'].includes(tier1.classification)
  ) {
    return { shouldInvoke: true, reason: 'ambiguous_short_company_name' };
  }

  // Clean Tier 1 hit -> Do NOT touch the LLM
  return { shouldInvoke: false, reason: null };
}

/**
 * Reconciliation Policy for Contradictions:
 * Dictates what to do when existing state, Tier 1, and AI extraction disagree.
 */
export function reconcileCompensation(
  existingDbCtc: string | null,
  tier1Ctc: string | null,
  aiCtc: string | null
): { acceptedCtc: string | null; action: 'preserve' | 'update' | 'flag_for_review' } {
  // If no existing state, accept AI if present, else Tier 1
  if (!existingDbCtc) {
    return {
      acceptedCtc: aiCtc || tier1Ctc,
      action: (aiCtc || tier1Ctc) ? 'update' : 'preserve',
    };
  }

  // If AI agrees with either Tier 1 or the existing DB state, we have a consensus
  if (aiCtc === existingDbCtc) {
    return { acceptedCtc: existingDbCtc, action: 'preserve' };
  }
  if (aiCtc === tier1Ctc && aiCtc !== null) {
    return { acceptedCtc: aiCtc, action: 'update' };
  }

  // If AI introduces a 3rd distinct number that contradicts both -> do NOT auto-overwrite
  return {
    acceptedCtc: existingDbCtc,
    action: 'flag_for_review',
  };
}
