// Markdown → safe HTML for answers: headings, lists (nested), tables, quotes, rules, code blocks with a language
// label and Copy, inline code / bold / italic / strike / links. Everything is escaped first; only http(s) links.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function inline(t) {
  const codes = [];
  let s = esc(t).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<i>$2</i>").replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<i>$2</i>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function list(lines, i) {
  const out = [], base = listItem.exec(lines[i])[1].length, ordered = /\d/.test(listItem.exec(lines[i])[2]);
  while (i < lines.length) {
    const m = listItem.exec(lines[i]);
    if (!m || m[1].length < base) break;
    if (m[1].length > base) { const [html, j] = list(lines, i); out[out.length - 1] += html; i = j; continue; }
    let body = inline(m[3]);
    i++;
    while (i < lines.length && lines[i].trim() && !listItem.test(lines[i]) && /^\s{2,}/.test(lines[i])) body += "<br>" + inline(lines[i++].trim());
    const task = /^\[( |x)\]\s/i.exec(m[3]);
    if (task) body = `<span class="task">${task[1].trim() ? "☑" : "☐"}</span> ` + inline(m[3].slice(4));
    out.push(body);
  }
  return [`<${ordered ? "ol" : "ul"}>${out.map((x) => `<li>${x}</li>`).join("")}</${ordered ? "ol" : "ul"}>`, i];
}

function blocks(text) {
  const lines = text.split("\n"), html = [];
  let i = 0, para = [];
  const flush = () => { if (para.length) { html.push(`<p dir="auto">${para.map(inline).join("<br>")}</p>`); para = []; } };
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { flush(); i++; continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { flush(); const n = Math.min(4, m[1].length + 1); html.push(`<h${n} dir="auto">${inline(m[2])}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); html.push("<hr>"); i++; continue; }
    if (isTableRow(l) && i + 1 < lines.length && isSep(lines[i + 1])) {
      flush();
      const head = cells(l), rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      html.push(`<div class="tablewrap"><table><thead><tr>${head.map((c) => `<th dir="auto">${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
        rows.map((r) => `<tr>${head.map((_, k) => `<td dir="auto">${inline(r[k] ?? "")}</td>`).join("")}</tr>`).join("") + "</tbody></table></div>");
      continue;
    }
    if (/^\s*>/.test(l)) {
      flush();
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      html.push(`<blockquote dir="auto">${blocks(q.join("\n"))}</blockquote>`);
      continue;
    }
    if (listItem.test(l)) { flush(); const [h, j] = list(lines, i); html.push(h); i = j; continue; }
    para.push(l); i++;
  }
  flush();
  return html.join("");
}

export function md(src) {
  return String(src ?? "").split(/^```/m).map((part, i) => {
    if (i % 2) {
      const nl = part.indexOf("\n"), lang = nl > 0 ? part.slice(0, nl).trim() : "", code = nl >= 0 ? part.slice(nl + 1) : part;
      return `<pre dir="ltr"><span class="lang">${esc(lang)}</span><button class="copycode" type="button">Copy</button><code>${esc(code.replace(/\n$/, ""))}</code></pre>`;
    }
    return blocks(part.replace(/^[^\n]*\n?/, i ? "" : (m) => m));   // text after a closing fence starts on the next line
  }).join("");
}
