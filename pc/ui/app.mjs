// MyChat on the PC — one page for everything that is not the chat itself (the chat is Open WebUI at :8080).
// Sections: Home · Agent · Accounts · Models · System. Talks only to this gateway (same origin, local token).
const TOKEN = document.querySelector('meta[name="mychat-token"]').content;
const H = { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" };
const api = async (p, b, method) => {
  const r = await fetch(p, { method: method || (b ? "POST" : "GET"), headers: H, body: b ? JSON.stringify(b) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || j.error || "HTTP " + r.status);
  return j;
};
const $ = (s) => document.querySelector(s);
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat(9)) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
function toast(t, ms = 3000) { const x = $("#toast"); x.textContent = t; x.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (x.hidden = true), ms); }
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + " s ago" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : new Date(t).toLocaleString(); };
const view = () => $("#view");
const busy = async (btn, fn) => { const t = btn.textContent; btn.disabled = true; btn.textContent = "…"; try { return await fn(); } finally { btn.disabled = false; btn.textContent = t; } };

// ------------------------------------------------------------------------------------------------ Home
async function home() {
  const v = view(); v.replaceChildren(el("h1", {}, "MyChat"));
  const [st, sys] = await Promise.all([api("/status").catch(() => null), api("/system").catch(() => null)]);
  const provs = st ? Object.values(st.providers) : [];
  const connected = provs.filter((p) => p.hasKey), paused = provs.filter((p) => p.disabled && (p.hasKey || p.keyless));
  const svc = sys?.supervisor?.services || [];
  v.append(el("div", { class: "grid" },
    el("div", { class: "card hero stack" }, el("h3", {}, "Chat"), el("div", { class: "sub" }, "Open WebUI with the MyChat models: Auto (instant answer, facts checked in the background), Fast, Max, Verified, Private."),
      el("a", { class: "btn primary", href: "http://127.0.0.1:8080/?model=mychat.auto", target: "_blank", rel: "noopener" }, "Open chat")),
    el("div", { class: "card stack" }, el("h3", {}, "Agent"), el("div", { class: "sub" }, "Organise, create and edit files and folders. You see every change before it happens, and every change can be undone."),
      el("a", { class: "btn", href: "#agent" }, "Start a task")),
    el("div", { class: "card stack" }, el("h3", {}, "Accounts"),
      el("div", {}, el("b", {}, connected.length), " connected", paused.length ? el("span", { class: "sub" }, ` · ${paused.length} paused for now`) : null),
      el("div", { class: "sub" }, connected.map((p) => p.name).join(" · ") || "Nothing connected yet"),
      el("a", { class: "btn", href: "#accounts" }, "Manage")),
    el("div", { class: "card stack" }, el("h3", {}, "Services"),
      svc.length ? el("div", {}, svc.map((s) => el("div", { class: "row" }, el("span", {}, s.name), el("span", { class: "pill " + (s.up ? "ok" : "bad") }, s.up ? "running" : "down"))))
                 : el("div", { class: "sub" }, "Supervisor not reachable"),
      el("a", { class: "btn", href: "#system" }, "Details and updates"))));
  if (paused.length) v.append(el("h2", {}, "Paused accounts"), el("div", { class: "card" }, paused.map((p) => el("div", { class: "row" }, el("span", {}, p.name), el("span", { class: "pill warn" }, p.disabled)))));
}

