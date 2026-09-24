import { requireAdmin } from '@/lib/auth/admin';
import { redirect } from 'next/navigation';
import SystemClient from './system-client';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'System & Deduplication | Admin',
};

export default async function AdminSystemPage() {
  try {
    await requireAdmin();
  } catch {
    redirect('/');
  }

  return <SystemClient />;
}
