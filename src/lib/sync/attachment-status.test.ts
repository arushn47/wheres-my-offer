import { describe, expect, it } from 'vitest';
import {
  DEFERRED_ATTACHMENT_ERROR,
  IGNORED_IMAGE_ATTACHMENT_ERROR,
  classifyUnsupportedAttachment,
  isIgnoredAttachment,
  isSupportedWorkbookAttachment,
  isTerminalUnsupportedRow,
} from './attachment-status';

describe('College attachment status classification', () => {
  it('only treats spreadsheets as parseable workbooks', () => {
    for (const name of ['Shortlist.xlsx', 'list.XLS', 'roster.csv']) {
      expect(isSupportedWorkbookAttachment(name)).toBe(true);
    }
    for (const name of ['JD.pdf', 'JD.doc', 'JD.docx', 'deck.pptx', 'archive.zip', 'mail.eml', 'logo.png']) {
      expect(isSupportedWorkbookAttachment(name)).toBe(false);
    }
  });

  it('marks image attachments as ignored instead of failed', () => {
    for (const name of ['image001.png', 'Signature.JPG', 'banner.jpeg', 'anim.gif']) {
      expect(isIgnoredAttachment(name)).toBe(true);
      expect(classifyUnsupportedAttachment(name)).toEqual({
        status: 'ignored',
        error: IGNORED_IMAGE_ATTACHMENT_ERROR,
      });
    }
  });

  it('defers PDF / DOC / DOCX style attachments for future JD parsing without failing them', () => {
    for (const name of ['JD - Analyst.pdf', 'Resume.doc', 'Offer.docx', 'JD_FullStack.PDF']) {
      expect(classifyUnsupportedAttachment(name)).toEqual({
        status: 'deferred',
        error: DEFERRED_ATTACHMENT_ERROR,
      });
    }
  });

  it('recognizes an already-classified terminal row so re-ingestion is a no-op', () => {
    const imageClassification = classifyUnsupportedAttachment('image002.png');
    expect(isTerminalUnsupportedRow(
      { parse_status: 'ignored', parse_error: IGNORED_IMAGE_ATTACHMENT_ERROR },
      imageClassification
    )).toBe(true);
    expect(isTerminalUnsupportedRow(
      { parse_status: 'error', parse_error: 'Attachment fetch or parser failed; retry on a later worker pass.' },
      imageClassification
    )).toBe(false);
    expect(isTerminalUnsupportedRow(null, imageClassification)).toBe(false);

    const pdfClassification = classifyUnsupportedAttachment('JD.pdf');
    expect(isTerminalUnsupportedRow(
      { parse_status: 'deferred', parse_error: DEFERRED_ATTACHMENT_ERROR },
      pdfClassification
    )).toBe(true);
    // legacy mislabel used `error` — must not be treated as already handled
    expect(isTerminalUnsupportedRow(
      { parse_status: 'error', parse_error: DEFERRED_ATTACHMENT_ERROR },
      pdfClassification
    )).toBe(false);
  });

  it('never classifies a workbook as ignored or deferred', () => {
    for (const name of ['Shortlist.xlsx', 'roster.csv']) {
      expect(isIgnoredAttachment(name)).toBe(false);
    }
  });
});
