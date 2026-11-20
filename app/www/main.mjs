// MyChat for Android — UI. All model work is done by ./engine.mjs (the same core as the PC gateway).
import { init, state, ask, setKey, settings, saveSettings, smartFetch, brain, pcLink } from "./engine.mjs";
import { detectKeys, validateKey, identifyPlainKey, pkcePair, openRouterAuthUrl, openRouterExchange, CONNECT, SEARCH_KEYS, exportKeys, importKeys, transferCode, BUNDLE_PREFIX } from "./core/accounts.mjs";
import { SEARCH_PROVIDERS, Search } from "./core/search.mjs";
import { agentView, filesView, hostTools } from "./agentui.mjs";
import { workspace, importFiles } from "./files.mjs";
import { workspaceReader, runAgent, preview as previewOps, apply as applyOps, undo as undoOps } from "./core/agent.mjs";
import { WORKSPACE_RX } from "./core/projects.mjs";
import { study } from "./core/digest.mjs";

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const Cap = globalThis.Capacitor;
const plugin = (n) => Cap?.Plugins?.[n];
const OAUTH_RETURN = "https://haran4-cpu.github.io/MyChat/oauth/";

function toast(t, ms = 2600) { const x = $("#toast"); x.textContent = t; x.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (x.hidden = true), ms); }
function openExternal(url) { const b = plugin("Browser"); if (b) b.open({ url }); else window.open(url, "_blank", "noopener"); }

// ---------------------------------------------------------------- markdown (escaped first, then a small safe subset)
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function inline(t) {
  return esc(t)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>');
}
export function md(src) {
  return String(src).split("```").map((part, i) => {
    if (i % 2) return `<pre><code>${esc(part.replace(/^[\w+.-]*\n/, ""))}</code></pre>`;
    return part.split(/\n{2,}/).filter((p) => p.trim()).map((p) => {
      const h = /^#{1,4}\s+(.*)$/.exec(p.trim());
      if (h && !p.trim().includes("\n")) return `<p><b>${inline(h[1])}</b></p>`;
      return `<p>${p.split("\n").map(inline).join("<br>")}</p>`;
    }).join("");
  }).join("");
}

// ---------------------------------------------------------------- chats (kept on the phone)
const MODES = [["auto", "Auto"], ["fast", "Fast"], ["max", "Max"], ["verified", "Verified"], ["consensus", "Consensus"]];
let chats = []; try { chats = JSON.parse(localStorage.getItem("mychat.chats") || "[]"); } catch { chats = []; }
let current = null, mode = localStorage.getItem("mychat.mode") || "auto", running = null;
const saveChats = () => { try { localStorage.setItem("mychat.chats", JSON.stringify(chats.slice(0, 200))); } catch { chats = chats.slice(0, 50); } };
function newChat() { current = { id: Date.now().toString(36), title: "", messages: [], meta: [] }; renderChat(); }
function openChat(id) { current = chats.find((c) => c.id === id) || current; renderChat(); }

function renderModes() {
  const box = $("#modes"); box.replaceChildren();
  for (const [id, label] of MODES) {
    box.append(el("button", { type: "button", role: "radio", "aria-checked": String(id === mode), class: id,
      onclick: () => { mode = id; localStorage.setItem("mychat.mode", id); renderModes(); } }, label));
  }
}

function botBubble(content, meta = {}) {
  const wrap = el("div", { class: "msg bot", dir: "auto" });
  const body = el("div", { class: "body" });
  const shown = meta.claims ? String(content).split("\n\n---\n")[0] : content;
  body.innerHTML = md(shown || "");
  wrap.append(body);
  if (meta.claims?.length) {
    const n = (s) => meta.claims.filter((c) => c.status === s).length;
    const chips = el("div", { class: "chips" });
    if (n("supported")) chips.append(el("span", { class: "chip ok" }, `✓ ${n("supported")} proven`));
    if (n("refuted")) chips.append(el("span", { class: "chip fix" }, `↻ ${n("refuted")} corrected`));
    if (n("agreed")) chips.append(el("span", { class: "chip" }, `${n("agreed")} agreed`));
    const un = meta.claims.length - n("supported") - n("refuted") - n("agreed") - n("opinion");
    if (un > 0) chips.append(el("span", { class: "chip" }, `${un} unverified`));
    if (meta.sources?.length) chips.append(el("span", { class: "chip" }, `${meta.sources.length} sources`));
    chips.append(el("button", { class: "chip link", type: "button", onclick: () => showChecks(meta) }, "See the checks"));
    wrap.append(chips);
  }
  return wrap;
}

function whoLine(meta) {
  const by = (meta.trace || []).map((t) => t.by).filter(Boolean).map((b) => b.split(":").slice(1).join(":").split("/").pop());
  const uniq = [...new Set(by)];
  const secs = meta.ms ? ` · ${Math.round(meta.ms / 1000)} s` : "";
  return uniq.length ? el("div", { class: "who" }, `${meta.mode || ""} · ${uniq.slice(0, 3).join(", ")}${secs}`) : null;
}

