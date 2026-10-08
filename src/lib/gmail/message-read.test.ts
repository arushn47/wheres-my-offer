import {expect,it} from 'vitest';
import {readGmailMessageIfPresent} from './message-read';
it('finishes a deleted message instead of leaving its queue entry retrying forever',async()=>{
  expect(await readGmailMessageIfPresent(async()=>{throw {code:404,message:'Not found'}})).toBeNull();
});
it('does not swallow authentication, quota or transient errors',async()=>{
  for(const code of [401,403,429,503]) await expect(readGmailMessageIfPresent(async()=>{throw {code}})).rejects.toEqual({code});
});
