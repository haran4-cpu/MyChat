// MyChat supervisor: keeps the local AI stack running without anyone double-clicking .bat files.
//   - starts Ollama, Open WebUI, the MyChat gateway and Kestrel when they are down
//   - checks their health every 20 s and restarts what died (with back-off, so a broken service can't loop)
//   - reloads MyChat and Kestrel by itself when their code on disk changes (Kestrel only when it is idle)
//   - "Update" pulls the latest version from GitHub, only a commit whose CI checks passed, with a backup
// Status: http://127.0.0.1:11510/status (also shown on the MyChat Accounts page).
// Measured reason for existing (2026-11-20): overnight, Kestrel ran 11 h on old code because nobody restarted it,
// and a long evaluation stopped at 00:53 without anyone noticing.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const MYCHAT_DIR = path.resolve(path.dirname(SELF), "..");
const HOME = process.env.MYCHAT_HOME || path.join(process.env.APPDATA || path.join(process.env.HOME || ".", ".config"), "MyChat");
const PORT = Number(process.env.MYCHAT_SUPERVISOR_PORT || 11510);
const WIN = process.platform === "win32";
fs.mkdirSync(HOME, { recursive: true });

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const first = (...ps) => ps.find((p) => p && exists(p)) || "";

// ---------------------------------------------------------------------------- settings (overridable in supervisor.json)
const user = readJson(path.join(HOME, "supervisor.json"), {});
const KESTREL_DIR = user.kestrelDir || "C:\\AI-Workspace\\Kestrel";
const LOCALAI = user.openWebUiHome || "C:\\Users\\user\\Documents\\Codex\\LocalAI";
const NODE = process.execPath;
const PYW = user.pythonw || first("C:\\Python314\\pythonw.exe", "C:\\Python313\\pythonw.exe", "C:\\Python312\\pythonw.exe");
const OLLAMA = user.ollama || first(path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe"), "C:\\Users\\user\\AppData\\Local\\Programs\\Ollama\\ollama.exe");
const OWUI_LAUNCHER = user.openWebUiLauncher || "C:\\Users\\user\\Documents\\Codex\\2026-11-14\\x20\\outputs\\Start-Local-AI.ps1";
const REPO = user.repo || "haran4-cpu/MyChat";

export const SERVICES = [
  { id: "ollama", name: "Ollama (local models)", url: "http://127.0.0.1:11434/api/version", port: 11434, graceSec: 30,
    start: () => OLLAMA && launch(OLLAMA, ["serve"], { env: { OLLAMA_MODELS: "C:\\OllamaModels", OLLAMA_NUM_PARALLEL: "1", OLLAMA_KEEP_ALIVE: "30m" } }) },
  // Open WebUI: started through its own launcher, which pins the session key and data folder (starting it any other
  // way signed everyone out once). Never restarted on code changes.
  { id: "openwebui", name: "Open WebUI", url: "http://127.0.0.1:8080/health", port: 8080, graceSec: 300,
    start: () => exists(OWUI_LAUNCHER) && launch("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", OWUI_LAUNCHER, "-NoBrowser"]) },
  { id: "mychat", name: "MyChat gateway", url: "http://127.0.0.1:11500/health", port: 11500, graceSec: 20, image: "node.exe",
    watch: () => [...listFiles(path.join(MYCHAT_DIR, "core"), ".mjs"), path.join(MYCHAT_DIR, "pc", "server.mjs"), path.join(MYCHAT_DIR, "pc", "bench.mjs")],
    start: () => launch(NODE, [path.join(MYCHAT_DIR, "pc", "server.mjs")], { cwd: MYCHAT_DIR }),
    stop: async () => { await post("http://127.0.0.1:11500/admin/shutdown", { Authorization: "Bearer " + token() }).catch(() => {}); } },
  { id: "kestrel", name: "Kestrel (PC agent)", url: "http://127.0.0.1:8765/api/status", port: 8765, graceSec: 60, image: "python",
    watch: () => [...listFiles(path.join(KESTREL_DIR, "kestrel"), ".py"), path.join(KESTREL_DIR, "config.json")],
    idle: (body) => { try { return !JSON.parse(body).busy; } catch { return true; } },
    start: () => PYW && launch(PYW, ["-m", "kestrel", "serve", "--no-browser"], { cwd: KESTREL_DIR }) },
];

