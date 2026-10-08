import type { Metadata } from 'next';
import PrivacyClient from './_components/privacy-client';

export const metadata: Metadata = {
  title: "Privacy Policy — Where's My Offer?",
  description:
    "Learn how Where's My Offer? protects your data, handles Gmail read-only scopes, and complies with Google's API Services User Data Policy.",
  alternates: {
    canonical: '/privacy',
  },
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return <PrivacyClient />;
}
