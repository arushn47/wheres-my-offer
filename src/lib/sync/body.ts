import type { ParsedEmail } from '@/lib/gmail/client';

/**
 * Converts the useful text from an HTML email into searchable plain text.
 * Quoted-thread removal remains the responsibility of the existing event/status pipeline.
 */
export function htmlToCanonicalText(html: string | undefined | null): string {
  if (!html) return '';

  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(?:tr|p|div|li)>/gi, '\n')
    .replace(/<(?:td|th)[^>]*>/gi, '   ')
    .replace(/<\/?[a-z][a-z0-9]*[^<>]*>/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * Removes common quoted/replied/forwarded sections from a text body.
 * Historical content is excluded from identifier and drive evidence.
 */
export function stripQuotedContent(text: string | undefined | null): string {
  if (!text) return '';

  return text
    .replace(/^>+.*$/gm, ' ')
    .replace(/\n?[- ]*Forwarded message[- ]*\n[\s\S]*$/i, ' ')
    .replace(/\n?Begin forwarded message:\s*[\s\S]*$/i, ' ')
    .replace(/\n?-----Original Message-----[\s\S]*$/i, ' ')
    .replace(/\n?On\s+[A-Za-z]{3},\s+[A-Za-z]{3}\s+\d{1,2},\s+\d{4}\s+at\s+[\d:apm\s.]+(?:[^\n\r]*?)wrote:?\s*[\s\S]*$/i, ' ')
    .replace(/\n?On\s+\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\s+at\s+[\d:apm\s.]+(?:[^\n\r]*?)wrote:?\s*[\s\S]*$/i, ' ')
    .replace(/\n?Warm\s+regards[\s\S]*?(?:Dr\.?V\.?Samuel\s+Rajkumar|Director\(Career\s+Development\s+Centre\))[\s\S]*$/i, ' ')
    .trim();
}

function removeHtmlQuotedSections(html: string | undefined | null): string {
  if (!html) return '';

  return html
    .replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, ' ')
    .replace(/<div\b[^>]*class=["'][^"']*(?:gmail_quote|gmail_extra|yahoo_quoted)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, ' ')
    .replace(/<div\b[^>]*class=["'][^"']*gmail_attr[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, ' ');
}

/**
 * Plain text is authoritative; HTML contributes additional text when it is
 * distinct; Gmail's snippet is used only when no full body is available.
 */
export function getCanonicalBodyText(
  email: Pick<ParsedEmail, 'bodyPlain' | 'bodyHtml' | 'bodySnippet'>
): string {
  const plain = email.bodyPlain?.trim() || '';
  const html = htmlToCanonicalText(email.bodyHtml);

  if (plain && html && plain !== html) {
    return `${plain}\n${html}`;
  }

  return plain || html || email.bodySnippet?.trim() || '';
}

/**
 * Returns the current-message body for identifier and drive matching.
 */
export function getCurrentMessageText(
  email: Pick<ParsedEmail, 'bodyPlain' | 'bodyHtml' | 'bodySnippet'>
): string {
  const plain = stripQuotedContent(email.bodyPlain?.trim() || '');
  const html = htmlToCanonicalText(removeHtmlQuotedSections(email.bodyHtml));

  if (plain && html && plain !== html) {
    return `${plain}\n${html}`;
  }

  return plain || html || stripQuotedContent(email.bodySnippet?.trim() || '');
}
