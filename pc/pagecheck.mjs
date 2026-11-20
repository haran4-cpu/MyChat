// Proof by running: open an HTML app in a headless browser on this PC, catch every error, press its buttons one by one,
// and report what broke and where (file:line), with screenshots. A model's "it works" is replaced by this report.
// Edge (always on Windows) or Chrome, driven over --remote-debugging-pipe (no network port, no WebSocket).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";

/** Serve the file's folder on 127.0.0.1 (a random port) — how the app really runs (the phone app's WebView, a local
 *  server). Measured: opened as file://, DJ TiTo's audio worklet is blocked by the browser, so the engine never starts. */
function serveFolder(dir) {
  const types = { ".html": "text/html", ".htm": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm", ".mp3": "audio/mpeg", ".wav": "audio/wav" };
  const root = path.resolve(dir);
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const p = path.resolve(root, "." + rel);
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": types[path.extname(p).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv)));
}

const CANDIDATES = process.platform === "win32"
  ? [process.env.MYCHAT_BROWSER, "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
     "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe")]
  : process.platform === "darwin"
    ? [process.env.MYCHAT_BROWSER, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    : [process.env.MYCHAT_BROWSER, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
export const findBrowser = () => CANDIDATES.find((p) => p && fs.existsSync(p)) || null;

// buttons whose name says they destroy or leave are not pressed
const RISKY = /delete|remove|erase|clear all|reset all|wipe|logout|log out|sign out|uninstall|format|factory|מחק|מחיקה|אפס הכל|התנתק/i;

/**
 * checkPage(file, { clicks = 25, waitMs = 1500, outDir, timeoutMs = 90000 })
 * -> { ok, title, loadMs, errors: [{ when, text, where }], clicked: [{ label, newErrors }], skipped, failedRequests, shots: [], text }
 */
export async function checkPage(file, o = {}) {
  const exe = findBrowser();
  if (!exe) throw new Error("no Edge or Chrome found on this computer");
  const clicks = Math.max(0, Math.min(Number(o.clicks ?? 25), 80));
  const outDir = o.outDir || path.join(os.tmpdir(), "mychat-runs");
  fs.mkdirSync(outDir, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mychat-page-"));
  const child = spawn(exe, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-pipe",
    "--autoplay-policy=no-user-gesture-required", "--window-size=1280,860", "--hide-scrollbars", "--mute-audio", `--user-data-dir=${profile}`, "about:blank"],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
  let id = 0, buf = "", session = null, dead = false;
  const pend = new Map(), errors = [], failed = [];
  let phase = "load";
  child.on("exit", () => { dead = true; for (const [, r] of pend) r({ error: { message: "browser exited" } }); });
  child.stdio[4].on("data", (chunk) => {
    buf += chunk; let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      let d; try { d = JSON.parse(buf.slice(0, i)); } catch { d = {}; } buf = buf.slice(i + 1);
      if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); continue; }
      const p = d.params || {};
      if (d.method === "Runtime.exceptionThrown") {
        const x = p.exceptionDetails || {};
        errors.push({ when: phase, text: (x.exception?.description || x.text || "error").split("\n")[0].slice(0, 300), where: where(x.url, x.lineNumber) });
      } else if (d.method === "Runtime.consoleAPICalled" && p.type === "error") {
        const fr = p.stackTrace?.callFrames?.[0];
        errors.push({ when: phase, text: "console.error: " + (p.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300), where: fr ? where(fr.url, fr.lineNumber) : "" });
      } else if (d.method === "Log.entryAdded" && p.entry?.level === "error" && !/favicon/.test(p.entry.url || "")) {
        errors.push({ when: phase, text: (p.entry.text || "").slice(0, 300), where: p.entry.url ? where(p.entry.url, p.entry.lineNumber) : "" });
      } else if (d.method === "Network.loadingFailed" && !p.canceled) {
        failed.push(p.errorText);
      } else if (d.method === "Page.javascriptDialogOpening") {
        raw("Page.handleJavaScriptDialog", { accept: false }, d.sessionId);
      }
    }
  });
  const where = (url, line) => (url ? `${decodeURIComponent(String(url).split("/").pop())}:${(line ?? 0) + 1}` : "");
  const raw = (method, params = {}, sid) => new Promise((r) => {
    if (dead) return r({ error: { message: "browser exited" } });
    const i = ++id; pend.set(i, r);
    child.stdio[3].write(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }) + "\0");
  });
  const send = (m, p) => raw(m, p, session);
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, o.timeoutMs || 90000);
  const shots = [];
  let srv = null;
  const shot = async (name) => {
    const s = await send("Page.captureScreenshot", { format: "png" });
    if (!s.result?.data) return;
    const f = path.join(outDir, `${path.basename(file).replace(/[^\w.-]+/g, "_")}-${Date.now()}-${name}.png`);
    fs.writeFileSync(f, Buffer.from(s.result.data, "base64")); shots.push(f);
  };
  try {
    let target = null;
    for (let i = 0; i < 200 && !target && !dead; i++) { const t = await raw("Target.getTargets"); target = t.result?.targetInfos?.find((x) => x.type === "page"); if (!target) await sleep(150); }   // up to 30 s: a busy CI runner starts Chrome slowly
    if (!target) throw new Error("the browser did not start");
    session = (await raw("Target.attachToTarget", { targetId: target.targetId, flatten: true })).result.sessionId;
    await Promise.all(["Runtime.enable", "Page.enable", "Log.enable", "Network.enable"].map((m) => send(m)));
    await raw("Browser.setDownloadBehavior", { behavior: "deny" });
    const t0 = Date.now();
    srv = o.mode === "file" ? null : await serveFolder(path.dirname(path.resolve(file)));
    const url = srv ? `http://127.0.0.1:${srv.address().port}/${encodeURIComponent(path.basename(file))}` : pathToFileURL(path.resolve(file)).href;
    await send("Page.navigate", { url });
    for (let i = 0; i < 60; i++) { if (await ev("document.readyState") === "complete") break; await sleep(250); }
    const loadMs = Date.now() - t0;
    await sleep(o.waitMs ?? 1500);
    await shot("loaded");
    const title = await ev("document.title");
    const info = await ev(`(() => { const t = (document.body?.innerText || "").trim(); return { textChars: t.length, buttons: document.querySelectorAll("button,[role=button],input[type=button],input[type=submit]").length,
      canvases: document.querySelectorAll("canvas").length, inputs: document.querySelectorAll("input,select,textarea").length, firstText: t.slice(0, 200) }; })()`);
    // Press the buttons a person could actually press, one at a time: visible, enabled and not covered by something
    // else (a start screen or dialog goes first, as for a person). The list is re-read after every press, because
    // pressing changes the page. Errors that appear right after a press are attributed to that button.
    const clickable = `(() => { const out = [], seen = new Set(window.__mcDone || []);
      for (const b of document.querySelectorAll("button,[role=button],input[type=button]")) {
        const r = b.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || b.disabled || getComputedStyle(b).visibility === "hidden") continue;
        const cx = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), cy = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
        if (r.bottom < 0 || r.top > innerHeight) continue;
        const hit = document.elementFromPoint(cx, cy);
        if (!hit || !(hit === b || b.contains(hit))) continue;
        const label = (b.getAttribute("aria-label") || b.title || b.innerText || b.value || b.id || "button").trim().replace(/\\s+/g, " ").slice(0, 50);
        const key = label + "|" + (b.id || "");
        if (seen.has(key)) continue;
        out.push({ key, label, id: b.id || "", x: cx, y: cy });
      }
      return { list: out, total: document.querySelectorAll("button,[role=button],input[type=button]").length }; })()`;
    const clicked = [], skipped = [];
    let buttonsFound = 0;
    phase = "after load";
    await ev("window.__mcDone = []; true");
    for (let guard = 0; clicked.length < clicks && guard < clicks * 3; guard++) {
      const st = await ev(clickable) || { list: [] };
      buttonsFound = Math.max(buttonsFound, (st.list || []).length + clicked.length);
      const next = (st.list || [])[0];
      if (!next) break;
      await ev(`window.__mcDone.push(${JSON.stringify(next.key)}); true`);
      if (RISKY.test(next.label)) { skipped.push(next.label); continue; }
      const before = errors.length;
      phase = `click "${next.label}"`;
      // a real mouse click at the button's centre (pointer events, focus, user activation for audio)
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: next.x, y: next.y, button: "left", clickCount: 1 });
      await sleep(400);
      clicked.push({ label: next.label, id: next.id, newErrors: errors.length - before });
    }
    const list = { length: buttonsFound };
    phase = "end";
    await sleep(500);
    await shot("after-clicks");
    const uniqueErrors = [];
    for (const e of errors) if (!uniqueErrors.some((u) => u.text === e.text && u.where === e.where)) uniqueErrors.push({ ...e, count: errors.filter((x) => x.text === e.text && x.where === e.where).length });
    const r = { ok: !uniqueErrors.length, file, url, title, loadMs, info, errors: uniqueErrors, clicked, skipped, buttonsFound, failedRequests: [...new Set(failed)].slice(0, 10), shots, browser: path.basename(exe) };
    r.text = reportText(r);
    return r;
  } finally {
    clearTimeout(killer);
    try { srv?.close(); } catch { /* closed */ }
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Windows may hold it a moment */ } }, 1500);
  }
}

