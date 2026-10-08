import { describe, it, expect } from 'vitest';
import {
  buildCandidateIdentity,
  extractRegistrationNumber,
  matchesCandidateRow,
  matchesCandidateText,
} from './user-identity';

describe('user-identity', () => {
  it('extracts registration number from college email', () => {
    expect(extractRegistrationNumber('arush.23bce10472@vitbhopal.ac.in')).toBe('23BCE10472');
    expect(extractRegistrationNumber('bera.23bsa10008@vitbhopal.ac.in')).toBe('23BSA10008');
    expect(extractRegistrationNumber('personal@gmail.com')).toBeNull();
  });

  it('builds candidate identity with all search tokens and emails', () => {
    const identity = buildCandidateIdentity({
      userId: 'user-123',
      name: 'Arush Nandakumar Menon',
      neoId: 'I4W0P0K8',
      collegeEmail: 'arush.23bce10472@vitbhopal.ac.in',
      personalEmail: 'arushn.2005@gmail.com',
    });

    expect(identity.regNo).toBe('23BCE10472');
    expect(identity.firstName).toBe('Arush');
    expect(identity.lastName).toBe('Menon');
    expect(identity.emails).toContain('arushn.2005@gmail.com');
    expect(identity.emails).toContain('arush.23bce10472@vitbhopal.ac.in');
    expect(identity.searchTokens).toContain('I4W0P0K8');
    expect(identity.searchTokens).toContain('23BCE10472');
    expect(identity.searchTokens).toContain('ARUSH NANDAKUMAR MENON');
    expect(identity.searchTokens).toContain('ARUSH MENON');
  });

  it('matches row when first name and last name are in separate cells (Infosys sheet structure)', () => {
    const identity = buildCandidateIdentity({
      name: 'Arush Nandakumar Menon',
      neoId: 'I4W0P0K8',
      collegeEmail: 'arush.23bce10472@vitbhopal.ac.in',
      personalEmail: 'arushn.2005@gmail.com',
    });

    const row = [
      '344',
      'arushn.2005@gmail.com',
      'Arush Nandakumar',
      'Menon',
      '23BCE10472',
      'Slot 1',
      'LC 202',
      '73',
    ];

    const match = matchesCandidateRow(row, identity);
    expect(match.matched).toBe(true);
  });

  it('matches row by registration number even if name is absent', () => {
    const identity = buildCandidateIdentity({
      collegeEmail: 'arush.23bce10472@vitbhopal.ac.in',
    });

    const row = ['52', '23BCE10472', 'Student', 'Lab 3'];
    const match = matchesCandidateRow(row, identity);
    expect(match.matched).toBe(true);
    expect(match.matchedValue).toBe('23BCE10472');
  });

  it('matches row by Neo ID', () => {
    const identity = buildCandidateIdentity({
      neoId: 'I4W0P0K8',
    });

    const row = ['10', 'I4W0P0K8', 'Qualified'];
    const match = matchesCandidateRow(row, identity);
    expect(match.matched).toBe(true);
    expect(match.matchedValue).toBe('I4W0P0K8');
  });

  it('does not falsely match another student with similar name', () => {
    const identity = buildCandidateIdentity({
      name: 'Arush Nandakumar Menon',
      regNo: '23BCE10472',
      personalEmail: 'arushn.2005@gmail.com',
    });

    const otherRow = [
      '739',
      'arushbhatnagar05@gmail.com',
      'Arush',
      'Bhatnagar',
      '23BCE11739',
      'Slot 2',
      'LC 102',
      '59',
    ];

    const match = matchesCandidateRow(otherRow, identity);
    expect(match.matched).toBe(false);
  });

  it('requires strong identity for automatic matching and permits name matching only in review', () => {
    const identity = buildCandidateIdentity({
      name: 'Arush Nandakumar Menon',
      neoId: 'I4W0P0K8',
      collegeEmail: 'arush.23bce10472@vitbhopal.ac.in',
      personalEmail: 'arushn.2005@gmail.com',
    });

    const textWithName = `
To: allstudents@vitbhopal.ac.in
Subject: Congratulations
The following students are selected:
1. Arush Nandakumar Menon - Super Dream Offer
2. Jane Doe - Dream Offer
    `;

    expect(matchesCandidateText(textWithName, identity).matched).toBe(false);
    expect(matchesCandidateText(textWithName, identity, true).matched).toBe(true);

    const broadcastOnly = `
To: arushn.2005@gmail.com
Subject: Circular
Dear students, please check the attached file.
    `;
    expect(matchesCandidateText(broadcastOnly, identity).matched).toBe(false);
  });
});
