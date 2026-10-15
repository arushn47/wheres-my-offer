import { beforeEach, expect, it, vi } from 'vitest';
const cache=vi.hoisted(()=>vi.fn());
vi.mock('./roster-lookup',()=>({cacheStoredRoster:cache}));
import { persistSheetSnapshot } from './sheet-snapshots';
import type { GSheetMatchResult } from './gsheet-parser';
beforeEach(()=>vi.clearAllMocks());
it('keeps immutable payloads while still recording each source check and publishing the lookup',async()=>{
 const upsert=vi.fn().mockResolvedValue({error:null});
 const from=vi.fn(()=>({upsert}));
 const scan={contentHash:'same-content',extractedRows:[{sheetName:'Candidates',rows:[['Registration'],['23BCE10001']]}],fetchedAt:'2026-10-15T00:00:00Z'} as GSheetMatchResult;
 await persistSheetSnapshot({from} as never,'email','https://example.test/sheet',scan);
 expect(upsert.mock.calls[0][1]).toEqual({onConflict:'content_hash',ignoreDuplicates:true});
 expect(upsert.mock.calls[1]).toEqual([expect.objectContaining({college_email_id:'email',content_hash:'same-content',parse_status:'complete'}),{onConflict:'college_email_id,source_url'}]);
 expect(cache).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({kind:'sheet',contentHash:'same-content',rows:scan.extractedRows}));
});
