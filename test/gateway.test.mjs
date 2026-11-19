// Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Gateway, classify, family } from "../core/router.mjs";
import { run } from "../core/reason.mjs";

// A fake world of providers. Each provider has a list of models and a behaviour per model.
function mockWorld(behaviours) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    const [, prov, ...rest] = req.url.split("/");
    const p = rest.join("/");
    if (p.endsWith("models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: Object.keys(behaviours[prov] || {}).map((id) => ({ id })) }));
    }
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      const b = JSON.parse(s);
      calls.push({ prov, model: b.model, messages: b.messages });
      const beh = behaviours[prov][b.model];
      const out = typeof beh === "function" ? beh(b) : beh;
      if (out.status) { res.writeHead(out.status, { "retry-after": "1" }); return res.end("nope"); }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const parts = out.text.match(/.{1,5}/gs) || [];
      for (const piece of parts) res.write("data: " + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + "\n\n");
      if (out.breakAfter) { setTimeout(() => res.destroy(), 80); return; }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ srv, calls, url: `http://127.0.0.1:${srv.address().port}` })));
}

function gwFor(w, provs) {
  const extra = {}, keys = {};
  for (const id of provs) { extra[id] = { name: id, baseUrl: `${w.url}/${id}` }; keys[id] = "k"; }
  return new Gateway({ keys, extraProviders: extra, allowKeyless: false });
}
const only = (provs) => (g) => { for (const id of Object.keys(g.providers)) if (!provs.includes(id)) delete g.providers[id]; return g; };

test("classify needs no model call and gets the obvious cases right", () => {
  assert.equal(classify([{ role: "user", content: "hi" }]), "fast");
  assert.equal(classify([{ role: "user", content: "fix this python function that crashes" }]), "code");
  assert.equal(classify([{ role: "user", content: "תכתוב לי קוד לאתר" }]), "code");
  assert.equal(classify([{ role: "user", content: "compare the trade-offs of these two architectures for my startup and recommend one" }]), "reason");
  assert.equal(classify([{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "x" } }] }]), "vision");
  assert.equal(family("z-ai/glm-5.3"), "glm");
  assert.equal(family("moonshotai/kimi-k2.6"), "kimi");
});

test("routes code to the strongest code model and fails over on 429", async () => {
  const w = await mockWorld({
    a: { "z-ai/glm-5.3": { status: 429 }, "llama-3.1-8b": { text: "small" } },
    b: { "deepseek-v4": { text: "def f(): return 1" } },
  });
  const g = only(["a", "b"])(gwFor(w, ["a", "b"]));
  const r = await g.chat({ messages: [{ role: "user", content: "write a python function" }] });
  assert.equal(r.model, "deepseek-v4");                  // glm ranked first but rate-limited -> next best, not the 8b
  assert.equal(r.attempts[0].model, "z-ai/glm-5.3");
  assert.ok(g.stats.get("a", "z-ai/glm-5.3").cooldownUntil > Date.now());  // learns the limit
  w.srv.closeAllConnections(); w.srv.close();
});

test("a stream that breaks mid-answer is continued by the next model", async () => {
  const w = await mockWorld({
    a: { "kimi-k2.6": { text: "The answer starts here and", breakAfter: true } },
    b: { "deepseek-v4": { text: " ends here." } },
  });
  const g = only(["a", "b"])(gwFor(w, ["a", "b"]));
  let streamed = "";
  const r = await g.chat({ messages: [{ role: "user", content: "explain step by step why" }] }, { onDelta: (d) => (streamed += d) });
  assert.equal(streamed, "The answer starts here and ends here.");
  const cont = w.calls.find((c) => c.model === "deepseek-v4");
  assert.match(cont.messages.at(-1).content, /cut off/);   // the second model was told to continue, not restart
  w.srv.closeAllConnections(); w.srv.close();
});

