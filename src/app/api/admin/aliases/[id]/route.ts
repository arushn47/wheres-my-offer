import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeDriveNumber } from '@/lib/drive-number';
import { normalizeCompanyName } from '@/lib/sync/classifier';

export const dynamic = 'force-dynamic';

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin();
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Unauthorized' },
      { status: err.status || 401 }
    );
  }

  const { id } = await params;
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

    if (!resolvedCompanyName) {
      return NextResponse.json(
        { error: 'Resolved company name is required' },
        { status: 400 }
      );
    }

    const normDriveNumber = driveNumber ? normalizeDriveNumber(driveNumber) : null;
    const baseName = companyBaseName
      ? companyBaseName.toLowerCase().trim()
      : normalizeCompanyName(resolvedCompanyName);

    const updatePayload: Record<string, any> = {
      resolved_company_name: resolvedCompanyName.trim(),
      company_base_name: baseName,
      resolved_role: (resolvedRole || 'Default Role').trim(),
      resolved_via: 'manual_review',
      confidence: 'high',
      notes: notes ? notes.trim() : null,
      updated_at: new Date().toISOString(),
    };

    if (normDriveNumber) {
      updatePayload.drive_number = normDriveNumber;
    }

    const { data: updated, error: updateError } = await supabase
      .from('drive_resolutions')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      console.error('[Admin Alias PUT API] Update error:', updateError);
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    // Also update existing placement_drives matching this drive number
    if (normDriveNumber) {
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
      message: `Rule for "${resolvedCompanyName}" updated successfully.`,
      rule: updated,
    });
  } catch (err: any) {
    console.error('[Admin Alias PUT API] Error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin();
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Unauthorized' },
      { status: err.status || 401 }
    );
  }

  const { id } = await params;
  const supabase = createAdminClient();

  try {
    const { error } = await supabase
      .from('drive_resolutions')
      .delete()
      .eq('id', id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: 'Drive rule deleted successfully' });
  } catch (err: any) {
    console.error('[Admin Alias DELETE API] Error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
