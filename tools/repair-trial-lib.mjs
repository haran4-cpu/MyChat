import {apply, memoryFs, preview} from '../core/agent.mjs';

// Small reviewed fixtures. The validator recognizes full, reviewed rewrites;
// candidates never run in this harness.
export const repairFixtures = [
  {id:'range', source:'function range(n){const out=[];for(let i=0;i<=n;i++)out.push(i);return out}',
    requirement:'Return the integers 0 through n-1. Change only the loop condition.',
    checks:'range(0) must be []; range(3) must be [0,1,2].',
    accepted:['function range(n){const out=[];for(let i=0;i<n;i++)out.push(i);return out}']},
  {id:'nullish', source:'function count(input){return input || 10;}',
    requirement:'Default to 10 only for null and undefined. Change only the return expression.',
    checks:'count(0) must be 0, count(false) must be false, and count(null) and count(undefined) must be 10.',
    accepted:['input ?? 10','input === null || input === undefined ? 10 : input',
      'input !== null && input !== undefined ? input : 10','input == null ? 10 : input'].map(x=>`function count(input){return ${x};}`)},
  {id:'safe-integer', source:'function valid(x){return Number.isInteger(x);}',
    requirement:'Require an integer within the JavaScript safe integer range. Change only the return expression.',
    checks:'valid(9007199254740992) must be false; valid(9007199254740991) and valid(-9007199254740991) must be true.',
    accepted:['Number.isSafeInteger(x)', 'Number.isInteger(x) && x >= Number.MIN_SAFE_INTEGER && x <= Number.MAX_SAFE_INTEGER']
      .map(x=>`function valid(x){return ${x};}`)},
];

const normalize = value => value.replace(/\s+/g,'');

export async function checkCandidate(task, content) {
  let proposal;
  try { proposal = JSON.parse(String(content).trim().replace(/^```(?:json)?\s*|\s*```$/g,'')); }
  catch { return {passed:false,reason:'The response was not valid JSON. Return exactly one old/replacement object.'}; }
  const {old,replacement} = proposal || {};
  if (typeof old !== 'string' || typeof replacement !== 'string' || !old || old === replacement || old.length > 500 || replacement.length > 500) {
    return {passed:false,reason:'The change was empty, unchanged, or had invalid fields. Use one nonempty exact replacement.'};
  }
  const fs = memoryFs({'fixture.js':task.source});
  const ops = [{op:'edit',path:'fixture.js',old,new:replacement}];
  const staged = await preview(fs,ops);
  if (staged[0]?.error) return {passed:false,proposal,reason:staged[0].error};
  const journal = await apply(fs,{id:'fixture',ops,preview:staged,enforcePreview:true});
  if(journal.steps.length!==1) return {passed:false,proposal,reason:journal.error || 'The old text must occur exactly once in the original source.'};
  const edited = await fs.read('fixture.js');
  const passed = task.accepted.some(expected=>normalize(expected)===normalize(edited));
  return {passed,proposal,edited,...(!passed?{reason:`The validator did not recognize this rewrite. Target behavior: ${task.checks} Recheck the smallest changed expression and preserve surrounding code.`}:{})};
}

export async function runRepairTrial(task, lanes, {signal,onAttempt=()=>{}}={}) {
  if (!lanes.length || lanes.length > 4) throw Error('Use between one and four attempts');
  const attempts=[];
  let feedback='';
  for (const lane of lanes) {
    signal?.throwIfAborted();
    const started = performance.now();
    let row;
    try {
      const answer = await lane.propose({task,feedback,signal});
      const result = await checkCandidate(task,answer.content);
      row={lane:lane.name,...result,usage:answer.usage,provider:answer.provider,model:answer.model};
    } catch (error) {
      signal?.throwIfAborted();
      row={lane:lane.name,passed:false,reason:'Model request failed: '+String(error.message).slice(0,200)};
    }
    row.elapsedMs=performance.now()-started;
    attempts.push(row);
    await onAttempt(row);
    if(row.passed)break;
    feedback=row.reason;
  }
  return {task:task.id,passed:attempts.at(-1).passed,attempts};
}
