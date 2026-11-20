// Reading more than fits in one model call: a whole project, a big archive, many attachments.
// How strong agents do it (sub-agents / map-reduce): split into parts, let several models read the parts in parallel,
// each returning notes WITH exact quotes, then CHECK every quote against the real file (a note whose quote is not in
// the file is dropped — no proof, no claim), then one model writes the answer only from the verified notes.

const SKIP_PATH = /(^|\/)(node_modules|\.git|dist|build|out|\.next|\.gradle|__pycache__|\.venv|vendor|coverage|\.mychat-trash|META-INF|kotlin)(\/|$)|(\.min\.(js|css)|\.map|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i;
const PRIORITY = [/readme/i, /package\.json$|pyproject\.toml$|requirements\.txt$|capacitor\.config|AndroidManifest\.xml$|\.gradle$/i,
  /(^|\/)(src|app|lib|core|server|pc|www)\//i, /\.(m?js|ts|tsx|jsx|py|kt|java|go|rs|cs|swift|dart)$/i, /\.(html|css|json|ya?ml|toml|md)$/i];
const rank = (p) => { const i = PRIORITY.findIndex((rx) => rx.test(p)); return i < 0 ? PRIORITY.length : i; };

/** Pick readable files, most informative first, within a character budget. */
export function selectFiles(files, budget = 600_000) {
  const seen = new Map(), dupes = [];
  const ok = files.filter((f) => typeof f.text === "string" && !SKIP_PATH.test(f.path) && !/^.{4000,}$/m.test(f.text.slice(0, 20000)))
    .filter((f) => {   // the same file twice (an app ZIP that also holds its APK) is read once
      const k = f.text.length + ":" + f.text.slice(0, 200) + f.text.slice(-200);
      if (seen.has(k) && seen.get(k) === f.text) { dupes.push(f.path); return false; }
      seen.set(k, f.text); return true;
    });
  ok.sort((a, b) => rank(a.path) - rank(b.path) || a.text.length - b.text.length);
  const picked = [], skipped = [];
  let used = 0;
  for (const f of ok) { if (used + f.text.length > budget) { skipped.push(f.path); continue; } picked.push(f); used += f.text.length; }
  const filtered = files.filter((f) => !ok.includes(f) && !dupes.includes(f.path)).map((f) => f.path);
  return { picked, skipped: [...skipped, ...filtered], chars: used, duplicates: dupes.length };
}

/** Pack files into parts of at most `size` characters (big files are split by lines, with their line numbers kept). */
export function chunk(files, size = 50_000) {
  const parts = [];
  let cur = [], n = 0;
  const push = () => { if (cur.length) parts.push(cur); cur = []; n = 0; };
  for (const f of files) {
    const lines = f.text.split("\n");
    let start = 0;
    while (start < lines.length) {
      let end = start, len = 0;
      while (end < lines.length && len + lines[end].length + 1 <= Math.max(1000, size - n)) len += lines[end++].length + 1;
      if (end === start) {
        if (n === 0) { cur.push({ path: f.path, from: start + 1, text: lines[start].slice(0, size) }); start++; push(); }   // one very long line
        else push();
        continue;
      }
      cur.push({ path: f.path, from: start + 1, text: lines.slice(start, end).join("\n") });
      n += len; start = end;
      if (n >= size * 0.9) push();
    }
  }
  push();
  return parts;
}
const numbered = (piece) => piece.text.split("\n").map((l, i) => `${piece.from + i}| ${l}`).join("\n");

const MAP_SYS = `You read ONE PART of a larger set of files for a question. Report only what this part shows.
Reply with JSON only: {"summary":"2-4 sentences: what these files are and do","notes":[{"path":"file path","line":<line number>,"quote":"exact text copied from that line (or a short exact snippet)","note":"what it means for the question","severity":"high|medium|low|info"}]}
Rules: every note needs a quote copied character-for-character from the files shown (lines are shown as "N| text"; do not copy the "N| " prefix).
No quote, no note. Prefer few, specific, important notes over many vague ones (max 12). If this part is irrelevant, return an empty notes list.`;

const REDUCE_SYS = `You write the final answer from verified notes taken from the files. Each note was checked: its quote really appears at that place.
Use only these notes and summaries; do not invent files, code or problems that are not in them. Cite places as path:line.
Be concrete and direct like a senior engineer: what matters most first, why it matters, and the specific fix. Answer in the language of the question.`;

function parseJson(t) {
  const s = String(t || ""), a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
const squash = (s) => String(s).replace(/\s+/g, " ").trim();

/** Check a note's quote against the real file. Returns the line where it was found, or 0. */
export function verifyQuote(fileText, quote, hintLine = 0) {
  const q = squash(quote);
  if (q.length < 4 || !fileText) return 0;
  const lines = fileText.split("\n"), L = lines.map(squash);
  const lo = hintLine > 0 ? Math.max(0, hintLine - 6) : 0, hi = hintLine > 0 ? Math.min(lines.length, hintLine + 5) : 0;
  for (let i = lo; i < hi; i++) if (L[i].includes(q)) return i + 1;            // on (or next to) the cited line
  for (let i = 0; i < lines.length; i++) if (L[i].includes(q)) return i + 1;    // anywhere in the file
  for (let i = 0; i < lines.length; i++) if (L.slice(i, i + 4).join(" ").includes(q)) return i + 1;   // a quote spanning lines
  return 0;
}

const sleep = (ms, signal) => new Promise((ok, bad) => { const t = setTimeout(ok, ms); signal?.addEventListener?.("abort", () => { clearTimeout(t); bad(new Error("stopped")); }); });
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (k < items.length) { const i = k++; out[i] = await fn(items[i], i); } }));
  return out;
}