// ------------------------------------------------------------------------------------------------ Agent
let agentState = { plan: null, root: null };
async function agent() {
  const v = view(); v.replaceChildren(el("h1", {}, "Agent"));
  const { roots, chatRoot } = await api("/agent/roots");
  if (!roots[agentState.root]) agentState.root = chatRoot || 0;
  const planId = new URLSearchParams(location.hash.split("?")[1]).get("plan");
  const sel = el("select", { "aria-label": "Folder", onchange: () => { agentState.root = Number(sel.value); showTree(); } },
    roots.map((r, i) => el("option", { value: i, selected: i === agentState.root }, r.path + (r.private ? "  (private: local models only)" : ""))));
  const goal = el("textarea", { dir: "auto", placeholder: "What should change? e.g. “Sort the files in Downloads-copy into folders by type”, “Add a README to every project”, “Rename the photos by date”…" });
  const out = el("div", { class: "stack" });
  const treeBox = el("details", {}, el("summary", {}, "What is in this folder"), el("pre", { class: "tree" }, "…"));
  async function showTree() { treeBox.querySelector("pre").textContent = (await api("/agent/tree?root=" + agentState.root).catch((e) => ({ tree: e.message }))).tree; }
  const planBtn = el("button", { class: "btn primary", onclick: () => busy(planBtn, async () => {
    if (!goal.value.trim()) return toast("Write what should change");
    out.replaceChildren(el("div", { class: "sub" }, "Working: reading, searching and thinking… (nothing changes until you approve)"));
    try { agentState.plan = await api("/agent/plan", { goal: goal.value, root: agentState.root }); renderPlan(out); }
    catch (e) { out.replaceChildren(el("div", { class: "pill bad" }, e.message)); }
  }) }, "Plan the changes");
  v.append(el("div", { class: "card stack" }, el("label", { class: "sub" }, "Folder"), sel, treeBox, goal,
    el("div", { class: "row" }, el("span", { class: "sub grow" }, "Step 1 plans only. You approve each change in step 2. Deleted items go to a trash folder."), planBtn)), out);
  showTree();
  if (planId) {
    try {
      agentState.plan = await api("/agent/plan?id=" + encodeURIComponent(planId));
      renderPlan(out);
      out.scrollIntoView({ block: "start" });
    } catch (error) { out.replaceChildren(el("div", { class: "pill bad", role: "alert" }, error.message)); }
  }
  v.append(el("h2", {}, "Folders the agent may use"), foldersCard(roots, chatRoot || 0));
  v.append(el("h2", {}, "History"), await historyCard());
}

