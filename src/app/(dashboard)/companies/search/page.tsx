import { redirect } from 'next/navigation';

export default async function CompaniesSearchRedirectPage(props: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const searchParams = props.searchParams ? await props.searchParams : {};
  const driveId = typeof searchParams.drive === 'string' ? searchParams.drive : undefined;
  const q = typeof searchParams.q === 'string' ? searchParams.q : undefined;

  if (driveId) {
    redirect(`/companies/${driveId}`);
  }

  if (q) {
    redirect(`/companies?search=${encodeURIComponent(q)}`);
  }

  redirect('/companies');
}
