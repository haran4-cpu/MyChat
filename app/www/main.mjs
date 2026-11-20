// MyChat for Android — UI. All model work is done by ./engine.mjs (the same core as the PC gateway).
import { init, state, ask, setKey, settings, saveSettings, smartFetch } from "./engine.mjs";
import { detectKeys, validateKey, identifyPlainKey, pkcePair, openRouterAuthUrl, openRouterExchange, CONNECT, SEARCH_KEYS } from "./core/accounts.mjs";
import { SEARCH_PROVIDERS, Search } from "./core/search.mjs";
import { agentView, filesView } from "./agentui.mjs";

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

function renderAccounts() {
  const v = $("#view-accounts"); v.replaceChildren();
  const pad = el("div", { class: "pad" });
  const st = state.gw.status().providers;
  const connected = Object.values(st).filter((p) => p.hasKey).length;
  $("#viewSub").textContent = `${connected} connected`;
  if (update) pad.append(el("section", { class: "card hero" }, el("h3", {}, `Update available — build ${update.build}`),
    el("p", {}, `You have build ${update.current}. Download it, open it, and Android installs it over this version (your chats and keys stay).`),
    el("button", { class: "btn white", type: "button", onclick: () => openExternal(update.url) }, "Download the update")));
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
let view = "chat";
function show(name) {
  view = name;
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== "view-" + name;
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.view === name);
  $("#viewTitle").textContent = { chat: "MyChat", accounts: "Accounts", agent: "Agent", files: "Files" }[name];
  $("#newChat").hidden = name !== "chat";
  if (name !== "chat") $("#viewSub").textContent = "";
  if (name === "chat") renderChat();
  if (name === "accounts") renderAccounts();
  if (name === "agent") agentView($("#view-agent"), { el, toast, gw: () => state.gw });
  if (name === "files") filesView($("#view-files"), { el, toast, onAsk: (text) => { show("agent"); setTimeout(() => { const g = document.querySelector("#view-agent .goal"); if (g) { g.value = text; g.focus(); } }, 300); } });
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
    const rel = await (await fetch("https://api.github.com/repos/haran4-cpu/MyChat/releases?per_page=5", { headers: { Accept: "application/vnd.github+json" } })).json();
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