function diffPre(lines) {
  return el("pre", { class: "diff" }, (lines || []).map((l) => el("span", { class: l[0] === "+" ? "a" : l[0] === "-" ? "d" : "c" }, l + "\n")));
}
function renderPlan(out) {
  const p = agentState.plan;
  out.replaceChildren();
  const card = el("div", { class: "card stack" }, el("h3", {}, "Answer"), el("div", { dir: "auto", style: "white-space:pre-wrap" }, p.answer || p.summary || ""),
    p.steps?.length ? el("details", {}, el("summary", {}, `${p.steps.length} tool steps · ${p.calls || "?"} model calls`),
      el("pre", { class: "tree" }, p.steps.map((s) => `🔧 ${s.tool} ${JSON.stringify(s.args || {}).slice(0, 140)}${s.thought ? "\n   💭 " + s.thought.slice(0, 200) : ""}`).join("\n"))) : null,
    el("div", { class: "sub" }, `By ${p.by}${p.reads?.length ? " · read " + p.reads.slice(0, 8).join(", ") : ""}`));
  card.prepend(el("div", { class: "sub", dir: "auto" }, p.root));
  if (p.journal) { out.append(card, changeReceipt(p.journal, p.id)); return; }
  if (!p.ops.length) { out.append(card); return; }
  card.append(el("h3", {}, "Proposed changes"));
  const list = el("ul", { class: "ops" });
  const textPaths = new Set();
  p.preview.forEach((o, i) => {
    const check = p.checks?.[i];
    const blocked = check?.status === "blocked";
    const textPath = ["write", "edit", "append"].includes(o.op) ? o.path.toLowerCase() : null;
    const checked = !blocked && !o.unchanged && (!textPath || !textPaths.has(textPath));
    if (checked && textPath) textPaths.add(textPath);
    const cb = el("input", { type: "checkbox", checked, disabled: blocked || o.unchanged, "data-i": i });
    if (textPath) cb.addEventListener("change", () => {
      if (!cb.checked) return;
      for (const other of list.querySelectorAll("input:checked")) {
        const candidate = p.preview[Number(other.dataset.i)];
        if (other !== cb && ["write", "edit", "append"].includes(candidate.op) && candidate.path.toLowerCase() === textPath) other.checked = false;
      }
    });
    list.append(el("li", {}, el("label", {}, cb, el("div", { class: "grow" },
      el("div", {}, el("b", {}, o.label), o.stats ? el("span", { class: "sub" }, `  +${o.stats.added} −${o.stats.removed}`) : null,
        o.unchanged ? el("span", { class: "pill" }, " no change") : null, o.targetExists ? el("span", { class: "pill bad" }, " target exists") : null),
      o.why ? el("div", { class: "why", dir: "auto" }, o.why) : null,
      blocked ? el("div", { class: "pill bad", role: "status" }, check.message)
        : check?.status === "passed" ? el("div", { class: "sub" }, check.syntax ? "Current file and proposed syntax checked" : "Current file matches preview") : null)),
      o.diff ? el("details", { open: p.preview.length <= 3 }, el("summary", {}, o.exists ? "Show the change" : "Show the new file"), diffPre(o.diff)) : null));
  });
  card.append(list);
  if (p.rejected?.length) card.append(el("div", { class: "sub" }, `Refused ${p.rejected.length} unsafe step(s): ` + p.rejected.map((r) => `${r.op || "?"} ${r.path || ""} (${r.reason})`).join("; ")));
  const applyBtn = el("button", { class: "btn primary", onclick: () => busy(applyBtn, async () => {
    const approve = [...list.querySelectorAll("input[type=checkbox]")].filter((c) => c.checked).map((c) => Number(c.dataset.i));
    if (!approve.length) return toast("Nothing selected");
    try {
      const j = await api("/agent/apply", { id: p.id, approve });
      out.replaceChildren(changeReceipt(j, p.id));
    } catch (e) { toast(e.message, 5000); }
  }) }, "Approve and apply selected");
  const updateApproval = () => { applyBtn.disabled = !list.querySelector("input:checked"); };
  list.addEventListener("change", updateApproval);
  updateApproval();
  card.append(el("div", { class: "row" }, el("button", { class: "btn", onclick: () => { agentState.plan = null; out.replaceChildren(); if (location.hash.includes("?plan=")) location.hash = "agent"; } }, "Close preview"), applyBtn));
  out.append(card);
}
function changeReceipt(j, id) {
  return el("div", { class: "card stack" }, el("h3", {}, j.undone ? "Undone" : j.error ? "Partly done" : "Applied"),
    el("div", {}, `${j.steps.filter(s => !s.auto).length} change(s) recorded.`), j.error ? el("div", { class: "pill bad" }, j.error) : null,
    (j.verify || []).map(v => el("details", { open: true }, el("summary", {}, v.failed ? `${v.path} · browser check incomplete` : `${v.path} · browser errors ${v.before} → ${v.after}`),
      v.failed ? el("div", { class: "pill bad" }, v.failed) : el("ul", {}, [...v.fixed.map(x => "Fixed: " + x), ...v.new.map(x => "New: " + x), ...v.still.map(x => "Still present: " + x)].map(x => el("li", {}, x))))),
    j.undone ? null : undoBtn(id, () => agent()));
}
const undoBtn = (id, after) => {
  const b = el("button", { class: "btn danger", onclick: () => busy(b, async () => {
    try { const r = await api("/agent/undo", { id }); toast(r.ok ? "Undone" : "Undone with notes: " + r.problems.join("; "), 6000); after?.(); }
    catch (e) { toast(e.message, 5000); }
  }) }, "Undo");
  return b;
};
async function historyCard() {
  const { history } = await api("/agent/history");
  if (!history.length) return el("div", { class: "card sub" }, "Nothing done yet.");
  return el("div", { class: "card" }, el("table", {}, el("tr", {}, el("th", {}, "When"), el("th", {}, "Task"), el("th", {}, "Changes"), el("th", {}, "")),
    history.map((h) => el("tr", { class: h.undone ? "muted" : "" }, el("td", {}, ago(h.at)), el("td", { dir: "auto" }, h.goal, h.error ? el("div", { class: "sub" }, h.error) : null),
      el("td", {}, h.steps), el("td", {}, h.undone ? el("span", { class: "pill" }, "undone") : undoBtn(h.id, () => agent()))))));
}
function foldersCard(roots, chatRoot = 0) {
  const rows = roots.map((r) => ({ ...r }));
  let pick = chatRoot;
  const box = el("div", { class: "card stack" });
  const draw = () => {
    box.replaceChildren(el("div", { class: "sub" }, "Any folder on this PC can be added (system folders and MyChat's own keys are always off-limits). ● marks the folder the chat works in. " +
      "You can also focus one request on any folder by writing its path in the message (e.g. C:\\Music\\Sets …), or switch the chat's folder with /folder C:\\path. Private folders are handled by the local models only."));
    rows.forEach((r, i) => box.append(el("div", { class: "row" },
      el("input", { type: "radio", name: "chatroot", checked: i === pick, title: "the chat works in this folder", onchange: () => { pick = i; } }),
      el("code", { class: "grow" }, r.path),
      el("label", { class: "sub" }, el("input", { type: "checkbox", checked: r.private, onchange: (e) => { r.private = e.target.checked; } }), " private"),
      el("button", { class: "btn small danger", onclick: () => { rows.splice(i, 1); draw(); } }, "Remove"))));
    const input = el("input", { type: "text", placeholder: "C:\\Users\\you\\Documents\\Something" });
    box.append(el("div", { class: "row" }, input, el("button", { class: "btn small", onclick: () => { if (input.value.trim()) { rows.push({ path: input.value.trim(), private: false }); draw(); } } }, "Add")),
      el("div", { class: "row" }, el("span", { class: "grow" }), el("button", { class: "btn primary small", onclick: async () => {
        const r = await api("/agent/roots", { roots: rows, chatRoot: pick }); toast(`${r.roots.length} folder(s) saved` + (r.roots.length < rows.length ? " (missing or protected folders were skipped)" : "")); agent();
      } }, "Save folders")));
  };
  draw();
  return box;
}

