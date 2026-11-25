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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Gateway } from "../core/router.mjs";
import { run } from "../core/reason.mjs";
import { PROVIDERS, priorFor } from "../core/providers.mjs";
import { pkcePair, openRouterAuthUrl, openRouterExchange, detectKeys, validateKey, identifyPlainKey, CONNECT, SEARCH_KEYS, exportKeys, importKeys, transferCode, BUNDLE_PREFIX } from "../core/accounts.mjs";
import { evaluate } from "../core/exact.mjs";
import { respond, workspaceFollowUp } from "../core/assistant.mjs";
import { htmlToText } from "../core/search.mjs";
import { Search, SEARCH_PROVIDERS } from "../core/search.mjs";
import { Ledger } from "../core/ledger.mjs";
import { terminalRequest, prepareTerminal, terminalTicket, executeTerminal } from "./terminal.mjs";
import { makeDocument, mission, missions, changeMission } from "./specialized.mjs";
import { smallLocalRepair } from "./compact-repair.mjs";
import { cloudRepairAttempts, verifiedRepair } from "./verified-repair.mjs";
import { receiveAttachment } from "./inbox.mjs";
import { Bench } from "./bench.mjs";
import { nodeFs } from "./agentfs.mjs";
import { workspaceReader } from "../core/agent.mjs";
import { checkPage } from "./pagecheck.mjs";
import { skillSearch, skillLoad } from "./skills.mjs";
import { captureScreen, askImage } from "./see.mjs";
import { iconPng, manifest as appManifest, installShortcuts, launch as launchApp, openChatApp } from "./desktopapp.mjs";
const SKILLS = { search: (q) => skillSearch(q), load: (id) => skillLoad(id) };

/** run_page for the agent, limited to one root folder (the path must stay inside it). */
const pageRunner = (rootPath) => async (rel, o = {}) => {
  const base = fs.realpathSync(rootPath), abs = path.resolve(base, String(rel).replace(/^[\\/]+/, ""));
  if (!abs.startsWith(base + path.sep) || !fs.existsSync(abs)) throw new Error(`${rel}: not found in this folder`);
  const real = fs.realpathSync(abs), relative = path.relative(base, real);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error(`${rel}: outside this folder`);
  return checkPage(real, { clicks: o.clicks ?? 25, expectedText: o.expectedText, outDir: path.join(HOME, "runs") });
};
import { plan as agentPlan, preview as agentPreview, apply as agentApply, undo as agentUndo, tree as agentTree, checkPlanPreviews, isTextChange, reviewPlanPreviews } from "../core/agent.mjs";

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
  gw.importState(readJson("gateway-state.json", {}));
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
const saveState = () => { try { writeJson("stats.json", gw.stats.toJSON()); writeJson("gateway-state.json", gw.exportState()); } catch { /* ignore */ } };
setInterval(saveState, 30000).unref();

const { createPlanConnector } = await import("./chatgpt-plan.mjs");
const planConnection = createPlanConnector(HOME);
const PLAN_PREFIX = "mychat/chatgpt-plan/";
const { createCopilotConnector } = await import("./copilot-plan.mjs");
const { readCredential } = await import("./wincred.mjs");
// settings.copilotCredential: name of a Windows Credential Manager entry holding a GitHub token with Copilot access.
// Read in memory only, cached 10 minutes; never logged or returned by any route.
let copilotTok = null;
const copilotConnection = createCopilotConnector(HOME, { tokenSource: async () => {
  const target = settings.copilotCredential;
  if (!target) return null;
  if (copilotTok && copilotTok.target === target && Date.now() < copilotTok.until) return copilotTok.value;
  const value = await readCredential(target);
  copilotTok = value ? { target, value, until: Date.now() + 600000 } : null;
  return value;
} });
const COPILOT_PREFIX = "mychat/github-copilot/";
const MODEL_IDS = ["mychat/auto", "mychat/max", "mychat/private"];
const truthFor = (privateData) => (privateData ? undefined : { search, ledger });

