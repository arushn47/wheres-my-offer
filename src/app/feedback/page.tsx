import type { Metadata } from 'next';
import { getSession } from '@/lib/auth';
import FeedbackClient from './_components/feedback-client';

export const metadata: Metadata = {
  title: "Feedback & Support — Where's My Offer?",
  description:
    "Submit bug reports, feature requests, or suggestions to improve Where's My Offer? campus placement tracker.",
};

export default async function FeedbackPage() {
  const session = await getSession();
  return <FeedbackClient session={session} />;
}
