import { spawn } from "node:child_process";
import path from "node:path";

const formats = {docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx:"application/vnd.openxmlformats-officedocument.presentationml.presentation",pdf:"application/pdf"};
const make = `
import json, sys, tempfile
from pathlib import Path
from kestrel import docs, verify
request = json.load(sys.stdin)
ext = "." + request["format"]
with tempfile.TemporaryDirectory(prefix="mychat-export-") as temp:
    target = Path(temp) / ("document" + ext)
    target.write_bytes(docs.MAKERS[ext](request["content"], request["title"]))
    issue = verify.check_file(target)
    if issue:
        raise RuntimeError("Generated document failed validation")
    sys.stdout.buffer.write(target.read_bytes())
`;

export async function makeDocument(b) {
  const { format, content } = b;
  if (!Object.hasOwn(formats,format) || typeof content!=="string" || !content.trim() || Buffer.byteLength(content)>128*1024) {
    throw new Error("Choose Word, Excel, PowerPoint or PDF and provide up to 128 KiB of text.");
  }
  const title=String(b.title||"Document").trim().slice(0,120)||"Document";
  const folder=process.env.KESTREL_HOME||"C:/AI-Workspace/Kestrel";
  const python=process.env.MYCHAT_DOCUMENT_PYTHON||"C:/Python314/python.exe";
  const bytes=await new Promise((resolve,reject)=>{
    const p=spawn(python,["-B","-c",make],{cwd:folder,windowsHide:true,signal:AbortSignal.timeout(20000),stdio:["pipe","pipe","ignore"],
      env:{...process.env,PYTHONPATH:folder,PYTHONIOENCODING:"utf-8"}});
    const chunks=[];
    let total=0;
    p.stdout.on("data",chunk=>{total+=chunk.length;if(total<=8*1024*1024)chunks.push(chunk);else p.kill();});
    p.stdin.on("error",()=>{});
    p.on("error",()=>reject(new Error("The local document engine could not start or timed out.")));
    p.on("close",code=>code===0 && total>0 && total<=8*1024*1024 ? resolve(Buffer.concat(chunks)) : reject(new Error("The local document did not pass validation.")));
    p.stdin.end(JSON.stringify({format,content,title}));
  });
  return {name:(title.replace(/[<>:"/\\|?*\x00-\x1f]/g,"_").replace(/[. ]+$/g,"")||"Document")+"."+format,
    bytes:bytes.length,mediaType:formats[format],data:bytes.toString("base64")};
}

async function kestrel(endpoint,body) {
  const r=await fetch("http://127.0.0.1:8765"+endpoint,{
    signal:AbortSignal.timeout(5000),redirect:"error",...(body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{})
  });
  const j=await r.json();
  if(!r.ok || j.ok===false)throw new Error(j.error||"Kestrel did not complete the request.");
  return j;
}

export async function missions() {
  const j=await kestrel("/api/status");
  return {missions:j.missions||[],pending:(j.pending||[]).length,online:j.online===true};
}

export async function mission(id) {
  if(!/^\d{8}-\d{6}-[a-f0-9]{4}$/.test(id||""))throw new Error("Invalid mission ID.");
  const m=await kestrel("/api/mission?id="+id);
  return {id:m.id,status:m.status,goal:m.goal,steps:(m.steps||[]).map(({title,status,summary})=>({title,status,summary}))};
}

export async function changeMission(b) {
  const state=await missions();
  if(state.online)throw new Error("Switch Kestrel to local mode before starting or resuming from this screen.");
  if (b.action==="start") {
    const goal=typeof b.goal==="string"?b.goal.trim():"";
    if(!goal||goal.length>4000)throw new Error("Enter a mission goal up to 4,000 characters.");
    return kestrel("/api/mission/start",{goal});
  }
  if (b.action==="resume") {
    const prior=await mission(b.id);
    if(!["paused","error","interrupted","done_with_blocks"].includes(prior.status))throw new Error("Only a stopped or blocked mission can be resumed from here.");
    return kestrel("/api/mission/resume",{id:prior.id});
  }
  throw new Error("Unknown mission action.");
}
