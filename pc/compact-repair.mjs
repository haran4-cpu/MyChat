import { checkOps, editText, newId, workspaceReader } from "../core/agent.mjs";

export async function smallLocalRepair(gw, {goal, fs, signal, history}) {
  if (history.length || !/(?:\bfix\b|\brepair\b|תקן|תתקן|תיקון)/i.test(goal)) return null;
  const reader = workspaceReader(fs);
  const files = await reader.files("", {limit: 33});
  if (files.length >= 33) return null;
  const code = files.filter(f => /\.(m?js|cjs|jsx|tsx?|py|html?|css)$/i.test(f.path));
  if (!code.length || code.length > 8 || code.reduce((n,f) => n + (f.size ?? 12000), 0) > 12000) return null;
  const source = new Map();
  for (const f of code) {
    const text = await reader.text(f.path);
    if (text == null) return null;
    source.set(f.path,text);
  }
  const messages = [
    {role:"system",content:'Propose one minimal source code edit. Return only a JSON object {"path":"existing filename","old":"unique literal source substring","new":"replacement substring","why":"short reason"}. Inspect the supplied files. A user reviews the patch before it is applied.'},
    {role:"user",content:JSON.stringify({request:goal,files:Object.fromEntries(source)})}
  ];
  const prefer = gw.models.ollama?.includes("qwen2.5-coder:3b") ? "ollama:qwen2.5-coder:3b" : undefined;
  let answer = "", ops = [], by = "", calls = 0;
  for (let attempt=0; attempt<2; attempt++) {
    const result = await gw.chat({messages,temperature:0,max_tokens:300,response_format:{type:"json_object"}}, {privateData:true,prefer,signal,task:"code"});
    calls++;
    by = result.provider + ":" + result.model;
    try {
      const patch = JSON.parse(result.content);
      const op = checkOps([{...patch,op:"edit"}]).ops[0];
      if (!op || !source.has(op.path)) throw new Error("Choose a supplied file and a nonempty literal old string.");
      if (editText(source.get(op.path),op).after === source.get(op.path)) throw new Error("Replacement must change the source.");
      ops = [op]; answer = op.why || op.path;
      break;
    } catch (error) {
      answer = "No applicable edit: " + error.message;
      messages.push({role:"assistant",content:result.content},{role:"user",content:answer});
    }
  }
  return {id:newId(),goal,answer,summary:answer,ops,rejected:[],steps:[{tool:"read",args:{paths:[...source.keys()]},result:"Loaded source for local review"}],reads:[...source.keys()],by,calls,at:Date.now()};
}
