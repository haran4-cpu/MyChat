// MyChat for Android — UI. All model work is done by ./engine.mjs (the same core as the PC gateway).
import { init, state, ask, setKey, settings, saveSettings, smartFetch } from "./engine.mjs";
import { detectKeys, validateKey, identifyPlainKey, pkcePair, openRouterAuthUrl, openRouterExchange, CONNECT, SEARCH_KEYS } from "./core/accounts.mjs";
import { SEARCH_PROVIDERS, Search } from "./core/search.mjs";

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

function renderChat() {
  const box = $("#messages"); box.replaceChildren();
  $("#viewSub").textContent = current.title || "";
  if (!current.messages.length) {
    box.append(el("div", { class: "empty" }, el("b", {}, "MyChat"),
      "Ask anything. Facts and numbers are checked automatically.", el("br"), "שאלו כל דבר. עובדות ומספרים נבדקים אוטומטית."));
    return;
  }
  current.messages.forEach((m, i) => {
    if (m.role === "user") box.append(el("div", { class: "msg user", dir: "auto" }, m.content));
    else {
      const meta = current.meta[i] || {};
      const w = whoLine(meta); if (w) box.append(w);
      box.append(botBubble(m.content, meta));
      box.append(el("div", { class: "actions" },
        el("button", { type: "button", onclick: () => { navigator.clipboard?.writeText(m.content.split("\n\n---\n")[0]).then(() => toast("Copied")); } }, "Copy"),
        i === current.messages.length - 1 ? el("button", { type: "button", onclick: retry }, "Try again") : null));
    }
  });
  box.scrollTop = box.scrollHeight;
}

async function send(text) {
  if (running) { running.abort(); return; }
  text = text.trim(); if (!text) return;
  if (!current.title) current.title = text.slice(0, 60);
  current.messages.push({ role: "user", content: text });
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
  try {
    const r = await ask(current.messages.map(({ role, content }) => ({ role, content })), {
      mode, signal: running.signal,
      onStatus: (s) => { status.textContent = String(s).split("\n").filter(Boolean).pop() || ""; },
      onDelta: (t) => { acc += t; if (!raf) raf = requestAnimationFrame(() => { raf = 0; live.querySelector(".body").innerHTML = md(acc); box.scrollTop = box.scrollHeight; }); },
    });
    current.messages.push({ role: "assistant", content: r.content });
    current.meta[current.messages.length - 1] = { mode: r.mode, trace: r.trace, claims: r.claims, sources: r.sources, ms: Date.now() - t0 };
  } catch (e) {
    const msg = running.signal.aborted ? (acc || "Stopped.") : `${acc ? acc + "\n\n" : ""}**Could not answer:** ${e.message}\n\nCheck **Accounts**: connect at least one provider.`;
    current.messages.push({ role: "assistant", content: msg });
  } finally {
    running = null; status.hidden = true;
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
  const found = detectKeys(text);
  const plain = text.trim();
  if (!found.length && /^[A-Za-z0-9._-]{24,120}$/.test(plain)) {
    const id = await identifyPlainKey(plain, state.gw.providers, ["mistral", "zai", "sambanova"], smartFetch);
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

function renderAccounts() {
  const v = $("#view-accounts"); v.replaceChildren();
  const pad = el("div", { class: "pad" });
  const st = state.gw.status().providers;
  const connected = Object.values(st).filter((p) => p.hasKey).length;
  $("#viewSub").textContent = `${connected} connected`;
  pad.append(el("section", { class: "card hero" },
    el("h3", {}, "One sign-in, many models"),
    el("p", {}, "OpenRouter with your Google account: Claude, GPT, Gemini, GLM, Kimi, DeepSeek. Opens in your browser and comes back here."),
    el("button", { class: "btn white", type: "button", onclick: startOpenRouter }, st.openrouter?.hasKey ? "Reconnect OpenRouter" : "Continue with Google")));

  const paste = el("section", { class: "card paste" }, el("h3", {}, "Add a key"),
    el("p", {}, "Copy a key on the provider’s site, then paste it here. The provider is recognised and the key is tested. Keys are encrypted on this phone."));
  const ta = el("textarea", { dir: "ltr", placeholder: "AIza… · AQ.… · nvapi-… · gsk_… · sk-or-… · sk-ant-… · hf_…", "aria-label": "API key" });
  const out = el("div", { class: "result", "aria-live": "polite" });
  paste.append(ta, el("div", { class: "actions" },
    el("button", { type: "button", onclick: async () => { try { ta.value = await navigator.clipboard.readText(); } catch { toast("Long-press the box and choose Paste"); } } }, "Paste from clipboard"),
    el("button", { type: "button", onclick: () => pasteKeys(ta.value, out) }, "Check and add")), out);
  pad.append(paste);

  const list = el("section", { class: "card" }, el("h3", {}, "Model accounts"));
  const order = ["openrouter", "gemini", "groq", "nvidia", "anthropic", "mistral", "huggingface", "zai", "cerebras", "sambanova", "github"];
  for (const id of order) {
    const p = st[id], def = state.gw.providers[id]; if (!p || !def) continue;
    const stateTxt = p.disabled ? "✗ " + p.disabled : p.hasKey ? `✓ ${p.models || 0} models` : "not connected";
    list.append(el("div", { class: "row" },
      el("div", { class: "grow" }, el("span", {}, p.name), el("small", {}, CONNECT[id]?.note || p.free || "")),
      el("span", { class: "state " + (p.disabled ? "bad" : p.hasKey ? "on" : "") }, stateTxt),
      p.hasKey ? el("button", { class: "mini", type: "button", onclick: async () => { await setKey(id, null); renderAccounts(); } }, "Remove")
               : def.keyUrl ? el("button", { class: "mini", type: "button", onclick: () => openExternal(def.keyUrl) }, "Get key") : null));
  }
  pad.append(list);

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

function renderSoon(id, title, text) {
  const v = $("#view-" + id); v.replaceChildren();
  v.append(el("div", { class: "pad" }, el("section", { class: "card" }, el("h3", {}, title), el("p", {}, text))));
}

// ---------------------------------------------------------------- navigation
let view = "chat";
function show(name) {
  view = name;
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== "view-" + name;
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.view === name);
  $("#viewTitle").textContent = { chat: "MyChat", accounts: "Accounts", agent: "Agent", files: "Files" }[name];
  $("#newChat").hidden = name !== "chat";
  if (name === "chat") renderChat();
  if (name === "accounts") renderAccounts();
  if (name === "agent") renderSoon("agent", "Agent — next step", "Multi-step tasks with tools: web search, the hunter, exact calculator, files and your PC — every change on the PC asks you first.");
  if (name === "files") renderSoon("files", "Files & PC link — next step", "Ask about files on this phone, share files into MyChat, and pair with your PC by QR code to use its local models and folders.");
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
  $("#menuBtn").addEventListener("click", () => { renderDrawer(); $("#drawer").hidden = false; });
  $("#drawer").addEventListener("click", (e) => { if (e.target.id === "drawer") $("#drawer").hidden = true; });
  $("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") $("#sheet").hidden = true; });
  $("#sheetClose").addEventListener("click", () => ($("#sheet").hidden = true));
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.("a[href^='http']");
    if (a) { e.preventDefault(); openExternal(a.href); }
  });
  const App = plugin("App");
  if (App) {
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

(async function main() {
  wire();
  renderModes();
  newChat();
  await init();
  const n = Object.keys(state.keys).length;
  if (!n) { show("accounts"); toast("Connect an account to start — free options included"); }
})();