// ------------------------------------------------------------------------------------------------ Accounts
const FREE = ["openrouter", "gemini", "groq", "nvidia", "sambanova", "huggingface", "siliconflow", "vercel", "nebius", "cerebras", "github"];
// The Google path: every free service that takes a Google sign-in (or a one-time check) and no card, best first.
// Free without a card on this account (2026-11-21): Gemini, Groq, OpenRouter, NVIDIA; Mistral and Cohere asked for payment;
// without a card; GitHub Models was retired (July 2026); Cerebras now asks for a card.
const GOOGLE_PATH = [
  ["openrouter", "One click — Claude, GPT, Gemini, DeepSeek… free models daily", null],
  ["gemini", "Gemini Flash family + Gemma, long context, images", "Sign in with Google → Create API key → Copy"],
  ["groq", "Very fast open models (gpt-oss 120B, Qwen, Kimi)", "Continue with Google → Create API Key → Copy"],
  ["nvidia", "Strong open models free: DeepSeek, Kimi, Qwen3, GLM, MiniMax", "Sign in (Google works) → verify phone once → Generate API Key → Copy"],
  ["sambanova", "Fast large open models, small free quota", "Sign in → API keys → Create → Copy"],
  ["huggingface", "Thousands of open models through partner providers, small monthly credit", "Sign in (Google works) → new token with 'Make calls to Inference Providers' → Copy"],
  ["siliconflow", "Qwen, DeepSeek, GLM — some models free", "Sign in → API keys → Create → Copy"],
  ["vercel", "AI Gateway: many models, small monthly free credit", "Sign in → AI Gateway → API keys → Create → Copy"],
  ["nebius", "Token Factory: open models (DeepSeek, Qwen, Kimi, Llama) — starter credit", "Sign in with Google → API keys → Create → Copy"],
  ["cerebras", "Extremely fast; trial now asks for a card", "Sign in → API keys → Copy"],
  ["github", "GitHub Models (reported retired July 2026) — try only if your key still answers", "github.com/settings/tokens → fine-grained token with Models access"],
];
// measured on this account 2026-11-21: Mistral and Cohere asked for payment — listed with the paid ones, not hidden
const PAID = ["mistral", "cohere", "anthropic", "openai", "deepseek", "xai", "moonshot", "zai", "together", "fireworks"];
async function accounts() {
  const v = view(); v.replaceChildren(el("h1", {}, "Accounts"));
  if (new URLSearchParams(location.search).get("connected")) toast("✓ OpenRouter connected");
  const [st, cat] = await Promise.all([api("/status"), api("/catalog")]);
  const P = st.providers;
  v.append(el("div", { class: "grid" }, googleCard(P, cat), pasteCard()));
  const card = (id) => {
    const p = P[id]; if (!p) return null;
    const pill = p.disabled && p.hasKey ? el("span", { class: "pill warn" }, p.disabled) : p.hasKey ? el("span", { class: "pill ok" }, `✓ ${p.models} models`) : el("span", { class: "pill" }, "not connected");
    return el("div", { class: "card stack" }, el("div", { class: "row" }, el("h3", { class: "grow" }, p.name), pill),
      el("div", { class: "sub" }, cat.connect[id]?.note || p.free || ""),
      el("div", { class: "row" }, p.keyUrl ? el("a", { class: "btn small", href: p.keyUrl, target: "_blank", rel: "noopener" }, p.hasKey ? "Manage key" : "Get a key") : el("span"),
        p.hasKey ? el("button", { class: "btn small danger", onclick: async () => { await api("/connections/remove", { provider: id }); accounts(); } }, "Remove") : null));
  };
  const connected = Object.keys(P).filter((id) => P[id].hasKey);
  if (connected.length) v.append(el("h2", {}, "Connected"), el("div", { class: "grid" }, connected.map(card)));
  v.append(el("h2", {}, "Free to add"), el("div", { class: "grid" }, FREE.filter((id) => !P[id]?.hasKey).map(card)));
  v.append(el("h2", {}, "Pay per use"), el("div", { class: "grid" }, PAID.filter((id) => !P[id]?.hasKey).map(card)));
  const kl = Object.entries(P).filter(([, p]) => p.keyless);
  v.append(el("h2", {}, "No key needed"), el("div", { class: "card stack" },
    el("label", { class: "row" }, el("span", { class: "grow" }, "Use the free no-key channels as a last resort (never for private chats)"),
      el("input", { type: "checkbox", checked: cat.allowKeyless, onchange: async (e) => { await api("/connections", { allowKeyless: e.target.checked }); toast("Saved"); } })),
    kl.map(([, p]) => el("div", { class: "row" }, el("span", {}, p.name), el("span", { class: "pill " + (p.disabled ? "warn" : p.models ? "ok" : "") }, p.disabled || (p.models ? p.models + " models" : "—"))))));
  v.append(el("h2", {}, "Web evidence for the Truth Engine"), el("div", { class: "sub" }, "Wikipedia is always on. Each search key adds broader, fresher evidence."),
    el("div", { class: "grid" }, Object.entries(cat.search).map(([id, p]) => el("div", { class: "card stack" },
      el("div", { class: "row" }, el("h3", { class: "grow" }, p.name), el("span", { class: "pill " + (p.hasKey ? "ok" : "") }, p.hasKey ? "✓ on" : "off")),
      el("div", { class: "sub" }, p.note), el("div", { class: "row" }, el("a", { class: "btn small", href: p.keyUrl, target: "_blank", rel: "noopener" }, p.hasKey ? "Manage key" : "Get a key"),
        p.hasKey ? el("button", { class: "btn small danger", onclick: async () => { await api("/connections/remove", { provider: id }); accounts(); } }, "Remove") : null)))));
}
/** Connect with Google: one service at a time. You sign in with Google there and copy the key; when you come back to
 *  this page the key is read from the clipboard, recognised, tested and saved, and the next service opens. */
