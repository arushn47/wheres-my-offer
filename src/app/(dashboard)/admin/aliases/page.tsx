import { requireAdmin } from '@/lib/auth/admin';
import { redirect } from 'next/navigation';
import AliasesClient from './aliases-client';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Aliases & Resolution Rules | Admin',
};

export default async function AdminAliasesPage() {
  try {
    await requireAdmin();
  } catch {
    redirect('/');
  }

  return <AliasesClient />;
}
