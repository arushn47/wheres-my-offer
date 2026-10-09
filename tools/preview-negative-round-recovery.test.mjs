import { test } from 'node:test';
import assert from 'node:assert/strict';
import { negativeRecoveryPreview } from './preview-negative-round-recovery.mjs';
test('requires an explicit bounded recovery window',()=>{
  for(const args of [[],['bad','bad'],['2026-10-09','2026-10-08'],['2026-10-07','2026-10-09']]) assert.throws(()=>negativeRecoveryPreview(...args),/explicit valid window/);
  const query=negativeRecoveryPreview('2026-10-08T18:30:00Z','2026-10-09T18:30:00Z');
  assert.deepEqual(query.params,['2026-10-08T18:30:00.000Z','2026-10-09T18:30:00.000Z']);
  assert.match(query.sql,/LIMIT 21/);assert.match(query.sql,/v.is_current/);
  assert.doesNotMatch(query.sql,/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CALL)\b/i);
});
