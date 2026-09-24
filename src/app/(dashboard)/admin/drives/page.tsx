import { requireAdmin } from '@/lib/auth/admin';
import { redirect } from 'next/navigation';
import DrivesClient from './drives-client';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Placement Drives & Email Pipeline | Admin',
};

export default async function AdminDrivesPage() {
  try {
    await requireAdmin();
  } catch {
    redirect('/');
  }

  return <DrivesClient />;
}
