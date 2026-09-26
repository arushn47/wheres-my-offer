import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';

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
    const [canonicalTotalRes, canonicalCompleteRes, linkedEmailsRes, unlinkedCollegeRes, attachmentsRes] = await Promise.all([
      supabase
        .from('college_emails')
        .select('id', { count: 'exact', head: true }),
      supabase
        .from('college_emails')
        .select('id', { count: 'exact', head: true })
        .eq('processing_status', 'complete'),
      supabase
        .from('personal_emails')
        .select('id', { count: 'exact', head: true })
        .not('canonical_email_id', 'is', null),
      supabase
        .from('personal_emails')
        .select('id', { count: 'exact', head: true })
        .is('canonical_email_id', null)
        .ilike('sender', '%vitlions2027@vitbhopal.ac.in%'),
      supabase
        .from('college_attachments')
        .select('id', { count: 'exact', head: true }),
    ]);

    return NextResponse.json({
      stats: {
        totalCanonical: canonicalTotalRes.count ?? 0,
        completeCanonical: canonicalCompleteRes.count ?? 0,
        totalLinkedReceipts: linkedEmailsRes.count ?? 0,
        unlinkedCollegeReceipts: unlinkedCollegeRes.count ?? 0,
        totalCanonicalAttachments: attachmentsRes.count ?? 0,
      }
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('[Admin Canonical Stats API] Error:', err);
    return NextResponse.json({ error: err.message || 'Failed to fetch canonical stats' }, { status: 500 });
  }
}