function googleCard(P, cat) {
  const todo = GOOGLE_PATH.filter(([id]) => P[id] && !P[id].hasKey);
  const done = GOOGLE_PATH.length - todo.length;
  const box = el("div", { class: "card hero stack" });
  const head = el("div", {}, el("h3", {}, "Connect with Google"),
    el("div", { class: "sub" }, `${done} of ${GOOGLE_PATH.length} services connected. Each opens with your Google account (or one quick sign-up); copy the key there and come back — it is added by itself. Gemini, Groq, OpenRouter and NVIDIA need no card; Mistral and Cohere asked for payment, so they are under "Pay per use".`));
  box.append(head);
  if (!todo.length) { box.append(el("div", { class: "pill ok" }, "✓ All free Google services are connected")); return box; }
  const list = el("div", { class: "stack" });
  for (const [id, what, how] of GOOGLE_PATH) {
    const p = P[id]; if (!p) continue;
    const row = el("div", { class: "row gstep" + (p.hasKey ? " done" : "") },
      el("span", { class: "pill " + (p.hasKey ? "ok" : "") }, p.hasKey ? "✓" : "·"),
      el("div", { class: "grow" }, el("b", {}, p.name.replace(/\s*\(.*\)$/, "")), el("div", { class: "sub" }, what + (how && !p.hasKey ? " — " + how : ""))),
      p.hasKey ? null : id === "openrouter"
        ? el("a", { class: "btn small primary", href: cat.openrouterStart }, "Connect")
        : el("button", { class: "btn small primary", onclick: () => { sessionStorage.setItem("mychat.hunt", id); window.open(p.keyUrl, "_blank", "noopener"); toast(`${p.name}: sign in with Google, create a key, copy it — then come back here`, 7000); } }, "Open"));
    list.append(row);
  }
  box.append(list);
  return box;
}

