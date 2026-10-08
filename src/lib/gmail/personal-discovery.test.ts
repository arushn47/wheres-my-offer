import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({list:vi.fn(),history:vi.fn(),profile:vi.fn()}));
vi.mock('./client',()=>({fetchMessageIds:mocks.list,getPlacementSearchQuery:()=> 'official-placement-season'}));
vi.mock('./history',()=>({fetchHistoryChanges:mocks.history,getProfileHistoryId:mocks.profile}));
import {discoverPersonalMessages} from './personal-discovery';
const gmail={} as Parameters<typeof discoverPersonalMessages>[0];
beforeEach(()=>{vi.resetAllMocks();mocks.profile.mockResolvedValue('100');mocks.list.mockResolvedValue(['old']);});
it('uses only added-message history on an established account, without searching the season',async()=>{
  mocks.history.mockResolvedValue({messageIds:['new','deleted'],deletedMessageIds:['deleted'],latestHistoryId:'110',historyExpired:false});
  expect(await discoverPersonalMessages(gmail,'100')).toEqual({messageIds:['new'],nextHistoryId:'110'});
  expect(mocks.history).toHaveBeenCalledWith(gmail,'100',{addedOnly:true});
  expect(mocks.list).not.toHaveBeenCalled();expect(mocks.profile).not.toHaveBeenCalled();
});
it('captures a checkpoint before initial discovery, leaving concurrent arrivals for the next run',async()=>{
  expect(await discoverPersonalMessages(gmail,null)).toEqual({messageIds:['old'],nextHistoryId:'100'});
  expect(mocks.profile.mock.invocationCallOrder[0]).toBeLessThan(mocks.list.mock.invocationCallOrder[0]);
});
it('recovers an expired cursor with one season scan and its already captured boundary',async()=>{
  mocks.history.mockResolvedValue({historyExpired:true,latestHistoryId:'200'});
  expect((await discoverPersonalMessages(gmail,'100')).nextHistoryId).toBe('200');
  expect(mocks.list).toHaveBeenCalledOnce();expect(mocks.profile).not.toHaveBeenCalled();
});
it('propagates transient history failures without falling back to a season scan',async()=>{
  mocks.history.mockRejectedValue(new Error('quota'));
  await expect(discoverPersonalMessages(gmail,'100')).rejects.toThrow('quota');expect(mocks.list).not.toHaveBeenCalled();
});
