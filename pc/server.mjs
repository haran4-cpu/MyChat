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

const HOME = process.env.MYCHAT_HOME || path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "MyChat");
const PORT = Number(process.env.MYCHAT_PORT || 11500);
fs.mkdirSync(HOME, { recursive: true });
const F = (n) => path.join(HOME, n);
const readJson = (n, d) => { try { return JSON.parse(fs.readFileSync(F(n), "utf8")); } catch { return d; } };
const writeJson = (n, v) => { const t = F(n) + ".tmp"; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, F(n)); };

let token = "";
try { token = fs.readFileSync(F("token"), "utf8").trim(); } catch { /* first run */ }
if (!token) { token = crypto.randomBytes(24).toString("base64url"); fs.writeFileSync(F("token"), token); }

const settings = { allowKeyless: true, allowLocal: true, pins: {}, ...readJson("settings.json", {}) };
let gw;
function build() {
  const keys = readJson("keys.json", {});
  gw = new Gateway({ keys, allowKeyless: settings.allowKeyless, allowLocal: settings.allowLocal, pins: settings.pins,
                     extraProviders: settings.extraProviders || {},
                     log: (m) => fs.appendFileSync(F("gateway.log"), new Date().toISOString() + " " + m + "\n") });
  gw.stats.load(readJson("stats.json", {}));
  gw.refreshModels().catch(() => {});
}
build();
setInterval(() => { try { writeJson("stats.json", gw.stats.toJSON()); } catch { /* ignore */ } }, 30000).unref();

const MODEL_IDS = [...Object.keys(MODES).map((m) => "mychat/" + m), "mychat/private"];

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
  const opts = { mode, privateData, signal: ctl.signal };
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

function connectionsPage() {
  const keys = readJson("keys.json", {});
  const rows = Object.entries(PROVIDERS).filter(([, p]) => !p.keyless).map(([id, p]) => {
    const has = !!keys[id];
    return `<tr><td><b>${p.name}</b><div class=s>${p.free || ""}</div></td>
      <td>${p.keyUrl ? `<a href="${p.keyUrl}" target=_blank rel=noopener>Get a key</a><div class=s>${p.signIn || ""}</div>` : ""}</td>
      <td><input id="k_${id}" type=password placeholder="${has ? "saved ✓ (paste to replace)" : "paste key"}"></td></tr>`;
  }).join("");
  return `<!doctype html><meta charset=utf-8><title>MyChat · Connections</title>
<style>body{font:15px system-ui;max-width:980px;margin:30px auto;color:#e8e8ea;background:#141418}td{padding:10px;border-bottom:1px solid #2a2a33;vertical-align:top}
a{color:#7cc4ff}.s{font-size:12px;color:#9a9aa5;margin-top:4px}input{width:100%;padding:8px;background:#1d1d24;border:1px solid #333;color:#fff;border-radius:6px}
button{padding:10px 18px;border:0;border-radius:8px;background:#3d7bfd;color:#fff;font-weight:600;cursor:pointer}#out{margin-top:14px;white-space:pre-wrap}</style>
<h1>MyChat · Connections</h1><p>Sign up on each site (most accept your Google account), create a key, paste it here. Keys stay on this PC
(<code>${HOME.replace(/\\/g, "\\\\")}</code>) and are only ever sent to the provider they belong to.</p>
<table>${rows}</table><p><label><input type=checkbox id=kl ${settings.allowKeyless ? "checked" : ""} style="width:auto"> Use the free no-key public channels as a last resort (never for private chats)</label></p>
<button onclick=save()>Save and test</button><div id=out></div>
<script>const T=${JSON.stringify(token)};async function save(){const k={};document.querySelectorAll('input[id^=k_]').forEach(e=>{if(e.value.trim())k[e.id.slice(2)]=e.value.trim()});
out.textContent='Saving and testing…';const r=await fetch('/connections',{method:'POST',headers:{'Content-Type':'application/json','X-MyChat-Token':T},body:JSON.stringify({keys:k,allowKeyless:kl.checked})});
const j=await r.json();out.textContent=Object.entries(j.providers).filter(([i,p])=>p.hasKey||p.keyless).map(([i,p])=>(p.enabled&&p.models?'✓ ':'✗ ')+p.name+': '+(p.disabled||p.models+' models')).join('\\n')}</script>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/connections") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" });
      return res.end(connectionsPage());
    }
    if (!authed(req)) return send(res, 401, { error: { message: "MyChat token required (file 'token' in " + HOME + ")" } });
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return send(res, 200, { object: "list", data: MODEL_IDS.map((id) => ({ id, object: "model", owned_by: "mychat",
        name: { "mychat/auto": "MyChat Auto", "mychat/max": "MyChat Max (draft · review · revise)", "mychat/consensus": "MyChat Consensus (3 families)",
                "mychat/fast": "MyChat Fast", "mychat/private": "MyChat Private (local only)" }[id] })) });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") return await completions(req, res);
    if (req.method === "GET" && url.pathname === "/status") return send(res, 200, gw.status());
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
