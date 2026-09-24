import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { checkIsAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import SettingsClient from './settings-client';
import { detectCampus, detectBranch, detectRegNo } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'Settings & Preferences',
  description: "Manage connected Gmail accounts, Neo ID matching rules, and notification preferences in Where's My Offer?.",
};

export default async function SettingsPage() {
  const session = await requireSession();

  if (await checkIsAdmin(session.userId, session.email)) {
    redirect('/admin');
  }

  const supabase = createAdminClient();

  const [{ data: accounts }, { data: user }] = await Promise.all([
    supabase
      .from('gmail_accounts')
      .select('id, email, account_type, is_connected, last_sync_at')
      .eq('user_id', session.userId),
    supabase
      .from('users')
      .select('neo_id')
      .eq('id', session.userId)
      .single(),
  ]);

  const collegeAccount = (accounts || []).find((a) => a.account_type === 'college');
  const autoCampus = detectCampus(collegeAccount?.email);
  const detectedBranch = detectBranch(collegeAccount?.email) || (user?.neo_id ? detectBranch(user.neo_id) : null);
  const detectedRegNo = detectRegNo(collegeAccount?.email) || user?.neo_id || null;

  return (
    <SettingsClient
      accounts={accounts || []}
      neoId={user?.neo_id || ''}
      userEmail={session.email}
      autoCampus={autoCampus}
      detectedBranch={detectedBranch}
      detectedRegNo={detectedRegNo}
    />
  );
}
