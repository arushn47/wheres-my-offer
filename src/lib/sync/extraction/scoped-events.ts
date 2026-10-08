import type { ParsedEmail } from '@/lib/gmail/client';
import { extractEvents, type ExtractedEvent } from './events';
import { getEvidenceMessageText } from './body';

/** A named event clause belongs to its company, even in a multi-company subject. */
export function extractScopedEvents(email: ParsedEmail, companyName: string, otherCompanyNames: string[] = []): ExtractedEvent[] {
  const body = getEvidenceMessageText(email);
  const paragraphs = body.split(/\n\s*\n/).map((text) => text.replace(/\s+/g, ' '));
  const tokens = (name: string) => name.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !['research','analytics','technology','technologies','limited','private','india','group','services'].includes(token));
  const mentions = (text: string, name: string) => tokens(name).some((token) => new RegExp(`\\b${token}\\b`, 'i').test(text));
  const subjectNames = (email.subject || '').split(/\band\b|&|,/i).map((part) => part.trim());
  const others = [...otherCompanyNames, ...subjectNames].filter((name) => !mentions(name, companyName));
  return extractEvents(email).filter((event) => {
    const cue = event.eventType === 'ppt' ? /\bppt\b|pre[\s-]*placement\s+talk/i : /interview/.test(event.eventType) ? /\binterview\b/i : /test/.test(event.eventType) ? /\btest\b|assessment/i : null;
    if (!cue) return true;
    const clauses = paragraphs.filter((paragraph) => cue.test(paragraph));
    return !clauses.length || clauses.some((clause) => mentions(clause, companyName) || !others.some((name) => mentions(clause, name)));
  });
}