// Coming back from a provider's page: read the clipboard once, add the key if it is one (Edge/Chrome ask once).
let lastClip = "";
async function huntClipboard() {
  const want = sessionStorage.getItem("mychat.hunt");
  if (!want || document.visibilityState !== "visible") return;
  let t = "";
  try { t = (await navigator.clipboard.readText()).trim(); } catch { toast("Paste the key in “Add a key” (the browser did not allow reading the clipboard)", 6000); sessionStorage.removeItem("mychat.hunt"); return; }
  if (!t || t === lastClip || t.length > 2000) return;
  lastClip = t;
  const { results = [] } = await api("/connections/paste", { text: t });
  if (!results.length) return toast("The clipboard does not hold a key yet — copy the key and come back", 5000);
  const ok = results.filter((r) => r.ok);
  toast(ok.length ? "✓ " + ok.map((r) => `${r.name}${r.models ? ` — ${r.models} models` : ""}`).join(", ") : "✗ " + results.map((r) => `${r.name}: ${r.error}`).join("; "), 6000);
  if (ok.length) { sessionStorage.removeItem("mychat.hunt"); if (location.hash === "#accounts" || !location.hash) accounts(); }
}
addEventListener("focus", () => setTimeout(huntClipboard, 300));
document.addEventListener("visibilitychange", () => setTimeout(huntClipboard, 300));

function pasteCard() {
  const ta = el("textarea", { dir: "ltr", placeholder: "Paste one or more keys (AIza… · AQ.… · gsk_… · nvapi-… · sk-or-… · sk-ant-… · hf_… · xai-…)" });
  const out = el("pre", { class: "sub", style: "white-space:pre-wrap;margin:0" });
  const b = el("button", { class: "btn primary", onclick: () => busy(b, async () => {
    out.textContent = "Checking…";
    const isBundle = ta.value.includes("mychat-keys-v1:");
    const code = isBundle ? prompt("Code shown on the phone (XXXX-XXXX-XXXX-XXXX)") || "" : "";
    const { results, error } = await api("/connections/paste", { text: ta.value, code });
    if (error) { out.textContent = "✗ " + error; return; }
    out.textContent = results.length ? results.map((r) => `${r.ok ? "✓" : "✗"} ${r.name} — ${r.ok ? (r.models ? r.models + " models" : "connected") : r.error}`).join("\n") : "✗ No key recognised. Nothing was saved.";
    if (results.some((r) => r.ok)) { ta.value = ""; setTimeout(accounts, 1500); }
  }) }, "Check and add");
  const xout = el("div", { class: "stack" });
  const x = el("button", { class: "btn", onclick: () => busy(x, async () => {
    const r = await api("/connections/export", {});
    xout.replaceChildren(el("div", { class: "sub" }, "Code to type on the phone:"), el("div", { style: "font:600 22px ui-monospace,Consolas,monospace;letter-spacing:1px" }, r.code),
      el("textarea", { readonly: true, style: "min-height:60px;font:12px ui-monospace,Consolas,monospace" }, r.text),
      el("button", { class: "btn small", onclick: async () => { await navigator.clipboard.writeText(r.text); toast("Copied — send it to yourself and paste it in the phone's “Add a key”"); } }, "Copy the keys text"));
  }) }, "Send my keys to the phone");
  return el("div", { class: "card stack" }, el("h3", {}, "Add a key"), el("div", { class: "sub" }, "The provider is recognised and the key tested before it is saved. Keys stay on this PC. A keys text from the phone (mychat-keys-v1:…) works here too."), ta, el("div", { class: "row" }, out, b),
    el("div", { class: "sub" }, "Same keys on the phone: makes one encrypted text plus a code; without the code the text is useless."), x, xout);
}

