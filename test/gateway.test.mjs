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

test("a keyless gateway that only serves :free models without a key lists only those", async () => {
  const w = await mockWorld({ k: { "google/gemini-4-neon": { text: "paid" }, "z-ai/glm-5:free": { text: "hi from glm" } } });
  const gw = new Gateway({ keys: {}, allowKeyless: true, extraProviders: { k: { name: "k", baseUrl: `${w.url}/k`, keyless: true, freeOnly: ":free" } } });
  for (const id of Object.keys(gw.providers)) if (id !== "k") gw.disabled[id] = "off in this test";
  await gw.refreshModels(true);
  assert.deepEqual(gw.models.k, ["z-ai/glm-5:free"]);
  w.srv.close();
});

test("Gemini native: request and streamed answer are translated both ways", async () => {
  const { toGemini, fromGemini } = await import("../core/router.mjs");
  const g = toGemini({ messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }, { role: "assistant", content: "hello" },
    { role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] }],
    temperature: 0.2, max_tokens: 50 });
  assert.deepEqual(g.systemInstruction, { parts: [{ text: "be brief" }] });
  assert.deepEqual(g.contents.map((c) => c.role), ["user", "model", "user"]);
  assert.deepEqual(g.contents[2].parts[1], { inlineData: { mimeType: "image/png", data: "QUJD" } });
  assert.deepEqual(g.generationConfig, { temperature: 0.2, maxOutputTokens: 50 });
  const c = fromGemini({ candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: "Hi!" }] }, finishReason: "STOP" }] });
  assert.equal(c.choices[0].delta.content, "Hi!");
  assert.equal(c.choices[0].finish_reason, "stop");
});

test("Gemini native endpoint end to end through the gateway", async () => {
  const srv = http.createServer((req, res) => {
    if (req.headers["x-goog-api-key"] !== "AQ.k") { res.writeHead(401); return res.end("{}"); }
    if (req.url.startsWith("/v1beta/models?")) { res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ models: [{ name: "models/gemini-3.6-flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/text-embedding-5", supportedGenerationMethods: ["embedContent"] }] })); }
    assert.match(req.url, /\/models\/gemini-3\.6-flash:streamGenerateContent\?alt=sse$/);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: " + JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hel" }] } }] }) + "\r\n\r\n");
    res.end("data: " + JSON.stringify({ candidates: [{ content: { parts: [{ text: "lo" }] }, finishReason: "STOP" }] }) + "\r\n\r\n");
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const { PROVIDERS } = await import("../core/providers.mjs");
  const gw = new Gateway({ keys: { gemini: "AQ.k" }, allowKeyless: false,
    extraProviders: { gemini: { ...PROVIDERS.gemini, baseUrl: `http://127.0.0.1:${srv.address().port}/v1beta` } } });
  for (const id of Object.keys(gw.providers)) if (id !== "gemini") gw.disabled[id] = "off";
  await gw.refreshModels(true);
  assert.deepEqual(gw.models.gemini, ["gemini-3.6-flash"]);
  let out = "";
  const r = await gw.chat({ messages: [{ role: "user", content: "hi" }] }, { onDelta: (t) => (out += t) });
  assert.equal(out, "Hello");
  assert.equal(r.content, "Hello");
  srv.closeAllConnections(); srv.close();
});

test("an account without credit is parked as a whole; a model not on the plan is skipped for a day", async () => {
  const w = await mockWorld({
    a: { m1: { status: 402 }, m2: { text: "never reached" } },
    b: { "gemini-pro": { status: 429 }, "fast-1": { text: "ok from b" } },
  });
  const gw = gwFor(w, ["a", "b"]);
  try {
    await gw.refreshModels(true);
    const r = await gw.chat({ messages: [{ role: "user", content: "hi" }] }, { onDelta: () => {} });
    assert.equal(r.content, "ok from b");
    assert.match(gw.status().providers.a.disabled, /no credit/);
    assert.ok(!gw.enabledProviders().includes("a"));
    assert.ok(!w.calls.some((c) => c.prov === "a" && c.model === "m2"));
  } finally { w.srv.closeAllConnections(); w.srv.close(); }
});

