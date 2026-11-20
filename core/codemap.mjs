// A map of a code file built by a parser, not by a model: deterministic, free, complete. The agent reads the map
// first and then only the line ranges it needs (measured 2026-11-20: models reading a 12,000-line HTML app in slices
// lost the picture and invented what they had not seen).
//
// outline(text, path) -> { lines, items: [{ kind, name, from, to, detail }], ids, events, scripts, summary }

const JS_EXT = /\.(m?js|cjs|jsx|ts|tsx|html?|svelte|vue)$/i;

/** Line number (1-based) of a character offset. */
function lineAt(starts, off) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

/** Offset of the brace that closes the one at `open`, skipping strings, template literals, comments and regex-ish text. */
function closeBrace(src, open) {
  let depth = 0, i = open;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); i = e < 0 ? n : e; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "/") {   // a regex literal (after an operator or keyword) may contain braces and quotes
      let j = i - 1; while (j >= 0 && /\s/.test(src[j])) j--;
      const prev = src[j] || "";
      const word = /[\w$]/.test(prev) ? (src.slice(Math.max(0, j - 8), j + 1).match(/[\w$]+$/) || [""])[0] : "";
      if (!prev || "(,=:[!&|?{};+-*%<>~^".includes(prev) || /^(return|typeof|case|in|of|void|delete|throw|new)$/.test(word)) {
        let k = i + 1, cls = false;
        while (k < n && src[k] !== "\n") {
          if (src[k] === "\\") { k += 2; continue; }
          if (src[k] === "[") cls = true; else if (src[k] === "]") cls = false; else if (src[k] === "/" && !cls) break;
          k++;
        }
        if (src[k] === "/") { i = k + 1; continue; }
      }
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < n && src[i] !== q) { if (src[i] === "\\") i++; else if (q === "`" && src[i] === "$" && src[i + 1] === "{") { const e = closeBrace(src, i + 1); i = e; } i++; }
      i++; continue;
    }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
    i++;
  }
  return n - 1;
}

