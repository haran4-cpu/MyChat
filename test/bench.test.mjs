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

test("scoring survives typographic spaces, LaTeX grouping and trailing zeros (all seen in real answers)", async () => {
  const { SET, normAnswer } = await import("../core/truthset.mjs");
  const rx = (q) => SET.find((s) => s[0].startsWith(q))[1];
  assert.match(normAnswer("\\(2^{20} = 1{,}048{,}576\\)."), rx("What is 2 to the power"));
  assert.match(normAnswer("by **Gabriel García Márquez**".normalize("NFD")), rx("Who wrote the novel"));
  assert.match(normAnswer("painted by Vincent van Gogh"), rx("Who painted"));
  assert.match(normAnswer("**Final price: \\$78.20**"), rx("If a price of 80"));
});

test("Hebrew questions go to models measured good at Hebrew, away from ones that answered gibberish", async () => {
  const { Gateway } = await import("../core/router.mjs");
  const gw = new Gateway({ keys: { x: "k" }, allowKeyless: false, extraProviders: { x: { name: "x", baseUrl: "http://127.0.0.1:9/v1" } },
    pins: { fast: ["x:fastbad"], he: ["x:hebrewgood"], heBad: ["x:fastbad"] } });
  for (const id of Object.keys(gw.providers)) if (id !== "x") gw.disabled[id] = "off";
  gw.models.x = ["fastbad", "hebrewgood"];
  assert.equal(gw.candidates("fast", { lang: "he" })[0].model, "hebrewgood");
  assert.equal(gw.candidates("fast", {})[0].model, "fastbad");
  const p = pinsFrom([{ provider: "x", model: "a", acc: { chat: 1, code: 1, reason: 1 }, ms: { chat: 1, code: 1, reason: 1 }, he: 1 },
                      { provider: "x", model: "b", acc: { chat: 0.7, code: 1, reason: 1 }, ms: { chat: 1, code: 1, reason: 1 }, he: 0.25 }]);
  assert.deepEqual(p.he, ["x:a"]); assert.deepEqual(p.heBad, ["x:b"]);
});
