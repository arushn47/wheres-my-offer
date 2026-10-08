import type { Metadata } from 'next';
import TermsClient from './_components/terms-client';

export const metadata: Metadata = {
  title: "Terms of Service — Where's My Offer?",
  description:
    "Read the Terms of Service for Where's My Offer?, the automated campus placement intelligence platform for VIT students.",
  alternates: {
    canonical: '/terms',
  },
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return <TermsClient />;
}