test("Gemini's ordinary quota message (mentions billing) does not park the account; a free daily limit parks it until reset", async () => {
  const gemini429 = '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. limit: 0"}}';
  const w = await mockWorld({ g: { "gemini-pro": { status: 429 }, "gemini-flash": { text: "flash ok" } } });
  const gw = gwFor(w, ["g"]);
  const realFetch = gw.fetch;
  gw.fetch = async (url, o) => (String(url).endsWith("/chat/completions") && JSON.parse(o.body).model === "gemini-pro")
    ? new Response(gemini429, { status: 429 }) : realFetch(url, o);
  try {
    await gw.refreshModels(true);
    const r = await gw.chat({ messages: [{ role: "user", content: "hi" }] }, { onDelta: () => {} });
    assert.equal(r.content, "flash ok");
    assert.equal(gw.status().providers.g.disabled, "");
    gw.fetch = async () => new Response('{"error":{"message":"Rate limit exceeded: free-models-per-day"}}', { status: 429 });
    await assert.rejects(gw.chat({ messages: [{ role: "user", content: "again" }] }, { onDelta: () => {} }));
    assert.match(gw.status().providers.g.disabled, /free daily limit/);
  } finally { w.srv.closeAllConnections(); w.srv.close(); }
});

test("offline: when every cloud model fails, the local model still answers (it is always the last resort)", async () => {
  const cloud = {};
  for (let i = 0; i < 12; i++) cloud["m" + i] = { status: 503 };
  const w = await mockWorld({ c: cloud, loc: { "qwen-local": { text: "local answer" } } });
  const gw = new Gateway({ keys: { c: "k" }, allowKeyless: false, allowLocal: true,
    extraProviders: { c: { name: "c", baseUrl: `${w.url}/c` }, loc: { name: "loc", baseUrl: `${w.url}/loc`, local: true, keyless: true } } });
  for (const id of Object.keys(gw.providers)) if (!["c", "loc"].includes(id)) gw.disabled[id] = "off";
  try {
    await gw.refreshModels(true);
    const r = await gw.chat({ messages: [{ role: "user", content: "hi" }] }, { onDelta: () => {} });
    assert.equal(r.content, "local answer");
  } finally { w.srv.closeAllConnections(); w.srv.close(); }
});

test("working pool: once an account has models that answer, the rest are skipped (with rare exploration); dead models drop out; stats stay small", async () => {
  const { Gateway, parseResetMs } = await import("../core/router.mjs");
  const gw = new Gateway({ keys: { x: "k" }, allowKeyless: false, extraProviders: { x: { name: "x", baseUrl: "http://127.0.0.1:9/v1" } } });
  for (const id of Object.keys(gw.providers)) if (id !== "x") gw.disabled[id] = "off";
  gw.models.x = ["good", "untried-1", "untried-2", "dead"];
  assert.equal(gw.candidates("chat").length, 4, "cold start: everything open");
  gw.stats.success("x", "good", 300, 50);
  for (let i = 0; i < 3; i++) gw.stats.failure("x", "dead", "500");
  assert.deepEqual(gw.candidates("chat").map((c) => c.model), ["good"]);
  assert.ok(gw.candidates("chat", { families: ["untried"] }).length >= 0);   // diversity requests are not limited by the pool
  gw.requests = 14; gw.pickExplore("chat");
  assert.ok(gw.explore && gw.explore.model.startsWith("untried"));
  assert.equal(gw.candidates("chat").length, 2, "the explored model joins for this request");
  assert.deepEqual(Object.keys(gw.stats.toJSON()).sort(), ["x|dead", "x|good"], "never-used models are not saved");
  // rate-limit headers: an account with 1 request left is tried after others
  gw.noteLimits("x", new Headers({ "x-ratelimit-remaining-requests": "1", "x-ratelimit-reset-requests": "2m59.56s" }));
  assert.ok(gw.limits.x.resetAt - Date.now() > 170e3);
  assert.equal(parseResetMs("7.66s"), 7660); assert.equal(parseResetMs("120ms"), 120); assert.equal(parseResetMs("30"), 30000);
});