// ---------------------------------------------------------------------------- helpers
const LOG = path.join(HOME, "supervisor.log");
export function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    if (exists(LOG) && fs.statSync(LOG).size > 1_000_000) fs.renameSync(LOG, LOG + ".1");
    fs.appendFileSync(LOG, line);
  } catch { /* logging must never stop the supervisor */ }
}
function token() { try { return fs.readFileSync(path.join(HOME, "token"), "utf8").trim(); } catch { return ""; } }
/** Start time a service reports about itself (gateway: startedAt ms; Kestrel: started_at s). 0 = unknown. */
export function startedFrom(body) {
  try { const j = JSON.parse(body); return j.startedAt || (j.started_at ? j.started_at * 1000 : 0) || 0; } catch { return 0; }
}
function listFiles(dir, ext) { try { return fs.readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f)); } catch { return []; } }
function newestMtime(files) { let m = 0; for (const f of files) { try { m = Math.max(m, fs.statSync(f).mtimeMs); } catch { /* gone */ } } return m; }

function launch(cmd, args, { cwd, env } = {}) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...(env || {}) }, detached: true, stdio: "ignore", windowsHide: true });
  p.on("error", (e) => log(`launch failed: ${cmd} ${e.message}`));
  p.unref();
  return true;
}

function get(url, timeoutMs = 4000) {
  return new Promise((ok) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let b = ""; res.setEncoding("utf8"); res.on("data", (d) => (b += d)); res.on("end", () => ok({ status: res.statusCode, body: b }));
    });
    req.on("timeout", () => { req.destroy(); ok({ status: 0, body: "timeout" }); });
    req.on("error", (e) => ok({ status: 0, body: e.code || e.message }));
  });
}
function post(url, headers = {}) {
  return new Promise((ok, bad) => {
    const req = http.request(url, { method: "POST", headers: { "Content-Length": 0, ...headers }, timeout: 5000 }, (res) => { res.resume(); res.on("end", () => ok(res.statusCode)); });
    req.on("error", bad); req.on("timeout", () => { req.destroy(); bad(new Error("timeout")); }); req.end();
  });
}
const sh = (cmd, args) => new Promise((ok) => execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (e, out) => ok(String(out || ""))));

/** Stop whatever listens on `port`, but only if its program is the one we expect (never kill an unrelated app). */
export async function killPortOwner(port, image) {
  if (!WIN) return false;
  const out = await sh("netstat", ["-ano", "-p", "TCP"]);
  const pids = new Set(out.split(/\r?\n/).filter((l) => l.includes(`127.0.0.1:${port} `) && /LISTENING/.test(l)).map((l) => l.trim().split(/\s+/).pop()));
  let killed = false;
  for (const pid of pids) {
    const img = (await sh("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"])).toLowerCase();
    if (image && !img.includes(image.toLowerCase())) { log(`not stopping PID ${pid} on :${port}: it is not ${image}`); continue; }
    await sh("taskkill", ["/PID", pid, "/T", "/F"]);
    killed = true;
  }
  return killed;
}

// ---------------------------------------------------------------------------- the loop
const state = Object.fromEntries(SERVICES.map((s) => [s.id, { up: false, since: 0, startedAt: 0, starts: [], restarts: 0, lastError: "", codeAt: 0, pendingReload: false }]));
let busyLoop = false;

