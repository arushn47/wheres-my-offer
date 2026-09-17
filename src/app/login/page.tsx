import type { Metadata } from 'next';
import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import LoginClient from './login-client';

export const metadata: Metadata = {
  title: "Login — Where's My Offer? | NeoPAT Tracker & Campus Placement Radar",
  description:
    'Real-time NeoPAT tracker and campus placement radar. Track every placement drive, shortlist, OA test, and interview from one unified dashboard. Connect your Gmail and let the radar do the rest.',
  alternates: {
    canonical: '/login',
  },
  openGraph: {
    title: "Where's My Offer? — NeoPAT Tracker & Campus Placement Radar",
    description:
      'Real-time NeoPAT tracker and campus placement radar. Track every placement drive, shortlist, OA test, and interview from one dashboard.',
    url: '/login',
  },
};

export default async function LoginPage() {
  // If already logged in, redirect to dashboard
  const session = await getSession();
  if (session) {
    redirect('/');
  }

  return <LoginClient />;
}
