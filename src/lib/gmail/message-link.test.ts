import { describe, expect, it } from 'vitest';
import { cleanRfcMessageId, directGmailLink, searchGmailLink, uniqueGmailTarget } from './message-link';
describe('mailbox-local Gmail link', () => {
  it('targets the connected account rather than a browser account index', () => {
    expect(directGmailLink('college+1@vitbhopal.ac.in', '18fc123456789abc')).toBe('https://mail.google.com/mail/u/?authuser=college%2B1%40vitbhopal.ac.in#all/18fc123456789abc');
  });
  it('rejects redirects/invalid ids and never treats an RFC Message-ID as a Gmail ID', () => {
    expect(() => directGmailLink('college@test.com', 'https://evil.test')).toThrow();
    expect(() => directGmailLink('college@test.com', '<message@example.test>')).toThrow();
  });
  it('offers only an exact RFC search or inbox, never a subject search', () => {
    expect(searchGmailLink('me@test.com', '<exact@example.test>')).toContain('#search/rfc822msgid%3Aexact%40example.test');
    expect(cleanRfcMessageId('a@example.test OR from:other')).toBeUndefined();
    expect(searchGmailLink('me@test.com')).toContain('#inbox');
  });
  it('accepts only one unambiguous message and returns its conversation id', () => {
    const message = { id: '18fc123456789abc', threadId: '18fc123456789def' };
    expect(uniqueGmailTarget({ messages: [message] })).toBe(message.threadId);
    expect(uniqueGmailTarget({ messages: [message, message] })).toBeUndefined();
    expect(uniqueGmailTarget({ messages: [message], nextPageToken: 'more' })).toBeUndefined();
    expect(uniqueGmailTarget({})).toBeUndefined();
  });
});
