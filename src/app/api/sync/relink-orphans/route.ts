import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { extractCompanyName } from '@/lib/sync/classifier';
import { isFuzzyCompanyMatch } from '@/lib/sync/engine';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/sync/relink-orphans
 * Re-evaluates email-to-company assignments across all stored emails
 * to fix orphaned emails and emails misassigned by loose alias matching.
 */
export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();
  const userId = session.userId;

  // 1. Fetch all companies and placement drives globally
  const [{ data: companies }, { data: drives }] = await Promise.all([
    supabase
      .from('companies')
      .select('id, name, aliases'),
    supabase
      .from('placement_drives')
      .select('id, company_id, drive_number'),
  ]);

  if (!companies || companies.length === 0) {
    return NextResponse.json({ message: 'No companies found', linked: 0 });
  }

  const drivesByCompanyId = new Map<string, Array<{ id: string; company_id: string; drive_number: string | null }>>();
  for (const d of drives || []) {
    const list = drivesByCompanyId.get(d.company_id) || [];
    list.push(d);
    drivesByCompanyId.set(d.company_id, list);
  }

  // 2. Fetch all emails for this user
  const { data: allEmails, error } = await supabase
    .from('personal_emails')
    .select('id, subject, sender, placement_drive_id, assignment_source')
    .eq('user_id', userId);

  if (error || !allEmails || allEmails.length === 0) {
    return NextResponse.json({ message: 'No emails found', linked: 0 });
  }

  let linked = 0;
  const details: { subject: string; company: string }[] = [];

  for (const email of allEmails) {
    // This endpoint is an automated repair pass, not an admin override. Respect explicit
    // admin unlink decisions; only the admin link endpoint may restore these emails.
    if (email.assignment_source === 'admin_unlinked') continue;

    const extractedName = extractCompanyName(email.subject || '', email.sender || '');
    if (!extractedName) continue;

    // Find the matching company using exact or word-boundary alias matching
    let matchedCompanyId: string | null = null;
    let matchedCompanyName = '';

    const extLower = extractedName.toLowerCase().trim();

    for (const company of companies) {
      const compNameLower = company.name.toLowerCase().trim();

      // Exact or collapsed alphanumeric match (e.g. "Value Labs" === "Valuelabs", "Squad Stack" === "SquadStack")
      const compAlpha = compNameLower.replace(/[^a-z0-9]/g, '');
      const extAlpha = extLower.replace(/[^a-z0-9]/g, '');

      if (compNameLower === extLower || (compAlpha.length >= 3 && extAlpha.length >= 3 && compAlpha === extAlpha)) {
        matchedCompanyId = company.id;
        matchedCompanyName = company.name;
        break;
      }

      // Fuzzy match engine check
      if (isFuzzyCompanyMatch(company.name, extractedName)) {
        matchedCompanyId = company.id;
        matchedCompanyName = company.name;
        break;
      }

      // Dynamic substring match for multi-word company names (length >= 4)
      if (
        compNameLower.length >= 4 &&
        extLower.length >= 4 &&
        (compNameLower.includes(extLower) || extLower.includes(compNameLower))
      ) {
        matchedCompanyId = company.id;
        matchedCompanyName = company.name;
        break;
      }

      // Check aliases with word boundary and alphanumeric match
      const aliases: string[] = company.aliases || [];
      for (const alias of aliases) {
        const aliasLower = alias.toLowerCase().trim();
        const aliasAlpha = aliasLower.replace(/[^a-z0-9]/g, '');
        if (aliasAlpha.length >= 3 && extAlpha.length >= 3 && aliasAlpha === extAlpha) {
          matchedCompanyId = company.id;
          matchedCompanyName = company.name;
          break;
        }
        if (aliasLower.length >= 2) {
          const escaped = aliasLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i');
          if (regex.test(extLower)) {
            matchedCompanyId = company.id;
            matchedCompanyName = company.name;
            break;
          }
        }
      }
      if (matchedCompanyId) break;
    }

    if (matchedCompanyId) {
      const companyDrives = drivesByCompanyId.get(matchedCompanyId) || [];
      const targetDrive = companyDrives[0];

      if (targetDrive && targetDrive.id !== email.placement_drive_id) {
        await supabase
          .from('personal_emails')
          .update({
            placement_drive_id: targetDrive.id,
            assignment_state: 'assigned',
            assignment_source: 'relink_orphans',
          })
          .eq('id', email.id);

        await supabase
          .from('email_drive_links')
          .upsert(
            {
              user_id: userId,
              email_id: email.id,
              placement_drive_id: targetDrive.id,
              assignment_source: 'relink_orphans',
              confidence: 'medium',
            },
            { onConflict: 'email_id,placement_drive_id,link_type' }
          );

        linked++;
        details.push({ subject: email.subject || '', company: matchedCompanyName });
      }
    }
  }

  return NextResponse.json({
    success: true,
    totalEmails: allEmails.length,
    relinked: linked,
    details: details.slice(0, 20),
  });
}

