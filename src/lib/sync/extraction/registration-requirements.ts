import { getEvidenceMessageText, htmlToCanonicalText } from './body';

export interface RegistrationLink { url: string; label: string }
export interface RegistrationRequirements {
  companyFormRequired: true;
  companyLinks: RegistrationLink[];
  sourceQuote: string;
}
interface RegistrationEmail { subject?: string; bodyPlain?: string; bodyHtml?: string; bodySnippet?: string }

function safeLink(raw: string): string | null {
  try {
    const url = new URL(raw.replace(/&amp;/gi, '&').replace(/&#(?:0*38|x0*26);/gi, '&'));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

/** Only explicit instructions to register in both places create a reminder. */
export function extractRegistrationRequirements(email: RegistrationEmail): RegistrationRequirements | null {
  const body = getEvidenceMessageText({ subject: email.subject || '', bodyPlain: email.bodyPlain || '', bodyHtml: email.bodyHtml || '', bodySnippet: email.bodySnippet || '' });
  const text = body.replace(/[*_`>#]/g, '').replace(/\s+/g, ' ').trim();
  const neopat = '\\bneo\\s*pat\\b(?:\\s+portal)?';
  const company = "(?:company(?:['’]s)?\\s+(?:(?:registration|application)\\s+)?(?:link|portal|website|form)|(?:google|microsoft|external)\\s+(?:form|link|portal))";
  const both = new RegExp(`(?:${neopat}[^.!?]{0,60}?(?:&|\\band\\b|\\balso\\b|as well as)[^.!?]{0,50}?${company}|${company}[^.!?]{0,60}?(?:&|\\band\\b|\\balso\\b|along with)[^.!?]{0,50}?${neopat})`, 'i');
  const match = text.match(both);
  if (!match || match.index === undefined) return null;
  const before = text.slice(Math.max(0, match.index - 180), match.index);
  const after = text.slice(match.index + match[0].length, match.index + match[0].length + 100);
  const instruction = `${before} ${match[0]} ${after}`;
  if (!/\b(?:register|registration|apply|fill|submit|complete)\b/i.test(instruction)) return null;
  if (/\b(?:do not|need not|don't|not required|not necessary|optional)\b|\b(?:should|must)\s+not\s+(?:register|apply|submit)\b/i.test(instruction)) return null;

  // Prefer actual registration/form links; never treat a company homepage or
  // an unrelated privacy/social link as proof of a second registration.
  const candidates: Array<RegistrationLink & { score: number }> = [];
  const add = (raw: string, label: string, context: string) => {
    const url = safeLink(raw);
    if (!url || /privacy|unsubscribe|feedback|linkedin|facebook|instagram/i.test(`${label} ${url}`) || /\bwebsite\s*[:\-]?\s*$/i.test(context)) return;
    const target = new URL(url);
    if (/neopat/i.test(target.hostname)) return;
    let score = /\b(?:register|registration|apply|application|fill\s+out|form)\b/i.test(label) ? 20 : 0;
    if (/^(?:forms\.gle|forms\.office\.com|forms\.cloud\.microsoft)$/i.test(target.hostname) || target.hostname === 'docs.google.com' && /^\/forms\//.test(target.pathname)) score += 30;
    if (/company(?:['’]s)?\s+(?:registration\s+)?link|registration\s+link|apply\s+(?:here|at)/i.test(context)) score += 15;
    if (score) candidates.push({ url, label: label.trim() || 'Company registration form', score });
  };
  const html = /^\s*re\s*:/i.test(email.subject || '')
    ? (email.bodyHtml || '').replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, '')
      .replace(/<div\b[^>]*class=["'][^"']*(?:gmail_quote|gmail_extra|yahoo_quoted)[^"']*["'][^>]*>[\s\S]*$/gi, '')
    : email.bodyHtml || '';
  for (const anchor of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = htmlToCanonicalText(anchor[2]);
    if (label && text.includes(label)) add(anchor[1], label, label);
  }
  // The link can appear below the instruction, as in the Philips circular.
  const registrationSection = text.slice(Math.max(0, match.index - 100), match.index + match[0].length + 1500)
    .split(/\b(?:mandatory note|warm regards|best regards|disclaimer)\b/i)[0];
  for (const url of registrationSection.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const context = registrationSection.slice(Math.max(0, (url.index || 0) - 120), url.index);
    add(url[0].replace(/[),.;]+$/, ''), '', context);
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return { companyFormRequired: true, companyLinks: best ? [{ url: best.url, label: best.label }] : [], sourceQuote: instruction.trim().slice(0, 500) };
}

/** JSON metadata is revalidated before rendering external links. */
export function readRegistrationRequirements(value: unknown): RegistrationRequirements | null {
  if (!value || typeof value !== 'object' || !('companyFormRequired' in value) || value.companyFormRequired !== true) return null;
  const record = value as Record<string, unknown>;
  const links: RegistrationLink[] = [];
  for (const candidate of Array.isArray(record.companyLinks) ? record.companyLinks : []) {
    if (!candidate || typeof candidate !== 'object' || typeof candidate.url !== 'string') continue;
    const url = safeLink(candidate.url);
    if (url) links.push({ url, label: typeof candidate.label === 'string' ? candidate.label : 'Company registration form' });
  }
  return { companyFormRequired: true, companyLinks: links.slice(0, 3), sourceQuote: typeof record.sourceQuote === 'string' ? record.sourceQuote : '' };
}

export function withRegistrationRequirements<T extends object>(details: T, email: RegistrationEmail): T & { registrationRequirements?: RegistrationRequirements } {
  const requirements = extractRegistrationRequirements(email);
  return requirements ? { ...details, registrationRequirements: requirements } : details;
}

export function shouldShowCompanyRegistrationReminder(status: string, deadline?: string | null, now = new Date()): boolean {
  if (/^(?:withdrawn|declined|selected|offer|offer_received|rejected.*|not_shortlisted.*)$/.test(status)) return false;
  const cutoff = deadline ? Date.parse(deadline) : NaN;
  if (Number.isFinite(cutoff)) return cutoff > now.getTime();
  return ['', 'unknown', 'not_applied', 'registration_open', 'applied'].includes(status);
}
