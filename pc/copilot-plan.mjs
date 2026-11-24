import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// tokenSource (optional): async () => a GitHub token with Copilot access (e.g. from the Windows Credential Manager).
// When it returns a token, the runtime signs in with it (official github.token option); otherwise the device sign-in is used.
const OK_AUTH = new Set(["user", "token"]);
export function createCopilotConnector(home, { tokenSource } = {}) {
  const install = path.join(home,"github-copilot-connector");
  const directory = path.join(home,"copilot-plan");
  const workspace = path.join(directory,"empty-workspace");
  const exe = path.join(install,"node_modules","@github","copilot-win32-"+process.arch,"copilot.exe");
  const env = {...process.env,COPILOT_HOME:directory};
  for (const key of Object.keys(env)) {
    if (/^(GH_TOKEN|GITHUB_TOKEN|COPILOT_GITHUB_TOKEN|GITHUB_COPILOT_API_TOKEN|COPILOT_API_URL|COPILOT_PROVIDER_.*)$/i.test(key)) delete env[key];
  }
  let sdk, login, error, cache, inspecting;
  async function withClient(fn) {
    mkdirSync(workspace,{recursive:true});
    const {CopilotClient, RuntimeConnection} = await (sdk ??= import(pathToFileURL(createRequire(path.join(install,"package.json")).resolve("@microsoft/copilot-sdk")).href));
    const token = tokenSource ? await tokenSource().catch(() => null) : null;
    const client = new CopilotClient({mode:"empty",...(token ? {github:{token}} : {}),runtime:RuntimeConnection.forSpawnedStdio({
      baseDirectory:directory, workingDirectory:workspace, env,
    })});
    try { await client.start(); return await fn(client); }
    finally { await client.stop(); }
  }
  async function inspect() {
    if (!existsSync(exe)) return {status:"unavailable",sharing:false,models:[]};
    if (login) return {status:"connecting",sharing:false,models:[],...login.consent};
    if (cache && Date.now()<cache.until) return cache.value;
    return inspecting ??= (async()=>{
      try {
        const value = await withClient(async client => {
          const auth = await client.getAuthStatus();
          if (!auth.isAuthenticated || !OK_AUTH.has(auth.authType)) return {status:"disconnected",sharing:false,models:[],error};
          try {
            const list = await client.listModels();
            return {status:"connected",sharing:true,account:auth.login,via:auth.authType,models:list
              .filter(m=>m.policy?.state!=="disabled" && m.policy?.state!=="unconfigured")
              .map(m=>({slug:m.id,displayName:m.name||m.id}))};
          } catch { return {status:"connected",sharing:true,account:auth.login,models:[],error:"GitHub could not list models for this account. Check Copilot access and organization policy."}; }
        });
        cache = {value,until:Date.now()+15000};
        return value;
      } catch {
        return {status:"error",sharing:false,models:[],error:"Copilot runtime could not start."};
      } finally { inspecting=null; }
    })();
  }
  async function start() {
    if (login) throw new Error("Copilot sign-in is already in progress.");
    if (!existsSync(exe)) throw new Error("GitHub Copilot CLI is unavailable.");
    mkdirSync(workspace,{recursive:true});
    cache=null; error=undefined;
    const child=spawn(exe,["login","--device-code"],{cwd:workspace,env,windowsHide:true,stdio:["ignore","pipe","pipe"],timeout:300000});
    const attempt={child}; login=attempt;
    return new Promise((resolve,reject)=>{
      let text="";
      const read=(chunk)=>{
        text=(text+chunk).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g,"").slice(-10000);
        const code=text.match(/\b([A-Z\d]{4}-[A-Z\d]{4})\b/)?.[1];
        if (code && /github\.com\/login\/device/i.test(text) && !attempt.consent) {
          attempt.consent={url:"https://github.com/login/device",code};
          resolve(attempt.consent);
        }
      };
      child.stdout.on("data",read); child.stderr.on("data",read);
      child.once("error",()=>reject(new Error("Could not start Copilot login.")));
      child.once("close",code=>{
        if(login===attempt) login=null;
        cache=null;
        if(code!==0 && !attempt.cancelled) error="Copilot sign-in was not completed. Try again.";
        if(!attempt.consent) reject(new Error(error||"Copilot sign-in did not return a device code."));
      });
    });
  }
  async function cancel() { if(login){login.cancelled=true; login.child.kill();} }
  async function answer(model, req, opt) {
    if (req.tools?.length || req.response_format || !Array.isArray(req.messages) || req.messages.some(m=>typeof m.content!=="string" || !["user","assistant","developer","system"].includes(m.role))) {
      throw new Error("Copilot mode supports text conversations.");
    }
    if (!(await inspect()).models.some(m=>m.slug===model)) throw new Error("Sign in to GitHub Copilot and choose an available model.");
    return withClient(async client=>{
      const auth=await client.getAuthStatus();
      if(!auth.isAuthenticated || !OK_AUTH.has(auth.authType)) throw new Error("Sign in to GitHub Copilot again.");
      opt.signal?.throwIfAborted();
      const session=await client.createSession({model,workingDirectory:workspace,
        tools:{availableTools:[]}, permissions:{onRequest:async()=>({kind:"denied-by-rules"})}, events:{streaming:true}});
      const abort=()=>{session.abort().catch(()=>{});};
      opt.signal?.addEventListener("abort",abort,{once:true});
      let streamed = false;
      session.on("assistant.message_delta",e=>{streamed = true; opt.onDelta?.(e.data.deltaContent);});
      try {
        opt.signal?.throwIfAborted();
        const r=await session.sendAndWait({prompt:JSON.stringify(req.messages.map(({role,content})=>({role,content})))},120000);
        const content=r?.data?.content;
        if(!content?.trim()) throw new Error("GitHub Copilot returned no response.");
        if (!streamed) opt.onDelta?.(content);
        return {content,provider:"github-copilot",model,mode:"github-copilot",trace:[{step:"answer",by:"github-copilot:"+model}]};
      } finally {
        opt.signal?.removeEventListener("abort",abort);
        await session.disconnect().catch(()=>{});
        await client.deleteSession(session.sessionId).catch(()=>{});
      }
    });
  }
  return {inspect,start,cancel,answer};
}
