// Models write JSON loosely: raw line breaks inside strings, a ```json fence, text around it, or a long markdown
// answer (with its own ``` code blocks) inside "final". Parse what they meant instead of showing the raw JSON
// (measured: answers reached the user starting with `","final":"## Code Review`).

/** Escape raw control characters inside string literals so JSON.parse accepts them. */
export function repairJson(s) {
  let out = "", inStr = false, esc = false;
  for (const ch of s) {
    if (!inStr) { if (ch === '"') inStr = true; out += ch; continue; }
    if (esc) { out += ch; esc = false; continue; }
    if (ch === "\\") { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = false; out += ch; continue; }
    if (ch === "\n") { out += "\\n"; continue; }
    if (ch === "\r") continue;
    if (ch === "\t") { out += "\\t"; continue; }
    out += ch;
  }
  return out;
}

export function parseJsonLoose(t) {
  const raw = String(t || "");
  const cands = [];
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a >= 0 && b > a) cands.push(raw.slice(a, b + 1));
  const fence = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(raw);
  if (fence) cands.push(fence[1]);
  for (const c of cands) for (const x of [c, repairJson(c)]) { try { const v = JSON.parse(x); if (v && typeof v === "object") return v; } catch { /* next */ } }
  // last resort: the "final" text alone
  const m = /"final"\s*:\s*"/.exec(raw);
  if (m) {
    let s = raw.slice(m.index + m[0].length);
    const end = s.search(/"\s*,\s*"(ops|thought)"\s*:|"\s*\}\s*(```)?\s*$/);
    if (end >= 0) s = s.slice(0, end);
    return { final: s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\") };
  }
  return null;
}
