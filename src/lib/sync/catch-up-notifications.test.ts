import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catchUpMissingNotifications } from './reprocess';
import { notifyNewDrive, notifyEventScheduled, notifyShortlistMatch } from '@/lib/notifications/service';
import { dispatchRoundNotificationOutbox } from './recruitment/round-verdict-service';

vi.mock('./recruitment/round-verdict-service', () => ({ dispatchRoundNotificationOutbox: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/notifications/service', () => ({
  notifyNewDrive: vi.fn().mockResolvedValue({ inAppCreated: true, pushSent: true }),
  notifyEventScheduled: vi.fn().mockResolvedValue({ inAppCreated: true, pushSent: true }),
  notifyShortlistMatch: vi.fn(),
}));
vi.mock('@/lib/utils', () => ({ getDriveMode: vi.fn().mockReturnValue('Online') }));

type Row = Record<string, string | null | undefined>;
type Payload = Record<string, unknown>;
type Data = Record<string, Row[]>;
const USER = 'user';
const NOW = Date.parse('2026-10-07T14:00:00Z');
const iso = (hours: number) => new Date(NOW + hours * 3600000).toISOString();
function fixture(count = 1): Data {
  return {
    applications: Array.from({length: count}, (_, i) => ({id:'app-'+i,user_id:USER,placement_drive_id:'drive-'+i,status:'applied',role:'Engineer',notes:'online',ctc:'10 LPA',location:'Pune',category:'Dream'})),
    placement_drives: Array.from({length: count}, (_, i) => ({id:'drive-'+i,company_id:'company',drive_name:'Fallback',created_at:iso(-100),source_college_email_id:'college-'+i})),
    companies: [{id:'company',name:'Company'}], notifications: [],
    personal_emails: Array.from({length: count}, (_, i) => announcement('p-'+i, 'drive-'+i, iso(-100))),
    college_emails: Array.from({length: count}, (_, i) => circular('college-'+i, iso(-100))), events: [], gmail_accounts: [],
  };
}
const announcement = (id:string, drive:string, date:string, user=USER): Row => ({id,user_id:user,placement_drive_id:drive,received_at:date,sender:'noreply.cdcinfo@vitstudent.ac.in',subject:"Congratulations! You're Eligible for Company Placement Drive",classification:'registration'});
const circular = (id:string, date:string): Row => ({id,received_at:date,classification:'registration',subject:'Company Dream Registration',processing_status:'complete'});

// In-memory PostgREST contract: actually filters, sorts, paginates and enforces
// the 1,000-row default cap; a canned fluent mock would hide scope/paging bugs.
function database(data: Data, failureTable?: string) {
  const requests: Array<{table:string;projection:string;filters:Array<[string,string,unknown]>;range?:number[]}> = [];
  return {requests, from(table: string) {
    const request = {table,projection:'',filters:[] as Array<[string,string,unknown]>,range:undefined as number[]|undefined};
    const order: Array<[string,boolean]> = [];
    const query = {
      select(projection:string) {request.projection=projection; return query;},
      eq(key:string,value:unknown) {request.filters.push(['eq',key,value]);return query;},
      in(key:string,value:string[]) {request.filters.push(['in',key,value]);return query;},
      gte(key:string,value:string) {request.filters.push(['gte',key,value]);return query;},
      neq(key:string,value:string) {request.filters.push(['neq',key,value]);return query;},
      order(key:string,options?:{ascending?:boolean}) {order.push([key,options?.ascending!==false]);return query;},
      range(from:number,to:number) {request.range=[from,to];return query;},
      then(resolve: (value: {data: Row[]|null;error:unknown}) => unknown, reject?: (error:unknown)=>unknown) {
        requests.push(request);
        if (table===failureTable) return Promise.resolve({data:null,error:{code:'READ_FAILED',message:'Test read failure'}}).then(resolve,reject);
        const rows=(data[table]||[]).filter(row=>request.filters.every(([op,key,value])=>{
          if(op==='eq')return row[key]===value;
          if(op==='in')return (value as unknown[]).includes(row[key]);
          if(op==='gte')return row[key]!=null && row[key]>=String(value);
          return row[key]!=null && row[key]!==value;
        })).sort((a,b)=>{
          for(const [key,ascending] of order) {
            if(a[key]===b[key])continue;
            return (String(a[key])<String(b[key])?-1:1)*(ascending?1:-1);
          }
          return 0;
        });
        const [from,to]=request.range||[0,999];
        return Promise.resolve({data:rows.slice(from,to+1),error:null}).then(resolve,reject);
      },
    };
    return query;
  }};
}

