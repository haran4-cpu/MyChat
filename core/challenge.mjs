// The claims of an answer are attacked before they reach the person: a model from ANOTHER family picks the claims most
// likely to be wrong and, for each, a concrete check that would expose it (a search, a range of lines to look at).
// The checks are run by the program on the real files — the decision is the evidence, not a vote.
// Measured 2026-11-20 on DJ-TiTo: a review said "no innerHTML injections" (the file uses it 72 times) and "without
// forge-worklet.js the audio engine cannot start" (line 8114 falls back to a built-in copy). Both are one search away.
import { family } from "./router.mjs";
import { parseJsonLoose } from "./json.mjs";

const SYS = `You are a hostile fact-checker. Another model wrote the ANSWER below about the person's files. Find the claims
most likely to be WRONG (absolutes like "no", "never", "all", "cannot", "missing", "works", "broken", "only"; causes;
counts) and, for each, ONE check a program can run on the files to expose it. Reply with JSON only:
{"checks":[{"claim":"the exact claim, short","file":"path of the file to check","pattern":"JavaScript regex (case-insensitive)",
"refuted_if":"found"|"not_found","why":"what the result would prove"}]}
Examples: claim "the code never uses innerHTML" → pattern "innerHTML", refuted_if "found".
claim "without X.js nothing works" → pattern that would show a fallback, e.g. "catch[\\\\s\\\\S]{0,200}(Blob|fallback)", refuted_if "found".
claim "the button calls save()" → pattern "save\\\\(", refuted_if "not_found".
At most 6 checks. Only claims about the files. If nothing is checkable, {"checks":[]}.`;

/**
 * challenge(gw, { answer, files: Map(path -> text), by: "provider:model", signal, privateData })
 * -> { tried, refuted: [{ claim, evidence }], upheld: [{ claim, evidence }], by }
 */
export async function challenge(gw, { answer, files, by = "", signal, privateData } = {}) {
  const out = { tried: 0, refuted: [], upheld: [], by: "" };
  if (!answer || !files?.size) return out;
  const fam = family(String(by).split(":").slice(1).join(":") || "x");
  const names = [...files.keys()].slice(0, 40).join(", ");
  // up to two checkers: if the first returns nothing usable (no JSON, no checks), a second model is asked
  let checks = [];
  const tried = [...(by ? [by] : [])];
  for (let attempt = 0; attempt < 2 && !checks.length; attempt++) {
    let r;
    try {
      r = await gw.chat({ temperature: 0.1, messages: [{ role: "system", content: SYS },
        { role: "user", content: `FILES THE ANSWER IS ABOUT: ${names}\n\nANSWER:\n${String(answer).slice(0, 12000)}` }] },
        { task: "reason", signal, privateData, quality: true, exclude: tried, avoidFamily: fam });
    } catch (e) { out.note = "checker failed: " + String(e.message).slice(0, 120); continue; }
    out.by = `${r.provider}:${r.model}`; tried.push(out.by);
    checks = (parseJsonLoose(r.content)?.checks || []).filter((c) => c && c.pattern && c.claim).slice(0, 6);
    if (!checks.length) out.note = `${r.model} returned no usable checks: ${String(r.content).replace(/\s+/g, " ").slice(0, 120)}`;
  }
  for (const c of checks) {
    const key = [...files.keys()].find((k) => k === c.file || k.endsWith("/" + String(c.file || "").replace(/^\.?\//, "")) || k.split("/").pop() === String(c.file || "").split("/").pop())
      || (files.size === 1 ? [...files.keys()][0] : null);
    if (!key) { out.note = `checker named a file that was not read: ${c.file}`; continue; }
    let re;
    try { re = new RegExp(String(c.pattern).slice(0, 300), "gi"); } catch { out.note = `bad pattern from the checker: ${String(c.pattern).slice(0, 60)}`; continue; }
    const text = files.get(key), hits = [];
    for (const m of text.matchAll(re)) { hits.push(m.index); if (hits.length >= 500 || !m[0].length) break; }
    out.tried++;
    const lineOf = (i) => text.slice(0, i).split("\n").length;
    const shown = hits.slice(0, 3).map((i) => `${key}:${lineOf(i)}: ${text.split("\n")[lineOf(i) - 1].trim().slice(0, 140)}`);
    const evidence = hits.length ? `/${c.pattern}/ found ${hits.length >= 500 ? "500+" : hits.length}× — ${shown.join(" | ")}` : `/${c.pattern}/ not found in ${key}`;
    const refuted = (c.refuted_if === "found" && hits.length > 0) || (c.refuted_if === "not_found" && hits.length === 0);
    (refuted ? out.refuted : out.upheld).push({ claim: String(c.claim).slice(0, 200), evidence });
  }
  return out;
}
