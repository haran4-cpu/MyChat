import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parseArgs} from 'node:util';
import {repairFixtures,runRepairTrial} from './repair-trial-lib.mjs';

const {values:flags}=parseArgs({options:{
  'model':{type:'string',multiple:true},'task':{type:'string'},'online':{type:'boolean'},
  'online-only':{type:'boolean'},'output':{type:'string'},'mychat-mode':{type:'string',default:'fast'},
}});
const selected = flags.task ? repairFixtures.filter(t=>t.id===flags.task) : repairFixtures;
if(!selected.length) throw Error(`Available tasks: ${repairFixtures.map(t=>t.id).join(', ')}`);
const models=flags.model||['qwen2.5-coder:3b','kestrel-agent:latest'];
if(models.length>3)throw Error('At most three local attempts per task');
if(!['fast','auto','max','verified'].includes(flags['mychat-mode']))throw Error('Unsupported MyChat mode');
const start=Date.now();
const interrupted=new AbortController();
const interrupt=()=>interrupted.abort(new Error('Stopped by user'));
const deadline=AbortSignal.any([interrupted.signal,AbortSignal.timeout(8*60_000)]);
const system='You repair one JavaScript expression. Return exactly one JSON object with string keys old and replacement. Copy the original old text literally. Preserve surrounding code.';
const schema={type:'object',properties:{old:{type:'string'},replacement:{type:'string'}},required:['old','replacement'],additionalProperties:false};
function messages(task,feedback){
  return [{role:'system',content:system},{role:'user',content:`Requirement: ${task.requirement}\nOriginal JavaScript:\n${task.source}${feedback?'\nPrevious attempt failed. Verification feedback: '+feedback:''}`}];
}
async function request(url,body,signal,headers={}){
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),
    signal:AbortSignal.any([signal,AbortSignal.timeout(90000)])});
  if(!r.ok)throw Error(`HTTP ${r.status}`);
  return r.json();
}
const local = model=>({name:model,async propose({task,feedback,signal}){
  const d=await request('http://127.0.0.1:11434/api/chat',{model,messages:messages(task,feedback),think:false,stream:false,
    format:schema,keep_alive:'2m',options:{temperature:0,seed:42,num_gpu:0,num_thread:4,num_ctx:4096,num_predict:100}},signal);
  if(d.done!==true||d.done_reason==='length')throw Error('Ollama did not return a complete proposal');
  return {content:d.message?.content,provider:'ollama',usage:{input:d.prompt_eval_count,output:d.eval_count}};
}});
const online = {name:`mychat/${flags['mychat-mode']}`,async propose({task,feedback,signal}){
  const home=process.env.MYCHAT_HOME||path.join(process.env.APPDATA||path.join(os.homedir(),'.config'),'MyChat');
  const token=(await fs.readFile(path.join(home,'token'),'utf8')).trim();
  const d=await request('http://127.0.0.1:11500/v1/chat/completions',{model:online.name,messages:messages(task,feedback),
    response_format:{type:'json_object'},stream:false,temperature:0,max_tokens:130},signal,{Authorization:`Bearer ${token}`});
  return {content:d.choices?.[0]?.message?.content,usage:d.usage,provider:d.mychat?.provider,model:d.mychat?.model};
}};
const lanes=flags['online-only']?[online]:[...models.map(local),...(flags.online?[online]:[])];
const output=path.resolve(flags.output||`repair-lab-${new Date(start).toISOString().replace(/[:.]/g,'-')}.json`);
if(process.platform==='win32'&&!/^C:\\/i.test(output))throw Error('Choose an output path on C:');
const log=await fs.open(output,'wx');
process.once('SIGINT',interrupt);
const results=[];
const summary={mode:flags['online-only']?'mychat':flags.online?'local+mychat':'local',
  note:'Reviewed synthetic fixtures only. Attempts use in-memory proposals, no code execution, no weight updates. MyChat modes may call multiple providers internally.',results};
try {
  for(const task of selected){
    const row=await runRepairTrial(task,lanes,{signal:deadline,onAttempt(a){console.log(`${task.id} · ${a.lane} · ${a.passed?'PASS':'FAIL'} · ${Math.round(a.elapsedMs)} ms`);}});
    results.push(row);
  }
}catch(error){summary.error=error.message;process.exitCode=1;}
finally{
  process.removeListener('SIGINT',interrupt);
  summary.elapsedMs=Date.now()-start;
  await log.writeFile(JSON.stringify(summary,null,2));
  await log.close();
  console.log(output);
}
if(results.some(r=>!r.passed))process.exitCode=1;