test("max: a different model family reviews the draft and the drafter fixes real issues", async () => {
  const w = await mockWorld({
    a: { "z-ai/glm-5.3": (b) => b.messages.at(-1).content.startsWith("An independent reviewer")
          ? { text: "def add(a, b):\n    return a + b" } : { text: "def add(a, b):\n    return a - b" } },
    b: { "kimi-k2.6": { text: '{"verdict":"revise","issues":["add() subtracts: line 2 must be a + b"]}' } },
  });
  const g = only(["a", "b"])(gwFor(w, ["a", "b"]));
  const r = await run(g, { messages: [{ role: "user", content: "write a python function add" }] }, { mode: "max" });
  assert.match(r.content, /a \+ b/);
  assert.deepEqual(r.trace.map((t) => t.step), ["draft", "review", "revise"]);
  const review = w.calls.find((c) => c.model === "kimi-k2.6");
  assert.match(review.messages[1].content, /a - b/);       // reviewer saw the draft
  assert.notEqual(family("kimi-k2.6"), family("z-ai/glm-5.3"));
  w.srv.closeAllConnections(); w.srv.close();
});

test("max: a clean review keeps the draft (no wasted revision)", async () => {
  const w = await mockWorld({
    a: { "z-ai/glm-5.3": { text: "print('ok')" } },
    b: { "kimi-k2.6": { text: '{"verdict":"ok","issues":[]}' } },
  });
  const g = only(["a", "b"])(gwFor(w, ["a", "b"]));
  const r = await run(g, { messages: [{ role: "user", content: "write python that prints ok" }] }, { mode: "max" });
  assert.equal(r.content, "print('ok')");
  assert.equal(w.calls.length, 2);
  w.srv.closeAllConnections(); w.srv.close();
});

test("consensus: three families answer in parallel and an aggregator reconciles", async () => {
  const w = await mockWorld({
    a: { "z-ai/glm-5.3": { text: "42" }, "gemini-3.1-pro": (b) => (b.messages[0].role === "system" ? { text: "Final: 42 (2 of 3 agree)" } : { text: "41" }) },
    b: { "kimi-k2.6": { text: "42" }, "deepseek-v4": { text: "42" } },
  });
  const g = only(["a", "b"])(gwFor(w, ["a", "b"]));
  const r = await run(g, { messages: [{ role: "user", content: "calculate 6*7 and explain why" }] }, { mode: "consensus" });
  const steps = r.trace.map((t) => t.step);
  assert.equal(steps.filter((s) => s === "proposal").length, 3);
  assert.equal(steps.at(-1), "aggregate");
  const fams = new Set(r.trace.filter((t) => t.step === "proposal").map((t) => family(t.by)));
  assert.equal(fams.size, 3);                                // three different families
  w.srv.closeAllConnections(); w.srv.close();
});

test("private requests never reach public no-key gateways", async () => {
  const w = await mockWorld({ pub: { "gpt-oss-120b": { text: "public" } }, loc: { "qwen3.5:4b": { text: "local" } } });
  const g = new Gateway({ keys: {}, allowLocal: true, allowKeyless: true,
    extraProviders: { pub: { name: "pub", baseUrl: `${w.url}/pub`, keyless: true }, loc: { name: "loc", baseUrl: `${w.url}/loc`, keyless: true, local: true } } });
  only(["pub", "loc"])(g);
  const r = await g.chat({ messages: [{ role: "user", content: "my medical notes" }] }, { privateData: true });
  assert.equal(r.content, "local");
  assert.ok(!w.calls.some((c) => c.prov === "pub"));
  w.srv.closeAllConnections(); w.srv.close();
});

test("a rejected key disables that provider instead of retrying it forever", async () => {
  const w = await mockWorld({ a: { "kimi-k2.6": { status: 401 } }, b: { "deepseek-v4": { text: "ok" } } });
  const g = only(["a", "b"])(gwFor(w, ["a", "b"]));
  await g.chat({ messages: [{ role: "user", content: "analyze why" }] });
  assert.match(g.disabled.a, /key rejected/);
  assert.ok(!g.enabledProviders().includes("a"));
  w.srv.closeAllConnections(); w.srv.close();
});
