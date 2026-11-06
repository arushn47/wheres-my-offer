import type { ParsedEmail } from '@/lib/gmail/client';
import { extractEvents, type ExtractedEvent } from './events';
import { getEvidenceMessageText } from './body';
import { extractCompanyAliases, isFuzzyCompanyMatch } from '../classification/classifier';

const GENERIC_EXCLUSIONS = new Set([
  'research', 'analytics', 'technology', 'technologies', 'limited',
  'private', 'india', 'group', 'services', 'solutions', 'systems', 'consulting'
]);

const KNOWN_SHORT_BRANDS = new Set(['ey', 'hp', 'ge', 'bp', 'gs', 'ti', 'de', 'ltm', 'lmt', 'tcs', 'sap', 'ibm', 'pwc', 'ubs', 'dbs']);

function getCompanyTokens(name: string): string[] {
  if (!name) return [];
  const aliases = extractCompanyAliases(name, name);
  const words = [name, ...aliases].flatMap((alias) =>
    alias.toLowerCase().split(/[^a-z0-9]+/)
  );
  return Array.from(new Set(words)).filter(
    (token) => (token.length >= 3 || KNOWN_SHORT_BRANDS.has(token)) && !GENERIC_EXCLUSIONS.has(token)
  );
}

function mentionsCompany(text: string, name: string): boolean {
  const tokens = getCompanyTokens(name);
  return tokens.some((token) => new RegExp(`\\b${token}\\b`, 'i').test(text));
}

/** A named event clause belongs to its company, even in a multi-company subject. */
export function extractScopedEvents(email: ParsedEmail, companyName: string, otherCompanyNames: string[] = []): ExtractedEvent[] {
  const body = getEvidenceMessageText(email);
  const paragraphs = body.split(/\n\s*\n/).map((text) => text.replace(/\s+/g, ' '));
  const others = otherCompanyNames.filter((other) => other && !isFuzzyCompanyMatch(companyName, other));

  return extractEvents(email).filter((event) => {
    const cue = event.eventType === 'ppt' ? /\bppt\b|pre[\s-]*placement\s+talk/i : /interview/.test(event.eventType) ? /\binterview\b/i : /test/.test(event.eventType) ? /\btest\b|assessment/i : null;
    if (!cue) return true;
    const clauses = paragraphs.filter((paragraph) => cue.test(paragraph));
    return !clauses.length || clauses.some((clause) => mentionsCompany(clause, companyName) || !others.some((name) => mentionsCompany(clause, name)));
  });
}

