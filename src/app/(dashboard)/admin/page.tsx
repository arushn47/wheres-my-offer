import { requireAdmin } from '@/lib/auth/admin';
import { redirect } from 'next/navigation';
import DashboardClient from './dashboard-client';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Admin Dashboard | Where\'s My Offer?',
};

export default async function AdminPage() {
  try {
    await requireAdmin();
  } catch {
    redirect('/');
  }

  return <DashboardClient />;
}