/**
 * study(gw, { question, files:[{path,text}], ... }) -> { answer, notes, dropped, parts, skipped, calls, by }
 */
export async function study(gw, { question, files, budget = 600_000, partSize = 50_000, concurrency = 3, retryDelayMs = 20000, onStatus = () => {}, signal, privateData = false }) {
  const { picked, skipped } = selectFiles(files, budget);
  if (!picked.length) return { answer: "None of these files can be read as text.", notes: [], dropped: 0, parts: 0, skipped, calls: 0 };
  const parts = chunk(picked, partSize);
  const byPath = new Map(picked.map((f) => [f.path, f.text]));
  let calls = 0, done = 0;
  onStatus(`Reading ${picked.length} files in ${parts.length} part(s)…`);
  // Free accounts hit rate limits mid-way: a failed part waits and is retried (other models, less parallelism) instead
  // of being lost. Parts that still fail are named in the answer.
  let par = concurrency;
  const readPart = async (part, i) => {
    const body = part.map((p) => `===== ${p.path} (from line ${p.from}) =====\n${numbered(p)}`).join("\n\n");
    calls++;
    const r = await gw.chat({ temperature: 0.1, messages: [{ role: "system", content: MAP_SYS },
      { role: "user", content: `QUESTION:\n${question}\n\nPART ${i + 1} of ${parts.length}:\n${body}` }] }, { task: "long", signal, privateData });
    onStatus(`Read part ${++done} of ${parts.length}…`);
    return { ...(parseJson(r.content) || { summary: "", notes: [] }), by: `${r.provider}:${r.model}` };
  };
  const results = new Array(parts.length);
  let queue = parts.map((_, i) => i);
  for (let round = 0; round < 3 && queue.length; round++) {
    if (round) { onStatus(`Retrying ${queue.length} part(s) in ${round * 20} s (rate limits)…`); await sleep(round * retryDelayMs, signal); par = 1; }
    const failed = [];
    await pool(queue, par, async (i) => {
      try { results[i] = await readPart(parts[i], i); }
      catch (e) { if (signal?.aborted) throw e; failed.push(i); results[i] = { summary: "", notes: [], error: e.message }; onStatus(`Part ${i + 1} failed (${e.message.slice(0, 60)}); will retry`); }
    });
    queue = failed.sort((a, b) => a - b);
  }
  const notes = [];
  let dropped = 0;
  for (const r of results) for (const n of Array.isArray(r.notes) ? r.notes : []) {
    const text = byPath.get(n.path) ?? byPath.get([...byPath.keys()].find((k) => k.endsWith("/" + n.path) || n.path?.endsWith("/" + k)) || "");
    const line = text ? verifyQuote(text, n.quote, Number(n.line) || 0) : 0;
    if (!line) { dropped++; continue; }
    notes.push({ path: [...byPath.keys()].find((k) => byPath.get(k) === text), line, quote: String(n.quote).slice(0, 300), note: String(n.note || "").slice(0, 600), severity: n.severity || "info" });
  }
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  notes.sort((a, b) => (order[a.severity] ?? 4) - (order[b.severity] ?? 4));
  onStatus(`Writing the answer from ${notes.length} verified notes (${dropped} unproven dropped)…`);
  const summaries = results.map((r, i) => `Part ${i + 1}: ${r.summary || (r.error ? "(could not be read: " + r.error.slice(0, 80) + ")" : "")}`).join("\n");
  const noteText = notes.slice(0, 80).map((n) => `[${n.severity}] ${n.path}:${n.line} — ${n.note}\n    > ${n.quote}`).join("\n");
  calls++;
  const fin = await gw.chat({ temperature: 0.2, messages: [{ role: "system", content: REDUCE_SYS },
    { role: "user", content: `QUESTION:\n${question}\n\n${results.some((r) => r?.error) ? `NOTE: ${results.filter((r) => r?.error).length} of ${parts.length} parts could not be read (model limits); say so briefly.\n\n` : ""}FILES READ: ${picked.length}${skipped.length ? ` (not read: ${skipped.length}, e.g. ${skipped.slice(0, 5).join(", ")})` : ""}\n\nPART SUMMARIES:\n${summaries}\n\nVERIFIED NOTES (${notes.length}; ${dropped} notes were dropped because their quote was not in the file):\n${noteText || "(none)"}` }] },
    { task: "reason", signal, privateData });
  const unread = results.filter((r) => r?.error).length;
  return { answer: fin.content, notes, dropped, parts: parts.length, unread, skipped, calls, by: `${fin.provider}:${fin.model}`, read: picked.length };
}
