import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeDriveNumber } from '@/lib/drive-number';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireAdmin();
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Unauthorized' },
      { status: err.status || 401 }
    );
  }

  const supabase = createAdminClient();

  try {
    // 1. Fetch all placement_drives across all users
    const [drivesRes, companiesRes, emailsRes, appsRes] = await Promise.all([
      supabase
        .from('placement_drives')
        .select('id, user_id, company_id, drive_number, normalized_drive_number, drive_name, role, category, ctc, stipend, location, updated_at')
        .order('updated_at', { ascending: false }),
      supabase
        .from('companies')
        .select('id, user_id, name, aliases'),
      supabase
        .from('emails')
        .select('id, placement_drive_id, received_at, classification'),
      supabase
        .from('applications')
        .select('id, placement_drive_id, status'),
    ]);

    if (drivesRes.error) {
      console.error('[Admin Drives API] Error querying drives:', drivesRes.error);
      return NextResponse.json({ error: drivesRes.error.message }, { status: 500 });
    }

    const drives = drivesRes.data || [];
    const companies = companiesRes.data || [];
    const emails = emailsRes.data || [];
    const apps = appsRes.data || [];

    // Map companyId to Company Name and Aliases
    const companyMap = new Map<string, string>();
    const companyAliasesMap = new Map<string, string[]>();
    for (const c of companies) {
      companyMap.set(c.id, c.name);
      if (c.aliases && Array.isArray(c.aliases) && c.aliases.length > 0) {
        companyAliasesMap.set(c.id, c.aliases);
      }
    }

    // Map placementDriveId to emails count and latest email date
    const emailsPerDrive = new Map<string, { count: number; latestDate: string | null }>();
    for (const e of emails) {
      if (e.placement_drive_id) {
        const current = emailsPerDrive.get(e.placement_drive_id) || { count: 0, latestDate: null };
        const newLatest = !current.latestDate || (e.received_at && e.received_at > current.latestDate)
          ? e.received_at
          : current.latestDate;
        emailsPerDrive.set(e.placement_drive_id, {
          count: current.count + 1,
          latestDate: newLatest,
        });
      }
    }

    // Map placementDriveId to apps count
    const appsPerDrive = new Map<string, number>();
    for (const a of apps) {
      if (a.placement_drive_id) {
        appsPerDrive.set(a.placement_drive_id, (appsPerDrive.get(a.placement_drive_id) || 0) + 1);
      }
    }

    // Group drives by normalized_drive_number OR drive_name
    interface AggregatedDrive {
      driveKey: string;
      driveNumber: string | null;
      companyName: string;
      role: string | null;
      category: string | null;
      ctc: string | null;
      stipend: string | null;
      location: string | null;
      totalEmails: number;
      totalApplications: number;
      totalUsers: number;
      latestEmailAt: string | null;
      driveIds: string[];
      aliases: string[];
    }

    const groupMap = new Map<string, AggregatedDrive>();

    for (const d of drives) {
      const normNumber = normalizeDriveNumber(d.drive_number || d.normalized_drive_number);
      const companyName = (d.company_id ? companyMap.get(d.company_id) : null) || d.drive_name || 'Unknown Drive';
      const key = normNumber ? `drive:${normNumber}` : `name:${companyName.toLowerCase().trim()}`;

      const emailStats = emailsPerDrive.get(d.id) || { count: 0, latestDate: null };
      const appCount = appsPerDrive.get(d.id) || 0;

      const existing = groupMap.get(key);
      const companyAliases = d.company_id ? companyAliasesMap.get(d.company_id) || [] : [];
      if (existing) {
        existing.totalEmails += emailStats.count;
        existing.totalApplications += appCount;
        existing.totalUsers += 1;
        existing.driveIds.push(d.id);
        if (!existing.role && d.role) existing.role = d.role;
        if (!existing.ctc && d.ctc) existing.ctc = d.ctc;
        if (!existing.stipend && d.stipend) existing.stipend = d.stipend;
        if (!existing.category && d.category) existing.category = d.category;
        if (!existing.location && d.location) existing.location = d.location;
        for (const al of companyAliases) {
          if (!existing.aliases.includes(al)) {
            existing.aliases.push(al);
          }
        }
        if (!existing.latestEmailAt || (emailStats.latestDate && emailStats.latestDate > existing.latestEmailAt)) {
          existing.latestEmailAt = emailStats.latestDate;
        }
      } else {
        groupMap.set(key, {
          driveKey: key,
          driveNumber: normNumber || d.drive_number || null,
          companyName,
          role: d.role,
          category: d.category,
          ctc: d.ctc,
          stipend: d.stipend,
          location: d.location,
          totalEmails: emailStats.count,
          totalApplications: appCount,
          totalUsers: 1,
          latestEmailAt: emailStats.latestDate,
          driveIds: [d.id],
          aliases: [...companyAliases],
        });
      }
    }

    const aggregated = Array.from(groupMap.values()).sort((a, b) => {
      // Sort drives with numbers descending first, then by latest email
      const numA = a.driveNumber ? parseInt(a.driveNumber, 10) : -1;
      const numB = b.driveNumber ? parseInt(b.driveNumber, 10) : -1;
      if (!isNaN(numA) && !isNaN(numB) && numA !== numB) {
        return numB - numA;
      }
      const dateA = a.latestEmailAt ? new Date(a.latestEmailAt).getTime() : 0;
      const dateB = b.latestEmailAt ? new Date(b.latestEmailAt).getTime() : 0;
      return dateB - dateA;
    });

    return NextResponse.json({ drives: aggregated }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('[Admin Drives API] Unexpected error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
