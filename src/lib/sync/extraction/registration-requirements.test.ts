import { describe, expect, it } from 'vitest';
import { extractRegistrationRequirements, readRegistrationRequirements, shouldShowCompanyRegistrationReminder } from './registration-requirements';

describe('company form registration requirements', () => {
  it('detects the Philips dual registration instruction and its linked Microsoft form', () => {
    const result = extractRegistrationRequirements({ bodyHtml: `<p>All the interested and eligible students should register in the <b>NEO PAT &amp; company link</b> on or before 15th October 2026 (10.00 am)</p><p>Link- <a href="https://forms.office.com/r/example">Student Academic and Professional Details Form- 2027) – Fill out form</a></p>` });
    expect(result?.companyFormRequired).toBe(true);
    expect(result?.companyLinks[0].url).toBe('https://forms.office.com/r/example');
  });

  it('detects company-first instructions and a plain-text registration link', () => {
    const result = extractRegistrationRequirements({ bodyPlain: "Register in the company's link & Neo pat portal on before 25-09-2026.\nCompany's Registration Link - https://campus.lntedutech.com/register" });
    expect(result?.companyLinks[0].url).toBe('https://campus.lntedutech.com/register');
  });

  it.each([
    'Register on NeoPAT. Company website: https://example.com',
    'Registration on NeoPAT only. The company form is optional.',
    'Do not register on NeoPAT and the company link.',
    'Company details are on NeoPAT and the company website.',
  ])('does not invent a dual registration requirement: %s', bodyPlain => {
    expect(extractRegistrationRequirements({ bodyPlain })).toBeNull();
  });

  it('keeps the requirement when the external link was not retained in the cached body', () => {
    expect(extractRegistrationRequirements({ bodyPlain: 'All eligible students should register in NEO PAT & company link before tomorrow. Link: Student details form' }))
      .toMatchObject({ companyFormRequired: true, companyLinks: [] });
  });

  it('rejects unsafe links and ignores unrelated homepage links', () => {
    const result = extractRegistrationRequirements({ bodyHtml: '<p>Register in NeoPAT and company link.</p><a href="javascript:alert(1)">Registration form</a><a href="https://example.com">Website</a>' });
    expect(result?.companyLinks).toEqual([]);
    expect(readRegistrationRequirements({ companyFormRequired: true, companyLinks: [{ url: 'data:text/html,test' }] })?.companyLinks).toEqual([]);
  });

  it('does not inherit requirements from a quoted historical registration circular', () => {
    expect(extractRegistrationRequirements({ subject: 'Re: Philips', bodyPlain: 'Thanks\nOn Tue, Oct 13, 2026 at 10:00 AM CDC wrote:\nRegister in NeoPAT and company link.' })).toBeNull();
  });

  it('keeps the reminder after NeoPAT application and hides it after the cutoff or withdrawal', () => {
    const now = new Date('2026-10-14T10:00:00Z');
    expect(shouldShowCompanyRegistrationReminder('applied', '2026-10-15T04:30:00Z', now)).toBe(true);
    expect(shouldShowCompanyRegistrationReminder('applied', '2026-10-14T04:30:00Z', now)).toBe(false);
    expect(shouldShowCompanyRegistrationReminder('withdrawn', '2026-10-15T04:30:00Z', now)).toBe(false);
  });
});
