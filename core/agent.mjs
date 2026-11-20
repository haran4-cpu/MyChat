// Agent mode — work on files and folders the way a careful person would:
//   1. look (tree + the files that matter), 2. propose a plan of concrete changes,
//   3. show every change (diffs) and wait for approval, 4. apply only what was approved,
//   5. keep a journal so every applied plan can be undone.
// Nothing is ever deleted: "delete" moves the item into .mychat-trash/<plan id>/ inside the same folder.
// The same code runs on the PC gateway (Node fs) and in the phone app (Capacitor Filesystem); each passes a small
// fs adapter: { list(rel) -> [{name, dir, size}], read(rel) -> string|null, write(rel, text), mkdir(rel),
//               move(from, to), exists(rel) -> bool, rmdirEmpty(rel) }.

export const TRASH = ".mychat-trash";
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", TRASH, ".gradle", "build", "dist"]);
const PROTECTED = /(^|\/)(keys\.json|token|\.env(\..*)?|id_rsa.*|.*\.pem|.*\.keystore)$/i;
const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|ps1|bat|sql|svg|log|env\.example|gitignore)$/i;
export const OPS = ["write", "append", "mkdir", "move", "delete", "extract"];

/** A path inside the workspace: relative, forward slashes, no "..", no drive letters, nothing secret. */
export function safeRel(p) {
  if (typeof p !== "string") return null;
  let s = p.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  if (!s || s === "." || /^[a-zA-Z]:/.test(s) || s.startsWith("/") || s.startsWith("~")) return null;
  const parts = s.split("/");
  if (parts.some((x) => x === ".." || x === "." || x === "" || /[<>:"|?*\x00-\x1f]/.test(x))) return null;
  if (parts[0] === TRASH || PROTECTED.test(s)) return null;
  return s;
}
export const isText = (p) => TEXT_EXT.test(p) || !/\.[a-z0-9]{1,6}$/i.test(p.split("/").pop());

/** The folder as a compact indented listing (what the model sees first). */
export async function tree(fs, { maxEntries = 400, maxDepth = 4 } = {}) {
  const lines = [];
  let n = 0;
  async function walk(rel, depth) {
    if (n >= maxEntries) return;
    let items = [];
    try { items = await fs.list(rel); } catch { return; }
    items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    for (const it of items) {
      if (n++ >= maxEntries) { lines.push("  ".repeat(depth) + "… (more not shown)"); return; }
      const path = rel ? rel + "/" + it.name : it.name;
      if (it.dir) {
        lines.push("  ".repeat(depth) + it.name + "/");
        if (!SKIP_DIRS.has(it.name) && depth < maxDepth) await walk(path, depth + 1);
      } else lines.push("  ".repeat(depth) + it.name + (it.size != null ? `  (${fmtSize(it.size)})` : ""));
    }
  }
  await walk("", 0);
  return lines.join("\n") || "(empty folder)";
}
const fmtSize = (b) => (b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : (b / 1048576).toFixed(1) + " MB");

const SYS = `You are MyChat Agent: a senior engineer and careful assistant working inside ONE folder (the workspace) with tools.
How you work (gather context → act → verify → repeat):
1. Understand what is asked and what "done" looks like.
2. Gather evidence with tools before concluding. Never guess what a file contains: read it. Archives (.zip/.apk) can be listed and read in place with paths like "Inbox/app.zip!/src/main.js".
3. For anything big (a whole project, many files, a code review) use "study": several models read it in parallel and every finding is checked against the real file.
4. Verify before answering: re-check numbers with "calc", re-read the exact lines you cite. Cite places as path:line.
5. Changes are only PROPOSED (as "ops" in your final reply); the person approves them before anything happens.
Reply with JSON only, one object per turn:
  {"thought":"short reasoning","tool":"<name>","args":{...}}            — use one tool
  {"thought":"...","calls":[{"tool":"...","args":{...}}, ...]}         — up to 4 independent tools at once
  {"thought":"...","final":"the answer for the person (their language, markdown)","ops":[...]}   — finish; ops optional
TOOLS:
__TOOLS__
OPS (proposed changes, applied only after approval):
  {"op":"mkdir","path":"a/b","why":"..."}
  {"op":"write","path":"a/b.txt","content":"FULL file content","why":"..."}   (read a file before rewriting it)
  {"op":"append","path":"a/log.md","content":"text","why":"..."}
  {"op":"move","path":"old.txt","to":"new/old.txt","why":"..."}
  {"op":"delete","path":"a/old.txt","why":"..."}   (goes to trash; undo restores)
  {"op":"extract","path":"Inbox/app.zip","to":"Projects/app","why":"..."}   (unpack an archive)
Be direct and specific, no filler. If something cannot be done, say exactly why and what would make it possible.`;

export const TOOL_DOCS = {
  tree: ["{\"path\":\"optional sub-folder or archive\"}", "the folder (or an archive) as an indented listing"],
  read: ["{\"path\":\"file or archive!/inner/file\",\"from\":1,\"to\":400}", "a text file with line numbers (lines optional)"],
  search: ["{\"pattern\":\"regex\",\"path\":\"optional folder or archive\"}", "matching lines (path:line: text) across text files"],
  study: ["{\"question\":\"...\",\"path\":\"folder or archive\"}", "deep read of many files by several models; returns verified findings"],
  calc: ["{\"expression\":\"(17.5/100)*2480\"}", "exact arithmetic"],
  web_search: ["{\"query\":\"...\"}", "web results with excerpts"],
  fetch: ["{\"url\":\"https://...\"}", "a web page as text"],
  run_js: ["{\"code\":\"...\"}", "run JavaScript in a sandbox (no files, no network); returns console output"],
};

const MAX_OBS = 12000;
const trimObs = (t) => (t.length > MAX_OBS ? t.slice(0, MAX_OBS) + `\n…(cut at ${MAX_OBS} characters; read a smaller range for more)` : t);

/** Read access to the workspace and to archives inside it ("a.zip!/inner/path"). */
export function workspaceReader(fs) {
  const zips = new Map();
  const openZip = async (rel) => {
    if (zips.has(rel)) return zips.get(rel);
    if (!fs.readBytes) throw new Error("archives cannot be read on this device");
    const { zipEntries } = await import("./zip.mjs");
    const bytes = await fs.readBytes(rel);
    if (!bytes) throw new Error(rel + " not found");
    const z = { bytes, entries: zipEntries(bytes) };
    zips.set(rel, z);
    return z;
  };
  const split = (p) => { const k = String(p || "").indexOf("!/"); return k < 0 ? [p, null] : [p.slice(0, k), p.slice(k + 2)]; };
  const self = {
    async text(path) {
      const [outer, inner] = split(path);
      if (inner == null) { const rel = safeRel(outer); if (!rel) throw new Error("unsafe path"); return fs.read(rel); }
      const z = await openZip(safeRel(outer));
      let e = z.entries.find((x) => x.name === inner || x.name === inner.replace(/^\/+/, ""));
      if (!e) throw new Error(`${inner} is not in ${outer}`);
      const { zipRead, looksText, isZip } = await import("./zip.mjs");
      const data = await zipRead(z.bytes, e);
      if (isZip(data)) return `(${inner} is itself an archive: read it as "${path}!/<inner path>" after extracting, or extract ${outer} first)`;
      return looksText(data) ? new TextDecoder().decode(data) : null;
    },
    async files(path = "", { limit = 3000 } = {}) {   // [{path, size}] of every file under path (folder or archive)
      const [outer, inner] = split(path);
      if (inner != null || /\.(zip|apk|jar)$/i.test(outer || "")) {
        const z = await openZip(safeRel(outer));
        return z.entries.filter((e) => !e.dir && (!inner || e.name.startsWith(inner))).slice(0, limit).map((e) => ({ path: `${outer}!/${e.name}`, size: e.size }));
      }
      const out = [];
      const walk = async (rel) => {
        if (out.length >= limit) return;
        let items = []; try { items = await fs.list(rel); } catch { return; }
        for (const it of items) {
          const p2 = rel ? rel + "/" + it.name : it.name;
          if (it.dir) { if (!SKIP_DIRS.has(it.name)) await walk(p2); } else out.push({ path: p2, size: it.size });
          if (out.length >= limit) return;
        }
      };
      await walk(path ? safeRel(path) || "" : "");
      return out;
    },
  };
  return self;
}

/**
 * The agent loop: the model thinks, calls tools, sees results, and finishes with an answer and optional proposed ops.
 * host = { search?: Search, fetchText?(url), runJs?(code), privateData?, onStep?(step) }
 * Returns { id, goal, answer, summary, ops, rejected, steps, by, calls, reads, at }.
 */
export async function runAgent(gw, { goal, fs, history = [], signal, maxSteps = 14, privateData = false, search, fetchText, runJs, onStep = () => {}, evaluate }) {
  const reader = workspaceReader(fs);
  const avail = Object.keys(TOOL_DOCS).filter((t) => (t !== "web_search" || (search && !privateData)) && (t !== "fetch" || (fetchText && !privateData)) && (t !== "run_js" || runJs) && (t !== "calc" || evaluate));
  const sys = SYS.replace("__TOOLS__", avail.map((t) => `  ${t} ${TOOL_DOCS[t][0]} — ${TOOL_DOCS[t][1]}`).join("\n"));
  const listing = await tree(fs, { maxEntries: 250, maxDepth: 3 });
  const msgs = [{ role: "system", content: sys }, ...history.slice(-8),
    { role: "user", content: `WORKSPACE (top levels):\n${listing}\n\nREQUEST:\n${goal}` }];
  const steps = [], reads = new Set();
  let by = "", calls = 0, last = null;
  const runTool = async (name, args = {}) => {
    if (!avail.includes(name)) return `unknown tool "${name}". Available: ${avail.join(", ")}`;
    try {
      if (name === "tree") {
        if (args.path && /\.(zip|apk|jar)(!\/|$)/i.test(args.path)) return (await reader.files(args.path, { limit: 400 })).map((f) => `${f.path}  (${fmtSize(f.size)})`).join("\n") || "(empty)";
        const sub = args.path ? safeRel(args.path) : "";
        if (args.path && !sub) return "unsafe path";
        return await tree(sub ? subFs(fs, sub) : fs, { maxEntries: 400, maxDepth: 5 });
      }
      if (name === "read") {
        const t = await reader.text(args.path);
        if (t == null) return `${args.path}: not found or not a text file`;
        reads.add(args.path);
        const lines = t.split("\n"), from = Math.max(1, Number(args.from) || 1), to = Math.min(lines.length, Number(args.to) || from + 399);
        return `${args.path} — lines ${from}-${to} of ${lines.length}\n` + lines.slice(from - 1, to).map((l, i) => `${from + i}| ${l}`).join("\n");
      }
      if (name === "search") {
        const rx = new RegExp(String(args.pattern || ""), "i"), hits = [];
        for (const f of await reader.files(args.path || "", { limit: 2000 })) {
          if (f.size > 2_000_000 || !isText(f.path.split("!/").pop())) continue;
          const t = await reader.text(f.path).catch(() => null);
          if (!t) continue;
          t.split("\n").forEach((l, i) => { if (hits.length < 60 && rx.test(l)) hits.push(`${f.path}:${i + 1}: ${l.trim().slice(0, 200)}`); });
          if (hits.length >= 60) break;
        }
        return hits.join("\n") || "no matches";
      }
      if (name === "study") {
        const { study } = await import("./digest.mjs");
        const list = await reader.files(args.path || "", { limit: 3000 });
        const files = [];
        for (const f of list) { if (f.size > 1_500_000 || !isText(f.path.split("!/").pop())) continue; const t = await reader.text(f.path).catch(() => null); if (t != null) files.push({ path: f.path, text: t }); }
        const r = await study(gw, { question: args.question || goal, files, signal, privateData, onStatus: (s) => onStep({ kind: "status", text: s }) });
        calls += r.calls;
        return `STUDY RESULT (${r.read} files in ${r.parts} parts; ${r.notes.length} verified notes, ${r.dropped} unproven dropped${r.skipped.length ? `; not read: ${r.skipped.length}` : ""}):\n${r.answer}\n\nVERIFIED NOTES:\n` +
          r.notes.slice(0, 40).map((n) => `[${n.severity}] ${n.path}:${n.line} — ${n.note}`).join("\n");
      }
      if (name === "calc") return String(evaluate(String(args.expression || "")));
      if (name === "web_search") { const r = await search.evidence(String(args.query || "")); return r.slice(0, 6).map((x, i) => `[${i + 1}] ${x.title}\n${x.url}\n${(x.text || "").slice(0, 700)}`).join("\n\n") || "no results"; }
      if (name === "fetch") return await fetchText(String(args.url || ""));
      if (name === "run_js") return await runJs(String(args.code || ""));
    } catch (e) { return `error: ${e.message}`; }
    return "no result";
  };
  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) throw new Error("stopped");
    compact(msgs);
    const r = await gw.chat({ messages: msgs, temperature: 0.2 }, { task: "code", signal, privateData });
    calls++; by = `${r.provider}:${r.model}`;
    last = parseJson(r.content);
    if (!last) {   // models sometimes answer in plain text: accept it as the final answer
      if (step > 0 || !/\{/.test(r.content)) { last = { final: r.content }; break; }
      msgs.push({ role: "assistant", content: r.content }, { role: "user", content: "Reply with one JSON object as described (tool call or final)." });
      continue;
    }
    if (last.final != null || Array.isArray(last.ops) && !last.tool && !last.calls) break;
    const list = Array.isArray(last.calls) ? last.calls.slice(0, 4) : last.tool ? [{ tool: last.tool, args: last.args }] : [];
    if (!list.length) { last = { final: last.thought || r.content }; break; }
    if (last.thought) onStep({ kind: "thought", text: String(last.thought).slice(0, 400) });
    const results = await Promise.all(list.map(async (c) => {
      onStep({ kind: "tool", tool: c.tool, args: c.args });
      const out = trimObs(String(await runTool(c.tool, c.args || {})));
      steps.push({ thought: last.thought || "", tool: c.tool, args: c.args, result: out.slice(0, 600) });
      return `RESULT of ${c.tool} ${JSON.stringify(c.args || {}).slice(0, 200)}:\n${out}`;
    }));
    msgs.push({ role: "assistant", content: JSON.stringify({ thought: last.thought, calls: list }) }, { role: "user", content: results.join("\n\n") });
    if (step === maxSteps - 2) msgs.push({ role: "user", content: "One step left: give your final answer now (JSON with \"final\")." });
  }
  const { ops, rejected } = checkOps(last?.ops);
  const answer = String(last?.final ?? last?.summary ?? "").trim() || "(no answer)";
  return { id: newId(), goal, answer, summary: answer.slice(0, 600), ops, rejected, steps, by, calls, reads: [...reads], at: Date.now() };
}

/** Keep the conversation inside a sane size: old tool results are shortened (they can be read again). */
function compact(msgs, max = 110_000) {
  let total = msgs.reduce((a, m) => a + m.content.length, 0);
  for (let i = 2; i < msgs.length - 4 && total > max; i++) {
    const m = msgs[i];
    if (m.role === "user" && m.content.startsWith("RESULT") && m.content.length > 600) { total -= m.content.length - 400; m.content = m.content.slice(0, 400) + "\n…(older result shortened; use the tool again if needed)"; }
  }
}
function subFs(fs, base) {
  const j = (r) => (r ? base + "/" + r : base);
  return { list: (r) => fs.list(j(r)), read: (r) => fs.read(j(r)), exists: (r) => fs.exists(j(r)) };
}

function parseJson(t) {
  const s = String(t || "").replace(/^[\s\S]*?```(?:json)?\s*/i, (m) => (m.includes("```") ? "" : m)).replace(/```[\s\S]*$/, "");
  for (const cand of [s, String(t || "")]) {
    const a = cand.indexOf("{"), b = cand.lastIndexOf("}");
    if (a >= 0 && b > a) { try { return JSON.parse(cand.slice(a, b + 1)); } catch { /* next */ } }
  }
  return null;
}

/** Validate the model's ops: safe paths, known ops, sizes. Returns { ops, rejected }. */
export function checkOps(raw) {
  const ops = [], rejected = [];
  for (const o of Array.isArray(raw) ? raw.slice(0, 60) : []) {
    const path = safeRel(o?.path), to = o?.to != null ? safeRel(o.to) : null;
    const why = String(o?.why || "").slice(0, 300);
    if (!o || !OPS.includes(o.op) || !path) { rejected.push({ ...o, reason: "unknown operation or unsafe path" }); continue; }
    if ((o.op === "move" || o.op === "extract") && !to) { rejected.push({ ...o, reason: `${o.op} needs a safe destination ("to")` }); continue; }
    if ((o.op === "write" || o.op === "append") && typeof o.content !== "string") { rejected.push({ ...o, reason: "no content" }); continue; }
    if ((o.op === "write" || o.op === "append") && o.content.length > 2_000_000) { rejected.push({ op: o.op, path, reason: "content over 2 MB" }); continue; }
    if ((o.op === "write" || o.op === "append") && !isText(path)) { rejected.push({ op: o.op, path, reason: "not a text file type" }); continue; }
    ops.push({ op: o.op, path, ...(to ? { to } : {}), ...(o.content != null ? { content: o.content } : {}), why });
  }
  return { ops, rejected };
}

/**
 * Ask the models for a plan. gw = the router (chat with failover). Returns
 * { id, goal, summary, ops, rejected, by, reads, at }.
 */
/** Compatibility: the PC API and older callers ask for a "plan" — that is now one agent run. */
export async function plan(gw, opts) {
  const r = await runAgent(gw, opts);
  return r;
}

export const newId = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6);

/** What each op will do, with a line diff for files that change. */
export async function preview(fs, ops) {
  const out = [];
  for (const o of ops) {
    const exists = await fs.exists(o.path).catch(() => false);
    const item = { ...o, exists };
    if (o.op === "write" || o.op === "append") {
      const before = exists ? await fs.read(o.path).catch(() => null) : "";
      const after = o.op === "append" ? (before || "") + o.content : o.content;
      item.diff = before == null ? null : lineDiff(before || "", after);
      item.stats = item.diff ? { added: item.diff.filter((l) => l[0] === "+").length, removed: item.diff.filter((l) => l[0] === "-").length } : null;
      item.unchanged = before === after;
    }
    if (o.op === "move" || o.op === "extract") item.targetExists = await fs.exists(o.to).catch(() => false);
    item.label = describe(o, exists);
    out.push(item);
  }
  return out;
}
function describe(o, exists) {
  if (o.op === "mkdir") return exists ? `Folder ${o.path} (already there)` : `New folder ${o.path}`;
  if (o.op === "write") return exists ? `Change ${o.path}` : `New file ${o.path}`;
  if (o.op === "append") return `Add to ${o.path}`;
  if (o.op === "move") return `Move ${o.path} → ${o.to}`;
  if (o.op === "extract") return `Unpack ${o.path} into ${o.to}/`;
  return `Delete ${o.path} (to trash, can be undone)`;
}

/** Line diff (LCS) as ["  same", "- old", "+ new"], context trimmed to 3 lines around changes. */
export function lineDiff(a, b, context = 3) {
  const A = a === "" ? [] : a.split("\n"), B = b === "" ? [] : b.split("\n");
  if (A.length * B.length > 4_000_000) return [`~ large file: ${A.length} → ${B.length} lines`];
  const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const all = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { all.push("  " + A[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) all.push("- " + A[i++]);
    else all.push("+ " + B[j++]);
  }
  while (i < n) all.push("- " + A[i++]);
  while (j < m) all.push("+ " + B[j++]);
  const keep = all.map((l, k) => l[0] !== " " || all.slice(Math.max(0, k - context), k + context + 1).some((x) => x[0] !== " "));
  const out = [];
  all.forEach((l, k) => { if (keep[k]) out.push(l); else if (out.at(-1) !== "  …") out.push("  …"); });
  return out;
}

/**
 * Apply the approved ops (indexes into plan.ops; default all). Returns a journal { id, goal, at, steps, error? }.
 * Stops at the first failure; what was applied before it stays in the journal, so undo still works.
 */
export async function apply(fs, p, approved = null) {
  const pick = approved ? new Set(approved) : null;
  const journal = { id: p.id, goal: p.goal, summary: p.summary, at: Date.now(), steps: [] };
  for (const [k, o] of p.ops.entries()) {
    if (pick && !pick.has(k)) continue;
    try {
      const exists = await fs.exists(o.path);
      if (o.op === "mkdir") {
        if (!exists) { await fs.mkdir(o.path); journal.steps.push({ op: "mkdir", path: o.path }); }
      } else if (o.op === "write" || o.op === "append") {
        const prev = exists ? await fs.read(o.path) : null;
        if (exists && prev == null) throw new Error(`${o.path} is not a text file; not changed`);
        await ensureParent(fs, o.path, journal);
        await fs.write(o.path, o.op === "append" ? (prev || "") + o.content : o.content);
        journal.steps.push({ op: "write", path: o.path, prev });
      } else if (o.op === "move") {
        if (!exists) throw new Error(`${o.path} does not exist`);
        if (await fs.exists(o.to)) throw new Error(`${o.to} already exists; not overwritten`);
        await ensureParent(fs, o.to, journal);
        await fs.move(o.path, o.to);
        journal.steps.push({ op: "move", path: o.path, to: o.to });
      } else if (o.op === "extract") {
        if (!exists) throw new Error(`${o.path} does not exist`);
        if (await fs.exists(o.to)) throw new Error(`${o.to} already exists; not overwritten`);
        if (!fs.readBytes) throw new Error("archives cannot be unpacked on this device");
        const { extractZip } = await import("./zip.mjs");
        await ensureParent(fs, o.to, journal);
        const r = await extractZip(await fs.readBytes(o.path), fs, o.to);
        journal.steps.push({ op: "extract", path: o.path, to: o.to, files: r.files });
      } else if (o.op === "delete") {
        if (!exists) continue;
        const t = `${TRASH}/${p.id}/${o.path}`;
        await ensureParent(fs, t, null);
        await fs.move(o.path, t);
        journal.steps.push({ op: "delete", path: o.path, trash: t });
      }
    } catch (e) {
      journal.error = `${o.op} ${o.path}: ${e.message}`;
      break;
    }
  }
  return journal;
}
async function ensureParent(fs, rel, journal) {
  const parts = rel.split("/").slice(0, -1);
  for (let k = 1; k <= parts.length; k++) {
    const d = parts.slice(0, k).join("/");
    if (!(await fs.exists(d))) { await fs.mkdir(d); journal?.steps.push({ op: "mkdir", path: d, auto: true }); }
  }
}

/** Reverse a journal, newest step first. New files go to the trash (not deleted); replaced files get their old text back. */
export async function undo(fs, journal) {
  const problems = [];
  for (const s of [...journal.steps].reverse()) {
    try {
      if (s.op === "write") {
        if (s.prev == null) {
          if (await fs.exists(s.path)) { const t = `${TRASH}/undo-${journal.id}/${s.path}`; await ensureParent(fs, t, null); await fs.move(s.path, t); }
        } else await fs.write(s.path, s.prev);
      } else if (s.op === "move") {
        if (await fs.exists(s.path)) throw new Error(`${s.path} exists again; left as is`);
        await fs.move(s.to, s.path);
      } else if (s.op === "delete") {
        if (await fs.exists(s.path)) throw new Error(`${s.path} exists again; the trashed copy stays in ${s.trash}`);
        await ensureParent(fs, s.path, null);
        await fs.move(s.trash, s.path);
      } else if (s.op === "extract") {
        if (await fs.exists(s.to)) { const t = `${TRASH}/undo-${journal.id}/${s.to}`; await ensureParent(fs, t, null); await fs.move(s.to, t); }
      } else if (s.op === "mkdir") {
        await fs.rmdirEmpty(s.path).catch(() => problems.push(`${s.path}/ is not empty; kept`));
      }
    } catch (e) { problems.push(e.message); }
  }
  return { ok: !problems.length, problems };
}

/** In-memory fs (tests, and the phone app in a plain browser). */
export function memoryFs(init = {}) {
  const files = new Map(Object.entries(init)), dirs = new Set();
  for (const p of files.keys()) { const ps = p.split("/"); for (let k = 1; k < ps.length; k++) dirs.add(ps.slice(0, k).join("/")); }
  const isDir = (p) => dirs.has(p);
  return {
    files, dirs,
    async list(rel) {
      const pre = rel ? rel + "/" : "", seen = new Map();
      for (const p of [...files.keys(), ...dirs]) {
        if (!p.startsWith(pre) || p === rel) continue;
        const name = p.slice(pre.length).split("/")[0];
        const full = pre + name;
        if (!seen.has(name)) seen.set(name, { name, dir: isDir(full), size: files.has(full) ? (files.get(full).length ?? files.get(full).byteLength) : undefined });
      }
      return [...seen.values()];
    },
    async read(rel) { const v = files.get(rel); return v == null ? null : typeof v === "string" ? v : null; },
    async readBytes(rel) { const v = files.get(rel); return v == null ? null : typeof v === "string" ? new TextEncoder().encode(v) : v; },
    async writeBytes(rel, bytes) { files.set(rel, bytes); },
    async write(rel, text) { files.set(rel, text); },
    async mkdir(rel) { dirs.add(rel); },
    async exists(rel) { return files.has(rel) || dirs.has(rel); },
    async move(a, b) {
      if (files.has(a)) { files.set(b, files.get(a)); files.delete(a); return; }
      if (!dirs.has(a)) throw new Error("not found");
      for (const p of [...files.keys()]) if (p.startsWith(a + "/")) { files.set(b + p.slice(a.length), files.get(p)); files.delete(p); }
      for (const d of [...dirs]) if (d === a || d.startsWith(a + "/")) { dirs.delete(d); dirs.add(b + d.slice(a.length)); }
    },
    async rmdirEmpty(rel) {
      if ([...files.keys(), ...dirs].some((p) => p.startsWith(rel + "/"))) throw new Error("not empty");
      dirs.delete(rel);
    },
  };
}
