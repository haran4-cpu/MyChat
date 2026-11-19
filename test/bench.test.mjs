import { test } from "node:test";
import assert from "node:assert/strict";
import { runCodeTest, extractCode, pinsFrom } from "../pc/bench.mjs";

test("model-written code is really executed, in a separate locked-down process", async () => {
  const good = "```js\nfunction solve(a){const u=[...new Set(a)].sort((x,y)=>y-x);return u.length>1?u[1]:null}\n```";
  assert.equal(await runCodeTest(extractCode(good), "solve([3,1,4,4,5])===4 && solve([7,7])===null"), true);
  assert.equal(await runCodeTest("function solve(a){return a[1]}", "solve([3,1,4,4,5])===4"), false);
  assert.equal(await runCodeTest("function solve(){while(true){}}", "solve()===1", 1500), false);          // hangs -> killed
  assert.equal(await runCodeTest("import fs from 'node:fs'; fs.writeFileSync('pwned.txt','x'); function solve(){return 1}", "solve()===1"), false); // no file writes
});

test("pins: most accurate first, then fastest; fast = fastest among fully correct", () => {
  const r = [
    { provider: "a", model: "m1", acc: { chat: 1, code: 0.67, reason: 1 }, ms: { chat: 900, code: 5000, reason: 3000 } },
    { provider: "b", model: "m2", acc: { chat: 1, code: 1, reason: 0.33 }, ms: { chat: 300, code: 8000, reason: 1e9 } },
    { provider: "c", model: "m3", acc: { chat: 0.75, code: 1, reason: 1 }, ms: { chat: 100, code: 2000, reason: 2000 } },
  ];
  const p = pinsFrom(r);
  assert.deepEqual(p.code, ["c:m3", "b:m2", "a:m1"]);
  assert.deepEqual(p.reason, ["c:m3", "a:m1"]);
  assert.deepEqual(p.fast, ["b:m2", "a:m1"]);
});
