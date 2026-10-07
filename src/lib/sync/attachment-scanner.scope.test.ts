import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture=vi.hoisted(()=>({admin:null as unknown,lookup:vi.fn(),emails:[] as Record<string,unknown>[]}));
vi.mock('@/lib/supabase/admin',()=>({createAdminClient:()=>fixture.admin}));
vi.mock('./roster-lookup',()=>({loadCandidateRosters:fixture.lookup}));
import { scanSharedCollegeCandidateMatches } from './attachment-scanner';
import { withOwnedMutationLease } from './lease-context';
import type { createAdminClient } from '@/lib/supabase/admin';

describe('targeted shared shortlist scan',()=>{
 const writes:Record<string,unknown>[]=[];
 beforeEach(()=>{
  writes.length=0;
  fixture.emails=['a','b'].map((id,index)=>({id:`email-${id}`,subject:'Apple online test shortlist',classification:'shortlist',parsed_company_name:'Apple',parsed_drive_numbers:[String(101+index)],received_at:'2026-10-05T00:00:00Z'}));
  fixture.lookup.mockReset().mockImplementation(async()=>['a','b'].map(id=>({sourceKind:'attachment',sourceKey:`attachment-${id}`,collegeEmailId:`email-${id}`,filename:'shortlist.xlsx',parseStatus:'complete',indexedSummary:{usable:true,match:{sheetIndex:0,sheetName:'Candidates',rowNumber:2}}})));
  const rows:Record<string,unknown[]>={
   users:[{id:'user',email:'user@example.com',name:'Test User',neo_id:'NEO123456'}],
   gmail_accounts:[{id:'personal',account_type:'personal',email:'user@example.com'},{id:'college',account_type:'college',email:'user@vitbhopal.ac.in'}],
   applications:['a','b'].map(id=>({placement_drive_id:id,manual_override:false,status:'applied'})),
   personal_emails:['a','b'].map(id=>({placement_drive_id:id})),candidate_matches:[],
   placement_drives:['a','b','c'].map((id,index)=>({id,company_id:'apple',drive_number:String(101+index),normalized_drive_number:String(101+index),source_college_email_id:null})),
   companies:[{id:'apple',name:'Apple',aliases:[]}],
   shared_college_sync_state:[{initial_scan_complete:true,next_page_token:null,is_syncing:false,pending_message_ids:[],pending_offset:0}],
   college_attachments:['a','b'].map(id=>({id:`attachment-${id}`,college_email_id:`email-${id}`,filename:'shortlist.xlsx',size_bytes:100,parse_status:'complete'})),events:[],
  };
  fixture.admin={rpc:vi.fn(async()=>({data:true,error:null})),from:(table:string)=>{
   let single=false;
   const query:Record<string,unknown>={};
   for(const method of ['select','eq','not','order','limit','neq','in'])query[method]=()=>query;
   query.range=(from:number)=>{if(from>0)throw Error('Unexpected second metadata page');return query;};
   query.single=query.maybeSingle=()=>{single=true;return query;};
   query.insert=(value:Record<string,unknown>)=>{writes.push(value);return Promise.resolve({data:null,error:null});};
   query.then=(resolve:(value:unknown)=>unknown)=>{
    const data=table==='college_emails'?fixture.emails:rows[table];
    if(!data)throw Error(`Unexpected table ${table}`);
    return Promise.resolve(resolve({data:single?data[0]:data,error:null}));
   };
   return query;
  }};
 });
 async function scan(targets?:string[]){
  return withOwnedMutationLease('user','owned-test-lease',()=>scanSharedCollegeCandidateMatches(fixture.admin as ReturnType<typeof createAdminClient>,'user',targets));
 }

 it('preserves the exact positive match while avoiding unrelated drive writes and roster reads',async()=>{
  expect(await scan()).toBe(2);
  const expected=writes.find(row=>row.placement_drive_id==='a');
  writes.length=0;fixture.lookup.mockClear();
  expect(await scan(['a'])).toBe(1);
  expect(writes).toEqual([expected]);
  expect(fixture.lookup.mock.calls[0][1]).toEqual(['email-a']);
 });

 it('does not promote an ineligible requested drive or an empty target list',async()=>{
  expect(await scan(['c'])).toBe(0);
  expect(await scan([])).toBe(0);
  expect(writes).toEqual([]);expect(fixture.lookup).not.toHaveBeenCalled();
 });

 it('retains sibling-drive ambiguity instead of treating the selected drive as the only company role',async()=>{
  fixture.emails=fixture.emails.map(email=>({...email,parsed_drive_numbers:[]}));
  expect(await scan(['a'])).toBe(0);
  expect(writes).toEqual([]);
  expect(fixture.lookup.mock.calls[0][1]).toEqual([]);
 });
});
