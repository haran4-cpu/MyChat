import test from "node:test";
import assert from "node:assert/strict";
import {verifiedRepair} from "../pc/verified-repair.mjs";

const source = "const x = n <= 5;\n";
const propose = (old,next) => async () => ({by:"fixture",content:JSON.stringify({old,new:next})});
const adapter = value => ({read:async()=>value,exists:async()=>true});
const args = {file:"threshold.js",goal:"Fix the threshold",mustInclude:" >= ",mustExclude:" <= ",validate:()=>{}};

test("uses fallback after a no-op and never rewrites source", async () => {
  const afs = adapter(source);
  const answer = await verifiedRepair({...args,fs:afs,attempts:[
    ["first",propose(" <= "," <= ")],["second",propose(" <= "," >= ")],
  ]});
  assert.deepEqual(answer.repairAttempts.map(a=>a.status),["rejected","passed"]);
  assert.ok(answer.preview[0].baseFingerprint);
  assert.equal(await afs.read(args.file),source);
});

test("rejects private source and checks that already pass before attempting a provider", async () => {
  const attempts = [["fixture",()=>assert.fail("provider should not be called")]];
  await assert.rejects(verifiedRepair({...args,fs:adapter(source),allowFile:()=>false,attempts}),/private/);
  await assert.rejects(verifiedRepair({...args,fs:adapter(source.replace("<=",">=")),attempts}),/already pass/);
});

test("refuses stale source instead of sending a second request", async () => {
  let reads=0;
  const afs={...adapter(source),read:async()=>reads++ ? source+"// changed" : source};
  const plan=await verifiedRepair({...args,fs:afs,attempts:[
    ["first",propose(" <= "," >= ")],["second",()=>assert.fail("stale source should stop")],
  ]});
  assert.deepEqual(plan.ops,[]);
  assert.match(plan.repairAttempts[0].reason,/source changed/);
});

test("sends a bounded HTML excerpt and rejects edits outside it", async () => {
  const page = "OUTSIDE_SCOPE\n" + "x".repeat(3_300_000) + "\n<h1 id='title'>Before</h1>";
  const plan = await verifiedRepair({...args,file:"page.html",anchor:"id='title'",mustInclude:"After",mustExclude:"Before",
    fs:adapter(page),validate:()=>assert.fail("HTML is verified separately in the browser"),attempts:[
      ["first",async payload=>{
        const excerpt=JSON.parse(payload).source;
        assert.ok(excerpt.length<7000);
        assert.ok(!excerpt.includes("OUTSIDE_SCOPE"));
        return propose("OUTSIDE_SCOPE","After")();
      }],["second",propose("Before","After")],
  ]});
  assert.deepEqual(plan.repairAttempts.map(a=>a.status),["rejected","passed"]);
  assert.match(plan.repairAttempts[0].reason,/outside the supplied excerpt/);
  assert.ok(plan.repairContext.fileBytes>3_000_000);
  assert.ok(plan.repairContext.bytesSent<7000);
  assert.equal(plan.repairContext.syntaxChecked,false);
});
