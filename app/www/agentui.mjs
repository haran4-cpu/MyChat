// Phone screens for Agent mode and Files. Same engine as the PC: core/agent.mjs (plan → approve → apply → undo).
import { plan, preview, apply, undo, tree, TRASH } from "./core/agent.mjs";
import { workspace } from "./files.mjs";

const JKEY = "mychat.agent.journals";
const journals = () => { try { return JSON.parse(localStorage.getItem(JKEY) || "[]"); } catch { return []; } };
function saveJournal(j) {
  let all = [j, ...journals().filter((x) => x.id !== j.id)].slice(0, 20);
  for (;;) {
    try { localStorage.setItem(JKEY, JSON.stringify(all)); return true; }
    catch { if (all.length <= 1) return false; all = all.slice(0, Math.ceil(all.length / 2)); }   // storage full: keep the newest
  }
}

export function agentView(root, { el, toast, gw }) {
  let current = null;
  const draw = async () => {
    const fs = await workspace();
    root.replaceChildren();
    const pad = el("div", { class: "pad" });
    const goal = el("textarea", { class: "goal", dir: "auto", rows: 3, placeholder: "What should change in your MyChat folder? · מה לשנות בתיקייה?" });
    const out = el("div", { class: "stack" });
    const go = el("button", { class: "btn", type: "button", onclick: async () => {
      if (!goal.value.trim()) return toast("Write what should change");
      go.disabled = true; out.replaceChildren(el("div", { class: "card" }, el("p", {}, "Planning… nothing changes yet.")));
      try {
        current = await plan(gw(), { goal: goal.value, fs, onStatus: (s) => { out.firstChild.querySelector("p").textContent = s; } });
        current.preview = await preview(fs, current.ops);
        showPlan(out, fs);
      } catch (e) { out.replaceChildren(el("div", { class: "card" }, el("p", {}, "✗ " + e.message))); }
      go.disabled = false;
    } }, "Plan the changes");
    pad.append(el("section", { class: "card" }, el("h3", {}, "Agent"),
      el("p", {}, `Works in ${fs.kind}. You see every change first; deleted items go to a trash folder; Undo puts everything back.`), goal, go), out);
    const hist = journals();
    if (hist.length) {
      const h = el("section", { class: "card" }, el("h3", {}, "Done before"));
      for (const j of hist.slice(0, 10)) {
        h.append(el("div", { class: "row" }, el("div", { class: "grow" }, el("span", { dir: "auto" }, j.goal), el("small", {}, `${j.steps.length} change(s) · ${new Date(j.at).toLocaleString()}`)),
          j.undone ? el("span", { class: "state" }, "undone") : el("button", { class: "mini", type: "button", onclick: async () => {
            const r = await undo(fs, j); j.undone = Date.now(); saveJournal(j); toast(r.ok ? "Undone" : "Undone with notes: " + r.problems.join("; "), 5000); draw();
          } }, "Undo")));
      }
      pad.append(h);
    }
    root.append(pad);
  };
  function showPlan(out, fs) {
    const p = current;
    const card = el("section", { class: "card" }, el("h3", {}, "Proposed changes"), el("p", { dir: "auto" }, p.summary || ""), el("small", { class: "muted" }, "Planned by " + p.by));
    if (!p.ops.length) { card.append(el("p", {}, "No changes proposed.")); out.replaceChildren(card); return; }
    const boxes = [];
    p.preview.forEach((o, i) => {
      const cb = el("input", { type: "checkbox", checked: !o.unchanged });
      boxes.push(cb);
      const diff = o.diff ? el("pre", { class: "diff" }, o.diff.slice(0, 200).join("\n")) : null;
      if (diff) diff.hidden = p.preview.length > 3;
      card.append(el("div", { class: "op" }, el("label", { class: "row" }, cb, el("div", { class: "grow" },
        el("span", {}, `${i + 1}. ${o.label}${o.stats ? `  +${o.stats.added} −${o.stats.removed}` : ""}`), o.why ? el("small", { dir: "auto" }, o.why) : null),
        diff ? el("button", { class: "mini", type: "button", onclick: (e) => { e.preventDefault(); diff.hidden = !diff.hidden; } }, "Show") : null), diff));
    });
    if (p.rejected?.length) card.append(el("small", {}, `Refused ${p.rejected.length} unsafe step(s).`));
    card.append(el("div", { class: "actions" },
      el("button", { class: "btn ghost", type: "button", onclick: () => { current = null; out.replaceChildren(); } }, "Discard"),
      el("button", { class: "btn", type: "button", onclick: async () => {
        const approved = boxes.map((b, i) => (b.checked ? i : -1)).filter((i) => i >= 0);
        if (!approved.length) return toast("Nothing selected");
        const j = await apply(fs, p, approved);
        if (!saveJournal(j)) toast("Applied, but the phone's storage is full: this one cannot be undone from history", 6000);
        out.replaceChildren(el("section", { class: "card" }, el("h3", {}, j.error ? "Partly done" : "Done"),
          el("p", {}, `${j.steps.length} change(s) made.` + (j.error ? " Stopped at: " + j.error : "")),
          el("button", { class: "btn ghost", type: "button", onclick: async () => { const r = await undo(fs, j); j.undone = Date.now(); saveJournal(j); toast(r.ok ? "Undone" : r.problems.join("; "), 5000); draw(); } }, "Undo")));
      } }, "Approve and apply")));
    out.replaceChildren(card);
  }
  draw();
}

