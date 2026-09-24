import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeDriveNumber } from '@/lib/drive-number';
import { normalizeCompanyName } from '@/lib/sync/classifier';

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
    const { data: resolutions, error } = await supabase
      .from('drive_resolutions')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      aliases: (resolutions || []).map((r) => ({
        id: r.id,
        driveNumber: r.drive_number,
        companyBaseName: r.company_base_name,
        resolvedCompanyName: r.resolved_company_name,
        resolvedRole: r.resolved_role,
        resolvedVia: r.resolved_via,
        confidence: r.confidence,
        notes: r.notes,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('[Admin Aliases API] Error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
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
    const body = await req.json();
    const {
      driveNumber,
      resolvedCompanyName,
      resolvedRole,
      companyBaseName,
      notes,
    } = body;

    if (!resolvedCompanyName || (!driveNumber && !companyBaseName)) {
      return NextResponse.json(
        { error: 'Company name and either Drive Number or Alias/Base Name are required' },
        { status: 400 }
      );
    }

    const normDriveNumber = driveNumber ? normalizeDriveNumber(driveNumber) : 'CUSTOM';
    const baseName = companyBaseName
      ? companyBaseName.toLowerCase().trim()
      : normalizeCompanyName(resolvedCompanyName);

    // Upsert into drive_resolutions
    const { data: inserted, error: upsertErr } = await supabase
      .from('drive_resolutions')
      .upsert(
        {
          drive_number: normDriveNumber,
          company_base_name: baseName,
          resolved_company_name: resolvedCompanyName.trim(),
          resolved_role: (resolvedRole || 'Default Role').trim(),
          resolved_via: 'manual_review',
          confidence: 'high',
          notes: notes ? notes.trim() : 'Manual rule configured from Admin Panel',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'drive_number' }
      )
      .select()
      .single();

    if (upsertErr) {
      console.error('[Admin Aliases API] Upsert error:', upsertErr);
      return NextResponse.json({ error: upsertErr.message }, { status: 500 });
    }

    // Also update existing placement_drives matching this drive number
    if (normDriveNumber && normDriveNumber !== 'CUSTOM') {
      await supabase
        .from('placement_drives')
        .update({
          drive_name: `${resolvedCompanyName.trim()} (Drive ${normDriveNumber})`,
          role: resolvedRole ? resolvedRole.trim() : undefined,
        })
        .or(`drive_number.eq.${normDriveNumber},normalized_drive_number.eq.${normDriveNumber}`);
    }

    return NextResponse.json({
      success: true,
      message: `Alias & Drive rule successfully saved for ${resolvedCompanyName}.`,
      rule: inserted,
    });
  } catch (err: any) {
    console.error('[Admin Aliases POST API] Error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
