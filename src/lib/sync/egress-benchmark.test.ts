import { describe, expect, it } from 'vitest';
import { postgrestFixture } from '@/test/postgrest-fixture';
import { withOwnedMutationLease } from './lease-context';
import { createRecalculationScope, loadRecalculationScope, loadScopedCircularMetadata, loadScopedMetadata, loadSelectedCanonicalBodies, PERSONAL_METADATA, CIRCULAR_METADATA } from './recalculation-scope';
import { invalidateCircularRoutingRead } from './run-reads';

const company = { id: 'company', name: 'Axxela Research & Analytics', aliases: ['AX', 'data'] };
const drive = { id: 'selected', company_id: 'company', drive_number: 'pat-PL-2026-1364', normalized_drive_number: 'pat-pl-2026-1364', source_college_email_id: 'explicit' };
const sibling = { ...drive, id: 'sibling', drive_number: 'pat-PL-2026-1350', normalized_drive_number: 'pat-pl-2026-1350' };
const scope = createRecalculationScope([drive], [company], [], ['linked'], [drive, sibling]);
const projection = (select: string) => select.replace(/\s/g, '');
function dataset() {
  const base = { sender_email: 'cdc@example.edu', received_at: '2026-09-01', created_at: '2026-09-01', classification: 'shortlist', body_text: 'Synthetic shortlist body '.repeat(100) };
  const college = [
    { ...base, id: 'explicit', subject: 'Candidates', parsed_company_name: null, parsed_drive_numbers: null },
    { ...base, id: 'current', subject: 'Axxela game round', parsed_company_name: 'Axxela', parsed_drive_numbers: [] },
    { ...base, id: 'old', received_at: '2025-01-01', subject: 'Axxela historical circular', parsed_company_name: 'Axxela', parsed_drive_numbers: [] },
    { ...base, id: 'sibling-number', subject: 'Next round candidates', parsed_company_name: null, parsed_drive_numbers: ['pat-pl-2026-1350'] },
    { ...base, id: 'number-variant', subject: 'Candidates', parsed_company_name: null, parsed_drive_numbers: ['PAT_PL_2026_1364'] },
    { ...base, id: 'fuzzy', subject: 'Candidates', parsed_company_name: 'Axxela Analytics', parsed_drive_numbers: [] },
    ...Array.from({ length: 1876 }, (_, i) => ({ ...base, id: `unrelated-${i}`, subject: `Unrelated Company ${i} test shortlist`, parsed_company_name: `Unrelated ${i}`, parsed_drive_numbers: [] })),
  ];
  const personalBase = { user_id: 'alice', received_at: '2026-09-02', sender: 'noreply.cdcinfo@vitstudent.ac.in', body_snippet: 'Synthetic personal snippet '.repeat(20), college_email_id: 'current' };
  const personal = [
    { ...personalBase, id: 'receipt', placement_drive_id: 'selected', subject: 'Axxela registration' },
    { ...personalBase, id: 'sibling-receipt', placement_drive_id: 'sibling', subject: 'Axxela older registration' },
    { ...personalBase, id: 'linked', placement_drive_id: 'another', subject: 'Candidates' },
    { ...personalBase, id: 'unassigned', placement_drive_id: null, subject: 'Axxela game round' },
    { ...personalBase, id: 'other-user', user_id: 'bob', placement_drive_id: 'selected', subject: 'Axxela registration' },
    ...Array.from({ length: 272 }, (_, i) => ({ ...personalBase, id: `unrelated-${i}`, subject: `Other brand ${i}`, placement_drive_id: `unrelated-drive-${i}` })),
  ];
  return { college_emails: college, personal_emails: personal };
}