export function filesView(root, { el, toast, onAsk }) {
  let cwd = "";
  const draw = async () => {
    const fs = await workspace();
    root.replaceChildren();
    const pad = el("div", { class: "pad" });
    const crumbs = el("div", { class: "crumbs" }, el("button", { class: "mini", type: "button", onclick: () => { cwd = ""; draw(); } }, "MyChat"),
      ...cwd.split("/").filter(Boolean).map((part, i, arr) => el("button", { class: "mini", type: "button", onclick: () => { cwd = arr.slice(0, i + 1).join("/"); draw(); } }, part)));
    const pick = el("input", { type: "file", multiple: true, hidden: true, onchange: async (e) => {
      let n = 0;
      for (const f of e.target.files) {
        const rel = (cwd ? cwd + "/" : "") + f.name.replace(/[\\/:*?"<>|]/g, "_");
        if (/^(text\/|application\/(json|xml|javascript))/.test(f.type) || /\.(md|txt|csv|json|js|mjs|py|html|css|xml|ya?ml)$/i.test(f.name)) await fs.write(rel, await f.text());
        else if (fs.writeBase64) await fs.writeBase64(rel, await toBase64(f));
        else continue;
        n++;
      }
      toast(`${n} file(s) added`); draw();
    } });
    const list = el("section", { class: "card" });
    let items = [];
    try { items = (await fs.list(cwd)).filter((x) => x.name !== TRASH).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name)); } catch (e) { list.append(el("p", {}, "✗ " + e.message)); }
    if (!items.length) list.append(el("p", {}, "Empty. Add files from the phone, or ask the Agent to create some."));
    for (const it of items) {
      const rel = (cwd ? cwd + "/" : "") + it.name;
      list.append(el("button", { class: "row file", type: "button", onclick: async () => {
        if (it.dir) { cwd = rel; draw(); return; }
        const text = await fs.read(rel);
        showFile(rel, text);
      } }, el("span", { class: "ic" }, it.dir ? "📁" : "📄"), el("span", { class: "grow", dir: "auto" }, it.name), el("small", {}, it.dir ? "" : fmt(it.size))));
    }
    function showFile(rel, text) {
      const sheet = document.querySelector("#sheet"), box = document.querySelector("#sheetContent");
      document.querySelector("#sheetTitle").textContent = rel.split("/").pop();
      box.replaceChildren(text == null ? el("p", {}, "Not a text file — open it from the phone's Files app (Documents/MyChat).") : el("pre", { class: "diff", dir: "auto" }, text.slice(0, 200000)),
        el("div", { class: "actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => { sheet.hidden = true; onAsk?.(`Read the file "${rel}" in my MyChat folder and `); } }, "Ask the Agent about it")));
      sheet.hidden = false;
    }
    pad.append(el("section", { class: "card" }, el("h3", {}, "Files"), el("p", {}, `Your folder: ${fs.kind}. The Agent works only here.`), crumbs,
      el("div", { class: "actions" },
        el("button", { class: "btn ghost", type: "button", onclick: () => pick.click() }, "Add files"),
        el("button", { class: "btn ghost", type: "button", onclick: async () => {
          const name = (prompt("New folder name") || "").trim().replace(/[\\/:*?"<>|]/g, "_");   // prompt is fine here: it is the app's own UI
          if (name) { await fs.mkdir((cwd ? cwd + "/" : "") + name); draw(); }
        } }, "New folder")), pick), list);
    try { const t = await tree(fs, { maxEntries: 60, maxDepth: 1 }); pad.dataset.tree = t; } catch { /* informative only */ }
    root.append(pad);
  };
  draw();
  return { refresh: draw };
}
const fmt = (b) => (b == null ? "" : b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(0) + " KB" : (b / 1048576).toFixed(1) + " MB");
const toBase64 = (f) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = bad; r.readAsDataURL(f); });
