// What really changed between two versions — the check for every handoff between agents (Lovable, Replit, GLM…):
// files added/removed/changed with line counts, and inside code files which functions and classes were added, removed
// or rewritten (by body, from the parser-built map). With the PC's browser both versions are also RUN and their errors
// compared. Then the agent checks the handoff's claims ("fixed X", "added Y") against this — claimed vs actual.
import { outline } from "./codemap.mjs";

/** Lines added/removed, by counting (exact for small edits, fast on 12,000-line files where a full diff is too slow). */
function lineDelta(a, b) {
  const cnt = new Map();
  for (const l of a.split("\n")) cnt.set(l, (cnt.get(l) || 0) + 1);
  let added = 0;
  for (const l of b.split("\n")) { const c = cnt.get(l) || 0; if (c > 0) cnt.set(l, c - 1); else added++; }
  let removed = 0; for (const c of cnt.values()) removed += c;
  return { added, removed };
}

const CODE = /\.(html?|m?js|cjs|jsx|ts|tsx|css|py|json|java|kt|swift|go|rs|c|cpp|h|cs|php|rb|vue|svelte)$/i;
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

/** Function/class name → body hash (overloads and duplicates keep the first). */
function bodies(text, path) {
  const o = outline(text, path), lines = text.split("\n"), m = new Map();
  for (const it of o.items) if (it.kind !== "embedded" && !m.has(it.kind + " " + it.name)) m.set(it.kind + " " + it.name, { h: hash(lines.slice(it.from - 1, it.to).join("\n").replace(/\s+/g, " ")), from: it.from, to: it.to });
  return { m, summary: o.summary };
}

/**
 * compareVersions(reader, a, b) — a, b: two files, folders or archives in the workspace ("v1.zip", "Projects/app-v2").
 * reader: workspaceReader(fs). Returns { text, files: {added, removed, changed}, code: [{ path, added, removed, rewritten }] }.
 */
export async function compareVersions(reader, a, b) {
  const list = async (p) => {
    const t = await reader.text(p).catch(() => null);
    if (t != null && !/\.(zip|apk|jar)$/i.test(p)) return new Map([[p.split("/").pop(), { full: p }]]);   // a single file
    const fl = await reader.files(p, { limit: 3000 });
    const base = p.replace(/\/$/, "");
    return new Map(fl.map((f) => [f.path.startsWith(base) ? f.path.slice(base.length).replace(/^[!/]+/, "") : f.path, { full: f.path, size: f.size }]));
  };
  const [A, B] = await Promise.all([list(a), list(b)]);
  // a single file on each side: compare them to each other even if the names differ (app-v1.html vs app-v2.html)
  if (A.size === 1 && B.size === 1) { const [ka] = A.keys(), [kb] = B.keys(); if (ka !== kb) { B.set(ka, B.get(kb)); B.delete(kb); } }
  const added = [...B.keys()].filter((k) => !A.has(k)), removed = [...A.keys()].filter((k) => !B.has(k));
  const changed = [], code = [];
  for (const k of [...A.keys()].filter((x) => B.has(x)).slice(0, 400)) {
    const [ta, tb] = await Promise.all([reader.text(A.get(k).full), reader.text(B.get(k).full)]);
    if (ta == null || tb == null) { if ((A.get(k).size ?? -1) !== (B.get(k).size ?? -2)) changed.push({ path: k, binary: true }); continue; }
    if (ta === tb) continue;
    const d = lineDelta(ta, tb);
    changed.push({ path: k, added: d.added, removed: d.removed, lines: [ta.split("\n").length, tb.split("\n").length] });
    if (CODE.test(k)) {
      const ba = bodies(ta, k), bb = bodies(tb, k);
      const add = [...bb.m.keys()].filter((n) => !ba.m.has(n)), rem = [...ba.m.keys()].filter((n) => !bb.m.has(n));
      const rew = [...bb.m.keys()].filter((n) => ba.m.has(n) && ba.m.get(n).h !== bb.m.get(n).h).map((n) => `${n} (now L${bb.m.get(n).from}-${bb.m.get(n).to})`);
      code.push({ path: k, added: add, removed: rem, rewritten: rew });
    }
  }
  const fmt = (arr, n = 25) => arr.slice(0, n).join(", ") + (arr.length > n ? ` … +${arr.length - n}` : "");
  const text = [
    `COMPARED ${a}  →  ${b} (computed by a program, not guessed)`,
    `Files: ${added.length} added, ${removed.length} removed, ${changed.length} changed${A.size + B.size > 2 ? ` (of ${A.size} → ${B.size})` : ""}`,
    added.length ? `ADDED FILES: ${fmt(added)}` : "", removed.length ? `REMOVED FILES: ${fmt(removed)}` : "",
    ...changed.slice(0, 60).map((c) => c.binary ? `CHANGED ${c.path} (binary)` : `CHANGED ${c.path}: +${c.added} −${c.removed} lines (${c.lines[0]} → ${c.lines[1]})`),
    ...code.flatMap((c) => [
      c.added.length ? `  ${c.path} NEW: ${fmt(c.added)}` : "", c.removed.length ? `  ${c.path} REMOVED: ${fmt(c.removed)}` : "",
      c.rewritten.length ? `  ${c.path} REWRITTEN: ${fmt(c.rewritten)}` : ""]),
    !added.length && !removed.length && !changed.length ? "NO DIFFERENCE: the two versions are identical." : "",
  ].filter(Boolean).join("\n");
  return { text, files: { added, removed, changed }, code };
}
