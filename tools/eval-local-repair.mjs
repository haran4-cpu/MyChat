import {readFile,writeFile} from 'node:fs/promises';
import {apply, memoryFs, preview} from '../core/agent.mjs';

const tasks = [
  {id:'boundary', code:'function range(n){const out=[];for(let i=0;i<=n;i++)out.push(i);return out}',
    goal:'Fix range(0) and range(3). It must return integers 0 through n-1. Change only the loop condition.',
    allowed:['function range(n){const out=[];for(let i=0;i<n;i++)out.push(i);return out}']},
  {id:'nullish', code:'function count(input){return input || 10;}',
    goal:'Keep 0 and false. Only null and undefined should default to 10. Change only the return expression.',
    allowed:['input ?? 10','input === null || input === undefined ? 10 : input','input !== null && input !== undefined ? input : 10','input == null ? 10 : input'].map(expression=>`function count(input){return ${expression};}`)},
];
const compact = code => code.replace(/\s+/g,'');
function passes(task, edited) {
  return task.allowed.some(expected => compact(expected) === compact(edited));
}
const scope='Two seeded JavaScript fixes. Checks the whole output against reviewed equivalent rewrites; other valid implementations can be missed. No generated source was executed.';
if(process.argv[2]==='--rescore') {
  const path=process.argv[3];
  const evidence=JSON.parse(await readFile(path,'utf8'));
  for(const row of evidence.rows) {
    row.initialStrictScore=row.passed;
    row.passed=typeof row.edited==='string' && passes(tasks.find(t=>t.id===row.task),row.edited);
  }
  await writeFile(path,JSON.stringify({scope,rows:evidence.rows},null,2));
  process.exit(0);
}
const models = process.argv.slice(3);
if (!models.length) throw Error('Usage: node tools/eval-local-repair.mjs RESULTS.json MODEL [MODEL...]');
const output = process.argv[2];
const rows = [];
const schema = {type:'object',properties:{old:{type:'string'},replacement:{type:'string'}},required:['old','replacement'],additionalProperties:false};
for (const model of models) {
  try {
    for(const task of tasks) {
      const start=performance.now();
      try {
        const res=await fetch('http://127.0.0.1:11434/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(120000),body:JSON.stringify({model,stream:false,think:false,format:schema,keep_alive:'2m',options:{temperature:0,seed:42,num_gpu:0,num_thread:4,num_ctx:4096,num_predict:100},messages:[{role:'system',content:'Return only one smallest exact text replacement as JSON: old and replacement.'},{role:'user',content:task.goal+'\n'+task.code}]})});
        const data=await res.json();
        if(!res.ok||!data.done||data.done_reason==='length')throw Error(`Incomplete model reply (${res.status}, ${data.done_reason||'error'})`);
        const proposal=JSON.parse(data.message.content);
        const fs=memoryFs({'fixture.js':task.code});
        const ops=[{op:'edit',path:'fixture.js',old:proposal.old,new:proposal.replacement}];
        const plan={id:'evaluation',ops,preview:await preview(fs,ops),enforcePreview:true};
        const journal=await apply(fs,plan);
        const edited=await fs.read('fixture.js');
        rows.push({model,task:task.id,passed:journal.steps.length===1&&passes(task,edited),elapsedMs:performance.now()-start,inputTokens:data.prompt_eval_count,outputTokens:data.eval_count,proposal,edited});
      }catch(error){rows.push({model,task:task.id,passed:false,elapsedMs:performance.now()-start,error:error.message});}
      await writeFile(output,JSON.stringify({scope,rows},null,2));
      console.log(JSON.stringify(rows.at(-1)));
    }
  }finally{
    await fetch('http://127.0.0.1:11434/api/generate',{method:'POST',body:JSON.stringify({model,keep_alive:0}),signal:AbortSignal.timeout(7000)}).catch(()=>{});
  }
}
