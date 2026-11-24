import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("ChatGPT plan lists authorized models and returns streaming and plain replies", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "mychat-plan-test-"));
  const dir = path.join(home, "siwc-sdk", "dist");
  await fs.mkdir(dir, {recursive:true});
  await fs.writeFile(path.join(dir,"index.js"), `
export function createChatGPT(){
  return {
    async getSession(){return {status:"connected",sharing:true}},
    async listModels(){return [{slug:"fixture",displayName:"Fixture"}]},
    async streamResponse({model,input,onDelta}){
      if(model!=="fixture"||input[0].content!=="probe") throw Error("Unexpected request");
      onDelta?.("first "); onDelta?.("second"); return {text:"first second"};
    }
  };
}`);
  await fs.writeFile(path.join(home,"settings.json"),JSON.stringify({allowKeyless:false,allowLocal:false}));
  process.env.MYCHAT_HOME = home;
  const {server,token} = await import("../pc/server.mjs");
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  const url = "http://127.0.0.1:"+server.address().port;
  const headers = {Authorization:"Bearer "+token,"Content-Type":"application/json"};
  const request = (model,stream) => fetch(url+"/v1/chat/completions",{
    method:"POST",headers,body:JSON.stringify({model,stream,messages:[{role:"user",content:"probe"}]}),
  });
  try {
    assert.equal((await fetch(url+"/chatgpt-plan")).status,401);
    const defaults = await (await fetch(url+"/v1/models",{headers})).json();
    assert.deepEqual(defaults.data.map(m=>m.id),["mychat/auto","mychat/max","mychat/private"]);
    const list = await (await fetch(url+"/v1/models?advanced=1",{headers})).json();
    assert.ok(list.data.some(m=>m.id==="mychat/chatgpt-plan/fixture"));
    const plain=await (await request("mychat/chatgpt-plan/fixture",false)).json();
    assert.equal(plain.choices[0].message.content,"first second");
    assert.equal(plain.mychat.model,"fixture");
    const events=await (await request("mychat/chatgpt-plan/fixture",true)).text();
    assert.match(events,/"content":"first "/);
    assert.match(events,/"content":"second"/);
    assert.match(events,/chatgpt-plan:fixture/);
    assert.match(events,/data: \[DONE\]/);
    assert.equal((await request("mychat/chatgpt-plan/other",false)).status,502);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(home,{recursive:true,force:true});
  }
});