describe('selected-drive request-count benchmark (fixture HTTP only)', () => {
  it('does not turn an empty selected scope into an archive scan or allow private reads without a user', async () => {
    const fixture = postgrestFixture(dataset());
    expect(await loadScopedCircularMetadata(fixture.admin, createRecalculationScope([], [], [], []))).toEqual([]);
    await expect(loadScopedMetadata(fixture.admin, 'personal_emails', scope.personalFilters)).rejects.toThrow('requires a user scope');
    expect(fixture.requests).toHaveLength(0);
  });
  it('preserves historical, fuzzy, explicit, normalized-number and sibling evidence while reducing downloads over eight recalculations', async () => {
    const tables = dataset(); const before = postgrestFixture(tables), after = postgrestFixture(tables);
    const legacyResults: string[][] = [], optimizedResults: string[][] = [];
    // Frozen pre-fix acquisition sequence: full personal metadata, paginated
    // full circular metadata, then separate personal and circular hydration.
    for (let run = 0; run < 8; run++) {
      const { data: personal } = await before.admin.from('personal_emails').select(PERSONAL_METADATA).eq('user_id', 'alice').order('received_at').range(0, 999);
      const selected = (personal || []).filter(scope.includesPersonal);
      await loadSelectedCanonicalBodies(before.admin, selected.map(row => row.college_email_id).filter(Boolean));
      const evidence: string[] = [];
      for (let from = 0; ; from += 1000) {
        const { data } = await before.admin.from('college_emails').select(CIRCULAR_METADATA).order('received_at').order('id').range(from, from + 999);
        const included = (data || []).filter(scope.includesCircular);
        await loadSelectedCanonicalBodies(before.admin, included.map(row => row.id));
        evidence.push(...included.map(row => row.id));
        if (!data || data.length < 1000) break;
      }
      legacyResults.push(evidence.sort());
    }
    await withOwnedMutationLease('alice', 'run', async () => {
      for (let run = 0; run < 8; run++) {
        const personal = await loadScopedMetadata(after.admin, 'personal_emails', scope.personalFilters, 'alice');
        expect(personal.map(row => row.id).sort()).toEqual(['linked', 'receipt', 'sibling-receipt', 'unassigned']);
        const circulars = await loadScopedCircularMetadata(after.admin, scope);
        expect(circulars.map(row => row.id)).toContain('sibling-number');
        const selected = circulars.filter(scope.includesCircular);
        const bodies = await loadSelectedCanonicalBodies(after.admin, [...personal.filter(scope.includesPersonal).flatMap(row => row.college_email_id ? [row.college_email_id] : []), ...selected.map(row => row.id)]);
        await loadSelectedCanonicalBodies(after.admin, selected.map(row => row.id), bodies);
        optimizedResults.push(selected.map(row => row.id).sort());
      }
    });
    expect(optimizedResults).toEqual(legacyResults);
    const summary = (requests: typeof before.requests) => ({ requests: requests.length, rows: requests.reduce((n, request) => n + request.rows, 0), decodedBytes: requests.reduce((n, request) => n + request.bytes, 0) });
    console.info('EGRESS_BENCHMARK', JSON.stringify({ workload: '8 selected-drive acquisitions; 1882 circulars, 276 private receipts', before: summary(before.requests), after: summary(after.requests), firstAcquisition: { before: summary(before.requests.slice(0, 5)), after: summary(after.requests.slice(0, 5)) } }));
    expect(after.requests.length).toBeLessThan(before.requests.length);
    expect(summary(after.requests).decodedBytes).toBeLessThan(summary(before.requests).decodedBytes / 4);
    expect(after.requests.filter(request => request.select === 'id,parsed_company_name,parsed_drive_numbers')).toHaveLength(2);
    const circularReads = after.requests.filter(request => request.select === projection(CIRCULAR_METADATA));
    const personalReads = after.requests.filter(request => request.select === projection(PERSONAL_METADATA));
    expect(circularReads).toHaveLength(8); expect(personalReads).toHaveLength(8);
    expect(circularReads.every(request => request.params.has('or'))).toBe(true);
    expect(personalReads.every(request => request.params.get('user_id') === 'eq.alice' && request.params.has('or'))).toBe(true);
    expect(after.requests.filter(request => request.select === 'id,body_text').every(request => request.rows <= 5)).toBe(true);
  });
  it('refreshes routing after canonical changes, and starts fresh in the next processing run', async () => {
    const tables = dataset(), fixture = postgrestFixture(tables);
    await withOwnedMutationLease('alice', 'first', async () => {
      await loadScopedCircularMetadata(fixture.admin, scope);
      tables.college_emails.push({ ...tables.college_emails[0], id: 'new-number', parsed_company_name: null, parsed_drive_numbers: ['pat-pl-2026-1364'] });
      invalidateCircularRoutingRead();
      expect((await loadScopedCircularMetadata(fixture.admin, scope)).map(row => row.id)).toContain('new-number');
    });
    await withOwnedMutationLease('alice', 'second', () => loadScopedCircularMetadata(fixture.admin, scope));
    expect(fixture.requests.filter(request => request.select === 'id,parsed_company_name,parsed_drive_numbers')).toHaveLength(6);
  });
  it('serializes punctuation in names safely without changing exact scope matching', async () => {
    const company = { id: 'quoted', name: 'Example, Labs ("R&D")', aliases: [] };
    const selected = createRecalculationScope([{ id: 'quoted-drive', company_id: 'quoted' }], [company], [], []);
    const fixture = postgrestFixture({ personal_emails: [{ id: 'receipt', user_id: 'alice', subject: 'Example, Labs ("R&D") recruitment', placement_drive_id: null }] });
    expect(await loadScopedMetadata(fixture.admin, 'personal_emails', selected.personalFilters, 'alice')).toHaveLength(1);
  });
  it('does not download unrelated next-round metadata for a short brand such as EXL', async () => {
    const selected = createRecalculationScope([{ id: 'drive', company_id: 'exl' }], [{ id: 'exl', name: 'EXL Service' }], [], []);
    const fixture = postgrestFixture({ college_emails: [
      { id: 'exl', subject: 'EXL Service registration', parsed_company_name: 'EXL Service', parsed_drive_numbers: [] },
      ...Array.from({ length: 100 }, (_, i) => ({ id: `other-${i}`, subject: 'Next round selection list', parsed_company_name: 'Other Company', parsed_drive_numbers: [] })),
    ] });
    expect((await loadScopedCircularMetadata(fixture.admin, selected)).map(row => row.id)).toEqual(['exl']);
    expect(fixture.requests.find(request => request.select === projection(CIRCULAR_METADATA))?.rows).toBe(1);
  });
  it('loads only selected company metadata while keeping shared links and sibling routing boundaries', async () => {
    const fixture = postgrestFixture({
      companies: [company, { id: 'unrelated', name: 'Unrelated' }],
      placement_drives: [drive, sibling, { id: 'unrelated', company_id: 'unrelated' }],
      candidate_matches: [{ user_id: 'alice', placement_drive_id: 'selected', email_id: null, college_email_id: 'matched' }, { user_id: 'bob', placement_drive_id: 'selected', college_email_id: 'private-match' }],
      email_drive_links: [{ user_id: 'bob', placement_drive_id: 'selected', email_id: 'shared-link' }],
    });
    const loaded = await loadRecalculationScope(fixture.admin, 'alice', ['selected']);
    expect(loaded.includesCircular({ id: 'matched' })).toBe(true);
    expect(loaded.includesCircular({ id: 'private-match' })).toBe(false);
    expect(loaded.includesPersonal({ id: 'shared-link', placement_drive_id: 'another' })).toBe(true);
    expect(loaded.includesRouting({ id: 'sibling-number', parsed_drive_numbers: ['pat-pl-2026-1350'] })).toBe(true);
    expect(fixture.requests.find(request => request.table === 'companies')?.rows).toBe(1);
    expect(fixture.requests.find(request => request.table === 'companies')?.params.has('id')).toBe(true);
  });
});
