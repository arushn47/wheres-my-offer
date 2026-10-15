import { extractJobDetails } from '@/lib/sync/extraction/events';

/** Repair only explicit document pointers and degree tiers from this drive's own circular. */
export function getJobDisplayOverrides(body: string): { ctc?: string; stipend?: string; location?: string } {
  return getParsedJobDisplayOverrides(extractJobDetails(body));
}

export function getParsedJobDisplayOverrides(details: { ctc?: string | null; stipend?: string | null; location?: string | null }): { ctc?: string; stipend?: string; location?: string } {
  return {
    ...(details.ctc && (details.ctc === 'Check documents' || /^(?:UG|PG):/.test(details.ctc) || details.ctc.includes(' · ') && /^[A-Za-z][^:]+:/.test(details.ctc)) ? { ctc: details.ctc } : {}),
    ...(details.stipend && (/^(?:UG|PG):/.test(details.stipend) || details.stipend.includes(' · ') && /^[A-Za-z][^:]+:/.test(details.stipend)) ? { stipend: details.stipend } : {}),
    ...(details.location === 'Check documents' ? { location: details.location } : {}),
  };
}