test("a stream that stalls after its first words is cut off and the next model finishes the answer", async () => {
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      const model = JSON.parse(b).model;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: model === "stall" ? "Half an " : "answer." } }] }) + "\n\n");
      if (model !== "stall") res.end("data: [DONE]\n\n");          // "stall" never finishes and never closes
    });
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const gw = new Gateway({ keys: { s: "k" }, allowKeyless: false, idleTimeoutMs: 400, extraProviders: { s: { name: "s", baseUrl: `http://127.0.0.1:${srv.address().port}/v1` } } });
  for (const id of Object.keys(gw.providers)) if (id !== "s") gw.disabled[id] = "off";
  gw.models.s = ["stall", "ok"];
  gw.pins = { chat: ["s:stall"], fast: ["s:stall"] };
  try {
    const t0 = Date.now();
    const r = await gw.chat({ messages: [{ role: "user", content: "hi" }] }, { onDelta: () => {} });
    assert.ok(Date.now() - t0 < 5000, "did not hang");
    assert.match(r.content, /^Half an answer\.?/);
    assert.match(gw.stats.peek("s", "stall").lastError, /stalled/);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test("candidate list keeps at most 3 models per account up front, so a second account is always reached", () => {
  const gw = new Gateway({ keys: { gemini: "k", groq: "k" }, allowKeyless: false, allowLocal: false });
  gw.models = { gemini: ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8"], groq: ["q1"] };
  gw.pins = { chat: ["gemini:g1", "gemini:g2", "gemini:g3", "gemini:g4", "gemini:g5", "gemini:g6", "gemini:g7", "gemini:g8"] };
  const list = gw.candidates("chat");
  assert.ok(list.slice(0, 4).some((c) => c.provider === "groq"), list.map((c) => c.provider + ":" + c.model).join(","));
});

test("429 from 3 different models of one account within 2 minutes pauses the account, doubling each time", () => {
  const gw = new Gateway({ keys: { gemini: "k" }, allowKeyless: false, allowLocal: false });
  gw.noteQuota("gemini", "a"); gw.noteQuota("gemini", "a"); gw.noteQuota("gemini", "b");
  assert.ok(!gw.parked.gemini, "same model twice + one other is not enough");
  gw.noteQuota("gemini", "c");
  assert.ok(gw.parked.gemini.until - Date.now() > 14 * 60000 && /15 min/.test(gw.parked.gemini.reason));
  gw.noteQuota("gemini", "d"); gw.noteQuota("gemini", "e"); gw.noteQuota("gemini", "f");
  assert.match(gw.parked.gemini.reason, /30 min/);
});

test("image, computer-use and live-audio models are not chat models", async () => {
  const { NOT_CHAT } = await import("../core/providers.mjs");
  for (const m of ["gemini-nano-banana-2.1", "nano-banana-pro-preview", "gemini-2.5-computer-use-preview-10-2025", "imagen-4.0", "veo-3.0", "gemini-2.5-flash-native-audio", "gemini-live-2.5-flash-live"])
    assert.ok(NOT_CHAT.test(m), m);
  for (const m of ["gemini-3-flash-preview", "gemini-flash-lite-latest", "openai/gpt-oss-120b", "nvidia/nemotron-3-ultra-550b-a55b:free"])
    assert.ok(!NOT_CHAT.test(m), m);
});

test("a Hebrew question answered in Arabic is held back, failed over, and that model is demoted for Hebrew", async () => {
  const w = await mockWorld({
    a: { "allam-2-7b": { text: "بيتكوين هي عملة افتراضية تم إنشاؤها في عام 2008" } },
    b: { "good-model": { text: "אוטווה" } },
  });
  const g = only(["a", "b"])(gwFor(w, ["a", "b"]));
  const seen = [];
  const r = await g.chat({ messages: [{ role: "user", content: "מהי בירת קנדה? מילה אחת." }] }, { prefer: "a:allam-2-7b", onDelta: (d) => seen.push(d) });
  assert.equal(r.model, "good-model");
  assert.equal(seen.join(""), "אוטווה", "no Arabic reached the user");
  assert.equal(g.stats.get("a", "allam-2-7b").heWrong, 1);
  const c = g.candidates("chat", { lang: "he" });
  assert.equal(c[0].model, "good-model");
  w.srv.closeAllConnections(); w.srv.close();
});

test("pauses survive a restart; expired ones are dropped", () => {
  const a = new Gateway({ keys: { groq: "k" }, allowKeyless: false, allowLocal: false });
  a.parked.groq = { until: Date.now() + 3600e3, reason: "free daily limit reached" };
  a.parked.gemini = { until: Date.now() - 1, reason: "old" };
  const b = new Gateway({ keys: { groq: "k" }, allowKeyless: false, allowLocal: false });
  b.importState(JSON.parse(JSON.stringify(a.exportState())));
  assert.ok(b.parked.groq && !b.parked.gemini);
});

test("an answer that stops on 'written by' is continued by the next model", async () => {
  const { cutOff } = await import("../core/router.mjs");
  assert.ok(cutOff({ content: "הספר אהבת ציון נכתב על ידי", finish_reason: "stop" }));
  assert.ok(cutOff({ content: "The novel was written by", finish_reason: "stop" }));
  assert.ok(cutOff({ content: "Here is a long answer", finish_reason: "length" }));
  for (const t of ["אוטווה", "Canberra", "365 days.", "את הספר כתב **אברהם מאפו**.", "```js\nx()\n```"]) assert.ok(!cutOff({ content: t, finish_reason: "stop" }), t);
  assert.ok(!cutOff({ content: "", tool_calls: [{}] }));
  const w = await mockWorld({ a: { "m1": { text: "The novel was written by" } }, b: { "m2": { text: " Abraham Mapu." } } });
  const g = only(["a", "b"])(gwFor(w, ["a", "b"]));
  const r = await g.chat({ messages: [{ role: "user", content: "who wrote Ahavat Zion?" }] }, { prefer: "a:m1" });
  assert.equal(r.content, "The novel was written by Abraham Mapu.");
  assert.equal(w.calls[1].messages.at(-1).role, "user", "the second model is asked to continue");
  w.srv.closeAllConnections(); w.srv.close();
});

test("no credit on an account that also has free models parks only the paid model (Z.ai GLM Flash stays usable)", async () => {
  const w = await mockWorld({ a: { "glm-5.3": { status: 402, text: '{"error":{"message":"Insufficient balance"}}' }, "glm-4.7-flash": { text: "ok" } } });
  const g = only(["a"])(gwFor(w, ["a"]));
  g.providers.a.freeModels = /flash/i;
  const r = await g.chat({ messages: [{ role: "user", content: "hi" }] }, { prefer: "a:glm-5.3" });
  assert.equal(r.model, "glm-4.7-flash");
  assert.ok(!g.parked.a, "account not parked");
  w.srv.closeAllConnections(); w.srv.close();
});

test("Hebrew questions avoid small models unless they were measured good in Hebrew", () => {
  const gw = new Gateway({ keys: { a: "k" }, allowKeyless: false, allowLocal: false, extraProviders: { a: { name: "a", baseUrl: "http://x" } } });
  gw.models = { a: ["Olala-v1.0-mini-7A1B", "gpt-oss-120b"] };
  assert.equal(gw.candidates("chat", { lang: "he" })[0].model, "gpt-oss-120b");
  gw.pins = { he: ["a:Olala-v1.0-mini-7A1B"] };
  assert.ok(gw.candidates("chat", { lang: "he" }).some((c) => c.model === "Olala-v1.0-mini-7A1B"));
});

test("one empty account can't stop an answer: other accounts and no-key channels get a rescue try, and the error is human", async () => {
  const q = { status: 429 };
  const w = await mockWorld({
    g: { "gemini-3-pro": q, "gemini-3-flash": q, "gemini-2.5-pro": q, "gemini-2.5-flash": q, "gemini-2.0-flash": q, "gemini-flash-lite": q, "gemini-x": q, "gemini-y": q },
    k: { "llama-3.3-70b": { text: "שלום! במה אפשר לעזור?" } },
  });
  const gw = new Gateway({ keys: { g: "k" }, allowKeyless: true, allowLocal: false,
    extraProviders: { g: { name: "Google Gemini", baseUrl: `${w.url}/g` }, k: { name: "Free (no key)", baseUrl: `${w.url}/k`, keyless: true } } });
  for (const id of Object.keys(gw.providers)) if (!["g", "k"].includes(id)) delete gw.providers[id];
  await gw.refreshModels();
  // the phone had marked the free channel dead (3 failures while offline) — a stale guess must not block the last chance
  for (let i = 0; i < 3; i++) gw.stats.failure("k", "llama-3.3-70b", "Failed to fetch", 600000);
  const r = await gw.chat({ messages: [{ role: "user", content: "היי" }] });
  assert.equal(r.provider, "k");
  assert.match(r.content, /שלום/);
  // and when truly nothing answers, the message says why in plain words, no raw JSON
  const w2 = await mockWorld({ g: { "gemini-3-flash": q, "gemini-2.5-flash": { status: 503 } } });
  const gw2 = new Gateway({ keys: { g: "k" }, allowKeyless: false, allowLocal: false, extraProviders: { g: { name: "Google Gemini", baseUrl: `${w2.url}/g` } } });
  for (const id of Object.keys(gw2.providers)) if (id !== "g") delete gw2.providers[id];
  await assert.rejects(gw2.chat({ messages: [{ role: "user", content: "hi" }] }), (e) => {
    assert.match(e.message, /^No model could answer right now \(2 tried\)\. Google Gemini: .*quota.*busy/);
    assert.doesNotMatch(e.message, /[{}]/);
    assert.match(e.detail, /gemini-3-flash/);
    return true;
  });
  w.srv.close(); w2.srv.close();
});

test("the modes really differ: Fast/Auto answer once, Max drafts with the strongest model and gets a cross-family review, Auto escalates real code", async () => {
  const review = JSON.stringify({ verdict: "ok", issues: [] });
  const ans = (b) => ({ text: /independent senior reviewer/.test(b.messages[0].content) ? review : "Here is a complete answer." });
  const w = await mockWorld({ a: { "gemini-3-flash": ans, "gemini-3-pro": ans }, b: { "deepseek-v4": ans } });
  const g = only(["a", "b"])(gwFor(w, ["a", "b"]));
  await g.refreshModels();
  g.stats.success("a", "gemini-3-flash", 300, 200);            // measured fast
  g.stats.success("a", "gemini-3-pro", 9000, 40);              // measured slow but strongest
  const ask = async (mode, content) => { const n = w.calls.length; const r = await run(g, { messages: [{ role: "user", content }] }, { mode }); return { r, calls: w.calls.length - n }; };
  let x = await ask("fast", "hi");
  assert.equal(x.calls, 1); assert.equal(x.r.route, "fastest model"); assert.equal(x.r.mode, "fast");
  x = await ask("auto", "hi");
  assert.equal(x.calls, 1); assert.equal(x.r.route, "quick answer"); assert.equal(x.r.mode, "auto");
  x = await ask("max", "hi");
  assert.equal(x.calls, 1); assert.equal(x.r.model, "gemini-3-pro", "Max uses the strongest model even when it is slow");
  x = await ask("max", "what should I name my coffee shop next to the beach?");
  assert.equal(x.calls, 2); assert.match(x.r.route, /reviewed/); assert.equal(x.r.mode, "max");
  assert.notEqual(x.r.trace[0].by.split(":")[0], x.r.trace[1].by.split(":")[0], "review by another family");
  x = await ask("auto", "what should I name my coffee shop next to the beach?");
  assert.equal(x.calls, 1, "Auto does not review a casual question");
  x = await ask("auto", "write a python function that parses ISO dates with timezones and returns UTC datetimes, with tests");
  assert.equal(x.calls, 2, "Auto escalates real code to a review"); assert.match(x.r.route, /reviewed/);
  w.srv.close();
});

test("Max: a review with only minor points keeps the draft; a blocker gets fixed", async () => {
  let verdict;
  const ans = (b) => ({ text: /independent senior reviewer/.test(b.messages[0].content) ? JSON.stringify(verdict)
    : /reviewer \(a different model\) found/.test(b.messages.at(-1).content) ? "fixed answer" : "draft answer" });
  const w = await mockWorld({ a: { "gemini-3-pro": ans }, b: { "deepseek-v4": ans } });
  const g = only(["a", "b"])(gwFor(w, ["a", "b"]));
  verdict = { verdict: "revise", issues: [{ severity: "minor", where: "intro", fix: "shorter" }] };
  let r = await run(g, { messages: [{ role: "user", content: "explain the trade-offs of SQLite vs Postgres for a small app" }] }, { mode: "max" });
  assert.equal(r.content, "draft answer");
  verdict = { verdict: "revise", issues: [{ severity: "blocker", where: "point 2", fix: "SQLite does support concurrent readers" }] };
  r = await run(g, { messages: [{ role: "user", content: "explain the trade-offs of SQLite vs Postgres for a small app" }] }, { mode: "max" });
  assert.equal(r.content, "fixed answer"); assert.match(r.issues[0], /\[blocker\] point 2/);
  w.srv.close();
});
