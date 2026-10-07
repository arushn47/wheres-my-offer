import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRosterLookup, identityTokenHash, loadCandidateRosters, type RosterLocation } from './roster-lookup';
import { evaluateCachedShortlistRosters, type CachedRosterInput } from './shortlist-verification';
import { canonicalRosterKey, resolveRoundVerdicts, type RoundEvidence } from './round-verdict';
import type { createAdminClient } from '@/lib/supabase/admin';

type Admin = ReturnType<typeof createAdminClient>;
afterEach(()=>vi.unstubAllEnvs());
function indexed(roster:CachedRosterInput,tokens:string[]) {
  const cache=buildRosterLookup(roster.extractedRows,roster.parseStatus||null,'email',roster.filename);
  const matches=tokens.map(token=>cache.locations[identityTokenHash(token)]).filter(Boolean)
    .sort((a,b)=>a.sheetIndex-b.sheetIndex||a.rowNumber-b.rowNumber);
  return {...roster,extractedRows:undefined,contentHash:cache.legacyHash,indexedSummary:{usable:cache.usable,match:matches[0]||null}};
}
function comparable(result:ReturnType<typeof evaluateCachedShortlistRosters>) {
  return {state:result.state,count:result.checkedRosterCount,details:result.matchingRoster?.details,round:result.matchingRoster?.round};
}
describe('canonical roster lookup equivalence',()=>{
  const cases: Array<[string,CachedRosterInput['extractedRows'],string]>=[
    ['positive', [{sheetName:'Test shortlist',rows:[['Neo ID'],['AB-12']]}],'complete'],
    ['excluded tabs', [{sheetName:'Eligible students',rows:[['Neo ID'],['AB12']]},{sheetName:'Test shortlist',rows:[['Neo ID'],['CD34']]}],'complete'],
    ['negative row', [{sheetName:'Test shortlist',rows:[['Neo ID','Status'],['AB12','Not shortlisted']]}],'complete'],
    ['unallocated seat', [{sheetName:'Test shortlist',rows:[['Neo ID','Venue'],['AB12','N/A'],['CD34','Lab 2']]}],'complete'],
    ['empty', [],'complete'],
    ['failure', [{sheetName:'Test shortlist',rows:[['AB12']]}],'failed'],
    ['earliest location', [{sheetName:'First',rows:[['CD34'],['AB12']]},{sheetName:'Second',rows:[['AB12']]}],'complete'],
    ['email normalization', [{sheetName:'Test shortlist',rows:[['Email'],['Candidate@Example.com']]}],'complete'],
  ];
  it.each(cases)('%s preserves membership, absence and location',(name,rows,status)=>{
    const roster:CachedRosterInput={filename:'shortlist.xlsx',collegeEmailId:'email',parseStatus:status,extractedRows:rows,round:'test'};
    for(const tokens of [['AB12'],['CD34','AB12'],['candidate@example.com'],['ABSENT'],[]]) {
      const raw=evaluateCachedShortlistRosters({rosters:[roster],identityTokens:tokens,shortlistContext:true});
      const cached=evaluateCachedShortlistRosters({rosters:[indexed(roster,tokens)],identityTokens:tokens,shortlistContext:true});
      expect(comparable(cached),name).toEqual(comparable(raw));
    }
  });
  it('preserves round verdicts and notification dedupe keys across cache rollout',()=>{
    const roster:CachedRosterInput={filename:'test shortlist.xlsx',parseStatus:'complete',extractedRows:[{sheetName:'Shortlist',rows:[['Neo ID'],['AB12']]}]};
    const item:RoundEvidence={emailId:'email',subject:'Test shortlist',body:'Shortlisted students for online test',receivedAt:'2026-10-01T08:00:00Z',rosters:[roster]};
    const cached={...item,rosters:[indexed(roster,['AB12'])]};
    expect(canonicalRosterKey(cached)).toEqual(canonicalRosterKey(item));
    expect(resolveRoundVerdicts([cached],['AB12'])).toEqual(resolveRoundVerdicts([item],['AB12']));
  });
});
describe('roster lookup rollout and reads',()=>{
  const location:RosterLocation={sheetIndex:0,sheetName:'Shortlist',rowNumber:2};
  const row={source_kind:'attachment',source_key:'attachment',source_revision:1,college_email_id:'email',filename:'shortlist.xlsx',size_bytes:200,content_hash:null,parse_status:'complete',index_ready:true,usable:true,legacy_roster_hash:'stable',match_location:location};
  it('does no extra reads while disabled',async()=>{
    vi.stubEnv('ROSTER_LOOKUP_ENABLED','false');
    const rpc=vi.fn();
    expect(await loadCandidateRosters({rpc} as unknown as Admin,['email'],['AB12'])).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('a warm lookup returns only candidate membership and never downloads canonical rows',async()=>{
    vi.stubEnv('ROSTER_LOOKUP_ENABLED','true');
    const rpc=vi.fn().mockResolvedValue({data:[row],error:null}),from=vi.fn();
    const result=await loadCandidateRosters({rpc,from} as unknown as Admin,['email'],['AB12']);
    expect(result?.[0]).toMatchObject({contentHash:'stable',indexedSummary:{usable:true,match:location}});
    expect(result?.[0].extractedRows).toBeUndefined();expect(from).not.toHaveBeenCalled();
    expect(rpc.mock.calls[0][1].p_token_hashes).toEqual([identityTokenHash('AB12')]);
  });
  it('falls back safely when the migration is absent',async()=>{
    vi.stubEnv('ROSTER_LOOKUP_ENABLED','true');
    const rpc=vi.fn().mockResolvedValue({data:null,error:{code:'PGRST202'}});
    expect(await loadCandidateRosters({rpc} as unknown as Admin,['email'],['AB12'])).toBeNull();
  });
  it('does not interpret a query failure as candidate absence',async()=>{
    vi.stubEnv('ROSTER_LOOKUP_ENABLED','true');
    const error={code:'57014'},rpc=vi.fn().mockResolvedValue({data:null,error});
    await expect(loadCandidateRosters({rpc} as unknown as Admin,['email'],['AB12'])).rejects.toEqual(error);
  });
  it('uses changed canonical rows on a stale lookup even when cache publication fails',async()=>{
    vi.stubEnv('ROSTER_LOOKUP_ENABLED','true');
    const rows=[{sheetName:'Shortlist',rows:[['CD34']]}];
    const rpc=vi.fn().mockResolvedValueOnce({data:[{...row,index_ready:false}],error:null}).mockResolvedValueOnce({error:{code:'XX000'}});
    const query={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:{extracted_rows:rows,roster_revision:2,parse_status:'complete',content_hash:'changed'},error:null})};
    const result=await loadCandidateRosters({rpc,from:()=>query} as unknown as Admin,['email'],['AB12']);
    expect(result?.[0].indexedSummary).toBeUndefined();
    expect(result?.[0].extractedRows).toEqual(rows);
    expect(evaluateCachedShortlistRosters({rosters:result!,identityTokens:['AB12'],shortlistContext:true}).state).toBe('verified_absent');
  });
});