/** Changes the assistant proposed from the chat: approve here, undo here (same engine as the Agent tab). */
function chatOps(o) {
  const wrap = el("div", { class: "card opsbox" }, el("b", {}, "Proposed changes"));
  if (o.journal) {
    wrap.append(el("p", {}, `${o.journal.undone ? "Undone" : "Applied"}: ${o.journal.steps.length} change(s)${o.journal.error ? " — stopped at: " + o.journal.error : ""}`));
    if (!o.journal.undone) wrap.append(el("button", { class: "btn ghost", type: "button", onclick: async () => { const r = await undoOps(await workspace(), o.journal); o.journal.undone = Date.now(); saveChats(); renderChat(); toast(r.ok ? "Undone" : r.problems.join("; ")); } }, "Undo"));
    return wrap;
  }
  const boxes = (o.preview || o.ops).map((p, i) => {
    const cb = el("input", { type: "checkbox", checked: !p.unchanged });
    wrap.append(el("label", { class: "row" }, cb, el("span", { class: "grow", dir: "auto" }, `${i + 1}. ${p.label || p.op + " " + p.path}${p.stats ? `  +${p.stats.added} −${p.stats.removed}` : ""}`)));
    return cb;
  });
  wrap.append(el("div", { class: "actions" }, el("button", { class: "btn", type: "button", onclick: async () => {
    const pick = boxes.map((b, i) => (b.checked ? i : -1)).filter((i) => i >= 0);
    if (!pick.length) return toast("Nothing selected");
    o.journal = await applyOps(await workspace(), { id: o.id, goal: o.goal, ops: o.ops }, pick);
    saveChats(); renderChat();
  } }, "Approve and apply")));
  return wrap;
}

