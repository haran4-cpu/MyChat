// Phone screens for the Agent and Files. Same engine as the PC (core/agent.mjs): the agent thinks and uses tools
// (tree, read, search — also inside ZIP/APK archives — study, calc, web search, fetch, run_js), shows its steps, keeps
// each conversation, and only PROPOSES changes: you approve, it applies, Undo puts everything back.
import { runAgent, preview, apply, undo, TRASH } from "./core/agent.mjs";
import { evaluate } from "./core/exact.mjs";
import { htmlToText } from "./core/search.mjs";
import { isArchiveName, isZip, extractZip } from "./core/zip.mjs";
import { workspace, importFiles, uniquePath } from "./files.mjs";

// ---------------------------------------------------------------- storage (sessions + undo journals), size-capped
const store = (key, max) => ({
  all() { try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; } },
  save(item) {
    let list = [item, ...this.all().filter((x) => x.id !== item.id)].slice(0, max);
    for (;;) { try { localStorage.setItem(key, JSON.stringify(list)); return true; } catch { if (list.length <= 1) return false; list = list.slice(0, Math.ceil(list.length / 2)); } }
  },
  remove(id) { localStorage.setItem(key, JSON.stringify(this.all().filter((x) => x.id !== id))); },
});
const sessions = store("mychat.agent.sessions", 30), journals = store("mychat.agent.journals", 30);

