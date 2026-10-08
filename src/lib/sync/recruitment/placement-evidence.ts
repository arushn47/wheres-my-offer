import type { CachedRosterInput } from '../attachments/shortlist-verification';

/** A scheduled PPT must explicitly include the audience; a process outline is not an invitation. */
export function isOpenPptInvitation(subject: string, body: string): boolean {
  if (!/\bppt\b|pre[\s-]*placement\s+talk/i.test(subject)) return false;
  const text = body.split(/warm\s+regards|best\s+regards/i)[0].replace(/\*/g, '').replace(/\s+/g, ' ');
  // Lists attached to a combined PPT/test schedule restrict the audience. "All
  // students must attend" in that same notice means all shortlisted students.
  const restricted = hasPublishedShortlistContext(subject, text);
  if (/not\s+shortlisted\s+(?:students|candidates).{0,35}(?:can|may)\s+also\s+attend\s+(?:the\s+)?ppt/i.test(text)) return true;
  if (restricted) return false;
  return /(?:all\s+(?:the\s+)?(?:applied|registered|eligible)?\s*(?:students|candidates)|(?:applied|registered)\s+(?:students|candidates)).{0,100}(?:attend|join).{0,40}(?:ppt|pre[\s-]*placement)/i.test(text) ||
    /(?:ppt|pre[\s-]*placement).{0,70}(?:open\s+to|for)\s+all\s+(?:the\s+)?(?:students|candidates)/i.test(text) ||
    /(?:attached|below)\s+(?:applied|registered)\s+(?:students|candidates)\s+list/i.test(text) && /(?:join|attend).{0,35}(?:ppt|pre[\s-]*placement)/i.test(text);
}

/** NeoPAT invitations and confirmations describe participation, never hiring outcomes. */
export function personalPlacementEvidence(subject: string, body: string): { outcome?: 'selected' | 'rejected'; invitation: boolean } {
  const text = `${subject}\n${body}`;
  if (/you're\s+eligible|you\s+are\s+eligible|placement\s+drive\s+invitation|registration\s+(?:confirmed|status\s+update)|confirmed:\s*your\s+registration|registration.*withdrawn/i.test(text)) return { invitation: false };
  if (/regret\s+to\s+inform|you\s+(?:have\s+)?(?:not\s+been|are\s+not)\s+(?:selected|shortlisted)|your\s+(?:candidature|application)\s+(?:has\s+been\s+)?reject/i.test(text)) return { outcome: 'rejected', invitation: false };
  if (/\boffer\s+letter\b|\byou\s+(?:have\s+been|are)\s+selected\s+(?:for\s+(?:the\s+)?(?:position|role|job|employment)|by\b)|\bwe\s+are\s+pleased\s+to\s+offer\s+you\b|\bcongratulations[!.\s]*(?:you\s+(?:have\s+been|are)\s+)?selected\s+for\s+(?:the\s+)?(?:position|role|job)/i.test(text)) return { outcome: 'selected', invitation: false };
  return { invitation: /test\s+link|password|passkey|assessment\s+link|you\s+(?:have\s+been|are)\s+shortlisted/i.test(text) };
}

export function hasPublishedShortlistContext(subject: string, body: string): boolean {
  // Registration/JD boilerplate says "there would be shortlisting"; no list exists yet.
  if (/registration|eligible\s+for|placement\s+drive\s+invitation/i.test(subject) && !/shortlist|selection\s*list/i.test(subject)) return false;
  return /shortlist|selection[\s_-]*list|selected\s+(?:students|candidates)|qualified\s+(?:students|candidates)|candidate\s+allocation/i.test(subject) ||
    /find\s+(?:the\s+)?(?:below|attached|enclosed)\s+(?:shortlist|shortlisted|selected)|below\s+(?:is\s+)?(?:the\s+)?shortlist|shortlist\s+(?:is\s+)?(?:attached|below|published|released)|list\s+of\s+(?:shortlisted|selected)|shortlisted\s+(?:students|candidates)\s+list/i.test(body);
}

/** A published table in the body is as authoritative as a spreadsheet attachment. */
export function inlineShortlistRoster(subject: string, body: string): CachedRosterInput | null {
  if (!hasPublishedShortlistContext(subject, body)) return null;
  const rosterText = body.split(/warm\s+regards|best\s+regards|\*?important\s+note|\*?code\s+of\s+conduct/i)[0];
  const header = /\bneo\s*(?:pat\s*)?id\b|\bregistration\s+(?:no|number)\b|\breg\s*no\b/i.exec(rosterText);
  const rows = rosterText.slice(header ? header.index + header[0].length : 0).split(/\r?\n/).flatMap(line => {
    const ids = [...line.matchAll(/\b(?:[a-z]\d){4}\b|\b\d{2}[a-z]{2,4}\d{4,6}\b/gi)];
    return ids.map((id,index) => {
      const previous=ids[index-1];
      const context=ids.length===1 ? line : line.slice(previous ? previous.index!+previous[0].length : 0,id.index);
      const negative=context.match(/\b(?:waitlisted|rejected|withdrawn|declined|not\s+(?:selected|shortlisted))\b/i)?.[0];
      return negative ? [id[0],negative] : [id[0]];
    });
  });
  if (!rows.length) return null;
  return { filename: 'Inline shortlist.csv', parseStatus: 'complete', extractedRows: [{ sheetName: 'Shortlist', rows: [['Candidate ID'], ...rows] }] };
}