export function outline(text, path = "") {
  const src = String(text || "");
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  const items = [], ids = new Set(), events = [];
  // script regions in HTML (code outside them is markup)
  const scripts = [];
  if (/\.html?$/i.test(path) || /<script[\s>]/i.test(src)) {
    for (const m of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const from = lineAt(starts, m.index), to = lineAt(starts, m.index + m[0].length);
      scripts.push({ from, to, attrs: m[1].trim().slice(0, 80) });
    }
    for (const m of src.matchAll(/\bid\s*=\s*["']([\w:-]+)["']/g)) ids.add(m[1]);
    for (const m of src.matchAll(/\bon(click|change|input|keydown|keyup|submit|load|pointerdown|touchstart)\s*=\s*["']([^"']{1,80})/gi))
      events.push({ event: m[1].toLowerCase(), handler: m[2].trim(), line: lineAt(starts, m.index) });
  }
  if (!JS_EXT.test(path) && !scripts.length) return { lines: starts.length, items, ids: [], events, scripts, summary: `${starts.length} lines (not code)` };
  const add = (kind, name, idx, braceAt, detail = "") => {
    const from = lineAt(starts, idx);
    const to = braceAt >= 0 ? lineAt(starts, closeBrace(src, braceAt)) : from;
    items.push({ kind, name, from, to, detail: detail.replace(/\s+/g, " ").slice(0, 100) });
  };
  const pats = [
    ["function", /(?:^|[^\w$.])(?:async\s+)?function\s*\*?\s*([\w$]+)\s*\(([^)]{0,200})\)\s*\{/g],
    ["class", /(?:^|[^\w$.])class\s+([\w$]+)(?:\s+extends\s+[\w$.]+)?\s*\{/g],
    ["function", /(?:^|[^\w$.])(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:function\b[^(]*)?\(([^)]{0,200})\)\s*(?:=>)?\s*\{/g],
    ["function", /(?:^|[^\w$.])(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?([\w$]+)\s*=>\s*\{/g],
    ["object", /(?:^|[^\w$.])(?:const|let|var)\s+([A-Z_$][\w$]*)\s*=\s*\{/g],
  ];
  for (const [kind, re] of pats) for (const m of src.matchAll(re)) {
    const brace = src.indexOf("{", m.index + m[0].length - 1);
    add(kind, m[1], m.index + (m[0].match(/^[^\w$]/) ? 1 : 0), brace, m[2] ? `(${m[2]})` : "");
  }
  // methods inside classes: name(args) { at the start of a line
  for (const m of src.matchAll(/^\s+(?:static\s+|async\s+|get\s+|set\s+)*([\w$]+)\s*\(([^)]{0,160})\)\s*\{/gm)) {
    if (/^(if|for|while|switch|catch|function|return|with)$/.test(m[1])) continue;
    const at = m.index + m[0].indexOf(m[1]);
    if (items.some((it) => lineAt(starts, at) === it.from)) continue;
    add("method", m[1], at, src.indexOf("{", m.index + m[0].length - 1), `(${m[2]})`);
  }
  for (const m of src.matchAll(/([\w$.\]\)]+)\.addEventListener\(\s*["']([\w:-]+)["']/g))
    events.push({ event: m[2], target: m[1].slice(-40), line: lineAt(starts, m.index) });
  items.sort((a, b) => a.from - b.from || b.to - a.to);
  const seen = new Set();
  const uniq = items.filter((it) => { const k = it.from + ":" + it.name; if (seen.has(k)) return false; seen.add(k); return true; });
  // many definitions starting on one line = code serialized inside a string (e.g. a worklet built from source text):
  // their ranges are meaningless, so they are listed once as an embedded block instead of as false ranges
  const perLine = {};
  for (const it of uniq) perLine[it.from] = (perLine[it.from] || 0) + 1;
  for (let k = uniq.length - 1; k >= 0; k--) {
    const it = uniq[k];
    if (perLine[it.from] >= 3 || (it.to - it.from > 1500 && uniq.filter((o) => o.from > it.from && o.from < it.to && o.kind === "class").length > 3)) uniq.splice(k, 1);
  }
  for (const [ln, c] of Object.entries(perLine)) if (c >= 3) uniq.push({ kind: "embedded", name: `${c} definitions packed on one line (code inside a string)`, from: Number(ln), to: Number(ln), detail: "" });
  uniq.sort((a, b) => a.from - b.from);
  const big = [...uniq].sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, 5).map((it) => `${it.name} (${it.to - it.from + 1} lines)`);
  return {
    lines: starts.length, items: uniq, ids: [...ids], events, scripts,
    summary: `${starts.length} lines · ${scripts.length} script block(s) · ${uniq.filter((i) => i.kind === "function" || i.kind === "method").length} functions/methods · ` +
      `${uniq.filter((i) => i.kind === "class").length} classes · ${ids.size} element ids · ${events.length} event handlers · largest: ${big.join(", ")}`,
  };
}

/** The map as text for a model: every item with its exact line range, so it reads only what it needs. */
export function outlineText(o, max = 400) {
  const rows = o.items.slice(0, max).map((it) => `L${it.from}-${it.to}  ${it.kind} ${it.name}${it.detail}`);
  const ev = o.events.slice(0, 80).map((e) => `L${e.line}  on ${e.event} ${e.target || ""}${e.handler ? " → " + e.handler : ""}`);
  return [o.summary,
    o.scripts.length ? "SCRIPTS: " + o.scripts.map((s) => `L${s.from}-${s.to}${s.attrs ? " [" + s.attrs + "]" : ""}`).join(", ") : "",
    "ITEMS:", ...rows, o.items.length > max ? `… ${o.items.length - max} more (ask outline with a "from" line to see later ones)` : "",
    ev.length ? "EVENTS:" : "", ...ev,
    o.ids.length ? `ELEMENT IDS (${o.ids.length}): ${o.ids.slice(0, 150).join(" ")}` : ""].filter(Boolean).join("\n");
}
