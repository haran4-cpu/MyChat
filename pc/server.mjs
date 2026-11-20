// MyChat gateway — PC server. OpenAI-compatible endpoint on 127.0.0.1 for Open WebUI, Kestrel and any client.
//   GET  /v1/models                 mychat/auto | max | consensus | fast | private
//   POST /v1/chat/completions       streaming (SSE) or not; progress of multi-model strategies is sent as
//                                   reasoning_content, which Open WebUI shows as a collapsible thinking block
//   GET  /connections               local page to add keys (links to each provider's sign-up/keys page)
//   GET  /status                    providers, discovered models, measured reliability/latency
// Keys and stats live in %APPDATA%\MyChat (or $MYCHAT_HOME). The server listens on 127.0.0.1 only and every
// API call needs the local token (state file `token`), so other programs on the network cannot use your keys.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Gateway } from "../core/router.mjs";
import { run, MODES } from "../core/reason.mjs";
import { PROVIDERS } from "../core/providers.mjs";
import { pkcePair, openRouterAuthUrl, openRouterExchange, detectKeys, validateKey, identifyPlainKey, CONNECT, SEARCH_KEYS } from "../core/accounts.mjs";
import { Search, SEARCH_PROVIDERS } from "../core/search.mjs";
import { Ledger } from "../core/ledger.mjs";
import { Bench } from "./bench.mjs";

const HOME = process.env.MYCHAT_HOME || path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "MyChat");
const PORT = Number(process.env.MYCHAT_PORT || 11500);
const STARTED_AT = Date.now();
fs.mkdirSync(HOME, { recursive: true });
const F = (n) => path.join(HOME, n);
const readJson = (n, d) => { try { return JSON.parse(fs.readFileSync(F(n), "utf8")); } catch { return d; } };
const writeJson = (n, v) => { const t = F(n) + ".tmp"; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, F(n)); };

let token = "";
try { token = fs.readFileSync(F("token"), "utf8").trim(); } catch { /* first run */ }
if (!token) { token = crypto.randomBytes(24).toString("base64url"); fs.writeFileSync(F("token"), token); }

const settings = { allowKeyless: true, allowLocal: true, pins: {}, ...readJson("settings.json", {}) };
let gw, search, bench = null;
const ledger = new Ledger({ load: () => readJson("ledger.json", null), save: (v) => { try { writeJson("ledger.json", v); } catch { /* best effort */ } } });
function build() {
  const keys = readJson("keys.json", {});
  search = new Search({ keys });
  gw = new Gateway({ keys, allowKeyless: settings.allowKeyless, allowLocal: settings.allowLocal, pins: settings.pins,
                     extraProviders: settings.extraProviders || {},
                     log: (m) => fs.appendFileSync(F("gateway.log"), new Date().toISOString() + " " + m + "\n") });
  gw.stats.load(readJson("stats.json", {}));
  gw.refreshModels().catch(() => {});
}
// A key saved under the wrong provider by an older version (e.g. a new "AQ." Gemini key filed as SambaNova) moves to its
// real provider, recognised by its shape. Runs on start; the key never leaves this PC.
(function fixMisfiledKeys() {
  const keys = readJson("keys.json", {});
  let moved = false;
  for (const [prov, key] of Object.entries(keys)) {
    const real = detectKeys(String(key)).find((d) => d.key === key)?.provider;
    if (real && real !== prov && !SEARCH_KEYS.has(prov) && !keys[real]) { keys[real] = key; delete keys[prov]; moved = true; }
  }
  if (moved) writeJson("keys.json", keys);
})();
build();
setInterval(() => { try { writeJson("stats.json", gw.stats.toJSON()); } catch { /* ignore */ } }, 30000).unref();

const MODEL_IDS = [...Object.keys(MODES).map((m) => "mychat/" + m), "mychat/private"];
const truthFor = (privateData) => (privateData ? undefined : { search, ledger });

function send(res, code, obj, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((ok, bad) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 20e6) { bad(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
  });
}
const authed = (req) => (req.headers.authorization || "") === "Bearer " + token || req.headers["x-mychat-token"] === token;