export function reportText(r) {
  const bad = r.clicked.filter((c) => c.newErrors);
  return [
    `RAN ${path.basename(r.file)} in ${r.browser} (headless, ${String(r.url).startsWith("http") ? "served from a local web server" : "opened as a file"}) — loaded in ${r.loadMs} ms, title "${r.title || ""}"`,
    `Page: ${r.info?.buttons ?? "?"} buttons, ${r.info?.inputs ?? "?"} inputs, ${r.info?.canvases ?? "?"} canvases, ${r.info?.textChars ?? "?"} characters of text`,
    `Pressed ${r.clicked.length} buttons a person could reach (each re-checked after the page changed)${r.skipped.length ? ` (not pressed, destructive names: ${r.skipped.slice(0, 6).join(", ")})` : ""}.`,
    r.errors.length ? `ERRORS (${r.errors.length} distinct):` : "No errors: nothing thrown and nothing logged as an error while loading and pressing the buttons.",
    ...r.errors.slice(0, 25).map((e) => `- [${e.when}] ${e.text}${e.where ? `  @ ${e.where}` : ""}${e.count > 1 ? ` (×${e.count})` : ""}`),
    bad.length ? `Buttons followed by errors: ${bad.map((c) => `"${c.label}" (+${c.newErrors})`).join(", ")}` : "",
    r.failedRequests.length ? `Failed loads (offline or missing files): ${r.failedRequests.join(", ")}` : "",
    r.shots.length ? `Screenshots: ${r.shots.join(" , ")}` : "",
    "This is a real run: it proves what happened in the browser, not that every feature is correct (sound, timing and looks need a person or a specific test).",
  ].filter(Boolean).join("\n");
}