// ---------------------------------------------------------------- host tools for the agent on the phone
export function hostTools({ search, fetch: f }) {
  return {
    search,
    evaluate: (e) => evaluate(e).toString(12),
    fetchText: async (url) => { if (!/^https?:\/\//.test(url)) throw new Error("only http(s) pages"); const r = await f(url); return htmlToText(await r.text()).slice(0, 20000); },
    runJs: (code) => new Promise((ok) => {
      const src = `self.fetch=undefined;self.XMLHttpRequest=undefined;self.WebSocket=undefined;self.importScripts=undefined;
        const out=[];const fmt=(a)=>a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ');
        console.log=(...a)=>out.push(fmt(a));console.error=(...a)=>out.push('ERROR '+fmt(a));
        onmessage=async(e)=>{try{const r=await (0,eval)('(async()=>{'+e.data+'\\n})()');postMessage(out.join('\\n')+(r!==undefined?'\\n=> '+fmt([r]):''))}catch(err){postMessage(out.join('\\n')+'\\nERROR '+err)}}`;
      let w;
      try { w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" }))); } catch (e) { ok("sandbox not available: " + e.message); return; }
      const t = setTimeout(() => { w.terminate(); ok("stopped after 5 s"); }, 5000);
      w.onmessage = (e) => { clearTimeout(t); w.terminate(); ok(String(e.data).slice(0, 8000) || "(no output)"); };
      w.postMessage(code);
    }),
  };
}

// ---------------------------------------------------------------- Agent
export function agentView(root, { el, md, toast, gw, tools, prefill }) {
  let session = sessions.all()[0] && !prefill ? null : null;   // start fresh; old sessions are one tap away
  let running = null;
  const newSession = () => ({ id: Date.now().toString(36), title: "", at: Date.now(), turns: [] });
  const draw = async () => {
    const fs = await workspace();
    root.replaceChildren();
    const pad = el("div", { class: "pad" });
    if (!session) {
      session = newSession();
      const list = sessions.all();
      pad.append(el("section", { class: "card" }, el("h3", {}, "Agent"),
        el("p", {}, `Works with your MyChat folder (${fs.kind}): reads files and archives, searches, studies whole projects, checks facts and numbers. It only proposes changes — you approve, and Undo puts everything back.`)));
      if (list.length) pad.append(el("section", { class: "card" }, el("h3", {}, "Earlier tasks"),
        list.slice(0, 12).map((s) => el("div", { class: "row" },
          el("button", { class: "grow linkish", type: "button", dir: "auto", onclick: () => { session = s; draw(); } }, s.title || "Untitled", el("small", {}, new Date(s.at).toLocaleString())),
          el("button", { class: "mini", type: "button", onclick: () => { sessions.remove(s.id); draw(); } }, "Delete")))));
    } else {
      pad.append(el("div", { class: "row tight" }, el("b", { class: "grow", dir: "auto" }, session.title || "New task"),
        el("button", { class: "mini", type: "button", onclick: () => { session = null; draw(); } }, "All tasks")));
    }
    for (const t of session.turns) pad.append(turnView(t, fs));
    const goal = el("textarea", { class: "goal", dir: "auto", rows: 3, placeholder: session.turns.length ? "Follow-up… · המשך…" : "What should I do? e.g. “Review the app in Projects/MyChat-14 like a senior engineer” · “סדר את הקבצים ב-Inbox לפי נושא”" });
    if (prefill) { goal.value = prefill; prefill = ""; }
    const status = el("div", { class: "steps live", hidden: true });
    const go = el("button", { class: "btn", type: "button" }, "Start");
    go.onclick = async () => {
      if (running) { running.abort(); return; }
      const text = goal.value.trim(); if (!text) return toast("Write what to do");
      running = new AbortController(); go.textContent = "Stop"; status.hidden = false; status.replaceChildren();
      const turn = { goal: text, at: Date.now(), steps: [] };
      try {
        const history = session.turns.flatMap((t) => [{ role: "user", content: t.goal }, { role: "assistant", content: t.answer || "" }]);
        const r = await runAgent(gw(), { goal: text, fs, history, signal: running.signal, ...tools(),
          onStep: (s) => { status.append(stepEl(s)); status.scrollTop = status.scrollHeight; if (s.kind !== "status") turn.steps.push(s); } });
        Object.assign(turn, { answer: r.answer, ops: r.ops, rejected: r.rejected, by: r.by, calls: r.calls, planId: r.id });
        if (r.ops.length) turn.preview = await preview(fs, r.ops);
      } catch (e) { turn.answer = (running.signal.aborted ? "Stopped." : "✗ " + e.message); }
      if (!session.title) session.title = text.slice(0, 70);
      session.turns.push(turn); session.at = Date.now();
      if (!sessions.save(session)) toast("Phone storage is full: older tasks were removed");
      running = null; draw();
    };
    pad.append(el("section", { class: "card" }, goal, el("div", { class: "actions" }, go, el("button", { class: "btn ghost", type: "button", onclick: () => { session = newSession(); draw(); } }, "New task")), status));
    root.append(pad);
    root.scrollTop = root.scrollHeight;
  };
  const stepEl = (s) => el("div", { class: "step " + s.kind, dir: "auto" },
    s.kind === "tool" ? `🔧 ${s.tool} ${s.args ? JSON.stringify(s.args).slice(0, 120) : ""}` : s.kind === "thought" ? `💭 ${s.text}` : `… ${s.text}`);
  function turnView(t, fs) {
    const box = el("section", { class: "card turn" }, el("div", { class: "msg user", dir: "auto" }, t.goal));
    if (t.steps?.length) {
      const d = el("details", {}, el("summary", {}, `${t.steps.filter((s) => s.kind === "tool").length} tool steps · ${t.calls || "?"} model calls · ${(t.by || "").split(":").slice(1).join(":").split("/").pop()}`),
        el("div", { class: "steps" }, t.steps.map(stepEl)));
      box.append(d);
    }
    const ans = el("div", { class: "body", dir: "auto" }); ans.innerHTML = md(t.answer || ""); box.append(ans);
    if (t.ops?.length) box.append(opsView(t, fs));
    return box;
  }
  function opsView(t, fs) {
    const wrap = el("div", { class: "opsbox" }, el("b", {}, "Proposed changes"));
    if (t.journal) {
      wrap.append(el("p", {}, `${t.journal.undone ? "Undone" : "Applied"}: ${t.journal.steps.length} change(s)` + (t.journal.error ? ` — stopped at: ${t.journal.error}` : "")));
      if (!t.journal.undone) wrap.append(el("button", { class: "btn ghost", type: "button", onclick: async () => {
        const r = await undo(fs, t.journal); t.journal.undone = Date.now(); journals.save(t.journal); sessions.save(session); toast(r.ok ? "Undone" : r.problems.join("; "), 5000); draw();
      } }, "Undo"));
      return wrap;
    }
    const boxes = [];
    (t.preview || t.ops).forEach((o, i) => {
      const cb = el("input", { type: "checkbox", checked: !o.unchanged });
      boxes.push(cb);
      const diff = o.diff ? el("pre", { class: "diff" }, o.diff.slice(0, 200).join("\n")) : null;
      if (diff) diff.hidden = (t.preview || []).length > 3;
      wrap.append(el("div", { class: "op" }, el("label", { class: "row" }, cb, el("div", { class: "grow" },
        el("span", {}, `${i + 1}. ${o.label || o.op + " " + o.path}${o.stats ? `  +${o.stats.added} −${o.stats.removed}` : ""}`), o.why ? el("small", { dir: "auto" }, o.why) : null),
        diff ? el("button", { class: "mini", type: "button", onclick: (e) => { e.preventDefault(); diff.hidden = !diff.hidden; } }, "Show") : null), diff));
    });
    wrap.append(el("div", { class: "actions" }, el("button", { class: "btn", type: "button", onclick: async () => {
      const approved = boxes.map((b, i) => (b.checked ? i : -1)).filter((i) => i >= 0);
      if (!approved.length) return toast("Nothing selected");
      const j = await apply(fs, { id: t.planId, goal: t.goal, ops: t.ops }, approved);
      t.journal = j; journals.save(j); sessions.save(session); draw();
    } }, "Approve and apply")));
    return wrap;
  }
  draw();
}

// ---------------------------------------------------------------- Files
export function filesView(root, { el, toast, onAgent, onAttach }) {
  let cwd = "";
  const draw = async () => {
    const fs = await workspace();
    root.replaceChildren();
    const pad = el("div", { class: "pad" });
    const status = el("small", { class: "muted" });
    const pick = el("input", { type: "file", multiple: true, hidden: true, onchange: async (e) => {
      const files = [...e.target.files]; if (!files.length) return;
      const r = await importFiles(fs, files, { folder: cwd && !cwd.startsWith("Inbox") ? cwd : undefined, onStatus: (s) => (status.textContent = s) });
      status.textContent = "";
      toast(`${r.saved.length} file(s) saved` + (r.projects.length ? ` · unpacked into ${r.projects.filter((p) => p.to).map((p) => p.to).join(", ")}` : ""), 5000);
      draw();
    } });
    const crumbs = el("div", { class: "crumbs" }, el("button", { class: "mini", type: "button", onclick: () => { cwd = ""; draw(); } }, "MyChat"),
      ...cwd.split("/").filter(Boolean).map((part, i, arr) => el("button", { class: "mini", type: "button", onclick: () => { cwd = arr.slice(0, i + 1).join("/"); draw(); } }, part)));
    pad.append(el("section", { class: "card" }, el("h3", {}, "Files"),
      el("p", {}, `Your MyChat folder (${fs.kind}). New files go to Inbox/<date>; archives (.zip, .apk) are also unpacked into Projects so the models can read them.`),
      crumbs, el("div", { class: "actions" },
        el("button", { class: "btn ghost", type: "button", onclick: () => pick.click() }, "Add files"),
        el("button", { class: "btn ghost", type: "button", onclick: async () => {
          const name = (prompt("New folder name") || "").trim().replace(/[\\/:*?"<>|]/g, "_");
          if (name) { await fs.mkdir((cwd ? cwd + "/" : "") + name); draw(); }
        } }, "New folder"),
        cwd ? el("button", { class: "btn ghost", type: "button", onclick: () => onAgent(`Look at the folder "${cwd}" and tell me what it contains and what stands out.`) }, "Ask the Agent") : null),
      status, pick));
    const list = el("section", { class: "card" });
    let items = [];
    try { items = (await fs.list(cwd)).filter((x) => x.name !== TRASH).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name)); } catch (e) { list.append(el("p", {}, "✗ " + e.message)); }
    if (!items.length) list.append(el("p", {}, "Empty."));
    for (const it of items) {
      const rel = (cwd ? cwd + "/" : "") + it.name;
      list.append(el("div", { class: "row file" },
        el("button", { class: "grow linkish", type: "button", onclick: async () => { if (it.dir) { cwd = rel; draw(); } else openFile(rel, it); } },
          el("span", { class: "ic" }, it.dir ? "📁" : isArchiveName(it.name) ? "🗜️" : "📄"), el("span", { dir: "auto" }, it.name), el("small", {}, it.dir ? "" : fmt(it.size)))));
    }
    async function openFile(rel, it) {
      const sheet = document.querySelector("#sheet"), box = document.querySelector("#sheetContent");
      document.querySelector("#sheetTitle").textContent = it.name;
      const actions = el("div", { class: "actions" },
        el("button", { class: "btn ghost", type: "button", onclick: () => { sheet.hidden = true; onAttach(rel); } }, "Attach to chat"),
        el("button", { class: "btn ghost", type: "button", onclick: () => { sheet.hidden = true; onAgent(`About "${rel}": `); } }, "Ask the Agent"));
      if (isArchiveName(it.name)) actions.prepend(el("button", { class: "btn", type: "button", onclick: async () => {
        const bytes = await fs.readBytes(rel);
        if (!bytes || !isZip(bytes)) return toast("Not a readable archive");
        const to = await uniquePath(fs, "Projects/" + it.name.replace(/\.[^.]+$/, ""));
        if (!(await fs.exists("Projects"))) await fs.mkdir("Projects");
        toast("Unpacking…");
        try { const r = await extractZip(bytes, fs, to); toast(`✓ ${r.files} files in ${to}`); sheet.hidden = true; cwd = to; draw(); } catch (e) { toast("✗ " + e.message, 5000); }
      } }, "Unpack"));
      const text = isArchiveName(it.name) ? null : await fs.read(rel);
      box.replaceChildren(text == null ? el("p", {}, isArchiveName(it.name) ? "An archive. Unpack it to read its files, or ask the Agent — it can read inside archives." : "Not a text file. Open it from the phone's Files app (Documents/MyChat).")
                                       : el("pre", { class: "diff", dir: "auto" }, text.slice(0, 200000)), actions);
      sheet.hidden = false;
    }
    pad.append(list);
    root.append(pad);
  };
  draw();
}
const fmt = (b) => (b == null ? "" : b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(0) + " KB" : (b / 1048576).toFixed(1) + " MB");
