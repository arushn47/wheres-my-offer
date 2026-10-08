/** Gmail IDs belong to one mailbox. RFC Message-ID is only a cross-mailbox search key. */
export function cleanRfcMessageId(value?: string | null): string | undefined {
  const id = value?.trim().replace(/^<|>$/g, '');
  return id && id.length <= 998 && /^[^\s<>"\\]+@[^\s<>"\\]+$/.test(id) ? id : undefined;
}
export function validGmailId(value?: string | null): value is string {
  return !!value && /^[a-f0-9]{10,32}$/i.test(value);
}
function accountPath(email: string) {
  // Google handles account selection/sign-in; an application session is not a Google browser session.
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}`;
}
export function directGmailLink(email: string, id: string): string {
  if (!validGmailId(id)) throw new Error('Invalid mailbox-local Gmail ID');
  return `${accountPath(email)}#all/${id}`;
}
export function searchGmailLink(email: string, rfcId?: string | null): string {
  const id = cleanRfcMessageId(rfcId);
  return `${accountPath(email)}${id ? `#search/${encodeURIComponent(`rfc822msgid:${id}`)}` : '#inbox'}`;
}

export interface GmailLookupResult { messages?: Array<{ id?: string | null; threadId?: string | null }>; nextPageToken?: string | null }
/** One exact result only. A duplicate or truncated result must not open an arbitrary conversation. */
export function uniqueGmailTarget(result: GmailLookupResult): string | undefined {
  if (result.nextPageToken || result.messages?.length !== 1) return;
  const message = result.messages[0];
  return validGmailId(message.threadId) ? message.threadId : validGmailId(message.id) ? message.id : undefined;
}
