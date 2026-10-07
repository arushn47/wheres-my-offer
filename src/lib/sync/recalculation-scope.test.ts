import { describe, expect, it, vi } from 'vitest';
import { createRecalculationScope, loadSelectedCanonicalBodies } from './recalculation-scope';

const company = { id: 'axxela', name: 'Axxela Research & Analytics', aliases: ['AX', 'data'] };
const drive = { id: '1364', company_id: company.id, drive_number: 'pat-PL-2026-1364', normalized_drive_number: '1364', source_college_email_id: 'original' };

describe('recalculation source acquisition', () => {
  const scope = createRecalculationScope([drive], [company], ['match-source', 'linked-source'], ['shared-personal']);
  it('keeps exact source links and abbreviated brand evidence without hydrating unrelated archives', () => {
    const catalog = [
      { id: 'original', subject: 'Internship details' },
      { id: 'match-source', subject: 'Next round candidates' },
      { id: 'linked-source', subject: 'Campus update' },
      { id: 'game', subject: 'Axxela game round' },
      { id: 'number', subject: 'Candidates', parsed_drive_numbers: ['1364'] },
      { id: 'company', subject: 'Candidates', parsed_company_name: company.name },
      { id: 'unrelated', subject: 'UBS next round', parsed_drive_numbers: ['1368'], parsed_company_name: 'UBS' },
      { id: 'generic-alias', subject: 'Data candidates' },
    ];
    expect(catalog.filter(email => scope.includesCircular(email)).map(email => email.id)).toEqual(['original', 'match-source', 'linked-source', 'game', 'number', 'company']);
  });
  it('preserves same-company sibling metadata so existing role/thread boundaries can still run', () => {
    expect(scope.includesCircular({id:'sibling',subject:'Axxela next round',parsed_drive_numbers:['1350']})).toBe(true);
    expect(scope.includesPersonal({id:'sibling-receipt',placement_drive_id:'1350',subject:'Axxela registration'})).toBe(false);
    expect(scope.includesPersonal({id:'unassigned',placement_drive_id:null,subject:'Axxela round 2'})).toBe(true);
    expect(scope.includesPersonal({id:'shared-personal',placement_drive_id:'other',subject:'Candidates'})).toBe(true);
  });
  it('fetches bodies only for the selected IDs, deduplicating and bounding batches', async () => {
    const selectedIds = Array.from({length:205}, (_, index) => `source-${index}`);
    const requests: string[][] = [];
    const from = vi.fn(() => ({select:vi.fn(() => ({in:vi.fn(async (_column:string, ids:string[]) => {
      requests.push(ids);
      return {data:ids.map(id => ({id,body_text:`body-${id}`})),error:null};
    })}))}));
    const bodies = await loadSelectedCanonicalBodies({from} as unknown as Parameters<typeof loadSelectedCanonicalBodies>[0], [...selectedIds,'source-1']);
    expect(requests.map(ids => ids.length)).toEqual([200,5]);
    expect(requests.flat()).toEqual(selectedIds);
    expect(bodies.size).toBe(205);
    expect(bodies.has('unrelated')).toBe(false);
  });
  it('does no body request for an empty scope and propagates read failures instead of deriving absence', async () => {
    const failure = new Error('database unavailable');
    const from = vi.fn(() => ({select:() => ({in:async () => ({data:null,error:failure})})}));
    const database = {from} as unknown as Parameters<typeof loadSelectedCanonicalBodies>[0];
    expect((await loadSelectedCanonicalBodies(database, [])).size).toBe(0);
    expect(from).not.toHaveBeenCalled();
    await expect(loadSelectedCanonicalBodies(database,['game'])).rejects.toBe(failure);
  });
});