// Independent reference for the paired announcement contract and unchanged
// event replay behavior. Also checks bounded batched reads and pagination.
function legacyDecisions(data: Data, scope?:string[]) {
  const newDrives: Payload[]=[]; const events: Payload[]=[];
  const keys=new Set(data.notifications.filter(n=>n.user_id===USER).map(n=>n.dedupe_key));
  for(const app of data.applications.filter(a=>a.user_id===USER && (scope===undefined || scope.includes(a.placement_drive_id || '')))) {
    const id=app.placement_drive_id;
    const drive=data.placement_drives.find(d=>d.id===id);
    if(!drive)continue;
    const companyName=data.companies.find(c=>c.id===drive.company_id)?.name || drive.drive_name || 'Placement Drive';
    const key='new_drive:'+USER+':'+id;
    if(!keys.has(key)) {
      const personal=data.personal_emails.filter(e=>e.user_id===USER && e.placement_drive_id===id && (e.received_at || '')>=iso(-48)).sort((a,b)=>String(b.received_at).localeCompare(String(a.received_at)))[0];
      const college=data.college_emails.find(e=>e.id===drive.source_college_email_id);
      if(personal && college && Math.abs(Date.parse(personal.received_at!)-Date.parse(college.received_at!))<=48*3600000) {
        newDrives.push({userId:USER,placementDriveId:id,companyName,role:app.role||null,ctc:app.ctc||null,stipend:app.stipend||null,location:app.location||null,driveMode:'To be announced',category:app.category||null,sourceEmailId:personal.id});
        keys.add(key);
      }
    }
    for(const event of data.events.filter(e=>e.user_id===USER && e.placement_drive_id===id)) {
      if(!event.start_time || event.event_type==='registration_deadline' || !(Date.parse(event.start_time)>=NOW-24*3600000))continue;
      const dateKey=new Date(event.start_time).toISOString();
      const key='event:'+USER+':'+id+':'+(event.id||event.event_type)+':'+dateKey+':'+(event.venue||'').trim().toLowerCase();
      if(keys.has(key))continue;
      events.push({userId:USER,placementDriveId:id,companyName,eventType:event.event_type,startTime:new Date(event.start_time),venue:event.venue,eventId:event.id,candidateConfirmed:['shortlisted','test_scheduled','interview_scheduled'].includes(app.status || '')});
      keys.add(key);
    }
  }
  return {newDrives,events,result:{newDrivesNotified:newDrives.length,eventsNotified:events.length,shortlistsNotified:0}};
}
const sorted = (values: unknown[]) => values.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
async function assertEquivalent(data:Data,scope?:string[]) {
  const db=database(data);
  const expected=legacyDecisions(data,scope);
  const result=await catchUpMissingNotifications(db,USER,scope);
  expect(result).toEqual(expected.result);
  expect(sorted(vi.mocked(notifyNewDrive).mock.calls.map(([value])=>value))).toEqual(sorted(expected.newDrives));
  expect(sorted(vi.mocked(notifyEventScheduled).mock.calls.map(([value])=>value))).toEqual(sorted(expected.events));
  expect(notifyShortlistMatch).not.toHaveBeenCalled();
  expect(dispatchRoundNotificationOutbox).toHaveBeenCalledTimes(1);
  expect(dispatchRoundNotificationOutbox).toHaveBeenCalledWith(db,USER);
  return db;
}

