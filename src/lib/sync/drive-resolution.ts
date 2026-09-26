import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeDriveNumber } from '@/lib/drive-number';
import { checkAcronymMatch } from '@/lib/sync/classifier';

export { normalizeDriveNumber };

export type DriveAssignmentState =
  | 'assigned'
  | 'ambiguous'
  | 'unassigned'
  | 'legacy'
  | 'conflict'
  | 'manually_assigned';

export type DriveIdentityConfidence = 'high' | 'medium' | 'low';

export type DriveIdentitySource =
  | 'explicit_drive_number'
  | 'existing_drive_match'
  | 'company_only'
  | 'legacy';

export interface DriveResolution {
  placementDriveId: string | null;
  state: DriveAssignmentState;
  confidence: DriveIdentityConfidence;
  source: DriveIdentitySource;
  normalizedDriveNumber: string | null;
}

async function enrichExistingDriveIfSparse(
  supabase: ReturnType<typeof createAdminClient>,
  existingDrive: {
    id: string;
    role?: string | null;
    category?: string | null;
    ctc?: string | null;
    stipend?: string | null;
    location?: string | null;
    eligibility?: string | null;
    branches?: string[] | null;
    cgpa_requirement?: string | null;
    backlog_requirement?: string | null;
    registration_deadline?: string | null;
  },
  params: {
    role?: string | null;
    category?: string | null;
    ctc?: string | null;
    stipend?: string | null;
    location?: string | null;
    eligibility?: string | null;
    branches?: string[] | null;
    cgpaRequirement?: string | null;
    backlogRequirement?: string | null;
    registrationDeadline?: string | null;
  }
) {
  const updates: Record<string, any> = {};
  if (!existingDrive.role && params.role?.trim()) updates.role = params.role.trim();
  if (!existingDrive.category && params.category?.trim()) updates.category = params.category.trim();
  if (!existingDrive.ctc && params.ctc?.trim()) updates.ctc = params.ctc.trim();
  if (!existingDrive.stipend && params.stipend?.trim()) updates.stipend = params.stipend.trim();
  if (!existingDrive.location && params.location?.trim()) updates.location = params.location.trim();
  if (!existingDrive.eligibility && params.eligibility?.trim()) updates.eligibility = params.eligibility.trim();
  if ((!existingDrive.branches || existingDrive.branches.length === 0) && params.branches && params.branches.length > 0) updates.branches = params.branches;
  if (!existingDrive.cgpa_requirement && params.cgpaRequirement?.trim()) updates.cgpa_requirement = params.cgpaRequirement.trim();
  if (!existingDrive.backlog_requirement && params.backlogRequirement?.trim()) updates.backlog_requirement = params.backlogRequirement.trim();
  if (!existingDrive.registration_deadline && params.registrationDeadline) updates.registration_deadline = params.registrationDeadline;

  if (Object.keys(updates).length > 0) {
    updates.updated_at = new Date().toISOString();
    await supabase.from('placement_drives').update(updates).eq('id', existingDrive.id);
  }
}

/**
 * Resolves a drive for one organization without allowing company-name fallback
 * to replace an explicit drive number. Persistence is deliberately separate so
 * callers can reason about identity before mutating related records.
 */
