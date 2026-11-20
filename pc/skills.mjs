// Know-how loaded only when relevant: ~1,000 skills, agents and commands from public GitHub repositories under
// permissive licences (collected with Claude Hunter Pro; sources in SKILLS-NOTICE.md). The agent searches them and
// loads one when a task matches (review, debugging, security, testing, audio, …).
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

let LIB = null, DF = null;
const words = (t) => String(t || "").toLowerCase().match(/[a-z][a-z0-9+#-]{1,30}/g) || [];
const STOP = new Set("the a an and or to of in for on with is are be this that it as by from use when your you at can will not any all how what".split(" "));

function load() {
  if (LIB) return LIB;
  const f = path.join(path.dirname(fileURLToPath(import.meta.url)), "skills.json.gz");
  LIB = fs.existsSync(f) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8")) : [];
  DF = new Map();
  for (const s of LIB) {
    const head = s.content.slice(0, 1500).split("\n").filter((l) => /^#|^description:/i.test(l)).join(" ");
    s._tf = new Map();
    const add = (t, w) => { for (const x of words(t)) if (!STOP.has(x)) s._tf.set(x, (s._tf.get(x) || 0) + w); };
    add(s.name.replace(/[-_]/g, " "), 4); add(s.description, 2); add(head, 1);
    for (const x of s._tf.keys()) DF.set(x, (DF.get(x) || 0) + 1);
  }
  return LIB;
}

export function skillSearch(query, k = 6) {
  const lib = load(), N = lib.length || 1, q = [...new Set(words(query).filter((x) => !STOP.has(x)))];
  const scored = lib.map((s) => {
    let sc = 0;
    for (const x of q) { const tf = s._tf.get(x); if (tf) sc += Math.log(1 + N / (DF.get(x) || 1)) * (tf / (tf + 1.5)); }
    return [sc, s];
  }).filter(([sc]) => sc > 0).sort((a, b) => b[0] - a[0]).slice(0, k);
  if (!scored.length) return "No matching skill.";
  return scored.map(([, s]) => `${s.id} · ${s.name} (${s.kind}) — ${s.description.slice(0, 160)} [${s.source}, ${s.license}]`).join("\n") +
    "\nLoad one with skill_load {\"id\":\"...\"} and follow it where it fits this task.";
}

export function skillLoad(id) {
  const s = load().find((x) => x.id === String(id).trim());
  if (!s) return `no skill ${id}`;
  return `SKILL ${s.name} — from github.com/${s.source}/${s.path} (${s.license}; author's copyright). Adapt it to this task and this workspace; ignore steps that need tools you don't have.\n\n` + s.content.slice(0, 14000);
}

export const skillCount = () => load().length;