beforeEach(()=>{vi.clearAllMocks();vi.useFakeTimers();vi.setSystemTime(NOW);});
afterEach(()=>vi.useRealTimers());
describe('notification catch-up pairing',()=>{
  it.each(['personal','college'])('waits for the other circular when %s arrives first',async first=>{
    const data=fixture();data.personal_emails=[];data.college_emails=[];
    if(first==='personal')data.personal_emails=[announcement('p','drive-0',iso(-1))];
    else data.college_emails=[circular('college-0',iso(-1))];
    const db=database(data);
    await catchUpMissingNotifications(db,USER,['drive-0']);expect(notifyNewDrive).not.toHaveBeenCalled();
    data.personal_emails=[announcement('p','drive-0',iso(-1))];data.college_emails=[circular('college-0',iso(-1))];
    await catchUpMissingNotifications(db,USER,['drive-0']);expect(notifyNewDrive).toHaveBeenCalledOnce();
    data.notifications=[{id:'n',user_id:USER,dedupe_key:'new_drive:user:drive-0',push_delivered_at:iso(0)}];
    await catchUpMissingNotifications(db,USER,['drive-0']);expect(notifyNewDrive).toHaveBeenCalledOnce();
  });
  it('retries an unaccepted push through its existing dedupe row',async()=>{
    const data=fixture();data.personal_emails=[announcement('p','drive-0',iso(-1))];data.college_emails=[circular('college-0',iso(-1))];
    data.notifications=[{id:'n',user_id:USER,dedupe_key:'new_drive:user:drive-0',push_delivered_at:null}];
    await catchUpMissingNotifications(database(data),USER,['drive-0']);expect(notifyNewDrive).toHaveBeenCalledOnce();
  });
  it('requires both sources, rejects old personal mail and college/creation-only fallbacks, and preserves dedupe',async()=>{
    const data=fixture(7);
    data.personal_emails=[
      announcement('older','drive-0',iso(-47)), announcement('latest','drive-0',iso(-1)),
      announcement('edge-personal','drive-1',iso(-48)), announcement('too-old','drive-2',iso(-48.0001)),
      announcement('other-user','drive-2',iso(-1),'other'), announcement('deduped','drive-6',iso(-1)),
      announcement('no-college','drive-5',iso(-1)),
    ];
    data.college_emails=[circular('college-0',iso(-1)),circular('college-1',iso(-48)),circular('college-3',iso(-1)),circular('college-2',iso(-48.0001))];
    data.placement_drives[4].created_at=iso(-48);
    data.placement_drives[5].created_at=iso(-48.0001);
    // Legacy keys can have no placement_drive_id; they must still dedupe.
    data.notifications=[{id:'n',user_id:USER,dedupe_key:'new_drive:user:drive-6'}];
    const db=await assertEquivalent(data);
    expect(notifyNewDrive).toHaveBeenCalledTimes(2);
    expect(db.requests.find(r=>r.table==='personal_emails')?.filters).toContainEqual(['in','placement_drive_id',['drive-0','drive-1','drive-2','drive-3','drive-4','drive-5']]);
    expect(db.requests.find(r=>r.table==='college_emails')?.filters).toContainEqual(['in','id',['college-0','college-1','college-2','college-3','college-4','college-5']]);
  });
  it('preserves event window, exact dedupe/venue normalization, statuses and candidate-confirmed flags',async()=>{
    const data=fixture(10);
    const statuses=['shortlisted','test_scheduled','interview_scheduled','applied','not_shortlisted','rejected_test','withdrawn','declined','selected','test_completed'];
    data.applications.forEach((a,i)=>a.status=statuses[i]);
    data.events=statuses.map((_,i)=>({id:'event-'+i,user_id:USER,placement_drive_id:'drive-'+i,event_type:'online_test',start_time:iso(i===0?-24:2),venue:' Hall A '}));
    data.events.push({id:'old',user_id:USER,placement_drive_id:'drive-0',event_type:'ppt',start_time:iso(-24.0001)},
      {id:'registration',user_id:USER,placement_drive_id:'drive-0',event_type:'registration_deadline',start_time:iso(1)},
      {id:'no-date',user_id:USER,placement_drive_id:'drive-0',event_type:'ppt',start_time:null},
      {id:'other-user',user_id:'other',placement_drive_id:'drive-0',event_type:'ppt',start_time:iso(1)});
    data.notifications=[{id:'n',user_id:USER,dedupe_key:'event:user:drive-1:event-1:'+iso(2)+':hall a'}];
    await assertEquivalent(data);
    expect(notifyEventScheduled).toHaveBeenCalledTimes(9);
    // Service-level outcome/preference/manual-override gates are still called,
    // not reimplemented or bypassed by this read optimization.
    expect(notifyEventScheduled).toHaveBeenCalledWith(expect.objectContaining({placementDriveId:'drive-4',candidateConfirmed:false}));
  });
  it('scopes every drive-related read while retaining the whole-user committed outbox dispatch',async()=>{
    const data=fixture(100);
    data.personal_emails=[announcement('p','drive-1',iso(-1)),announcement('unrelated','drive-2',iso(-1))];
    data.college_emails=[circular('college-1',iso(-1)),circular('college-2',iso(-1))];
    data.events=[{id:'e',user_id:USER,placement_drive_id:'drive-2',event_type:'ppt',start_time:iso(1)}];
    const db=await assertEquivalent(data,['drive-1','drive-1']);
    expect(notifyNewDrive).toHaveBeenCalledTimes(1);
    for(const table of ['applications','personal_emails','events'])expect(db.requests.find(r=>r.table===table)?.filters).toContainEqual(['in','placement_drive_id',['drive-1']]);
    expect(db.requests.find(r=>r.table==='placement_drives')?.filters).toContainEqual(['in','id',['drive-1']]);
  });
  it('does not invent raw shortlist alerts and retains sender return/count behavior',async()=>{
    vi.mocked(notifyNewDrive).mockResolvedValueOnce({inAppCreated:false,pushSent:false,complete:false});
    const data=fixture();data.personal_emails=[announcement('p','drive-0',iso(-1))];data.college_emails=[circular('college-0',iso(-1))];
    await assertEquivalent(data);
  });
  it('empty incremental scope reads no applications and still dispatches the existing outbox',async()=>{
    const db=await assertEquivalent(fixture(),[]);
    expect(db.requests).toHaveLength(0);
  });
  it('retains the no-applications early return',async()=>{
    const db=database(fixture(0));
    expect(await catchUpMissingNotifications(db,USER)).toEqual({newDrivesNotified:0,eventsNotified:0,shortlistsNotified:0});
    expect(dispatchRoundNotificationOutbox).not.toHaveBeenCalled();
  });
  it('does not send notifications after a batched read fails',async()=>{
    const data=fixture();data.placement_drives[0].created_at=iso(-1);
    await expect(catchUpMissingNotifications(database(data,'events'),USER)).rejects.toMatchObject({code:'READ_FAILED'});
    expect(notifyNewDrive).not.toHaveBeenCalled();expect(notifyEventScheduled).not.toHaveBeenCalled();
  });
});