async function completions(req, res) {
  const b = await body(req);
  const name = String(b.model || "mychat/auto").replace(/^mychat\//, "");
  const privateData = name === "private";
  const mode = privateData ? "auto" : name;
  const id = "chatcmpl-" + crypto.randomBytes(8).toString("hex"), created = Math.floor(Date.now() / 1000);
  const ctl = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ctl.abort(); });
  const opts = { mode, privateData, signal: ctl.signal, truth: truthFor(privateData) };
  const oreq = { messages: b.messages || [], tools: b.tools, tool_choice: b.tool_choice, temperature: b.temperature,
                 max_tokens: b.max_tokens, response_format: b.response_format };
  if (privateData) {
    // private: only the local model sees this conversation
    const r = await gwLocalOnly(oreq, b.stream, res, id, created, b.model);
    return r;
  }
  if (!b.stream) {
    try {
      const r = await run(gw, oreq, opts);
      return send(res, 200, { id, object: "chat.completion", created, model: b.model,
        choices: [{ index: 0, finish_reason: r.tool_calls?.length ? "tool_calls" : "stop",
                    message: { role: "assistant", content: r.content, ...(r.tool_calls?.length ? { tool_calls: r.tool_calls } : {}) } }],
        usage: r.usage || undefined, mychat: { provider: r.provider, model: r.model, task: r.task, trace: r.trace } });
    } catch (e) {
      return send(res, 502, { error: { message: e.message, type: "mychat_gateway" } });
    }
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const chunk = (delta, finish = null) => res.write("data: " + JSON.stringify({ id, object: "chat.completion.chunk", created,
    model: b.model, choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n");
  chunk({ role: "assistant" });
  const tick = setInterval(() => res.write(": keep-alive\n\n"), 15000);
  try {
    const r = await run(gw, oreq, { ...opts, onDelta: (t) => chunk({ content: t }),
                                   onStatus: (s) => chunk({ reasoning_content: s + "\n" }) });
    const who = (r.trace || []).map((t) => t.by ? `${t.step}: ${t.by}` : t.step).join(" · ");
    if (who) chunk({ reasoning_content: `\n[${r.mode}] ${who}\n` });
    if (r.tool_calls?.length) chunk({ tool_calls: r.tool_calls.map((t, i) => ({ index: i, ...t })) });
    chunk({}, r.tool_calls?.length ? "tool_calls" : "stop");
  } catch (e) {
    chunk({ content: `\n\n**Gateway:** ${e.message}` }, "stop");
  } finally {
    clearInterval(tick);
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

async function gwLocalOnly(oreq, stream, res, id, created, model) {
  const local = new Gateway({ keys: {}, allowKeyless: false, allowLocal: true });
  local.stats = gw.stats;
  await local.refreshModels();
  if (!stream) {
    try {
      const r = await local.chat(oreq, { privateData: true });
      return send(res, 200, { id, object: "chat.completion", created, model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: r.content } }] });
    } catch (e) { return send(res, 502, { error: { message: e.message } }); }
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const chunk = (delta, finish = null) => res.write("data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n");
  try { await local.chat(oreq, { privateData: true, onDelta: (t) => chunk({ content: t }) }); chunk({}, "stop"); }
  catch (e) { chunk({ content: "\n\n**Local model:** " + e.message }, "stop"); }
  res.write("data: [DONE]\n\n");
  res.end();
}

const pendingOAuth = new Map(); // nonce -> { verifier, at }

function saveKey(provider, key) {
  const keys = readJson("keys.json", {});
  keys[provider] = key;
  writeJson("keys.json", keys);
}

function connectionsPage(flash = "") {
  const keys = readJson("keys.json", {});
  const st = gw.status().providers;
  const order = ["openrouter", "gemini", "nvidia", "groq", "anthropic", "mistral", "huggingface", "zai", "cerebras", "sambanova", "github"];
  const card = (id) => {
    const p = PROVIDERS[id], c = CONNECT[id] || { how: "guided", note: p.free || "" }, s = st[id] || {};
    const on = !!keys[id], bad = s.disabled;
    const state = bad ? `<span class=bad>✗ ${bad}</span>` : on ? `<span class=ok>✓ connected · ${s.models || 0} models</span>` : `<span class=off>not connected</span>`;
    const action = c.how === "one-tap"
      ? `<a class=btn href="/oauth/openrouter/start?t=${encodeURIComponent(token)}">${on ? "Reconnect" : "Connect"} · sign in with Google</a>`
      : `<a class="btn ghost" href="${p.keyUrl}" target=_blank rel=noopener>${on ? "Manage key" : "Get key"}</a>`;
    return `<div class=card><div class=h><b>${p.name}</b>${state}</div><div class=s>${c.note || ""}</div><div class=a>${action}${on ? ` <button class=x onclick="rm('${id}')">Remove</button>` : ""}</div></div>`;
  };
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>MyChat · Accounts</title>
<style>body{font:15px system-ui;max-width:1000px;margin:24px auto;padding:0 16px;color:#e8e8ea;background:#111216}
h1{font-size:22px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.card{background:#1a1b21;border:1px solid #2a2b33;border-radius:12px;padding:14px}.h{display:flex;justify-content:space-between;gap:8px}
.s{font-size:12.5px;color:#9a9aa5;margin:6px 0 10px}.ok{color:#5fd38d;font-size:13px}.bad{color:#ff7b7b;font-size:13px}.off{color:#777;font-size:13px}
.btn{display:inline-block;padding:8px 14px;border-radius:8px;background:#3d7bfd;color:#fff;text-decoration:none;font-weight:600;font-size:14px}
.ghost{background:#2a2b33}.x{background:none;border:0;color:#999;cursor:pointer}
.paste{background:#1a1b21;border:1px dashed #3d7bfd;border-radius:12px;padding:16px;margin:16px 0}
textarea{width:100%;min-height:60px;background:#111216;color:#fff;border:1px solid #333;border-radius:8px;padding:8px;font:13px monospace}
#out{white-space:pre-wrap;margin-top:8px}.flash{background:#183a26;border-radius:8px;padding:10px;margin:10px 0}</style>
<h1>MyChat · Accounts</h1>
${flash ? `<div class=flash>${flash}</div>` : ""}
<div class=paste><b>Paste any key here — or press Ctrl+V anywhere on this page.</b>
<div class=s>The provider is recognised automatically, the key is checked live, and stored only on this PC. Several keys at once are fine.</div>
<textarea id=t placeholder="AIza… · nvapi-… · gsk_… · sk-or-… · sk-ant-… · hf_…"></textarea><button class=btn onclick="paste(t.value)">Add</button><div id=out></div></div>
<div class=card style="margin:12px 0"><div class=h><b>Use MyChat inside Open WebUI</b></div>
<div class=s>Open WebUI → Admin Panel → Settings → Connections → OpenAI API → <b>+</b>. URL: <code>http://127.0.0.1:${PORT}/v1</code> · Key: the MyChat key (button below). The models mychat/auto, max, consensus, verified, fast and private then appear in the model list.</div>
<div class=a><button class=btn onclick="navigator.clipboard.writeText(T).then(()=>{cp.textContent='✓ copied'})" id=cp>Copy MyChat key</button>
<button class="btn ghost" onclick="navigator.clipboard.writeText('http://127.0.0.1:${PORT}/v1').then(()=>{cu.textContent='✓ copied'})" id=cu>Copy URL</button></div></div>
<div class=card style="margin:12px 0"><div class=h><b>Measure my models</b><span class=off id=bst></span></div>
<div class=s>Asks every connected account short questions with known answers (facts, Hebrew, exact math, code that is actually run) and routes each kind of task to the models that really got it right. Also compares the Truth Engine with a single model. Uses a little of each free quota; takes 10–30 minutes.</div>
<div class=a><button class=btn onclick="bstart()">Start</button></div><pre id=bout style="white-space:pre-wrap;font-size:12px;color:#bbb"></pre></div>
<div class=card style="margin:12px 0"><div class=h><b>Connection check</b></div><div class=s>Tests every evidence source the Truth Engine uses (Wikipedia, search keys).</div>
<div class=a><button class="btn ghost" onclick="diag()">Run check</button></div><pre id=dout style="white-space:pre-wrap;font-size:12px;color:#bbb"></pre></div>
<h2>Models</h2><div class=grid>${order.filter((id) => PROVIDERS[id]).map(card).join("")}</div>
<h2>Web evidence for the Truth Engine</h2><div class=s>Wikipedia is always on (no key). Each search key below adds broader, fresher evidence.</div>
<div class=grid>${Object.entries(SEARCH_PROVIDERS).map(([id, p]) => `<div class=card><div class=h><b>${p.name}</b>${keys[id] ? "<span class=ok>✓ connected</span>" : "<span class=off>not connected</span>"}</div><div class=s>${p.note}</div><div class=a><a class="btn ghost" href="${p.keyUrl}" target=_blank rel=noopener>${keys[id] ? "Manage key" : "Get key"}</a>${keys[id] ? ` <button class=x onclick="rm('${id}')">Remove</button>` : ""}</div></div>`).join("")}</div>
<p class=s><label><input type=checkbox id=kl ${settings.allowKeyless ? "checked" : ""} onchange="opt()"> Use free no-key public channels as a last resort (never for private chats)</label></p>
<script>const T=${JSON.stringify(token)};const H={'Content-Type':'application/json','X-MyChat-Token':T};
async function paste(text){if(!text||!text.trim())return;out.textContent='Checking…';const r=await fetch('/connections/paste',{method:'POST',headers:H,body:JSON.stringify({text})});const j=await r.json();
out.textContent=j.results.map(x=>(x.ok?'✓ ':'✗ ')+x.name+(x.ok?' — '+x.models+' models':' — '+x.error)).join('\\n')||'No key recognised';if(j.results.some(x=>x.ok))setTimeout(()=>location.reload(),1200)}
document.addEventListener('paste',e=>{if(e.target===t)return;const s=(e.clipboardData||window.clipboardData).getData('text');if(s){t.value=s;paste(s)}});
async function rm(id){await fetch('/connections/remove',{method:'POST',headers:H,body:JSON.stringify({provider:id})});location.reload()}
async function diag(){dout.textContent='checking…';const j=await (await fetch('/diag',{headers:H})).json();
dout.textContent=j.checks.map(c=>(c.ok?'✓ ':'✗ ')+c.name+'  '+c.ms+' ms'+(c.error?'  '+c.error:'')).join('\\n')+(j.recentErrors.length?'\\n\\nRecent errors:\\n'+j.recentErrors.map(e=>e.where+': '+e.error).join('\\n'):'')}
async function bstart(){await fetch('/bench/start',{method:'POST',headers:H,body:'{}'});bpoll()}
async function bpoll(){const j=await (await fetch('/bench',{headers:H})).json();if(!j.startedAt)return;
bst.textContent=j.running?('running · '+j.phase+' · '+j.done+'/'+j.total):(j.error?'✗ '+j.error:'✓ done');
let t=(j.models||[]).map(m=>m.provider+':'+m.model+'  chat '+m.acc.chat+'  code '+m.acc.code+'  reason '+m.acc.reason).join('\\n');
if(j.pins)t+='\\n\\nRouting now prefers:\\n'+Object.entries(j.pins).map(([k,v])=>k+': '+(v.join(', ')||'—')).join('\\n');
if(j.truth)t+='\\n\\nTruth Engine vs one fast model:\\n'+JSON.stringify(j.truth.summary,null,1);
bout.textContent=t;if(j.running)setTimeout(bpoll,4000)}
bpoll();
async function opt(){await fetch('/connections',{method:'POST',headers:H,body:JSON.stringify({allowKeyless:kl.checked})})}</script>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    // DNS-rebinding guard: a web page that re-points its own domain at 127.0.0.1 must not reach the Accounts page or the API
    const host = String(req.headers.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) return send(res, 403, { error: { message: "forbidden host" } });
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, startedAt: STARTED_AT, pid: process.pid });
    if (req.method === "GET" && url.pathname === "/connections") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Cache-Control": "no-store" });
      return res.end(connectionsPage(url.searchParams.get("connected") ? "✓ OpenRouter connected — Claude, GPT, Gemini, GLM and more are now available." : ""));
    }
    if (req.method === "GET" && url.pathname === "/oauth/openrouter/start") {
      if (url.searchParams.get("t") !== token) return send(res, 401, { error: { message: "open this from the Accounts page" } });
      const { verifier, challenge } = await pkcePair();
      const nonce = crypto.randomBytes(12).toString("hex");
      // where to return after sign-in: only a page on this PC (e.g. Open WebUI at 127.0.0.1:8080), never an outside site
      let back = "";
      try { const b = new URL(url.searchParams.get("back") || ""); if (["127.0.0.1", "localhost"].includes(b.hostname) && /^https?:$/.test(b.protocol)) back = b.href; } catch { /* none */ }
      pendingOAuth.set(nonce, { verifier, at: Date.now(), back });
      const cb = `http://localhost:${PORT}/oauth/openrouter/callback/${nonce}`;
      res.writeHead(302, { Location: openRouterAuthUrl(cb, challenge) });
      return res.end();
    }
    if (req.method === "GET" && url.pathname.startsWith("/oauth/openrouter/callback/")) {
      const nonce = url.pathname.split("/").pop(), p = pendingOAuth.get(nonce);
      pendingOAuth.delete(nonce);
      if (!p || Date.now() - p.at > 15 * 60e3) return send(res, 400, { error: { message: "this sign-in link expired; start again from the Accounts page" } });
      try {
        saveKey("openrouter", await openRouterExchange(url.searchParams.get("code") || "", p.verifier));
        build();
        await gw.refreshModels(true);
        if (p.back) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(`<!doctype html><meta charset=utf-8><body style="font:16px system-ui;background:#111216;color:#e8e8ea;text-align:center;padding-top:80px">
<h2>✓ OpenRouter connected</h2><p>Claude, GPT, Gemini, GLM and more are now available in MyChat.</p>
<p><a style="color:#7aa7ff" href="${p.back.replace(/"/g, "&quot;")}">Back to the chat</a></p><script>setTimeout(()=>{try{window.close()}catch(e){};location.href=${JSON.stringify(p.back)}},1500)</script>`);
        }
        res.writeHead(302, { Location: "/connections?connected=openrouter" });
        return res.end();
      } catch (e) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(connectionsPage("✗ OpenRouter connection failed: " + e.message));
      }
    }
    if (!authed(req)) return send(res, 401, { error: { message: "MyChat token required (file 'token' in " + HOME + ")" } });
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return send(res, 200, { object: "list", data: MODEL_IDS.map((id) => ({ id, object: "model", owned_by: "mychat",
        name: { "mychat/auto": "MyChat Auto", "mychat/max": "MyChat Max (draft · review · revise)", "mychat/consensus": "MyChat Consensus (3 families)",
                "mychat/fast": "MyChat Fast", "mychat/verified": "MyChat Verified (Truth Engine)", "mychat/private": "MyChat Private (local only)" }[id] })) });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") return await completions(req, res);
    if (req.method === "GET" && url.pathname === "/status") return send(res, 200, gw.status());
    if (req.method === "POST" && url.pathname === "/bench/start") {
      const b = await body(req);
      bench = bench && bench.gw === gw ? bench : new Bench(gw);
      const st = await bench.start({ truth: b.truth !== false, truthLimit: Number(b.truthLimit) || undefined, truthSet: b.truthSet || "hard",
        models: b.models !== false, ...(Array.isArray(b.modes) ? { modes: b.modes } : {}),
        onPins: (pins) => { if (b.apply !== false) { settings.pins = pins; writeJson("settings.json", settings); gw.pins = pins; } } });
      return send(res, 200, { running: st.running, total: st.total });
    }
    if (req.method === "GET" && url.pathname === "/diag") return send(res, 200, await search.diagnose());
    if (req.method === "GET" && url.pathname === "/bench") return send(res, 200, bench ? bench.state : { running: false });
    if (req.method === "POST" && url.pathname === "/admin/shutdown") {   // used by the Open WebUI function to reload updated code
      send(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 150);
      return;
    }
    if (req.method === "POST" && url.pathname === "/connections/paste") {
      const b = await body(req);
      const found = detectKeys(b.text);
      const plain = String(b.text || "").trim();
      if (!found.length && /^[A-Za-z0-9._-]{24,80}$/.test(plain)) {   // a key without a recognisable prefix (Mistral, Z.ai…)
        const id = await identifyPlainKey(plain, gw.providers);
        if (id) found.push({ provider: id.provider, key: plain });
      }
      const results = [];
      for (const f of found) {
        if (SEARCH_KEYS.has(f.provider)) {
          let v = { ok: true, models: 0 };
          if (f.provider !== "jina") { try { const r = await new Search({ keys: { [f.provider]: f.key } }).provider(f.provider, "wikipedia", 1); v = { ok: true, models: r.length }; } catch (e) { v = { ok: false, error: e.message }; } }
          if (v.ok) saveKey(f.provider, f.key);
          results.push({ provider: f.provider, name: SEARCH_PROVIDERS[f.provider].name, ...v, models: v.models });
          continue;
        }
        const v = await validateKey(f.provider, f.key, gw.providers);
        if (v.ok) saveKey(f.provider, f.key);
        results.push({ provider: f.provider, name: gw.providers[f.provider]?.name || f.provider, ...v });
      }
      if (results.some((r) => r.ok)) { build(); await gw.refreshModels(true); }
      return send(res, 200, { results });
    }
    if (req.method === "POST" && url.pathname === "/connections/remove") {
      const b = await body(req), keys = readJson("keys.json", {});
      delete keys[b.provider];
      writeJson("keys.json", keys);
      build();
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/connections") {
      const b = await body(req);
      const keys = { ...readJson("keys.json", {}), ...(b.keys || {}) };
      for (const [k, v] of Object.entries(keys)) if (!v) delete keys[k];
      writeJson("keys.json", keys);
      if (typeof b.allowKeyless === "boolean") { settings.allowKeyless = b.allowKeyless; writeJson("settings.json", settings); }
      build();
      await gw.refreshModels(true);
      return send(res, 200, gw.status());
    }
    send(res, 404, { error: { message: "not found" } });
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: { message: e.message } });
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  server.listen(PORT, "127.0.0.1", () => console.log(`MyChat gateway on http://127.0.0.1:${PORT}  (home: ${HOME})`));
}
export { server, HOME, token };