function renderChat() {
  const box = $("#messages"); box.replaceChildren();
  $("#viewSub").textContent = current.title || "";
  if (!current.messages.length) {
    box.append(el("div", { class: "empty" }, el("b", {}, "MyChat"),
      "Ask anything. Facts and numbers are checked automatically.", el("br"), "שאלו כל דבר. עובדות ומספרים נבדקים אוטומטית."));
    return;
  }
  current.messages.forEach((m, i) => {
    if (m.role === "user") box.append(el("div", { class: "msg user", dir: "auto" }, m.content, m.files?.length ? el("div", { class: "files" }, m.files.map((f) => el("span", { class: "chip file" }, "📎 " + f.split("/").pop()))) : null));
    else {
      const meta = current.meta[i] || {};
      const w = whoLine(meta); if (w) box.append(w);
      box.append(botBubble(m.content, meta));
      if (meta.steps?.length) box.append(el("details", { class: "steps-box" }, el("summary", {}, `🔧 ${meta.steps.length} steps — looked at your files`), el("div", { class: "steps" }, meta.steps.map((x) => el("div", { class: "step tool" }, x)))));
      if (meta.ops) box.append(chatOps(meta.ops));
      box.append(el("div", { class: "actions" },
        el("button", { type: "button", onclick: () => { navigator.clipboard?.writeText(m.content.split("\n\n---\n")[0]).then(() => toast("Copied")); } }, "Copy"),
        i === current.messages.length - 1 ? el("button", { type: "button", onclick: retry }, "Try again") : null));
    }
  });
  box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------- attachments (📎): files from the phone or the MyChat folder
let attached = [];   // [{ name, path, kind: "file"|"folder"|"image", url? }]
function renderAttached() {
  const row = $("#attachRow"); row.replaceChildren(); row.hidden = !attached.length;
  attached.forEach((a, i) => row.append(el("span", { class: "chip file" }, (a.kind === "image" ? "🖼️ " : a.kind === "folder" ? "📁 " : "📄 ") + a.name,
    el("button", { type: "button", "aria-label": "Remove " + a.name, onclick: () => { attached.splice(i, 1); renderAttached(); } }, "×"))));
}
async function attachPhoneFiles(list) {
  const fs = await workspace();
  const status = $("#statusLine"); status.hidden = false;
  const images = [...list].filter((f) => /^image\//.test(f.type));
  const others = [...list].filter((f) => !/^image\//.test(f.type));
  for (const f of images) attached.push({ name: f.name, kind: "image", url: await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(f); }) });
  if (others.length) {
    const r = await importFiles(fs, others, { onStatus: (t) => (status.textContent = t) });
    const unpacked = new Set(r.projects.filter((p) => p.to && !p.from.includes("/Projects/")).map((p) => p.from));
    for (const p of r.projects) if (p.to && !p.from.startsWith("Projects/")) attached.push({ name: p.to.split("/").pop(), path: p.to, kind: "folder" });
    for (const rel of r.saved) if (!unpacked.has(rel)) attached.push({ name: rel.split("/").pop(), path: rel, kind: "file" });
  }
  status.hidden = true;
  renderAttached();
}
async function attachSheet() {
  const fs = await workspace();
  const box = $("#sheetContent"); $("#sheetTitle").textContent = "Attach";
  const input = el("input", { type: "file", multiple: true, hidden: true, onchange: async (e) => { $("#sheet").hidden = true; await attachPhoneFiles(e.target.files); } });
  const recent = [];
  for (const top of ["Projects", "Inbox"]) {
    for (const it of await fs.list(top).catch(() => [])) {
      if (top === "Inbox" && it.dir) for (const f of await fs.list(`Inbox/${it.name}`).catch(() => [])) recent.push({ name: f.name, path: `Inbox/${it.name}/${f.name}`, kind: f.dir ? "folder" : "file", t: it.name });
      else recent.push({ name: it.name, path: `${top}/${it.name}`, kind: it.dir ? "folder" : "file", t: top });
    }
  }
  recent.sort((a, b) => String(b.t).localeCompare(String(a.t)));
  box.replaceChildren(el("div", { class: "actions" }, el("button", { class: "btn", type: "button", onclick: () => input.click() }, "From this phone")), input,
    el("p", { class: "sub" }, "Or from your MyChat folder:"),
    ...recent.slice(0, 40).map((r) => el("button", { class: "row file linkish", type: "button", onclick: () => { attached.push(r); renderAttached(); $("#sheet").hidden = true; } },
      el("span", { class: "ic" }, r.kind === "folder" ? "📁" : "📄"), el("span", { class: "grow", dir: "auto" }, r.path))));
  $("#sheet").hidden = false;
}
/** Text of the attached files: inline when small; a verified deep read (several models) when big. */
async function filesContext(items, question, onStatus, signal) {
  const fs = await workspace(), reader = workspaceReader(fs), files = [];
  for (const a of items.filter((x) => x.kind !== "image")) {
    const list = a.kind === "folder" || /\.(zip|apk|jar)$/i.test(a.path) ? await reader.files(a.path, { limit: 3000 }) : [{ path: a.path }];
    for (const f of list) { if (f.size > 1_500_000) continue; const t = await reader.text(f.path).catch(() => null); if (t != null) files.push({ path: f.path, text: t }); }
  }
  const total = files.reduce((n, f) => n + f.text.length, 0);
  if (!files.length) return { inline: items.some((x) => x.kind !== "image") ? "\n\n(The attached files are not text and could not be read.)" : "" };
  if (total <= 60000) return { inline: "\n\nATTACHED FILES:\n" + files.map((f) => `===== ${f.path} =====\n${f.text}`).join("\n\n") };
  const gw = await brain();
  return { study: await study(gw, { question, files, onStatus, signal, ...(gw.remote ? { concurrency: 4 } : {}) }) };
}

// Long tasks keep running with the screen off: a foreground service (Android) while they run, "Answer ready" when done.
const keepAlive = {
  on: false,
  async start(text) { const K = plugin("KeepAlive"); if (!K || this.on) return; try { await K.start({ text }); this.on = true; } catch { /* still runs in the foreground */ } },
  async end(text) { const K = plugin("KeepAlive"); if (!K || !this.on) return; this.on = false; try { await K.done({ text, notify: document.visibilityState === "hidden" }); } catch { /* ignore */ } },
};
const IDENTITY = `You are MyChat, the user's own assistant (Android app + PC). The app has the user's MyChat folder (Files tab: Inbox, Projects) and an Agent with tools; when the user asks about their files, the app reads them for you — so never claim you have no access to their files. Answer in the user's language, directly and specifically; say plainly when you are unsure.`;
const modelKeys = () => Object.keys(state.keys).filter((k) => state.gw.providers[k] && !state.gw.providers[k].keyless);

async function send(text) {
  if (running) { running.abort(); return; }
  text = text.trim(); if (!text && !attached.length) return;
  if (!text) text = "Look at the attached files and tell me what they are and what stands out.";
  if (!current.title) current.title = text.slice(0, 60);
  const files = attached; attached = []; renderAttached();
  current.messages.push({ role: "user", content: text, ...(files.length ? { files: files.map((f) => f.path || f.name) } : {}) });
  if (!chats.includes(current)) chats.unshift(current);
  renderChat();
  const box = $("#messages");
  const live = botBubble("");
  box.append(live);
  const status = $("#statusLine");
  status.hidden = false; status.textContent = "Choosing models…";
  running = new AbortController();
  $("#sendBtn").classList.add("stop"); $("#sendBtn").setAttribute("aria-label", "Stop");
  let acc = "", raf = 0;
  const t0 = Date.now();
  if (files.length || ["max", "verified", "consensus"].includes(mode)) keepAlive.start(files.length ? "Reading your files…" : "Thinking…");
  const noKeys = !modelKeys().length;
  try {
    const apiMsgs = current.messages.map(({ role, content, files: fl }) => ({ role, content: fl?.length ? content + `\n(attached: ${fl.join(", ")})` : content }));
    // one assistant: a question about the user's own files/projects is answered by looking (agent tools), not guessing
    const prevAgentic = current.meta[current.messages.length - 2]?.mode === "agent";
    if (!files.length && (WORKSPACE_RX.test(text) || (prevAgentic && text.length < 400))) {
      keepAlive.start("Looking at your files…");
      const fs = await workspace(), gw = await brain(), steps = [];
      const history = current.messages.slice(0, -1).slice(-8).map(({ role, content }) => ({ role, content: String(content).slice(0, 4000) }));
      const r = await runAgent(gw, { goal: text, fs, history, signal: running.signal, ...hostTools({ search: state.search, fetch: smartFetch }),
        onStep: (st) => { if (st.kind !== "status") steps.push(st); status.textContent = st.kind === "tool" ? `🔧 ${st.tool} ${JSON.stringify(st.args || {}).slice(0, 70)}` : String(st.text || "").slice(0, 120); } });
      current.messages.push({ role: "assistant", content: r.answer });
      const k = current.messages.length - 1;
      current.meta[k] = { mode: "agent", trace: [{ by: r.by }], ms: Date.now() - t0, steps: steps.filter((x) => x.kind === "tool").map((x) => `${x.tool} ${JSON.stringify(x.args || {}).slice(0, 100)}`) };
      if (r.ops.length) current.meta[k].ops = { id: r.id, goal: text, ops: r.ops, preview: await previewOps(fs, r.ops) };
      return;
    }
    apiMsgs.unshift({ role: "system", content: IDENTITY });
    if (files.length) {
      status.textContent = "Reading the attached files…";
      const ctx = await filesContext(files, text, (t) => (status.textContent = t), running.signal);
      if (ctx.study) {
        const s2 = ctx.study;
        current.messages.push({ role: "assistant", content: s2.answer + `\n\n---\n*Read ${s2.read} files in ${s2.parts} part(s) by several models · ${s2.notes.length} findings checked against the code · ${s2.dropped} unproven dropped${s2.unread ? ` · ${s2.unread} part(s) could not be read` : ""}${s2.skipped.length ? ` · ${s2.skipped.length} files not read` : ""}*` +
          (noKeys ? "\n\n> ⚠ No account is connected on this phone, so this used the free no-key channels (slow, often rate-limited). Connect Google Gemini or Groq in **Accounts** (about a minute) — or link your PC — for much better results." : "") });
        current.meta[current.messages.length - 1] = { mode: "deep read", trace: [{ by: s2.by }], ms: Date.now() - t0 };
        return;
      }
      const imgs = files.filter((f) => f.kind === "image");
      const last = apiMsgs[apiMsgs.length - 1];
      last.content = imgs.length ? [{ type: "text", text: text + ctx.inline }, ...imgs.map((i) => ({ type: "image_url", image_url: { url: i.url } }))] : text + ctx.inline;
    }
    const r = await ask(apiMsgs, {
      mode, signal: running.signal,
      onStatus: (s) => { status.textContent = String(s).split("\n").filter(Boolean).pop() || ""; },
      onDelta: (t) => { acc += t; if (!raf) raf = requestAnimationFrame(() => { raf = 0; live.querySelector(".body").innerHTML = md(acc); box.scrollTop = box.scrollHeight; }); },
    });
    current.messages.push({ role: "assistant", content: r.content });
    current.meta[current.messages.length - 1] = { mode: r.mode, trace: r.trace, claims: r.claims, sources: r.sources, ms: Date.now() - t0 };
  } catch (e) {
    const msg = running.signal.aborted ? (acc || "Stopped.") : `${acc ? acc + "\n\n" : ""}**Could not answer:** ${e.message}\n\n` +
      (noKeys ? "No account is connected on this phone — only the free no-key channels were available, and they are busy. Connect Google Gemini or Groq in **Accounts** (about a minute)." : "All connected accounts failed just now (limits or outages). Try again in a minute, or connect one more account in **Accounts**.");
    current.messages.push({ role: "assistant", content: msg });
  } finally {
    running = null; status.hidden = true;
    keepAlive.end("Your answer is ready");
    $("#sendBtn").classList.remove("stop"); $("#sendBtn").setAttribute("aria-label", "Send");
    saveChats(); renderChat();
  }
}
function retry() {
  const last = current.messages.at(-1);
  if (last?.role !== "assistant") return;
  current.messages.pop(); current.meta.length = current.messages.length;
  const q = current.messages.pop(); send(q.content);
}

function showChecks(meta) {
  const box = $("#sheetContent"); box.replaceChildren();
  const label = { supported: ["✓ Proven by source", "ok"], refuted: ["↻ Corrected", "fix"], agreed: ["Models agree", ""], disputed: ["Disputed", ""],
                  doubtful: ["Doubtful", ""], unverified: ["Not verified", ""], unchecked: ["Not verified", ""], opinion: ["Opinion / advice", ""] };
  for (const c of meta.claims || []) {
    const [t, cls] = label[c.status] || [c.status, ""];
    const src = c.src && meta.sources?.[c.src - 1];
    box.append(el("section", { class: "claim" },
      el("span", { class: `chip ${cls}` }, t),
      el("div", { dir: "auto" }, c.text),
      c.correction ? el("div", { dir: "auto" }, "Correction: " + c.correction) : null,
      c.quote ? el("blockquote", { dir: "auto" }, "“" + c.quote + "”") : null,
      src ? el("a", { href: src.url, onclick: (e) => { e.preventDefault(); openExternal(src.url); } }, src.title || src.url) : null));
  }
  box.append(el("p", { class: "sub" }, "How it was checked: each claim on its own, exact arithmetic for numbers, and a source quote that must really appear on the page."));
  $("#sheet").hidden = false;
}

// ---------------------------------------------------------------- accounts
async function startOpenRouter() {
  const { verifier, challenge } = await pkcePair();
  localStorage.setItem("mychat.pkce", JSON.stringify({ verifier, at: Date.now() }));
  openExternal(openRouterAuthUrl(OAUTH_RETURN, challenge));
}
async function finishOpenRouter(code) {
  let p = {}; try { p = JSON.parse(localStorage.getItem("mychat.pkce") || "{}"); } catch { /* none */ }
  localStorage.removeItem("mychat.pkce");
  if (!p.verifier || Date.now() - p.at > 20 * 60e3) { toast("That sign-in expired. Please try again."); return; }
  try {
    const key = await openRouterExchange(code, p.verifier, smartFetch);
    await setKey("openrouter", key);
    toast("✓ OpenRouter connected");
    show("accounts");
  } catch (e) { toast("OpenRouter: " + e.message, 5000); }
}

async function pasteKeys(text, out) {
  out.textContent = "Checking…";
  if (text.includes(BUNDLE_PREFIX)) {
    const code = prompt("Code shown on the other device (XXXX-XXXX-XXXX-XXXX)") || "";
    try {
      const keys = await importKeys(text, code);
      if (keys.__pc) { saveSettings({ ...settings(), pc: keys.__pc }); delete keys.__pc; }
      for (const [k, v] of Object.entries(keys)) if (!k.startsWith("__")) await setKey(k, v);
      const linked = state.settings.pc ? await pcLink(true) : null;
      out.textContent = `✓ ${Object.keys(keys).length} keys added` + (state.settings.pc ? (linked ? " · ✓ your PC is linked" : " · PC paired (not reachable right now — it will be used when it is)") : "");
      setTimeout(() => show("accounts"), 1500);
    } catch (e) { out.textContent = "✗ " + e.message; }
    return;
  }
  const found = detectKeys(text);
  const plain = text.trim();
  if (!found.length && /^[A-Za-z0-9._-]{24,120}$/.test(plain)) {
    const id = await identifyPlainKey(plain, state.gw.providers, undefined, smartFetch);
    if (id) found.push({ provider: id.provider, key: plain });
  }
  if (!found.length) { out.textContent = "✗ No API key recognised. Nothing was saved."; return; }
  const lines = [];
  for (const f of found) {
    if (SEARCH_KEYS.has(f.provider)) {
      let ok = true, err = "";
      if (f.provider !== "jina") { try { await new Search({ keys: { [f.provider]: f.key }, fetch: smartFetch }).provider(f.provider, "wikipedia", 1); } catch (e) { ok = false; err = e.message; } }
      if (ok) await setKey(f.provider, f.key);
      lines.push(`${ok ? "✓" : "✗"} ${SEARCH_PROVIDERS[f.provider]?.name || f.provider}${ok ? " — web evidence on" : " — " + err}`);
      continue;
    }
    const v = await validateKey(f.provider, f.key, state.gw.providers, smartFetch);
    if (v.ok) await setKey(f.provider, f.key);
    lines.push(`${v.ok ? "✓" : "✗"} ${state.gw.providers[f.provider]?.name || f.provider} — ${v.ok ? v.models + " models" : v.error}`);
  }
  out.textContent = lines.join("\n");
  if (lines.some((l) => l.startsWith("✓"))) setTimeout(() => show("accounts"), 1200);
}

function transferCard() {
  const out = el("div", { class: "result", "aria-live": "polite" });
  return el("section", { class: "card" }, el("h3", {}, "Same keys on PC and phone"),
    el("p", {}, "Send: makes one encrypted text with all your keys and a code. Send the text to yourself (WhatsApp, e-mail) and paste it into “Add a key” on the other device — it asks for the code. Without the code the text is useless."),
    el("div", { class: "actions" }, el("button", { type: "button", onclick: async () => {
      const n = Object.keys(state.keys).length; if (!n) return toast("No keys on this phone yet");
      const code = transferCode(), text = await exportKeys(state.keys, code);
      out.replaceChildren(el("p", {}, "Code (type it on the other device):"), el("div", { class: "code" }, code),
        el("div", { class: "actions" },
          el("button", { type: "button", onclick: async () => { try { await navigator.share({ text }); } catch { await navigator.clipboard?.writeText(text); toast("Copied the keys text"); } } }, "Share the keys text"),
          el("button", { type: "button", onclick: async () => { await navigator.clipboard?.writeText(text); toast("Copied"); } }, "Copy")));
    } }, "Send my keys")), out);
}

// After "Get key": when you come back with a key in the clipboard, it is recognised, tested and added (only within 15 minutes of
// tapping a provider, so the clipboard is not read at other times).
async function keyHunt() {
  let h; try { h = JSON.parse(localStorage.getItem("mychat.keyHunt") || "null"); } catch { h = null; }
  if (!h || Date.now() - h.at > 15 * 60e3) return;
  let text = "";
  try { text = (await plugin("Clipboard")?.read())?.value || (await navigator.clipboard?.readText()) || ""; } catch { return; }
  text = String(text).trim();
  if (!text || Object.values(state.keys).includes(text)) return;
  let found = detectKeys(text);
  if (!found.length && /^[A-Za-z0-9._-]{24,120}$/.test(text)) { const id = await identifyPlainKey(text, state.gw.providers, [h.id, "mistral", "cohere", "siliconflow"], smartFetch); if (id) found = [{ provider: id.provider, key: text }]; }
  if (!found.length) return;
  localStorage.removeItem("mychat.keyHunt");
  for (const f of found) {
    const v = await validateKey(f.provider, f.key, state.gw.providers, smartFetch);
    if (v.ok) { await setKey(f.provider, f.key); toast(`✓ ${state.gw.providers[f.provider]?.name || f.provider} added (${v.models} models)`, 4000); }
    else toast(`✗ That ${f.provider} key did not work: ${v.error}`, 5000);
  }
  if (view === "accounts") renderAccounts();
}

function renderAccounts() {
  const v = $("#view-accounts"); v.replaceChildren();
  const pad = el("div", { class: "pad" });
  const st = state.gw.status().providers;
  const connected = Object.values(st).filter((p) => p.hasKey).length;
  $("#viewSub").textContent = `${connected} connected`;
  if (update) pad.append(el("section", { class: "card hero" }, el("h3", {}, `Update available — build ${update.build}`),
    el("p", {}, `You have build ${update.current}. Download it, open it, and Android installs it over this version (your chats and keys stay).`),
    el("button", { class: "btn white", type: "button", onclick: () => openExternal(update.url) }, "Download the update")));
  const G = [["gemini", "Google Gemini", "free"], ["groq", "Groq", "free, very fast"], ["mistral", "Mistral", "free credits"], ["cohere", "Cohere", "free trial"],
             ["siliconflow", "SiliconFlow", "some models free"], ["nvidia", "NVIDIA", "free endpoints"], ["huggingface", "Hugging Face", "small free credit"]];
  pad.append(el("section", { class: "card hero" },
    el("h3", {}, "Your Google account opens everything"),
    el("p", {}, "1 · One tap: OpenRouter with Google — Claude, GPT, Gemini, GLM, Kimi, DeepSeek in one account."),
    el("button", { class: "btn white", type: "button", onclick: startOpenRouter }, st.openrouter?.hasKey ? "✓ OpenRouter — reconnect" : "Continue with Google"),
    el("p", {}, "2 · Free keys: tap a provider, sign in with Google on its site, copy the key, come back — MyChat finds the key and adds it."),
    el("div", { class: "gkeys" }, G.map(([id, name, note]) => el("button", { type: "button", class: "gkey" + (st[id]?.hasKey ? " on" : ""),
      onclick: () => { if (st[id]?.hasKey) return toast(`${name} is connected`); localStorage.setItem("mychat.keyHunt", JSON.stringify({ id, at: Date.now() })); openExternal(state.gw.providers[id].keyUrl); toast("Copy the key there, then come back here", 5000); } },
      el("b", {}, (st[id]?.hasKey ? "✓ " : "") + name), el("small", {}, note))))));
  pad.append(transferCard());
  if (state.settings.pc) {
    const line = el("p", {}, "Checking your PC…");
    pad.append(el("section", { class: "card" }, el("h3", {}, "Your PC"), line,
      el("div", { class: "actions" }, el("button", { type: "button", onclick: () => { const s2 = settings(); delete s2.pc; saveSettings(s2); renderAccounts(); } }, "Unpair"))));
    pcLink(true).then((b) => { line.textContent = b ? `✓ Linked (${b}) — chat, deep reads and the Agent run on your PC with its accounts.` : "Paired, not reachable now (PC off, or not on the same Wi-Fi/Tailscale). The phone answers on its own meanwhile."; });
  }

  const paste = el("section", { class: "card paste" }, el("h3", {}, "Add a key"),
    el("p", {}, "Copy a key on the provider’s site, then paste it here. The provider is recognised and the key is tested. Keys are encrypted on this phone."));
  const ta = el("textarea", { dir: "ltr", placeholder: "AIza… · AQ.… · nvapi-… · gsk_… · sk-or-… · sk-ant-… · hf_…", "aria-label": "API key" });
  const out = el("div", { class: "result", "aria-live": "polite" });
  paste.append(ta, el("div", { class: "actions" },
    el("button", { type: "button", onclick: async () => { try { ta.value = await navigator.clipboard.readText(); } catch { toast("Long-press the box and choose Paste"); } } }, "Paste from clipboard"),
    el("button", { type: "button", onclick: () => pasteKeys(ta.value, out) }, "Check and add")), out);
  pad.append(paste);

  const FREE = ["openrouter", "gemini", "groq", "nvidia", "mistral", "cohere", "siliconflow", "github", "huggingface", "sambanova", "cerebras"];
  const PAID = ["anthropic", "openai", "deepseek", "xai", "moonshot", "zai", "together", "fireworks"];
  const row = (id) => {
    const p = st[id], def = state.gw.providers[id]; if (!p || !def) return null;
    const stateTxt = p.disabled ? "paused: " + p.disabled : p.hasKey ? `✓ ${p.models || 0} models` : "";
    return el("div", { class: "row" },
      el("div", { class: "grow" }, el("span", {}, p.name), el("small", {}, CONNECT[id]?.note || p.free || "")),
      stateTxt ? el("span", { class: "state " + (p.disabled ? "bad" : "on") }, stateTxt) : null,
      p.hasKey ? el("button", { class: "mini", type: "button", onclick: async () => { await setKey(id, null); renderAccounts(); } }, "Remove")
               : def.keyUrl ? el("button", { class: "mini", type: "button", onclick: () => openExternal(def.keyUrl) }, "Get key") : null);
  };
  const ids = Object.keys(st).filter((id) => !state.gw.providers[id]?.keyless);
  const mine = ids.filter((id) => st[id].hasKey);
  if (mine.length) pad.append(el("section", { class: "card" }, el("h3", {}, "Connected"), mine.map(row)));
  pad.append(el("section", { class: "card" }, el("h3", {}, "Free to add"), FREE.filter((id) => !st[id]?.hasKey).map(row)));
  pad.append(el("section", { class: "card" }, el("h3", {}, "Pay per use"), PAID.filter((id) => !st[id]?.hasKey).map(row),
    ids.filter((id) => !FREE.includes(id) && !PAID.includes(id) && !st[id].hasKey).map(row)));

  const web = el("section", { class: "card" }, el("h3", {}, "Web evidence for the Truth Engine"), el("p", {}, "Wikipedia is always on. Each search key adds fresher evidence."));
  for (const [id, p] of Object.entries(SEARCH_PROVIDERS)) {
    const has = !!state.keys[id];
    web.append(el("div", { class: "row" }, el("div", { class: "grow" }, el("span", {}, p.name), el("small", {}, p.note || "")),
      el("span", { class: "state " + (has ? "on" : "") }, has ? "✓" : ""),
      has ? el("button", { class: "mini", type: "button", onclick: async () => { await setKey(id, null); renderAccounts(); } }, "Remove")
          : p.keyUrl ? el("button", { class: "mini", type: "button", onclick: () => openExternal(p.keyUrl) }, "Get key") : null));
  }
  pad.append(web);

  const s = settings();
  const kl = el("input", { type: "checkbox", id: "kl", checked: s.allowKeyless, onchange: (e) => saveSettings({ ...settings(), allowKeyless: e.target.checked }) });
  pad.append(el("label", { class: "row", for: "kl" }, kl, el("span", { class: "grow" }, "Use free no-key channels as a last resort")));
  v.append(pad);
}


// ---------------------------------------------------------------- navigation
let view = "chat", agentPrefill = "", brainNow = null;
function show(name) {
  view = name;
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== "view-" + name;
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.view === name);
  $("#viewTitle").textContent = { chat: "MyChat", accounts: "Accounts", agent: "Agent", files: "Files" }[name];
  $("#newChat").hidden = name !== "chat";
  if (name !== "chat") $("#viewSub").textContent = "";
  if (name === "chat") renderChat();
  if (name === "accounts") renderAccounts();
  if (name === "agent") brain().then((b) => { brainNow = b.remote ? b : null; });
  if (name === "agent") { agentView($("#view-agent"), { el, md, toast, gw: () => brainNow || state.gw, tools: () => hostTools({ search: state.search, fetch: smartFetch }), prefill: agentPrefill, keepAlive }); agentPrefill = ""; }
  if (name === "files") filesView($("#view-files"), { el, toast, onAgent: (text) => { agentPrefill = text; show("agent"); },
    onAttach: (rel) => { attached.push({ name: rel.split("/").pop(), path: rel, kind: /\.(zip|apk|jar)$/i.test(rel) ? "folder" : "file" }); renderAttached(); show("chat"); } });
}

