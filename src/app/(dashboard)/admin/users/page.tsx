import { requireAdmin } from '@/lib/auth/admin';
import { redirect } from 'next/navigation';
import UsersClient from './users-client';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Registered Users & Accounts | Admin',
};

export default async function AdminUsersPage() {
  try {
    await requireAdmin();
  } catch {
    redirect('/');
  }

  return <UsersClient />;
}