export async function checkOnce(services = SERVICES, now = Date.now) {
  for (const s of services) {
    const st = state[s.id] || (state[s.id] = { up: false, since: 0, startedAt: 0, starts: [], restarts: 0, lastError: "", codeAt: 0, pendingReload: false });
    const r = await get(s.url);
    const up = r.status >= 200 && r.status < 500 && r.status !== 0;
    if (up !== st.up) { st.up = up; st.since = now(); log(`${s.id} is ${up ? "up" : "DOWN (" + r.body.slice(0, 80) + ")"}`); }
    if (up) {
      if (!st.startedAt) {                                // was already running when the supervisor started:
        st.startedAt = now();                             // its code is as new as its own start time (reported by the
        if (s.watch) st.codeAt = startedFrom(r.body);     // service); a service that can't say is reloaded once, when idle
      }
      // reload on new code: MyChat at once; Kestrel only while idle (a build in progress is never interrupted)
      if (s.watch) {
        const code = newestMtime(s.watch());
        if (code > st.codeAt + 1000) {
          st.pendingReload = true;
          if (!s.idle || s.idle(r.body)) {
            log(`${s.id}: new code on disk, reloading`);
            if (s.stop) await s.stop();
            await sleep(800);
            if ((await get(s.url)).status) await killPortOwner(s.port, s.image);
            st.codeAt = code; st.pendingReload = false; st.up = false; st.restarts++;
            await sleep(1500);
            s.start(); st.startedAt = now(); st.starts.push(now());
          }
        }
      }
      continue;
    }
    // down: start it, unless we started it moments ago (still booting) or it keeps failing (back-off)
    st.starts = st.starts.filter((t) => now() - t < 15 * 60e3);
    const booting = st.starts.length && now() - st.starts.at(-1) < s.graceSec * 1000;
    if (booting) continue;
    if (st.starts.length >= 3) { st.lastError = "failed to start 3 times in 15 minutes; waiting"; continue; }
    log(`${s.id}: starting`);
    try { if (s.start()) { st.starts.push(now()); st.startedAt = now(); if (s.watch) st.codeAt = newestMtime(s.watch()); } else st.lastError = "not installed"; }
    catch (e) { st.lastError = e.message; log(`${s.id}: start failed ${e.message}`); }
  }
  return state;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------- update from GitHub (only on request)
// Files are taken from one commit, only if its CI checks all passed; every replaced file is backed up first.
// Never touched: config.json, keys, state, logs, data.
export const MAP = [
  { from: "core/", to: () => path.join(MYCHAT_DIR, "core") },
  { from: "pc/", to: () => path.join(MYCHAT_DIR, "pc") },
  { from: "openwebui/", to: () => path.join(MYCHAT_DIR, "openwebui") },
  { from: "tools/", to: () => path.join(MYCHAT_DIR, "tools") },
  { from: "test/", to: () => path.join(MYCHAT_DIR, "test") },
  { from: "kestrel/kestrel/", to: () => path.join(KESTREL_DIR, "kestrel") },
  { from: "kestrel/ui/", to: () => path.join(KESTREL_DIR, "ui") },
  { from: "kestrel/integrations/", to: () => path.join(KESTREL_DIR, "integrations") },
  { from: "kestrel/tools/", to: () => path.join(KESTREL_DIR, "tools") },
  { from: "kestrel/tests/", to: () => path.join(KESTREL_DIR, "tests") },
];
export function localPathFor(repoPath) {
  if (/(^|\/)(config\.json|keys\.json|token|settings\.json)$/.test(repoPath) || repoPath.includes("..")) return null;
  const m = MAP.find((x) => repoPath.startsWith(x.from));
  return m ? path.join(m.to(), ...repoPath.slice(m.from.length).split("/")) : null;
}
const gitBlobSha = (buf) => crypto.createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");

export async function update({ fetchImpl = fetch, dryRun = false } = {}) {
  const gh = async (u) => { const r = await fetchImpl(u, { headers: { "User-Agent": "MyChat-supervisor", Accept: "application/vnd.github+json" } }); if (!r.ok) throw new Error(`GitHub ${r.status} for ${u}`); return r.json(); };
  const head = await gh(`https://api.github.com/repos/${REPO}/commits/main`);
  const sha = head.sha;
  const checks = await gh(`https://api.github.com/repos/${REPO}/commits/${sha}/check-runs`);
  const runs = checks.check_runs || [];
  if (!runs.length) throw new Error("this commit has no CI results yet; try again in a few minutes");
  const bad = runs.filter((c) => c.status !== "completed" || !["success", "skipped", "neutral"].includes(c.conclusion));
  if (bad.length) throw new Error(`not installing ${sha.slice(0, 7)}: CI ${bad.map((c) => c.name + "=" + (c.conclusion || c.status)).join(", ")}`);
  const tree = await gh(`https://api.github.com/repos/${REPO}/git/trees/${sha}?recursive=1`);
  const changed = [];
  for (const it of tree.tree || []) {
    if (it.type !== "blob") continue;
    const local = localPathFor(it.path);
    if (!local) continue;
    let same = false;
    try { same = gitBlobSha(fs.readFileSync(local)) === it.sha || gitBlobSha(Buffer.from(fs.readFileSync(local, "utf8").replace(/\r\n/g, "\n"))) === it.sha; } catch { /* new file */ }
    if (!same) changed.push({ repo: it.path, local, sha: it.sha });
  }
  if (dryRun || !changed.length) return { commit: sha, changed: changed.map((c) => c.repo), installed: false };
  const backup = path.join(HOME, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
  for (const c of changed) {
    const r = await fetchImpl(`https://raw.githubusercontent.com/${REPO}/${sha}/${c.repo}`);
    if (!r.ok) throw new Error(`download failed for ${c.repo}: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (gitBlobSha(buf) !== c.sha) throw new Error(`integrity check failed for ${c.repo}`);
    c.buf = buf;
  }
  for (const c of changed) {          // everything downloaded and verified before the first file is replaced
    if (exists(c.local)) { const b = path.join(backup, path.relative(path.parse(c.local).root, c.local)); fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(c.local, b); }
    fs.mkdirSync(path.dirname(c.local), { recursive: true });
    fs.writeFileSync(c.local, c.buf);
  }
  log(`update: installed ${sha.slice(0, 7)} (${changed.length} files), backup in ${backup}`);
  return { commit: sha, changed: changed.map((c) => c.repo), installed: true, backup };
}

// ---------------------------------------------------------------------------- status server (also the single-instance lock)
export function startServer() {
  let lastUpdate = null;
  const srv = http.createServer(async (req, res) => {
    const host = String(req.headers.host || "").replace(/:\d+$/, "");
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (!["127.0.0.1", "localhost"].includes(host)) return send(403, { error: "forbidden host" });
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/status") {
      return send(200, { pid: process.pid, since: STARTED, services: SERVICES.map((s) => ({ id: s.id, name: s.name, ...state[s.id], starts: undefined })), lastUpdate });
    }
    const auth = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token() || auth !== token()) return send(401, { error: "unauthorized" });
    if (req.method === "POST" && url.pathname === "/update") {
      try { lastUpdate = { at: Date.now(), ...(await update({ dryRun: url.searchParams.get("check") === "1" })) }; send(200, lastUpdate); setTimeout(loop, 1000); }
      catch (e) { lastUpdate = { at: Date.now(), error: e.message }; send(200, lastUpdate); }
      return;
    }
    send(404, { error: "not found" });
  });
  return new Promise((ok, bad) => { srv.once("error", bad); srv.listen(PORT, "127.0.0.1", () => ok(srv)); });
}

const STARTED = Date.now();
async function loop() {
  if (busyLoop) return;
  busyLoop = true;
  try {
    const before = SERVICES.reduce((n, s) => n + state[s.id].starts.length, 0);
    await checkOnce();
    if (SERVICES.reduce((n, s) => n + state[s.id].starts.length, 0) > before) setTimeout(loop, 4000);   // confirm soon after a start
    // the supervisor reloads itself too when its own file changes
    if (newestMtime([SELF]) > STARTED + 1000) { log("supervisor: new version on disk, restarting"); launch(NODE, [SELF, "--replace"]); setTimeout(() => process.exit(0), 300); }
  } catch (e) { log("loop error: " + e.message); }
  busyLoop = false;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  (async () => {
    let started = false;
    for (let i = 0; i < (process.argv.includes("--replace") ? 20 : 1); i++) {
      try { await startServer(); started = true; break; }
      catch (e) {
        if (e.code !== "EADDRINUSE") throw e;
        if (!process.argv.includes("--replace")) { console.log("MyChat supervisor is already running."); process.exit(0); }
        await sleep(500);   // the old copy is exiting
      }
    }
    if (!started) { log("supervisor: another copy keeps the port; exiting"); process.exit(0); }
    log(`supervisor ${process.pid} started (MyChat ${MYCHAT_DIR}, Kestrel ${KESTREL_DIR})`);
    await loop();
    setInterval(loop, 20000);
  })();
}