// ------------------------------------------------------------------------------------------------ Models
async function models() {
  const v = view(); v.replaceChildren(el("h1", {}, "Models"));
  const b = await api("/bench");
  const st = await api("/status");
  const startBtn = el("button", { class: "btn primary", disabled: b.running, onclick: () => busy(startBtn, async () => { await api("/bench/start", { truthSet: "hard", modes: ["fast", "auto"] }); toast("Measuring… this page updates by itself"); setTimeout(models, 1500); }) }, "Measure my models");
  v.append(el("div", { class: "card stack" }, el("div", { class: "sub" }, "Sends real test questions (chat, code that is run, reasoning, Hebrew) to each connected account, then routes each task to the models that actually did best. Uses some of your free quota."),
    el("div", { class: "row" }, el("span", { class: "grow" }, b.running ? `Running: ${b.phase} ${b.done}/${b.total}` : b.finishedAt ? "Last run " + ago(b.finishedAt) : "Not measured in this session"),
      b.running ? el("button", { class: "btn", onclick: async () => { await api("/bench/stop", {}); toast("Stopping after the current question"); } }, "Stop") : null, startBtn)));
  if (b.running) setTimeout(() => { if (location.hash === "#models") models(); }, 5000);
  if (b.truth?.summary) v.append(el("h2", {}, "Question set (facts, traps, math)"), el("div", { class: "card" }, el("table", {},
    el("tr", {}, ["Mode", "Correct", "Confidently wrong", "First word", "Total", "Model calls"].map((h) => el("th", {}, h))),
    Object.entries(b.truth.summary).map(([m, s]) => el("tr", {}, el("td", {}, m), el("td", {}, Math.round(s.accuracy * 100) + "%"), el("td", {}, s.confidentlyWrong), el("td", {}, s.firstWordSeconds + " s"), el("td", {}, s.avgSeconds + " s"), el("td", {}, s.avgCalls))))));
  if (b.models?.length) v.append(el("h2", {}, "Measured models"), el("div", { class: "card" }, el("table", {},
    el("tr", {}, ["Model", "Chat", "Code", "Reasoning", "Hebrew"].map((h) => el("th", {}, h))),
    b.models.map((r) => el("tr", {}, el("td", {}, `${r.provider}: ${r.model}`), ["chat", "code", "reason"].map((t) => el("td", {}, Math.round((r.acc[t] || 0) * 100) + "%")), el("td", {}, Math.round((r.he || 0) * 100) + "%"))))));
  const rows = Object.entries(st.stats).filter(([, s]) => s.ok > 0).sort((a, b) => b[1].ok - a[1].ok).slice(0, 25);
  v.append(el("h2", {}, "Working models (from real use)"), el("div", { class: "card" }, el("table", {},
    el("tr", {}, ["Model", "Answered", "Failed", "First token", "Last problem"].map((h) => el("th", {}, h))),
    rows.map(([k, s]) => el("tr", {}, el("td", {}, k.replace("|", ": ")), el("td", {}, s.ok), el("td", {}, s.fail), el("td", {}, s.ttft ? (s.ttft / 1000).toFixed(1) + " s" : "—"), el("td", { class: "sub" }, (s.lastError || "").slice(0, 70)))))));
}

