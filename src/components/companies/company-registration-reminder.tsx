import { ExternalLink } from 'lucide-react';
import { shouldShowCompanyRegistrationReminder, type RegistrationRequirements } from '@/lib/sync/extraction/registration-requirements';

export function CompanyRegistrationReminder({ requirements, status, deadline, embedded = false }: {
  requirements?: RegistrationRequirements | null;
  status: string;
  deadline?: string | null;
  embedded?: boolean;
}) {
  if (!shouldShowCompanyRegistrationReminder(status, deadline)) return null;
  if (!requirements && (!embedded || status !== 'registration_open')) return null;
  const companyLinks = requirements?.companyLinks || [];
  return (
    <aside aria-label={requirements ? 'Company registration reminder' : 'Registration links'} className={embedded ? 'mt-2 flex flex-wrap items-center gap-x-3 gap-y-2' : 'mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5'}>
      {!embedded && <p className="text-sm font-semibold text-amber-200">NeoPAT + company registration required</p>}
      {requirements && companyLinks.length === 0 && (
        <p className="basis-full text-xs leading-relaxed text-amber-300/90">Find the company form link in the registration email below.</p>
      )}
      <div className={embedded ? 'ml-auto flex flex-wrap justify-end gap-2' : 'mt-3 flex flex-wrap justify-end gap-2'}>
        {companyLinks.map((link, index) => (
          <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer" title={link.label}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/20">
            {companyLinks.length === 1 ? 'Open company form' : `Company form ${index + 1}`}<ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        ))}
        <a href="https://vit.neopat.ai/" target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:text-zinc-100">
          Open NeoPAT<ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      </div>
    </aside>
  );
}