function renderDrawer() {
  const list = $("#chatList"); list.replaceChildren();
  list.append(el("button", { type: "button", onclick: () => { newChat(); $("#drawer").hidden = true; } }, "+ New chat"));
  for (const c of chats) list.append(el("button", { type: "button", dir: "auto", onclick: () => { openChat(c.id); show("chat"); $("#drawer").hidden = true; } }, c.title || "Untitled"));
}

function wire() {
  for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => show(b.dataset.view));
  $("#sendForm").addEventListener("submit", (e) => { e.preventDefault(); const t = $("#msg"); const v = t.value; t.value = ""; t.style.height = ""; send(v); });
  $("#msg").addEventListener("input", (e) => { e.target.style.height = "auto"; e.target.style.height = Math.min(140, e.target.scrollHeight) + "px"; });
  $("#msg").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && window.matchMedia("(pointer:fine)").matches) { e.preventDefault(); $("#sendForm").requestSubmit(); } });
  $("#newChat").addEventListener("click", newChat);
  $("#attachBtn").addEventListener("click", attachSheet);
  $("#menuBtn").addEventListener("click", () => { renderDrawer(); $("#drawer").hidden = false; });
  $("#drawer").addEventListener("click", (e) => { if (e.target.id === "drawer") $("#drawer").hidden = true; });
  $("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") $("#sheet").hidden = true; });
  $("#sheetClose").addEventListener("click", () => ($("#sheet").hidden = true));
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.("a[href^='http']");
    if (a) { e.preventDefault(); openExternal(a.href); }
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") setTimeout(keyHunt, 400); });
  const App = plugin("App");
  if (App) {
    App.addListener("resume", () => setTimeout(keyHunt, 400));
    App.addListener("appUrlOpen", ({ url }) => {
      const u = new URL(url.replace(/^mychat:\/\//, "https://mychat/"));
      if (u.pathname.startsWith("/openrouter") || u.hostname === "oauth" || url.includes("oauth")) {
        const code = u.searchParams.get("code");
        if (code) finishOpenRouter(code);
      }
    });
    App.addListener("backButton", () => {
      if (!$("#sheet").hidden) $("#sheet").hidden = true;
      else if (!$("#drawer").hidden) $("#drawer").hidden = true;
      else if (view !== "chat") show("chat");
      else App.minimizeApp?.();
    });
  }
}

// ---------------------------------------------------------------- updates (GitHub Releases; the APK is built by CI on every change)
let update = null;
async function checkUpdate(force = false) {
  try {
    const me = await (await fetch("build.json")).json().catch(() => null);
    if (!me?.build) return null;
    const last = Number(localStorage.getItem("mychat.updateCheck") || 0);
    if (!force && Date.now() - last < 6 * 3600e3) {
      const u = JSON.parse(localStorage.getItem("mychat.update") || "null");
      update = u && u.build > me.build ? { ...u, current: me.build } : null;
      return update;
    }
    const rel = await (await fetch("https://api.github.com/repos/haran4-cpu/MyChat/releases?per_page=100", { headers: { Accept: "application/vnd.github+json" } })).json();
    const best = (Array.isArray(rel) ? rel : []).map((r) => ({ build: Number(/build-(\d+)/.exec(r.tag_name)?.[1] || 0), url: r.assets?.find((a) => a.name.endsWith(".apk"))?.browser_download_url }))
      .filter((r) => r.url).sort((a, b) => b.build - a.build)[0];
    update = best && best.build > me.build ? { ...best, current: me.build } : null;
    localStorage.setItem("mychat.updateCheck", String(Date.now()));
    localStorage.setItem("mychat.update", JSON.stringify(update));
    if (update && update.build > me.build) toast(`Update available (build ${update.build}) — see Accounts`, 4000);
  } catch { /* offline: try next time */ }
  return update;
}

(async function main() {
  wire();
  renderModes();
  newChat();
  await init();
  const n = Object.keys(state.keys).length;
  if (!n) { show("accounts"); toast("Connect an account to start — free options included"); }
  checkUpdate();
})();