// ------------------------------------------------------------------------------------------------ System
async function system() {
  const v = view(); v.replaceChildren(el("h1", {}, "System"));
  const sys = await api("/system");
  const sup = sys.supervisor || {};
  v.append(el("div", { class: "card" }, sup.error ? el("div", { class: "pill bad" }, sup.error) : el("table", {},
    el("tr", {}, ["Service", "State", "Up since", "Restarts", "Last problem"].map((h) => el("th", {}, h))),
    (sup.services || []).map((s) => el("tr", {}, el("td", {}, s.name), el("td", {}, el("span", { class: "pill " + (s.up ? "ok" : "bad") }, s.up ? "running" : "down")),
      el("td", {}, s.since ? ago(s.since) : "—"), el("td", {}, s.restarts || 0), el("td", { class: "sub" }, (s.lastError || "").slice(0, 80)))))),
    el("div", { class: "sub" }, "The supervisor starts and watches everything (Ollama, Open WebUI, MyChat, Kestrel) and restarts what stops."));
  const out = el("pre", { class: "sub", style: "white-space:pre-wrap" }, sup.lastUpdate ? fmtUpdate(sup.lastUpdate) : "");
  const check = el("button", { class: "btn", onclick: () => busy(check, async () => { out.textContent = fmtUpdate(await api("/system/update?check=1", {})); }) }, "Check for updates");
  const inst = el("button", { class: "btn primary", onclick: () => busy(inst, async () => { out.textContent = "Installing…"; out.textContent = fmtUpdate(await api("/system/update", {})); setTimeout(system, 8000); }) }, "Install update");
  v.append(el("h2", {}, "Updates"), el("div", { class: "card stack" },
    el("div", { class: "sub" }, "Installs only versions that passed all tests on GitHub. A backup of every replaced file is kept, and services reload by themselves (Kestrel waits until it is idle)."),
    el("div", { class: "row" }, el("span", { class: "grow" }), check, inst), out));
  const link = await api("/system/phone-link");
  const pairOut = el("div", { class: "stack" });
  const pair = el("button", { class: "btn primary", disabled: !link.enabled, onclick: () => busy(pair, async () => {
    const r = await api("/connections/export", { withPc: true });
    pairOut.replaceChildren(el("div", { class: "sub" }, "On the phone: Accounts → Add a key → paste this text → type the code."),
      el("div", { style: "font:600 22px ui-monospace,Consolas,monospace;letter-spacing:1px" }, r.code),
      el("textarea", { readonly: true, style: "min-height:60px;font:12px ui-monospace,Consolas,monospace" }, r.text),
      el("button", { class: "btn small", onclick: async () => { await navigator.clipboard.writeText(r.text); toast("Copied — send it to yourself (WhatsApp / e-mail)"); } }, "Copy"));
  }) }, "Pair the phone (keys + this PC)");
  v.append(el("h2", {}, "Phone link"), el("div", { class: "card stack" },
    el("div", { class: "sub" }, "Lets the phone use this PC: all its accounts, local models and folders, and long tasks keep running here even when the phone sleeps. A separate port that answers only with your token — no pages, no keys. For use outside home, install Tailscale (free) on both PC and phone."),
    el("label", { class: "row" }, el("span", { class: "grow" }, link.enabled ? (link.running ? `On — port ${link.port}` : "On, but the port is busy") : "Off"),
      el("input", { type: "checkbox", checked: link.enabled, onchange: async (e) => { await api("/system/phone-link", { enabled: e.target.checked }); toast(e.target.checked ? "Phone link on. If Windows asks, allow Node.js on private networks." : "Phone link off"); system(); } })),
    link.enabled ? el("div", {}, link.urls.map((u) => el("div", { class: "row" }, el("code", {}, u.url), el("span", { class: "sub" }, u.via)))) : null,
    pair, pairOut));
  const appBtn = el("button", { class: "btn primary", onclick: () => busy(appBtn, async () => {
    const r = await api("/system/desktop-app", {});
    toast(r.ok ? "✓ MyChat is on your Desktop and in the Start menu — opening its window" : "✗ " + r.error, 6000);
  }) }, "Install the PC app");
  v.append(el("h2", {}, "PC app"), el("div", { class: "card stack" },
    el("div", { class: "sub" }, "MyChat in its own window — no tabs, no address bar — with a Desktop and Start-menu icon. It uses Microsoft Edge (already on Windows) and your normal sign-ins."),
    el("div", { class: "row" }, appBtn)));
  v.append(el("h2", {}, "Phone"), el("div", { class: "card stack" }, el("div", {}, "The Android app is built automatically on every change."),
    el("a", { class: "btn", href: "https://github.com/haran4-cpu/MyChat/releases", target: "_blank", rel: "noopener" }, "Latest APK")));
}
function fmtUpdate(u) {
  if (!u) return "";
  if (u.error) return "✗ " + u.error;
  const c = (u.commit || "").slice(0, 7), n = (u.changed || []).length;
  if (!n) return `✓ Up to date (${c})`;
  return (u.installed ? `✓ Installed commit ${c}: ` : `Update available — commit ${c}: `) + `${n} file(s)\n` + u.changed.slice(0, 20).join("\n") + (u.backup ? "\nBackup: " + u.backup : "");
}

// ------------------------------------------------------------------------------------------------ router
const SECTIONS = { home, agent, accounts, models, system };
async function route() {
  const name = (location.hash || "#home").slice(1).split("?")[0];
  const fn = SECTIONS[name] || home;
  for (const a of document.querySelectorAll("#nav a")) a.classList.toggle("on", a.getAttribute("href") === "#" + (SECTIONS[name] ? name : "home"));
  try { await fn(); } catch (e) { view().replaceChildren(el("div", { class: "card" }, el("span", { class: "pill bad" }, e.message))); }
  view().focus({ preventScroll: true });
}
addEventListener("hashchange", route);
route();

// After an update the gateway restarts with new pages, but an open tab keeps running the old ones (measured: the
// Accounts page still showed the previous version after "Install update"). When the gateway's start time changes,
// reload — unless you are typing.
let bootedAt = null;
setInterval(async () => {
  try {
    const h = await (await fetch("/health", { cache: "no-store" })).json();
    if (bootedAt == null) { bootedAt = h.startedAt; return; }
    if (h.startedAt !== bootedAt && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) location.reload();
  } catch { /* restarting */ }
}, 15000);

// "Open chat" opens your Open WebUI app (the one installed on this PC) when there is one; otherwise a browser tab
document.addEventListener("click", async (e) => {
  const a = e.target.closest?.('a[href^="http://127.0.0.1:8080"]');
  if (!a || e.ctrlKey || e.shiftKey || e.metaKey) return;
  e.preventDefault();
  try { const r = await api("/system/open-chat", {}); if (r.opened) { toast("Opening the Open WebUI app"); return; } } catch { /* fall back */ }
  window.open(a.href, "_blank", "noopener");
});