function send(res, code, obj, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}
function body(req, max = 20e6) {
  return new Promise((ok, bad) => {
    req.setEncoding("utf8");
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > max) { bad(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
  });
}
const authed = (req) => (req.headers.authorization || "") === "Bearer " + token || req.headers["x-mychat-token"] === token;

// ---------------------------------------------------------------- one brain on the PC
// Chat from Open WebUI or the phone goes through the same assistant as the Agent: it reads your folders when the
// question needs them. API clients that bring their own tools or a JSON format (Kestrel) get the plain engine.
function agentMemory(root) {
  const f = path.join(F("agent"), "memory-" + crypto.createHash("sha1").update(root).digest("hex").slice(0, 12) + ".md");
  return {
    get: () => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } },
    add: (line) => {
      let t = ""; try { t = fs.readFileSync(f, "utf8"); } catch { /* new */ }
      const lines = (t + line + "\n").split("\n").filter(Boolean).slice(-300);
      fs.writeFileSync(f, lines.join("\n") + "\n");
    },
  };
}
// look: "screen" captures the PC screen (the agent may only ask when the person asked about the screen); any other
// value is a picture file (run screenshots live in MyChat's runs folder)
const seeHost = () => async (img, q) => {
  const f = img === "screen" ? await captureScreen(F("runs")) : path.resolve(String(img));
  if (img !== "screen" && !f.startsWith(path.resolve(F("runs")) + path.sep)) throw new Error("look only at the screen or at run screenshots");
  try { return await askImage(gw, f, q); } finally { if (img === "screen") fs.rm(f, () => {}); }
};
const terminalHost = root => ({
  terminalRequest,
  proposeCommand: command => prepareTerminal(root, command, PORT)
});
const hostTools = () => ({ search, skills: SKILLS, see: seeHost(), evaluate: (e) => evaluate(e).toString(12),
  fetchText: async (u) => { if (!/^https?:\/\//.test(u)) throw new Error("only http(s) pages"); const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); return htmlToText(await r.text()).slice(0, 20000); } });
/** Any folder on the PC can be the working folder: named in the message (C:\\…, a file means its folder), or the one
 *  chosen as the chat folder. Only system folders and MyChat's own data (keys) are refused. */
const FORBIDDEN_ROOT = (p) => {
  const n = path.resolve(p).toLowerCase(), home = path.resolve(HOME).toLowerCase();
  return n === home || n.startsWith(home + path.sep) || home.startsWith(n + path.sep) && n.length < 4 ||
    /^[a-z]:\\(windows|program files|program files \(x86\)|programdata)(\\|$)/i.test(n) || /\\appdata\\(roaming|local)\\mychat(\\|$)/i.test(n) ||
    /^[a-z]:\\?$/i.test(n) || /\\\.ssh(\\|$)/i.test(n);
};
function folderFromText(text) {
  for (const m of String(text || "").matchAll(/[A-Za-z]:\\[^\r\n"'<>|*?]+/g)) {
    let p = m[0].replace(/[\s.,;:)\]]+$/, "");
    for (let k = 0; k < 6 && p.length > 3; k++) {          // "C:\Projects\DJ TiTo\file.html and more" → longest existing prefix
      if (fs.existsSync(p)) { const dir = fs.statSync(p).isDirectory() ? p : path.dirname(p); return FORBIDDEN_ROOT(dir) ? null : { path: dir, private: false, named: true }; }
      p = p.replace(/\s+\S*$/, "");
    }
  }
  return null;
}
const chatRoot = (text) => folderFromText(text) || agentRoots()[Number(settings.chatRoot) || 0] || agentRoots()[0];
function isPrivateFolder(folder) {
  if (!folder) return false;
  const actual = fs.realpathSync(folder);
  return agentRoots().some(r => {
    if (!r.private || !fs.existsSync(r.path)) return false;
    const rel = path.relative(fs.realpathSync(r.path), actual);
    return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
  });
}
async function brainRun(oreq, opts) {
  if (/^\/(?:capabilities|mission|documents)$/i.test(lastText(oreq.messages).trim())) {
    const content = [
      "אפשר לעבוד על קבצים ופרויקטים מתוך השיחה. רשימת קבצים: `/ls`. הצעת פקודה לאישור: `/terminal echo ready`.",
      "- [תיקון עם תצוגה מקדימה ובדיקות מקומיות](http://127.0.0.1:" + PORT + "/#agent)",
      "- [פקודות ומעקב אחרי ביצוע](http://127.0.0.1:" + PORT + "/#terminal)",
      "- [מסמכים ומשימות ארוכות מתוך MyChat](http://127.0.0.1:" + PORT + "/#work)",
      opts.privateData ? "מצב מקומי משתמש ב־Ollama. חיפוש אינטרנט וניתוח תמונה בענן אינם זמינים במצב זה." : "חיפוש אינטרנט וניתוח חזותי זמינים כשהספקים המתאימים עונים.",
    ].join("\n\n");
    opts.onDelta?.(content);
    return {content,mode:"capabilities",trace:[{step:"features",by:"MyChat gateway"}]};
  }
  const root = chatRoot(workspaceFollowUp(oreq.messages) || lastText(oreq.messages));
  const request = lastText(oreq.messages).match(/^\/read-attachment[ \t]+([^\r\n]{1,250})\r?\n\r?\n\(Attached files, saved in the working folder: (Inbox\/\d{4}-\d\d-\d\d\/[^\r\n/]+?\.(?:apk|zip|jar))\)$/i);
  if (request && root) {
    const [, member, archive] = request;
    const reader = workspaceReader(nodeFs(root.path));
    let content;
    try {
      const value = await reader.text(archive + "!/" + member.trim());
      content = value === null ? "The archive member is binary." : value.slice(0, 6000);
      if (value?.length > 6000) content += "\n[Preview truncated]";
    } catch (error) {
      content = "Could not read the attached archive member: " + error.message;
    }
    opts.onDelta?.(content);
    return {content, mode:"archive", trace:[{step:"archive", by:"MyChat local archive reader"}]};
  }
  const privateData = Boolean(opts.privateData || root?.private || isPrivateFolder(root?.path));
  const engine = privateData ? await localGateway() : gw;
  opts = { ...opts, privateData, truth: privateData ? undefined : opts.truth };
  if (oreq.tools?.length || oreq.response_format || settings.oneBrain === false) return run(engine, oreq, opts);
  const r = await respond(engine, { ...opts, messages: oreq.messages, fs: root ? nodeFs(root.path) : null,
    memory: root ? agentMemory(root.path) : null, tools: { ...hostTools(), ...(root ? { runPage: pageRunner(root.path), ...terminalHost(root.path), ...await gitHost(root.path) } : {}), models: agentModels() }, privateData: opts.privateData || root?.private,
    onStep: (st) => opts.onStatus?.(st.kind === "tool" ? `🔧 ${st.tool} ${JSON.stringify(st.args || {}).slice(0, 90)}` : String(st.text || "").slice(0, 160)) });
  if (r.ops?.length) {
    agentSave("plan", r.planId, { id: r.planId, goal: lastText(oreq.messages), ops: r.ops, preview: r.preview, root: root.path, rootIndex: Number(settings.chatRoot) || 0, at: Date.now(), answer: r.content });
    const list = (r.preview || r.ops).map((o, i) => `${i + 1}. ${o.label || o.op + " " + o.path}`).join("\n");
    const extra = `\n\n**Proposed changes** (waiting for approval):\n${list}\n\n[Review this exact plan on the PC](http://127.0.0.1:${PORT}/#agent?plan=${encodeURIComponent(r.planId)}). In chat, use **/approve ${r.planId}** or specify change numbers, for example **/approve ${r.planId} 1,3**. Use **/undo ${r.planId}** to undo this plan.`;
    r.content += extra; opts.onDelta?.(extra);
  }
  return r;
}
const lastText = (msgs) => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") return typeof msgs[i].content === "string" ? msgs[i].content : ""; return ""; };

// ---------------------------------------------------------------- jobs: work that outlives the connection
// The phone starts a job and polls it; if the phone sleeps or loses Wi-Fi, the PC keeps working and keeps the result.
const jobs = new Map();
const saveJob = (job) => writeJson(path.join("agent", job.id + ".json"), job);
function startJob(b) {
  const id = "job-" + newIdLocal();
  const job = { id, status: "running", at: Date.now(), content: "", steps: [], statusLine: "", mode: b.mode || "auto" };
  saveJob(job);
  jobs.set(id, job);
  const oreq = { messages: Array.isArray(b.messages) ? b.messages : [] };
  brainRun(oreq, { mode: job.mode, privateData: b.mode === "private", truth: truthFor(false),
    onDelta: (t) => { job.content += t; }, onStatus: (st) => { job.statusLine = st; job.steps.push(st); if (job.steps.length > 200) job.steps.shift(); } })
    .then(async (r) => {
      const saved = r.planId && agentLoad("plan", r.planId);
      const checks = saved ? (await reviewPlan(saved)).checks : undefined;
      Object.assign(job, { status: "done", content: r.content, result: { mode: r.mode, route: r.route, trace: r.trace, claims: r.claims, sources: r.sources, ops: r.ops, planId: r.planId, preview: r.preview, checks, checked: r.checked } });
    })
    .catch((e) => Object.assign(job, { status: "error", error: e.message, detail: e.detail }))
    .finally(() => {
      job.ended = Date.now();
      try { saveJob(job); } catch (error) { console.warn("Could not persist MyChat job", id, error.code); }
    });
  for (const [k, j] of jobs) if (j.ended && Date.now() - j.ended > 24 * 3600e3) jobs.delete(k);
  return job;
}
const newIdLocal = () => Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
function getJob(id) {
  if (jobs.has(id)) return jobs.get(id);
  if (!/^job-[a-z0-9]+$/.test(id)) return null;
  const saved = readJson(path.join("agent", id + ".json"), null);
  if (saved?.status === "running") {
    return { ...saved, status: "error", error: "The PC gateway restarted before the task completed. Run the request again." };
  }
  return saved;
}

async function completions(req, res, allowPlan = false) {
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
  const requested = String(b.model || "");
  const githubModel = requested.startsWith(COPILOT_PREFIX);
  const accountModel = githubModel || requested.startsWith(PLAN_PREFIX);
  if (accountModel && !allowPlan) return send(res, 403, {error:{message:"Account-backed models are only available on this PC"}});
  const answer = (options) => accountModel
    ? githubModel
      ? copilotConnection.answer(requested.slice(COPILOT_PREFIX.length), oreq, options)
      : planConnection.answer(requested.slice(PLAN_PREFIX.length), oreq, options)
    : brainRun(oreq, options);
  if (!b.stream) {
    try {
      const r = await answer(opts);
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
    const r = await answer({ ...opts, onDelta: (t) => chunk({ content: t }),
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

async function localGateway() {
  const local = new Gateway({ keys: {}, allowKeyless: false, allowLocal: true,
    fetch(url, options) {
      if (new URL(url).origin !== "http://127.0.0.1:11434") throw new Error("Private requests require local Ollama.");
      return fetch(url, { ...options, redirect: "error" });
    }
  });
  local.providers = { ollama: PROVIDERS.ollama };
  local.stats = gw.stats;
  await local.refreshModels();
  return local;
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
<div class=s>Open WebUI → Admin Panel → Settings → Connections → OpenAI API → <b>+</b>. URL: <code>http://127.0.0.1:${PORT}/v1</code> · Key: the MyChat key (button below). The three profiles appear in the chat picker: Assistant, Deep and Local.</div>
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

// ---------------------------------------------------------------- Agent mode (files and folders, approve + undo)
const AGENT_DIR = F("agent");
fs.mkdirSync(AGENT_DIR, { recursive: true });
function agentRoots() {
  if (Array.isArray(settings.agentRoots) && settings.agentRoots.length) return settings.agentRoots;
  const d = [];
  for (const p of ["C:\\AI-Workspace\\Projects", path.join(os.homedir(), "Documents", "MyChat")]) if (fs.existsSync(p)) d.push({ path: p, private: false });
  if (!d.length) { const p = path.join(os.homedir(), "Documents", "MyChat"); fs.mkdirSync(p, { recursive: true }); d.push({ path: p, private: false }); }
  return d;
}
const rootAt = (i) => { const r = agentRoots()[Number(i) || 0]; if (!r) throw new Error("no such folder"); return r; };
const agentFile = (kind, id) => path.join(AGENT_DIR, `${kind}-${String(id).replace(/[^\w-]/g, "")}.json`);
const agentSave = (kind, id, v) => fs.writeFileSync(agentFile(kind, id), JSON.stringify(v));
const agentLoad = (kind, id) => { try { return JSON.parse(fs.readFileSync(agentFile(kind, id), "utf8")); } catch { return null; } };
let agentMutationActive = false;

function validateJavaScript(filename, source) {
  const extension = path.extname(filename).toLowerCase();
  const types = extension === ".mjs" ? ["module"] : extension === ".cjs" ? ["commonjs"] : extension === ".js" ? ["module", "commonjs"] : [];
  let diagnostic;
  for (const type of types) {
    const result = spawnSync(process.execPath,["--check",`--input-type=${type}`],{
      input:source,encoding:"utf8",windowsHide:true,timeout:4000,maxBuffer:64*1024,
      env:{...process.env,NODE_OPTIONS:""},
    });
    if (result.error) throw new Error(`${filename}: JavaScript verification did not complete`);
    if (result.status === 0) return;
    diagnostic = result.stderr?.split(/\r?\n/).find(line=>line.startsWith("SyntaxError:"));
  }
  if (types.length) throw new Error(`${filename}: ${diagnostic || "proposed JavaScript did not pass the syntax check"}`);
}
async function reviewPlan(p) {
  return { ...p, checks: await reviewPlanPreviews(nodeFs(p.root), p, validateJavaScript) };
}
function agentHistory(n = 30) {
  return fs.readdirSync(AGENT_DIR).filter((f) => f.startsWith("journal-")).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(AGENT_DIR, f), "utf8")); } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.at - a.at).slice(0, n)
    .map((j) => ({ id: j.id, goal: j.goal, summary: j.summary, at: j.at, root: j.root, steps: j.steps.length, error: j.error, undone: !!j.undone }));
}
async function agentRoute(req, res, url) {
  if (req.method === "POST" && url.pathname === "/agent/inbox/upload") {
    const root = url.searchParams.has("root") ? rootAt(url.searchParams.get("root")) : chatRoot("");
    try { return send(res, 200, await receiveAttachment(req, root.path, url.searchParams.get("name"))); }
    catch (e) { return send(res, 400, { error: { message: e.message } }); }
  }
  const b = req.method === "POST" ? await body(req, url.pathname === "/agent/inbox" ? 85e6 : 20e6) : {};
  if (url.pathname === "/agent/eval") return agentEvalRoute(req, res, b);
  if (url.pathname === "/agent/roots") {
    if (req.method === "POST") {
      const roots = (b.roots || []).map((r) => ({ path: path.resolve(String(r.path || r)), private: !!r.private })).filter((r) => fs.existsSync(r.path) && !FORBIDDEN_ROOT(r.path));
      settings.agentRoots = roots;
      if (b.chatRoot != null) settings.chatRoot = Math.max(0, Math.min(roots.length - 1, Number(b.chatRoot) || 0));
      writeJson("settings.json", settings);
    }
    return send(res, 200, { roots: agentRoots(), chatRoot: Number(settings.chatRoot) || 0 });
  }
  // a file attached in the chat → <chat folder>/Inbox/<date>/<name> (never overwrites), so the agent can read/run/change it
  if (url.pathname === "/agent/inbox" && req.method === "POST") {
    const root = chatRoot("");
    const name = String(b.name || "file").replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";
    const day = new Date().toISOString().slice(0, 10), dir = path.join(root.path, "Inbox", day);
    fs.mkdirSync(dir, { recursive: true });
    let f = path.join(dir, name), k = 1;
    while (fs.existsSync(f)) f = path.join(dir, name.replace(/(\.[^.]+)?$/, ` (${++k})$1`));
    fs.writeFileSync(f, Buffer.from(String(b.data || ""), "base64"));
    return send(res, 200, { path: path.relative(root.path, f).split(path.sep).join("/"), root: root.path, bytes: fs.statSync(f).size });
  }
  // "/folder C:\…" from a chat: work there from now on (added to the list if new)
  if (url.pathname === "/agent/use" && req.method === "POST") {
    const p = path.resolve(String(b.path || ""));
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return send(res, 400, { error: { message: `no such folder: ${p}` } });
    if (FORBIDDEN_ROOT(p)) return send(res, 400, { error: { message: "that folder is protected (system or MyChat's own data)" } });
    const roots = agentRoots().slice();
    let i = roots.findIndex((r) => path.resolve(r.path).toLowerCase() === p.toLowerCase());
    if (i < 0) { roots.push({ path: p, private: !!b.private }); i = roots.length - 1; }
    settings.agentRoots = roots; settings.chatRoot = i; writeJson("settings.json", settings);
    return send(res, 200, { roots, chatRoot: i });
  }
  if (url.pathname === "/agent/tree") return send(res, 200, { tree: await agentTree(nodeFs(rootAt(url.searchParams.get("root")).path)) });
  if (url.pathname === "/agent/plan" && req.method === "POST") {
    const named = b.verifiedRepair ? null : folderFromText(b.goal);
    const root = named || (typeof b.root === "string" && /[\\/]/.test(b.root) && fs.existsSync(b.root) && !FORBIDDEN_ROOT(b.root) ? { path: path.resolve(b.root), private: false } : rootAt(b.root ?? settings.chatRoot));
    const afs = nodeFs(root.path);
    const privateData = Boolean(root.private || b.private === true || isPrivateFolder(root.path));
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    const options = { signal: controller.signal, goal: String(b.goal || "").slice(0, 4000), fs: afs, ...terminalHost(root.path), privateData, history: Array.isArray(b.history) ? b.history.slice(-8) : [], memory: agentMemory(root.path),
      search, skills: SKILLS, see: seeHost(), evaluate: (e) => evaluate(e).toString(12), runPage: pageRunner(root.path), ...await gitHost(root.path), models: agentModels(),
      fetchText: async (u) => { if (!/^https?:\/\//.test(u)) throw new Error("only http(s) pages"); const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); return htmlToText(await r.text()).slice(0, 20000); } };
    if (b.verifiedRepair) {
      if (privateData || req.socket.localPort !== server.address()?.port) {
        return send(res, 403, {error:{message:"Verified cloud repair is available only on this PC and for non-private folders."}});
      }
      try {
        const verified = await verifiedRepair({...b.verifiedRepair, goal:options.goal, fs:afs, signal:controller.signal,
          validate:validateJavaScript, attempts:cloudRepairAttempts(gw), allowFile:rel=>!isPrivateFolder(path.resolve(root.path,rel))});
        verified.root = root.path;
        verified.rootIndex = Number(b.root) || 0;
        if (verified.ops.length) agentSave("plan",verified.id,verified);
        return send(res,200,await reviewPlan(verified));
      } catch(error) {
        return send(res,400,{error:{message:error.message}});
      }
    }
    const engine = privateData ? await localGateway() : gw;
    const compact = privateData ? await smallLocalRepair(engine, options) : null;
    const p = compact || await agentPlan(engine, options);
    p.root = root.path; p.rootIndex = Number(b.root) || 0;
    p.preview = await agentPreview(afs, p.ops);
    agentSave("plan", p.id, p);
    return send(res, 200, await reviewPlan(p));
  }
  if (url.pathname === "/agent/apply" && req.method === "POST") {
    if (!validPlanId(b.id)) return send(res, 400, { error: { message: "Specify the plan ID from the preview." } });
    const p = agentLoad("plan", b.id);
    if (!p) return send(res, 404, { error: { message: "plan not found" } });
    if (agentLoad("journal", p.id)) return send(res, 409, { error: { message: "this plan was already applied (use undo first)" } });
    // Proof around the change: every HTML app that is about to change is run before and after, and the difference in
    // errors is reported (fixed / still there / new). "Fixed" becomes a measured fact, not the model's word.
    const pick = Array.isArray(b.approve) ? b.approve : null;
    if (b.approve !== undefined && (!pick || !pick.length || pick.some(i => !Number.isInteger(i) || i < 0 || i >= p.ops.length))) {
      return send(res, 400, { error: { message: "Select at least one valid change from this plan." } });
    }
    const adapter = nodeFs(p.root);
    try {
      await checkPlanPreviews(adapter,p,pick,validateJavaScript);
    } catch (error) {
      return send(res, 409, { error: { message: error.message } });
    }
    const pages = [...new Set((p.ops || []).filter((o, i) => (!pick || pick.includes(i)) && /\.html?$/i.test(o.path) && ["write", "edit"].includes(o.op)).map((o) => o.path))].slice(0, 3);
    const run = pageRunner(p.root), before = {};
    if (b.verify !== false) for (const f of pages) before[f] = await run(f, { clicks: 30 }).catch((e) => ({ failed: e.message }));
    const j = await agentApply(adapter, { ...p, enforcePreview: true }, pick);
    j.root = p.root;
    j.preflight = p.ops.flatMap((op, i) => ((!pick || pick.includes(i)) && isTextChange(op.op))
      ? [{ path: op.path, syntax: /\.(?:json|[cm]?js)$/i.test(op.path) }] : []);
    if (pages.length && b.verify !== false) {
      j.verify = [];
      for (const f of pages) {
        const after = await run(f, { clicks: 30 }).catch((e) => ({ failed: e.message }));
        const key = (e) => e.text.replace(/127\.0\.0\.1:\d+/g, "localhost") + "@" + e.where;
        const B = new Set((before[f].errors || []).map(key)), A = new Set((after.errors || []).map(key));
        j.verify.push({ path: f, before: B.size, after: A.size, fixed: [...B].filter((k) => !A.has(k)).slice(0, 10), still: [...B].filter((k) => A.has(k)).slice(0, 10),
          new: [...A].filter((k) => !B.has(k)).slice(0, 10), failed: before[f].failed || after.failed || null, shots: after.shots || [] });
      }
    }
    agentSave("journal", p.id, j);
    return send(res, 200, j);
  }
  if (url.pathname === "/agent/undo" && req.method === "POST") {
    if (!validPlanId(b.id)) return send(res, 400, { error: { message: "Specify the ID of the plan to undo." } });
    const j = agentLoad("journal", b.id);
    if (!j) return send(res, 404, { error: { message: "nothing to undo" } });
    if (j.undone) return send(res, 409, { error: { message: "already undone" } });
    const r = await agentUndo(nodeFs(j.root), j);
    j.undone = Date.now(); agentSave("journal", j.id, j);
    return send(res, 200, { ...r, id: j.id, goal: j.goal });
  }
  if (url.pathname === "/agent/history") return send(res, 200, { history: agentHistory() });
  if (url.pathname === "/agent/plan" && req.method === "GET") {
    const id = url.searchParams.get("id");
    const p = validPlanId(id) && agentLoad("plan", id);
    if (!p) return send(res, 404, { error: { message: "Plan not found. Create a new preview." } });
    const journal = agentLoad("journal", id);
    if (!journal) return send(res, 200, await reviewPlan(p));
    const { steps, verify, preflight, error, undone } = journal;
    return send(res, 200, { ...p, journal: { steps: steps.map(({ auto }) => ({ auto })), verify, preflight, error, undone } });
  }
  return send(res, 404, { error: { message: "not found" } });
}
function validPlanId(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/i.test(id) && id.toLowerCase() !== "latest";
}

// ---------------------------------------------------------------- System: services and updates (through the supervisor)
async function supervisor(pathname, method = "GET", payload) {
  try {
    const r = await fetch("http://127.0.0.1:11510" + pathname, { method, headers: { Authorization: "Bearer " + token, ...(payload ? { "Content-Type": "application/json" } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(method === "POST" ? 120000 : 3000) });
    return await r.json();
  } catch (e) { return { error: "supervisor not reachable (" + e.message + ")" }; }
}

// ---------------------------------------------------------------- the PC app (one page: Home, Agent, Accounts, Models, System)
let ICON = null;
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");
function serveUi(res, name) {
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".mjs": "text/javascript; charset=utf-8" };
  let data;
  try { data = fs.readFileSync(path.join(UI_DIR, name), "utf8"); } catch { return send(res, 404, { error: { message: "not found" } }); }
  if (name === "index.html") data = data.replace("__MYCHAT_TOKEN__", token);
  res.writeHead(200, { "Content-Type": types[path.extname(name)], "X-Frame-Options": "DENY", "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
  res.end(data);
}

// ---------------------------------------------------------------- phone link (off by default)
// The phone can use this PC — its accounts, local models and folders — over the home Wi-Fi or Tailscale. A SEPARATE port
// that serves only the API, only with the token: no pages, no keys, no settings. Repeated wrong tokens are blocked.
const LINK_PORT = Number(process.env.MYCHAT_LINK_PORT || 11501);
const LINK_ROUTES = /^\/(health|status|v1\/chat\/completions|v1\/models|agent\/(roots|tree|plan|apply|undo|history|use)|jobs(\/[\w-]+)?)$/;
let linkServer = null;
const strikes = new Map();
function linkUrls() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
    if (a.family !== "IPv4" || a.internal) continue;
    // virtual adapters (Hyper-V/WSL "vEthernet", VirtualBox, VMware, Docker) are never reachable from the phone
    if (/vEthernet|VirtualBox|VMware|Docker|WSL|Hyper-V|vboxnet|br-|docker/i.test(name)) continue;
    out.push({ url: `http://${a.address}:${LINK_PORT}`, via: /^100\./.test(a.address) ? "Tailscale (works anywhere)" : `${name} (home network)` });
  }
  return out.sort((a, b) => (a.via.startsWith("Tailscale") ? -1 : 1) - (b.via.startsWith("Tailscale") ? -1 : 1));
}
function startPhoneLink() {
  if (linkServer) return;
  linkServer = http.createServer((req, res) => {
    const ip = req.socket.remoteAddress || "?", now = Date.now();
    const st = strikes.get(ip) || { n: 0, until: 0 };
    if (st.until > now) return send(res, 429, { error: { message: "too many wrong tokens; try again later" } });
    const url = new URL(req.url, "http://x");
    if (!LINK_ROUTES.test(url.pathname)) return send(res, 404, { error: { message: "not available over the phone link" } });
    const auth = String(req.headers.authorization || "");
    const ok = auth.length === ("Bearer " + token).length && crypto.timingSafeEqual(Buffer.from(auth), Buffer.from("Bearer " + token));
    if (!ok && url.pathname !== "/health") {
      st.n++; if (st.n >= 10) { st.until = now + 10 * 60e3; st.n = 0; } strikes.set(ip, st);
      return send(res, 401, { error: { message: "wrong token" } });
    }
    req.headers.host = "127.0.0.1";   // passes the local-only guard of the main handler, which checks the token again
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    server.emit("request", req, res);
  });
  linkServer.on("error", (e) => { console.error("phone link:", e.message); linkServer = null; });
  linkServer.listen(LINK_PORT, "0.0.0.0", () => console.log(`phone link on port ${LINK_PORT}`));
}
function stopPhoneLink() { linkServer?.close(); linkServer = null; }

// Read-only git for the chosen folder, and read-only GitHub for the account named in settings.githubRead
// ({ "owner": "...", "credential": "<Windows Credential Manager target>" }); the key is read in memory, never shown.
const { gitReader, githubReader } = await import("./gitread.mjs");
let ghTok = null;
async function gitHost(rootPath) {
  const out = { gitRead: gitReader(rootPath) };
  const cfg = settings.githubRead;
  if (cfg?.owner && cfg?.credential && /^[\w.-]+$/.test(cfg.owner)) {
    if (!ghTok || Date.now() > ghTok.until) { const v = await readCredential(cfg.credential); ghTok = v ? { v, until: Date.now() + 600000 } : null; }
    if (ghTok) out.githubRead = githubReader({ owner: cfg.owner, token: ghTok.v });
  }
  return out;
}

// Which models the agent prefers (settings.agentModels = { plan, work: [] }), set from a measured agent eval.
function agentModels() {
  const m = settings.agentModels;
  const ok = (x) => typeof x === "string" && /^[\w.-]+:\S+$/.test(x);
  if (!m || typeof m !== "object") return null;
  const work = (Array.isArray(m.work) ? m.work : []).filter(ok).slice(0, 4);
  return ok(m.plan) || work.length ? { plan: ok(m.plan) ? m.plan : work[0], work } : null;
}

// Agent eval: the same real tasks over the same folder, one model at a time (see core/agent-eval.mjs).
// POST {root, casesFile: "path inside root" | cases: [...], models: ["provider:model"], apply?: true}; GET for progress.
let agentEval = null;
async function agentEvalRoute(req, res, b) {
  if (req.method === "GET") return send(res, 200, agentEval ? { ...agentEval, controller: undefined } : (readJson(path.join("agent", "eval-latest.json"), null) || { running: false }));
  if (req.method !== "POST") return send(res, 405, {});
  if (b.stop) { agentEval?.controller?.abort(); return send(res, 200, { stopping: !!agentEval }); }
  if (agentEval?.running) return send(res, 409, { error: { message: "An agent eval is already running." } });
  const root = rootAt(b.root ?? settings.chatRoot);
  if (root.private || isPrivateFolder(root.path)) return send(res, 403, { error: { message: "Agent eval sends the folder to cloud models; it does not run on private folders." } });
  const afs = nodeFs(root.path);
  let cases = Array.isArray(b.cases) ? b.cases : null;
  if (!cases && typeof b.casesFile === "string") { try { cases = JSON.parse(await afs.read(b.casesFile)).cases; } catch (e) { return send(res, 400, { error: { message: "cases file: " + e.message } }); } }
  const models = (Array.isArray(b.models) ? b.models : []).filter((m) => typeof m === "string" && /^[\w.-]+:\S+$/.test(m)).slice(0, 12);
  if (!Array.isArray(cases) || !cases.length || cases.length > 20 || !models.length) return send(res, 400, { error: { message: "Give 1-20 cases and 1-12 models (provider:model)." } });
  const { evalAgentModels } = await import("../core/agent-eval.mjs");
  const host = await gitHost(root.path), controller = new AbortController();
  agentEval = { running: true, startedAt: Date.now(), root: root.path, models, cases: cases.length, at: null, controller };
  const run = (goal, m) => agentPlan(gw, { goal: String(goal).slice(0, 4000), fs: afs, ...host, search, skills: SKILLS, evaluate: (e) => evaluate(e).toString(12),
    memory: null, signal: controller.signal, models: m, privateData: false });
  evalAgentModels({ cases, models, run, gitRead: host.gitRead, signal: controller.signal, onProgress: (p) => { agentEval.at = p; } })
    .then((r) => {
      const out = { running: false, root: root.path, ...r };
      if (b.apply === true && r.recommend) { settings.agentModels = r.recommend; writeJson("settings.json", settings); out.applied = r.recommend; }
      writeJson(path.join("agent", "eval-latest.json"), out); agentEval = null;
    })
    .catch((e) => { writeJson(path.join("agent", "eval-latest.json"), { running: false, error: e.message, at: new Date().toISOString() }); agentEval = null; });
  return send(res, 202, { running: true, models: models.length, cases: cases.length });
}

// What would be lost if the gateway restarted now: requests in flight, sign-ins waiting for the owner, running agent jobs.
// The supervisor reloads new code only when this is empty (see pc/supervisor.mjs), so a sign-in is never cut off.
let inFlight = 0;
function busyReasons() {
  const r = [];
  if (inFlight > 0) r.push(`${inFlight} request(s) in progress`);
  if (planConnection.busy?.()) r.push("ChatGPT sign-in in progress");
  if (copilotConnection.busy?.()) r.push("Copilot sign-in in progress");
  const running = [...jobs.values()].filter((j) => j.status === "running").length;
  if (agentEval?.running) r.push("agent eval running");
  if (running) r.push(`${running} agent job(s) running`);
  return r;
}
const server = http.createServer(async (req, res) => {
  const counted = !(req.method === "GET" && /^\/(health|ui\/|$)/.test(req.url || ""));
  if (counted) { inFlight++; res.once("close", () => { inFlight--; }); }
  try {
    const url = new URL(req.url, "http://x");
    // DNS-rebinding guard: a web page that re-points its own domain at 127.0.0.1 must not reach the Accounts page or the API
    const host = String(req.headers.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) return send(res, 403, { error: { message: "forbidden host" } });
    if (req.method === "GET" && url.pathname === "/manifest.webmanifest") {
      res.writeHead(200, { "Content-Type": "application/manifest+json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify(appManifest(`http://127.0.0.1:${PORT}/`)));
    }
    if (req.method === "GET" && url.pathname === "/ui/icon.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=86400" });
      return res.end(ICON ||= iconPng(256));
    }
    if (req.method === "GET" && url.pathname === "/health") { const why = busyReasons(); return send(res, 200, { ok: true, startedAt: STARTED_AT, pid: process.pid, busy: why.length > 0, why }); }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/app")) return serveUi(res, "index.html");
    if (req.method === "GET" && /^\/ui\/(app\.css|app\.mjs)$/.test(url.pathname)) return serveUi(res, url.pathname.slice(4));
    if (req.method === "GET" && url.pathname === "/connections" && !url.searchParams.has("classic")) {
      res.writeHead(302, { Location: "/" + (url.searchParams.get("connected") ? "?connected=openrouter" : "") + "#accounts" });
      return res.end();
    }
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
        res.writeHead(302, { Location: "/?connected=openrouter#accounts" });
        return res.end();
      } catch (e) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(connectionsPage("✗ OpenRouter connection failed: " + e.message));
      }
    }
    if (!authed(req)) return send(res, 401, { error: { message: "MyChat token required (file 'token' in " + HOME + ")" } });
    if (url.pathname === "/github-copilot" && req.method === "GET") return send(res, 200, await copilotConnection.inspect());
    if (url.pathname === "/github-copilot" && req.method === "POST") {
      const action = (await body(req)).action;
      try {
        if (action === "connect") return send(res, 200, await copilotConnection.start());
        if (action === "cancel") { await copilotConnection.cancel(); return send(res, 200, {ok:true}); }
        return send(res, 400, {error:{message:"Unknown Copilot connection action"}});
      } catch (error) {
        return send(res, 409, {error:{message:error.message}});
      }
    }
    if (url.pathname === "/chatgpt-plan" && req.method === "GET") {
      const session = await planConnection.status();
      let models = [];
      if (session.sharing) {
        try { models = await planConnection.models(); } catch (error) { session.error = error.message; }
      }
      return send(res, 200, { ...session, models });
    }
    if (url.pathname === "/chatgpt-plan" && req.method === "POST") {
      const action = (await body(req)).action;
      try {
        if (action === "connect") return send(res, 200, await planConnection.start());
        if (action === "disconnect") return send(res, 200, await planConnection.disconnect());
        if (action === "cancel") { await planConnection.cancel(); return send(res, 200, {ok:true}); }
        return send(res, 400, {error:{message:"Unknown ChatGPT connection action"}});
      } catch (error) {
        return send(res, 409, {error:{message:error.message}});
      }
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const [extra, copilot] = url.searchParams.get("advanced") === "1" && req.socket.localPort === server.address()?.port
        ? await Promise.all([planConnection.models().catch(() => []), copilotConnection.inspect()])
        : [[], {models:[]}];
      return send(res, 200, { object: "list", data: [...MODEL_IDS.map((id) => ({ id, object: "model", owned_by: "mychat",
        name: { "mychat/auto": "MyChat · Assistant", "mychat/max": "MyChat · Deep", "mychat/private": "MyChat · Local" }[id] })), ...extra.map(m => ({id:PLAN_PREFIX+m.slug, object:"model", owned_by:"chatgpt-plan", name:m.displayName})),
        ...copilot.models.map(m=>({id:COPILOT_PREFIX+m.slug, object:"model", owned_by:"github-copilot", name:"GitHub Copilot · "+m.displayName}))] });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") return await completions(req, res, req.socket.localPort === server.address()?.port);
    if (req.method === "GET" && url.pathname === "/status") return send(res, 200, gw.status());
    if (req.method === "POST" && url.pathname === "/bench/start") {
      const b = await body(req);
      bench = bench && bench.gw === gw ? bench : new Bench(gw, truthFor(false));
      const st = await bench.start({ truth: b.truth !== false, truthLimit: Number(b.truthLimit) || undefined, truthSet: b.truthSet || "hard",
        models: b.models !== false, ...(Array.isArray(b.modes) ? { modes: b.modes } : {}),
        onPins: (pins) => { if (b.apply !== false) { settings.pins = pins; writeJson("settings.json", settings); gw.pins = pins; } } });
      return send(res, 200, { running: st.running, total: st.total });
    }
    if (req.method === "GET" && url.pathname === "/models") {
      await gw.refreshModels();
      const strong = {};
      for (const [id, list] of Object.entries(gw.models)) {
        const top = list.map((m) => ({ m, q: Math.max(priorFor(m).code ?? 0, priorFor(m).reason ?? 0) })).filter((x) => x.q >= 0.8).sort((a, b) => b.q - a.q);
        if (top.length) strong[id] = top.map((x) => { const st = gw.stats.peek(id, x.m); return { model: x.m, prior: x.q, ok: st.ok, fail: st.fail }; });
      }
      return send(res, 200, { counts: Object.fromEntries(Object.entries(gw.models).map(([k, v]) => [k, v.length])), strong, agentModels: agentModels() });
    }
    if (req.method === "POST" && url.pathname === "/bench/stop") return send(res, 200, bench ? bench.stop() : { running: false });
    if (url.pathname.startsWith("/specialized/")) {
      if (req.socket.localPort !== server.address()?.port) return send(res,403,{error:{message:"This tool runs on the PC only."}});
      try {
        if (req.method==="POST" && url.pathname==="/specialized/document") return send(res,200,await makeDocument(await body(req,150000)));
        if (url.pathname==="/specialized/missions") {
          if(req.method==="GET") return send(res,200,url.searchParams.has("id")?await mission(url.searchParams.get("id")):await missions());
          if(req.method==="POST") return send(res,200,await changeMission(await body(req,12000)));
        }
        return send(res,404,{error:{message:"Tool not found."}});
      } catch(error) { return send(res,400,{error:{message:error.message}}); }
    }
    if (url.pathname === "/system/terminal") {
      if (req.method === "GET") return send(res, 200, terminalTicket(url.searchParams.get("id")));
      if (req.method !== "POST") return send(res, 405, {});
      const b = await body(req);
      if (b.approve === true) return send(res, 200, await executeTerminal(String(b.id)));
      return send(res, 200, prepareTerminal(rootAt(b.root ?? settings.chatRoot).path, b.command, PORT));
    }
    if (url.pathname.startsWith("/agent/")) {
      const changesFiles = req.method === "POST" && ["/agent/apply", "/agent/undo"].includes(url.pathname);
      if (!changesFiles) return await agentRoute(req, res, url);
      if (agentMutationActive) return send(res, 409, { error: { message: "Another file change is already running." } });
      agentMutationActive = true;
      try { return await agentRoute(req, res, url); }
      finally { agentMutationActive = false; }
    }
    if (req.method === "POST" && url.pathname === "/jobs") return send(res, 200, startJob(await body(req)));
    if (req.method === "GET" && url.pathname.startsWith("/jobs/")) {
      const j = getJob(url.pathname.slice(6));
      return j ? send(res, 200, j) : send(res, 404, { error: { message: "no such job" } });
    }
    if (req.method === "GET" && url.pathname === "/catalog") {
      const keys = readJson("keys.json", {});
      return send(res, 200, { connect: CONNECT, allowKeyless: settings.allowKeyless,
        search: Object.fromEntries(Object.entries(SEARCH_PROVIDERS).map(([id, p]) => [id, { ...p, hasKey: !!keys[id] }])),
        openrouterStart: "/oauth/openrouter/start?t=" + encodeURIComponent(token) + "&back=" + encodeURIComponent("http://127.0.0.1:" + PORT + "/#accounts") });
    }
    if (req.method === "GET" && url.pathname === "/system") return send(res, 200, { gateway: { startedAt: STARTED_AT, pid: process.pid }, supervisor: await supervisor("/status") });
    if (url.pathname === "/system/github-key") return send(res, 200, req.method === "POST"
      ? await supervisor("/github-key", "POST", { key: String((await body(req, 8192)).key || "") }) : await supervisor("/github-key"));
    if (req.method === "POST" && url.pathname === "/system/update") return send(res, 200, await supervisor("/update" + (url.searchParams.get("check") ? "?check=1" : url.searchParams.get("keep") ? "?keep=1" : url.searchParams.get("force") ? "?force=1" : ""), "POST"));
    if (req.method === "GET" && url.pathname === "/diag") return send(res, 200, await search.diagnose());
    if (req.method === "GET" && url.pathname === "/bench") return send(res, 200, bench ? bench.state : { running: false });
    if (req.method === "POST" && url.pathname === "/admin/shutdown") {   // used by the Open WebUI function to reload updated code
      saveState();
      send(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 150);
      return;
    }
    if (req.method === "POST" && url.pathname === "/connections/export") {
      const b = await body(req);
      const code = transferCode(), payload = { ...readJson("keys.json", {}) };
      if (b.withPc && settings.phoneLink?.enabled) payload.__pc = { urls: linkUrls().map((u) => u.url), token };
      return send(res, 200, { code, text: await exportKeys(payload, code) });
    }
    // "Open chat": your installed Open WebUI app when there is one, otherwise the page asks the browser to open it
    if (url.pathname === "/system/open-chat" && req.method === "POST") {
      try { const lnk = openChatApp(); return send(res, 200, { opened: !!lnk, app: lnk }); } catch (e) { return send(res, 200, { opened: false, error: e.message }); }
    }
    if (url.pathname === "/system/desktop-app" && req.method === "POST") {
      const b = await body(req), appUrl = `http://127.0.0.1:${PORT}/`;
      try {
        const r = b.launchOnly ? {} : await installShortcuts({ home: HOME, url: appUrl });
        if (b.launch !== false) launchApp({ home: HOME, url: appUrl });
        return send(res, 200, { ok: true, ...r });
      } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    }
    if (url.pathname === "/system/phone-link") {
      if (req.method === "POST") {
        const b = await body(req);
        settings.phoneLink = { enabled: !!b.enabled }; writeJson("settings.json", settings);
        if (b.enabled) startPhoneLink(); else stopPhoneLink();
      }
      return send(res, 200, { enabled: !!settings.phoneLink?.enabled, running: !!linkServer, port: LINK_PORT, urls: linkUrls() });
    }
    if (req.method === "POST" && url.pathname === "/connections/paste") {
      const b = await body(req);
      if (String(b.text || "").includes(BUNDLE_PREFIX)) {
        try {
          const got = await importKeys(b.text, String(b.code || ""));
          for (const [k, v] of Object.entries(got)) if (!k.startsWith("__") && typeof v === "string") saveKey(k, v);
          build(); await gw.refreshModels(true);
          return send(res, 200, { results: Object.keys(got).map((k) => ({ provider: k, name: PROVIDERS[k]?.name || SEARCH_PROVIDERS[k]?.name || k, ok: true, models: 0 })) });
        } catch (e) { return send(res, 200, { results: [], needCode: true, error: e.message }); }
      }
      const found = detectKeys(b.text);
      const plain = String(b.text || "").trim();
      if (!found.length && /^[A-Za-z0-9._-]{24,1200}$/.test(plain)) {   // a key without a recognisable prefix (Mistral, Z.ai, Nebius…)
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
        let v = await validateKey(f.provider, f.key, gw.providers);
        if (!v.ok && f.alt && SEARCH_KEYS.has(f.alt)) {   // a UUID that is not SambaNova's may be Exa's (search)
          try { const r = await new Search({ keys: { [f.alt]: f.key } }).provider(f.alt, "wikipedia", 1); saveKey(f.alt, f.key); results.push({ provider: f.alt, name: SEARCH_PROVIDERS[f.alt].name, ok: true, models: r.length }); continue; }
          catch { /* report the first error */ }
        }
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
  if (settings.phoneLink?.enabled) startPhoneLink();
}
export { server, HOME, token };
