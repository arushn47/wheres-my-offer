import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { EmailAttachments } from './email-attachments';

it('offers a collapsed native disclosure containing all additional PDFs and Excel files', () => {
  const html = renderToStaticMarkup(createElement(EmailAttachments, { names: ['QA.pdf', 'Analyst.pdf', 'CTC.xlsx'] }));
  expect(html).toContain('<details');
  expect(html).not.toContain(' open=');
  expect(html).toContain('+2 more');
  expect(html).toContain('QA.pdf');
  expect(html).toContain('Analyst.pdf');
  expect(html).toContain('CTC.xlsx');
});

it('keeps other files visible when one workbook is already shown as shortlist evidence', () => {
  const html = renderToStaticMarkup(createElement(EmailAttachments, {
    names: ['Test shortlist.xlsx', 'Interview shortlist.xlsx', 'JD.pdf'], alreadyShownName: 'Test shortlist.xlsx',
  }));
  expect(html).toContain('+1 more');
  expect(html).not.toContain('Test shortlist.xlsx');
  expect(html).toContain('Interview shortlist.xlsx');
  expect(html).toContain('JD.pdf');
});

it('keeps single attachments quiet and omits empty lists', () => {
  const single = renderToStaticMarkup(createElement(EmailAttachments, { names: ['JD.pdf'] }));
  expect(single).toContain('JD.pdf');
  expect(single).not.toContain('<details');
  expect(renderToStaticMarkup(createElement(EmailAttachments, { names: [] }))).toBe('');
});
