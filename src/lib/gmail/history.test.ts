import {expect,it,vi} from 'vitest';
import {fetchHistoryChanges} from './history';
it('ignores label-only changes and generic message references in added-only discovery',async()=>{
  const list=vi.fn().mockResolvedValue({data:{historyId:'103',history:[
    {messages:[{id:'label-only'}],labelsAdded:[{message:{id:'label-only'}}]},
    {messagesAdded:[{message:{id:'first'}}]},
    {messagesAdded:[{message:{id:'last'}}],messagesDeleted:[{message:{id:'removed'}}]},
  ]}});
  const gmail={users:{history:{list}}} as unknown as Parameters<typeof fetchHistoryChanges>[0];
  const result=await fetchHistoryChanges(gmail,'100',{addedOnly:true});
  expect(result.messageIds).toEqual(['last','first']);
  expect(result.deletedMessageIds).toEqual(['removed']);
  expect(list).toHaveBeenCalledWith(expect.objectContaining({historyTypes:['messageAdded','messageDeleted']}));
});
it('keeps existing label-change discovery available for the shared College pipeline',async()=>{
  const list=vi.fn().mockResolvedValue({data:{historyId:'103',history:[{labelsAdded:[{message:{id:'changed'}}]}]}});
  const gmail={users:{history:{list}}} as unknown as Parameters<typeof fetchHistoryChanges>[0];
  expect((await fetchHistoryChanges(gmail,'100')).messageIds).toEqual(['changed']);
  expect(list.mock.calls[0][0]).not.toHaveProperty('historyTypes');
});
