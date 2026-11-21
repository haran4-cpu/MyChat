import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkCandidate,repairFixtures,runRepairTrial} from '../tools/repair-trial-lib.mjs';

test('failed check feeds the next model and the first passing proposal stops the loop',async()=>{
  const task=repairFixtures.find(x=>x.id==='range');
  const result=await runRepairTrial(task,[
    {name:'first',propose:async()=>({content:'{"old":"i<=n","replacement":"i<n+1"}'})},
    {name:'second',propose:async({feedback})=>{
      assert.match(feedback,/range\(0\) must be \[\]/);
      return {content:'{"old":"i<=n","replacement":"i<n"}'};
    }},
    {name:'unused',propose:()=>assert.fail('Unexpected third call')},
  ]);
  assert.equal(result.passed,true);
  assert.deepEqual(result.attempts.map(x=>x.passed),[false,true]);
  assert.equal(task.source.includes('i<=n'),true);
});

test('stops at the attempt budget and reports invalid exact replacement',async()=>{
  const result=await runRepairTrial(repairFixtures[0], [{name:'bad',propose:async()=>({content:'{"old":"missing","replacement":"x"}'})}]);
  assert.equal(result.passed,false);
  assert.equal(result.attempts.length,1);
  assert.match(result.attempts[0].reason,/not found/);
});

test('an aborted trial contacts no model',async()=>{
  const controller=new AbortController();
  controller.abort();
  await assert.rejects(runRepairTrial(repairFixtures[0],[{name:'unused',propose:()=>assert.fail('Unexpected call')}],{signal:controller.signal}),{name:'AbortError'});
});

test('recognizes explicit bounds as equivalent to Number.isSafeInteger',async()=>{
  const task=repairFixtures.find(x=>x.id==='safe-integer');
  const result=await checkCandidate(task,JSON.stringify({old:'Number.isInteger(x)',replacement:'Number.isInteger(x) && x >= Number.MIN_SAFE_INTEGER && x <= Number.MAX_SAFE_INTEGER'}));
  assert.equal(result.passed,true);
});