describe('notification catch-up request bounds and pagination',()=>{
  it.each([1,100])('uses eight reads for %i old, un-notified drives instead of one read per drive',async count=>{
    const db=await assertEquivalent(fixture(count));
    expect(db.requests).toHaveLength(8);
    for(const table of ['personal_emails','college_emails','events'])expect(db.requests.filter(r=>r.table===table)).toHaveLength(1);
  });
  it('chunks 450 drives into bounded filters rather than N+1 reads',async()=>{
    const db=await assertEquivalent(fixture(450));
    expect(db.requests).toHaveLength(16);
    for(const request of db.requests)for(const [op,,value] of request.filters)if(op==='in')expect((value as string[]).length).toBeLessThanOrEqual(200);
  });
  it('reads beyond PostgREST caps for notifications, events and personal emails',async()=>{
    const data=fixture(3);
    data.notifications=Array.from({length:1001},(_,i)=>({id:String(i).padStart(5,'0'),user_id:USER,dedupe_key:i===1000?'new_drive:user:drive-0':'irrelevant-'+i}));
    data.personal_emails=Array.from({length:1001},(_,i)=>announcement('p'+String(i).padStart(5,'0'),'drive-1',iso(-1-i/10000)));
    data.personal_emails.push(announcement('last-page-other-drive','drive-2',iso(-2)));
    data.college_emails=[circular('college-1',iso(-1)),circular('college-2',iso(-2))];
    data.events=Array.from({length:1001},(_,i)=>({id:'e'+String(i).padStart(5,'0'),user_id:USER,placement_drive_id:'drive-1',event_type:'ppt',start_time:iso(1),venue:'Hall'}));
    const db=await assertEquivalent(data);
    expect(notifyNewDrive).toHaveBeenCalledTimes(2);
    expect(notifyEventScheduled).toHaveBeenCalledTimes(1001);
    for(const table of ['notifications','personal_emails','events'])expect(db.requests.filter(r=>r.table===table)).toHaveLength(2);
  });
});
