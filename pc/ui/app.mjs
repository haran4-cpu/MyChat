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
      el("a", { class: "btn primary", href: "http://127.0.0.1:8080/", target: "_blank", rel: "noopener" }, "Open chat")),
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
let agentState = { plan: null, root: 0 };
async function agent() {
  const v = view(); v.replaceChildren(el("h1", {}, "Agent"));
  const { roots } = await api("/agent/roots");
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
  v.append(el("h2", {}, "Folders the agent may use"), foldersCard(roots));
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
  if (!p.ops.length) { out.append(card); return; }
  card.append(el("h3", {}, "Proposed changes"));
  const list = el("ul", { class: "ops" });
  p.preview.forEach((o, i) => {
    const cb = el("input", { type: "checkbox", checked: !o.unchanged, "data-i": i });
    list.append(el("li", {}, el("label", {}, cb, el("div", { class: "grow" },
      el("div", {}, el("b", {}, o.label), o.stats ? el("span", { class: "sub" }, `  +${o.stats.added} −${o.stats.removed}`) : null,
        o.unchanged ? el("span", { class: "pill" }, " no change") : null, o.targetExists ? el("span", { class: "pill bad" }, " target exists") : null),
      o.why ? el("div", { class: "why", dir: "auto" }, o.why) : null)),
      o.diff ? el("details", { open: p.preview.length <= 3 }, el("summary", {}, o.exists ? "Show the change" : "Show the new file"), diffPre(o.diff)) : null));
  });
  card.append(list);
  if (p.rejected?.length) card.append(el("div", { class: "sub" }, `Refused ${p.rejected.length} unsafe step(s): ` + p.rejected.map((r) => `${r.op || "?"} ${r.path || ""} (${r.reason})`).join("; ")));
  const applyBtn = el("button", { class: "btn primary", onclick: () => busy(applyBtn, async () => {
    const approve = [...list.querySelectorAll("input[type=checkbox]")].filter((c) => c.checked).map((c) => Number(c.dataset.i));
    if (!approve.length) return toast("Nothing selected");
    try {
      const j = await api("/agent/apply", { id: p.id, approve });
      out.replaceChildren(el("div", { class: "card stack" }, el("h3", {}, j.error ? "Partly done" : "Done"),
        el("div", {}, `${j.steps.length} change(s) made.`), j.error ? el("div", { class: "pill bad" }, j.error) : null,
        el("div", { class: "row" }, el("span", { class: "sub grow" }, "Not what you wanted? Undo puts everything back."), undoBtn(p.id, () => agent()))));
    } catch (e) { toast(e.message, 5000); }
  }) }, "Approve and apply selected");
  card.append(el("div", { class: "row" }, el("button", { class: "btn", onclick: () => { agentState.plan = null; out.replaceChildren(); } }, "Discard"), applyBtn));
  out.append(card);
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
function foldersCard(roots) {
  const rows = roots.map((r) => ({ ...r }));
  const box = el("div", { class: "card stack" });
  const draw = () => {
    box.replaceChildren(el("div", { class: "sub" }, "Only these folders (and what is inside them) can be read or changed. Private folders are handled by the local models on this PC only."));
    rows.forEach((r, i) => box.append(el("div", { class: "row" }, el("code", { class: "grow" }, r.path),
      el("label", { class: "sub" }, el("input", { type: "checkbox", checked: r.private, onchange: (e) => { r.private = e.target.checked; } }), " private"),
      el("button", { class: "btn small danger", onclick: () => { rows.splice(i, 1); draw(); } }, "Remove"))));
    const input = el("input", { type: "text", placeholder: "C:\\Users\\you\\Documents\\Something" });
    box.append(el("div", { class: "row" }, input, el("button", { class: "btn small", onclick: () => { if (input.value.trim()) { rows.push({ path: input.value.trim(), private: false }); draw(); } } }, "Add")),
      el("div", { class: "row" }, el("span", { class: "grow" }), el("button", { class: "btn primary small", onclick: async () => {
        const r = await api("/agent/roots", { roots: rows }); toast(`${r.roots.length} folder(s) saved` + (r.roots.length < rows.length ? " (folders that don't exist were skipped)" : "")); agent();
      } }, "Save folders")));
  };
  draw();
  return box;
}

// ------------------------------------------------------------------------------------------------ Accounts
const FREE = ["openrouter", "gemini", "groq", "nvidia", "mistral", "cohere", "siliconflow", "github", "huggingface", "sambanova", "cerebras"];
const PAID = ["anthropic", "openai", "deepseek", "xai", "moonshot", "zai", "together", "fireworks"];
async function accounts() {
  const v = view(); v.replaceChildren(el("h1", {}, "Accounts"));
  if (new URLSearchParams(location.search).get("connected")) toast("✓ OpenRouter connected");
  const [st, cat] = await Promise.all([api("/status"), api("/catalog")]);
  const P = st.providers;
  v.append(el("div", { class: "grid" },
    el("div", { class: "card hero stack" }, el("h3", {}, "One sign-in, many models"),
      el("div", { class: "sub" }, "OpenRouter with your Google account: Claude, GPT, Gemini, GLM, Kimi, DeepSeek. Opens in your browser and comes back here."),
      el("a", { class: "btn primary", href: cat.openrouterStart }, P.openrouter?.hasKey ? "Reconnect OpenRouter" : "Connect OpenRouter")),
    pasteCard()));
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
