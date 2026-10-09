import { describe,it,expect,vi,beforeEach } from 'vitest';
import { DEFAULT_PREFERENCES } from './preferences-model';
const state=vi.hoisted(()=>({rows:[] as Array<Record<string,unknown>>,insertFailure:false,decisionEligible:true,claimed:false,decisionCurrent:true,negativeFinal:true,negativeState:'verified_absent',applicationStatus:'applied',manualOverride:false,legacyNegative:false}));
const push=vi.hoisted(()=>vi.fn());
vi.mock('./push',()=>({sendPushToUser:push}));
vi.mock('./preferences',()=>({getNotificationPreferences:vi.fn(async()=>({...DEFAULT_PREFERENCES,userId:'user'}))}));
vi.mock('@/lib/supabase/admin',()=>({createAdminClient:()=>({
  rpc:async(name:string)=>{if(name==='has_negative_round_notification')return {data:state.legacyNegative,error:null};if(state.claimed)return {data:null,error:null};state.claimed=true;return {data:true,error:null};},
  from:(table:string)=>{
    const filters:Record<string,unknown>={};
    const chain={
      select:()=>chain,
      eq:(field:string,value:unknown)=>{filters[field]=value;return chain;},
      maybeSingle:async()=>({data:table==='round_verdicts'?{is_current:state.decisionCurrent,verdict:{eligible:state.decisionEligible,state:state.negativeState,finalNegative:state.negativeFinal,reason:'complete_list_absence',evaluations:[{state:'verified_absent'}]}}:table==='applications'?{status:state.applicationStatus,manual_override:state.manualOverride}:state.rows.find(row=>Object.entries(filters).every(([field,value])=>row[field]===value)),error:null}),
      insert:(row:Record<string,unknown>)=>({select:()=>({single:async()=>{
        if(state.insertFailure)return {data:null,error:{code:'XX001',message:'Fixture insert failure'}};
        const stored={...row,id:'notification'};state.rows.push(stored);return {data:stored,error:null};
      }})}),
      update:(values:Record<string,unknown>)=>({eq:async(field:string,value:unknown)=>{for(const row of state.rows.filter(row=>row[field]===value))Object.assign(row,values);state.claimed=false;return {error:null};}}),
    };return chain;
  },
})}));
import { sendNotification } from './service';
import { getNotificationPreferences } from './preferences';
const params={userId:'user',placementDriveId:'drive',type:'shortlist_match' as const,title:'Fixture shortlist',body:'Fixture',dedupeKey:'fixture',decisionId:'decision'};
beforeEach(()=>{state.rows=[];state.insertFailure=false;state.decisionEligible=true;state.claimed=false;state.decisionCurrent=true;state.negativeFinal=true;state.negativeState='verified_absent';state.applicationStatus='applied';state.manualOverride=false;state.legacyNegative=false;push.mockReset();});
describe('committed shortlist delivery',()=>{
 const absentParams={...params,title:'Not Shortlisted: Fixture',dedupeKey:'shortlist_absent:user:drive'};
 it('keeps legacy elimination alerts as a dedupe ledger without creating another alert',async()=>{
  state.decisionEligible=false;state.legacyNegative=true;await sendNotification(absentParams);
  expect(state.rows).toHaveLength(0);expect(push).not.toHaveBeenCalled();
 });
 it('respects a disabled shortlist preference for negative outcomes',async()=>{
  state.decisionEligible=false;vi.mocked(getNotificationPreferences).mockResolvedValueOnce({...DEFAULT_PREFERENCES,userId:'user',notifyShortlist:false});
  expect((await sendNotification(absentParams)).complete).toBe(true);
  expect(state.rows).toHaveLength(0);expect(push).not.toHaveBeenCalled();
 });
 it('still creates the negative in-app alert when browser push is disabled',async()=>{
  state.decisionEligible=false;vi.mocked(getNotificationPreferences).mockResolvedValueOnce({...DEFAULT_PREFERENCES,userId:'user',browserPushEnabled:false});
  expect((await sendNotification(absentParams)).inAppCreated).toBe(true);
  expect(state.rows).toHaveLength(1);expect(push).not.toHaveBeenCalled();
 });
 it('persists and pushes a confirmed negative once using the shortlist preference',async()=>{
  state.decisionEligible=false;push.mockResolvedValue({sent:1});
  expect((await sendNotification(absentParams)).complete).toBe(true);
  expect((await sendNotification(absentParams)).pushSent).toBe(false);
  expect(state.rows).toHaveLength(1);expect(push).toHaveBeenCalledTimes(1);
 });
 it.each(['withdrawn','declined','not_applied','unknown','registration_open'])('blocks a negative when participation is now %s',async status=>{
  state.decisionEligible=false;state.applicationStatus=status;await sendNotification(absentParams);
  expect(state.rows).toHaveLength(0);expect(push).not.toHaveBeenCalled();
 });
 it('blocks partial, manual, superseded, and positive decisions from sending a negative payload',async()=>{
  await sendNotification(absentParams);expect(state.rows).toHaveLength(0);
  state.decisionEligible=false;state.negativeFinal=false;await sendNotification(absentParams);expect(state.rows).toHaveLength(0);
  state.negativeFinal=true;state.manualOverride=true;await sendNotification(absentParams);expect(state.rows).toHaveLength(0);
  state.manualOverride=false;state.decisionCurrent=false;await sendNotification(absentParams);expect(state.rows).toHaveLength(0);
  expect(push).not.toHaveBeenCalled();
 });
 it('retries failed negative push using the same in-app record',async()=>{
  state.decisionEligible=false;push.mockResolvedValueOnce({sent:0}).mockResolvedValueOnce({sent:1});
  expect((await sendNotification(absentParams)).complete).toBe(false);
  expect((await sendNotification(absentParams)).complete).toBe(true);
  expect(state.rows).toHaveLength(1);expect(push).toHaveBeenCalledTimes(2);
 });
 it('releases a push claim when the subscription lookup throws so delivery can retry',async()=>{
  push.mockRejectedValueOnce(new Error('Subscription lookup unavailable'));
  await expect(sendNotification(params)).rejects.toThrow('Subscription lookup unavailable');
  expect(state.claimed).toBe(false);expect(state.rows[0].push_delivered_at).toBeNull();
  push.mockResolvedValueOnce({sent:1,failed:0});
  expect((await sendNotification(params)).pushSent).toBe(true);expect(state.rows).toHaveLength(1);
 });
 it('does not dispatch when the current decision denies eligibility',async()=>{
  state.decisionEligible=false;await sendNotification(params);expect(state.rows).toHaveLength(0);expect(push).not.toHaveBeenCalled();
 });
 it('does not push when notification persistence fails',async()=>{
  state.insertFailure=true;const log=vi.spyOn(console,'error').mockImplementation(()=>{});try{expect((await sendNotification(params)).complete).toBe(false);expect(push).not.toHaveBeenCalled();}finally{log.mockRestore();}
 });
 it('retries failed push without duplicating the in-app message, then suppresses replay',async()=>{
  push.mockResolvedValueOnce({sent:0}).mockResolvedValueOnce({sent:1});
  expect((await sendNotification(params)).complete).toBe(false);expect(state.rows).toHaveLength(1);
  expect((await sendNotification(params)).complete).toBe(true);expect(state.rows).toHaveLength(1);
  expect((await sendNotification(params)).pushSent).toBe(false);expect(push).toHaveBeenCalledTimes(2);
 });
 it('does not take an active push claim owned by another attempt',async()=>{
  state.claimed=true;expect((await sendNotification(params)).complete).toBe(false);expect(push).not.toHaveBeenCalled();
 });
});
