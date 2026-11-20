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
export const OPS = ["write", "append", "mkdir", "move", "delete"];

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

const SYS = `You are a careful file assistant working inside ONE folder (the workspace). You propose changes; a person approves them before anything happens.
You see the folder listing and any files you asked to read. Reply with JSON only, one of:
1. Need to look first: {"read": ["relative/path", ...]}  (at most 8 files, only text files)
2. The plan: {"summary": "one or two sentences: what will change and why", "ops": [ ... ]}
Each op is one of:
  {"op":"mkdir","path":"a/b","why":"..."}
  {"op":"write","path":"a/b.txt","content":"FULL new file content","why":"..."}   (creates or replaces the whole file)
  {"op":"append","path":"a/log.md","content":"text to add at the end","why":"..."}
  {"op":"move","path":"old/name.txt","to":"new/place/name.txt","why":"..."}         (rename or move a file or folder)
  {"op":"delete","path":"a/old.txt","why":"..."}                                   (goes to a trash folder; undo brings it back)
Rules: paths are relative to the workspace, with forward slashes. Never touch files you were not asked about.
Prefer the smallest set of changes that fully does the job. To edit a file, read it first, then "write" its complete new content.
If the request is unclear or impossible, return {"summary":"<what is unclear>","ops":[]}.`;

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
    if (o.op === "move" && !to) { rejected.push({ ...o, reason: "move needs a safe destination" }); continue; }
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
export async function plan(gw, { goal, fs, history = [], onStatus = () => {}, signal, maxRounds = 3, privateData = false }) {
  const listing = await tree(fs);
  const files = {};
  let last = null, by = "";
  for (let round = 0; round < maxRounds; round++) {
    onStatus(round === 0 ? "Looking at the folder…" : "Reading the files it needs…");
    const shown = Object.entries(files).map(([p, c]) => `--- ${p} ---\n${c == null ? "(missing or not a text file)" : c}`).join("\n\n");
    const msgs = [{ role: "system", content: SYS }, ...history.slice(-6),
      { role: "user", content: `WORKSPACE LISTING:\n${listing}\n\n${shown ? "FILES YOU READ:\n" + shown + "\n\n" : ""}REQUEST:\n${goal}` +
        (round === maxRounds - 1 ? "\n\nYou cannot read more files now: reply with the plan." : "") }];
    const r = await gw.chat({ messages: msgs, temperature: 0.1 }, { task: "code", signal, privateData });
    by = `${r.provider}:${r.model}`;
    last = parseJson(r.content);
    if (!last) throw new Error("The model's plan was not valid JSON; try again.");
    if (Array.isArray(last.read) && last.read.length && !last.ops && round < maxRounds - 1) {
      for (const p of last.read.slice(0, 8)) {
        const rel = safeRel(p);
        if (!rel || rel in files) continue;
        let c = null;
        try { c = isText(rel) ? await fs.read(rel) : null; } catch { c = null; }
        files[rel] = c == null ? null : c.length > 60000 ? c.slice(0, 60000) + "\n…(cut)" : c;
      }
      continue;
    }
    break;
  }
  const { ops, rejected } = checkOps(last.ops);
  return { id: newId(), goal, summary: String(last.summary || "").slice(0, 600), ops, rejected, by, reads: Object.keys(files), at: Date.now() };
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
    if (o.op === "move") item.targetExists = await fs.exists(o.to).catch(() => false);
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
        if (!seen.has(name)) seen.set(name, { name, dir: isDir(full), size: files.has(full) ? files.get(full).length : undefined });
      }
      return [...seen.values()];
    },
    async read(rel) { return files.has(rel) ? files.get(rel) : null; },
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