export async function resolvePlacementDrive(params: {
  supabase: ReturnType<typeof createAdminClient>;
  userId: string;
  companyId: string | null;
  driveNumber?: string | null;
  driveNumbers?: string[];
  driveName?: string | null;
  role?: string | null;
  category?: string | null;
  ctc?: string | null;
  stipend?: string | null;
  location?: string | null;
  registrationDeadline?: string | null;
  eligibility?: string | null;
  branches?: string[] | null;
  cgpaRequirement?: string | null;
  backlogRequirement?: string | null;
}): Promise<DriveResolution> {
  const distinctDriveNumbers = Array.from(new Set(
    (params.driveNumbers || []).map((value) => normalizeDriveNumber(value)).filter(Boolean)
  )) as string[];
  const normalizedDriveNumber = normalizeDriveNumber(params.driveNumber);

  if (distinctDriveNumbers.length > 1) {
    return {
      placementDriveId: null,
      state: 'conflict',
      confidence: 'high',
      source: 'explicit_drive_number',
      normalizedDriveNumber: null,
    };
  }

  if (!params.companyId) {
    return {
      placementDriveId: null,
      state: 'unassigned',
      confidence: 'low',
      source: normalizedDriveNumber ? 'explicit_drive_number' : 'company_only',
      normalizedDriveNumber,
    };
  }

  if (normalizedDriveNumber) {
    // 1. Check if the drive already exists globally by normalized_drive_number
    const { data: existing } = await params.supabase
      .from('placement_drives')
      .select('id, company_id, role, category, ctc, stipend, location, eligibility, branches, cgpa_requirement, backlog_requirement, registration_deadline')
      .eq('normalized_drive_number', normalizedDriveNumber)
      .maybeSingle();

    if (existing?.id) {
      if (existing.company_id === params.companyId) {
        await enrichExistingDriveIfSparse(params.supabase, existing, params);
      }
      return {
        placementDriveId: existing.company_id === params.companyId ? existing.id : null,
        state: existing.company_id === params.companyId ? 'assigned' : 'conflict',
        confidence: 'high',
        source: 'existing_drive_match',
        normalizedDriveNumber,
      };
    }

    // 2. Concurrency-safe insert:
    // NOTE: This catch-then-SELECT pattern works because these are isolated Supabase JS client calls
    // (each call auto-committing its own transaction). If this logic is ever wrapped in a single
    // PostgreSQL transaction / RPC, a caught 23505 without a SAVEPOINT will poison the transaction!
    const { data: created, error } = await params.supabase
      .from('placement_drives')
      .insert({
        company_id: params.companyId,
        drive_number: params.driveNumber?.trim() || normalizedDriveNumber,
        normalized_drive_number: normalizedDriveNumber,
        drive_name: params.driveName?.trim() || null,
        role: params.role?.trim() || null,
        category: params.category?.trim() || null,
        ctc: params.ctc?.trim() || null,
        stipend: params.stipend?.trim() || null,
        location: params.location?.trim() || null,
        registration_deadline: params.registrationDeadline || null,
        eligibility: params.eligibility?.trim() || null,
        branches: params.branches && params.branches.length > 0 ? params.branches : null,
        cgpa_requirement: params.cgpaRequirement?.trim() || null,
        backlog_requirement: params.backlogRequirement?.trim() || null,
        identity_state: 'assigned',
        identity_confidence: 'high',
        identity_source: 'explicit_drive_number',
      })
      .select('id, company_id')
      .maybeSingle();

    if (created?.id) {
      return {
        placementDriveId: created.id,
        state: 'assigned',
        confidence: 'high',
        source: 'explicit_drive_number',
        normalizedDriveNumber,
      };
    }

    // A concurrent sync run may have won the unique normalized-drive index race (Postgres error 23505).
    if (error?.code === '23505') {
      const { data: concurrent } = await params.supabase
        .from('placement_drives')
        .select('id, company_id')
        .eq('normalized_drive_number', normalizedDriveNumber)
        .maybeSingle();

      if (concurrent?.id) {
        return {
          placementDriveId: concurrent.company_id === params.companyId ? concurrent.id : null,
          state: concurrent.company_id === params.companyId ? 'assigned' : 'conflict',
          confidence: 'high',
          source: 'existing_drive_match',
          normalizedDriveNumber,
        };
      }
    }

    return {
      placementDriveId: null,
      state: 'conflict',
      confidence: 'high',
      source: 'explicit_drive_number',
      normalizedDriveNumber,
    };
  }

  const { data: companyDrives } = await params.supabase
    .from('placement_drives')
    .select('id, company_id, drive_name, role, category, ctc, stipend, location, eligibility, branches, cgpa_requirement, backlog_requirement, registration_deadline, created_at')
    .eq('company_id', params.companyId)
    .in('identity_state', ['assigned', 'manually_assigned'])
    .order('created_at', { ascending: false });

  // 1. If exactly one drive exists for this company, resolve directly to it
  if (companyDrives && companyDrives.length === 1) {
    await enrichExistingDriveIfSparse(params.supabase, companyDrives[0], params);
    return {
      placementDriveId: companyDrives[0].id,
      state: 'assigned',
      confidence: 'high',
      source: 'company_only',
      normalizedDriveNumber: null,
    };
  }

  // 2. If multiple drives exist, attempt matching by driveName
  if (companyDrives && companyDrives.length > 1 && params.driveName) {
    const cleanParamName = params.driveName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cleanParamName.length >= 2) {
      const matched = companyDrives.find((d) => {
        if (!d.drive_name) return false;
        const cleanDbName = d.drive_name.toLowerCase().replace(/[^a-z0-9]/g, '');
        return (
          cleanDbName.includes(cleanParamName) ||
          cleanParamName.includes(cleanDbName) ||
          checkAcronymMatch(cleanParamName, cleanDbName) ||
          checkAcronymMatch(cleanDbName, cleanParamName)
        );
      });
      if (matched) {
        await enrichExistingDriveIfSparse(params.supabase, matched, params);
        return {
          placementDriveId: matched.id,
          state: 'assigned',
          confidence: 'high',
          source: 'existing_drive_match',
          normalizedDriveNumber: null,
        };
      }
    }
  }

  return {
    placementDriveId: null,
    state: companyDrives && companyDrives.length > 1 ? 'ambiguous' : 'unassigned',
    confidence: 'low',
    source: 'company_only',
    normalizedDriveNumber: null,
  };
}
