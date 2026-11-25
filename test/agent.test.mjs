import { test } from "node:test";
import assert from "node:assert/strict";
import { safeRel, checkOps, plan, runAgent, preview, apply, undo, memoryFs, lineDiff, tree, TRASH } from "../core/agent.mjs";
import { makeZip, zipEntries, zipRead, extractZip } from "../core/zip.mjs";
import { study, verifyQuote, chunk } from "../core/digest.mjs";

const fakeGw = (replies) => {
  const seen = [];
  return { seen, async chat(req) { seen.push(JSON.parse(JSON.stringify(req))); const c = replies.shift(); return { content: typeof c === "string" ? c : JSON.stringify(c), provider: "p", model: "m" }; } };
};

test("paths stay inside the workspace and away from secrets", () => {
  for (const ok of ["a.txt", "notes/today.md", "./x/y.js", "a\\b.txt"]) assert.ok(safeRel(ok), ok);
  for (const bad of ["../x", "a/../../b", "/etc/passwd", "C:/Windows/x", "~/x", "", "keys.json", "cfg/.env", `${TRASH}/x`, "a/token", "a/b?.txt"])
    assert.equal(safeRel(bad), null, bad);
  const { ops, rejected } = checkOps([{ op: "write", path: "a.md", content: "x" }, { op: "rm", path: "a" }, { op: "move", path: "a", to: "../b" },
                                      { op: "write", path: "pic.png", content: "x" }]);
  assert.equal(ops.length, 1);
  assert.equal(rejected.length, 3);
});

test("plan: reads what it needs, then proposes; preview shows a diff; apply + undo restore the folder exactly", async () => {
  const fs = memoryFs({ "notes/todo.md": "- milk\n- eggs\n", "old.txt": "bye", "docs/a.md": "A" });
  const before = JSON.stringify([...fs.files.entries()].sort());
  const gw = fakeGw([
    { thought: "read the list first", tool: "read", args: { path: "notes/todo.md" } },
    { final: "Add bread, archive docs, remove old.txt", ops: [
      { op: "write", path: "notes/todo.md", content: "- milk\n- eggs\n- bread\n", why: "asked" },
      { op: "mkdir", path: "archive" },
      { op: "move", path: "docs", to: "archive/docs" },
      { op: "delete", path: "old.txt" },
      { op: "write", path: "new/readme.md", content: "# hi" },
      { op: "write", path: "../escape.txt", content: "no" }] },
  ]);
  const p = await plan(gw, { plan: false, goal: "add bread to my todo, archive docs, remove old.txt", fs });
  assert.deepEqual(p.reads, ["notes/todo.md"]);
  assert.match(gw.seen[1].messages.at(-1).content, /1\| - milk/, "the file it asked for was shown with line numbers");
  assert.equal(p.ops.length, 5);
  assert.equal(p.rejected.length, 1);
  const pv = await preview(fs, p.ops);
  assert.deepEqual(pv[0].stats, { added: 1, removed: 0 });
  assert.match(pv[3].label, /trash/);

  const j = await apply(fs, p);
  assert.equal(j.error, undefined);
  assert.equal(await fs.read("notes/todo.md"), "- milk\n- eggs\n- bread\n");
  assert.equal(await fs.read("archive/docs/a.md"), "A");
  assert.equal(await fs.exists("old.txt"), false);
  assert.equal(await fs.read(`${TRASH}/${p.id}/old.txt`), "bye", "deleted means moved to trash");

  const u = await undo(fs, j);
  assert.ok(u.ok, u.problems.join("; "));
  const after = [...fs.files.entries()].filter(([k]) => !k.startsWith(TRASH)).sort();
  assert.equal(JSON.stringify(after), before, "folder is back to how it was (the new file sits in the trash)");
});

test("only approved ops are applied; a failure stops and keeps an undoable journal", async () => {
  const fs = memoryFs({ "a.txt": "1", "b.txt": "2" });
  const p = { id: "t1", goal: "g", ops: [{ op: "write", path: "a.txt", content: "one" }, { op: "write", path: "b.txt", content: "two" },
                                          { op: "move", path: "a.txt", to: "b.txt" }] };
  const j1 = await apply(fs, p, [1]);
  assert.equal(await fs.read("a.txt"), "1");
  assert.equal(await fs.read("b.txt"), "two");
  const j2 = await apply(fs, p, [0, 2]);
  assert.match(j2.error, /already exists/);
  assert.equal(j2.steps.length, 1);
  await undo(fs, j2); await undo(fs, j1);
  assert.equal(await fs.read("a.txt"), "1");
  assert.equal(await fs.read("b.txt"), "2");
});

test("diff and listing", async () => {
  assert.deepEqual(lineDiff("a\nb\nc", "a\nB\nc"), ["  a", "- b", "+ B", "  c"]);
  const t = await tree(memoryFs({ "src/x.js": "1", "node_modules/p/i.js": "2", "r.md": "3" }));
  assert.match(t, /src\//); assert.match(t, /node_modules\//); assert.doesNotMatch(t, /i\.js/);
});

test("a plain-text reply is taken as the answer (no tool call, no changes)", async () => {
  const r = await plan(fakeGw(["The folder is empty."]), { plan: false, goal: "x", fs: memoryFs() });
  assert.equal(r.answer, "The folder is empty.");
  assert.equal(r.ops.length, 0);
});

test("ZIP: read, list and search inside an archive (an APK is a ZIP) without unpacking; unpack + undo", async () => {
  const inner = makeZip({ "assets/public/main.mjs": "const key = localStorage.getItem('k');\nexport default key;\n" });
  const zip = makeZip({ "MyChat.apk": inner, "README.md": "# MyChat\nAndroid build" });
  assert.deepEqual(zipEntries(zip).map((e) => e.name), ["MyChat.apk", "README.md"]);
  assert.equal(new TextDecoder().decode(await zipRead(zip, zipEntries(zip)[1])), "# MyChat\nAndroid build");
  const fs = memoryFs({ "Inbox/build.zip": zip });
  const gw = fakeGw([
    { calls: [{ tool: "tree", args: { path: "Inbox/build.zip" } }, { tool: "read", args: { path: "Inbox/build.zip!/README.md" } }] },
    { tool: "search", args: { pattern: "Android", path: "Inbox/build.zip" } },
    { final: "It is an APK build.", ops: [{ op: "extract", path: "Inbox/build.zip", to: "Projects/build" }] },
  ]);
  const steps = [];
  const r = await runAgent(gw, { plan: false, goal: "what is this?", fs, onStep: (s) => steps.push(s) });
  assert.match(gw.seen[1].messages.at(-1).content, /MyChat\.apk[\s\S]*1\| # MyChat/);
  assert.match(gw.seen[2].messages.at(-1).content, /README\.md:2: Android build/);
  assert.equal(r.ops[0].op, "extract");
  const j = await apply(fs, r);
  assert.equal(j.error, undefined);
  assert.equal(await fs.read("Projects/build/README.md"), "# MyChat\nAndroid build");
  assert.ok(await fs.exists("Projects/build/MyChat.apk"), "binary entries kept as bytes");
  // the APK inside can now be unpacked too, and its code read
  await extractZip(await fs.readBytes("Projects/build/MyChat.apk"), fs, "Projects/build/apk");
  assert.match(await fs.read("Projects/build/apk/assets/public/main.mjs"), /localStorage/);
  assert.ok((await undo(fs, j)).ok);
  assert.equal(await fs.exists("Projects/build/README.md"), false);
});

test("study: parts are read in parallel and a note whose quote is not in the file is dropped", async () => {
  const files = [{ path: "a.js", text: "function add(a,b){\n  return a - b;\n}\n" }, { path: "b.js", text: "export const x = 1;\n" }];
  assert.equal(verifyQuote(files[0].text, "return a - b;"), 2);
  assert.equal(verifyQuote(files[0].text, "return a + b;"), 0);
  assert.ok(chunk(files, 30).length >= 2);
  const gw = { calls: 0, async chat(req) {
    this.calls++;
    if (req.messages[0].content.startsWith("You read ONE PART")) return { provider: "p", model: "m", content: JSON.stringify({ summary: "math", notes: [
      { path: "a.js", line: 2, quote: "return a - b;", note: "add subtracts", severity: "high" },
      { path: "a.js", line: 9, quote: "eval(userInput)", note: "invented", severity: "high" }] }) };
    return { provider: "p", model: "m", content: "FINAL: " + req.messages[1].content };
  } };
  const r = await study(gw, { question: "bugs?", files, partSize: 100000 });
  assert.equal(r.notes.length, 1);
  assert.equal(r.dropped, 1);
  assert.match(r.answer, /a\.js:2/);
  assert.doesNotMatch(r.answer, /eval\(userInput\)/);
});

test("PC folder adapter: real files, trash, undo, and nothing outside the folder", async () => {
  const { nodeFs } = await import("../pc/agentfs.mjs");
  const os = await import("node:os"), fsp = await import("node:fs/promises"), path = await import("node:path");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mychat-agent-"));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "mychat-outside-"));
  await fsp.writeFile(path.join(dir, "a.txt"), "hello");
  await fsp.symlink(outside, path.join(dir, "escape"), "junction").catch(() => {});
  const fs = nodeFs(dir);
  const p = { id: "x1", goal: "g", ops: [{ op: "write", path: "sub/b.md", content: "B" }, { op: "delete", path: "a.txt" }] };
  const j = await apply(fs, p);
  assert.equal(j.error, undefined);
  assert.equal(await fsp.readFile(path.join(dir, `${TRASH}/x1/a.txt`), "utf8"), "hello");
  assert.ok((await undo(fs, j)).ok);
  assert.equal(await fsp.readFile(path.join(dir, "a.txt"), "utf8"), "hello");
  await assert.rejects(fs.write("escape/pwn.txt", "x"), /outside/);
  await assert.rejects(fs.read("../x"), /outside/);
  assert.equal(await fs.read("missing.txt"), null);
});

test("a new file's diff shows only added lines", () => {
  assert.deepEqual(lineDiff("", "a\nb"), ["+ a", "+ b"]);
});

test("study: the same file twice is read once, and a part that fails is retried instead of lost", async () => {
  const code = "export const a = 1;\n".repeat(50);
  const files = [{ path: "app/www/main.js", text: code }, { path: "app/MyChat-apk/assets/public/main.js", text: code }, { path: "b.js", text: "let b = 2;\n" }];
  let failOnce = true;
  const gw = { async chat(req) {
    if (req.messages[0].content.startsWith("You read ONE PART")) {
      if (failOnce) { failOnce = false; throw new Error("All models failed (3 tried)"); }
      return { provider: "p", model: "m", content: JSON.stringify({ summary: "s", notes: [{ path: "b.js", line: 1, quote: "let b = 2;", note: "n", severity: "low" }] }) };
    }
    return { provider: "p", model: "m", content: "final" };
  } };
  const r = await study(gw, { question: "q", files, partSize: 100000, retryDelayMs: 1 });
  assert.equal(r.read, 2, "duplicate skipped");
  assert.equal(r.unread, 0, "the failed part was retried");
  assert.equal(r.notes.length, 1);
});

test("workspace map says what each project is and where its code is; the agent starts from it and never repeats a call", async () => {
  const { workspaceMap, WORKSPACE_RX } = await import("../core/projects.mjs");
  const fs = memoryFs({ "Projects/MyChat-17/assets/public/main.mjs": "x", "Projects/MyChat-17/assets/public/core/agent.mjs": "y",
    "Projects/MyChat-17/assets/capacitor.config.json": JSON.stringify({ appId: "il.mychat", appName: "MyChat" }),
    "Projects/MyChat-17/kotlin/collections/a.kotlin_builtins": "z", "Projects/shop/package.json": JSON.stringify({ name: "shop", scripts: { start: "x" } }) });
  const map = await workspaceMap(fs);
  assert.match(map, /MyChat-17 — Android app \(unpacked APK, web-based\); code in Projects\/MyChat-17\/assets\/public; app id il\.mychat/);
  assert.match(map, /shop — JavaScript\/Node project/);
  for (const q of ["יש לך גישה לקבצים של הפרויקט שלי?", "review my app", "what's in Projects/shop"]) assert.ok(WORKSPACE_RX.test(q), q);
  for (const q of ["מהי בירת קנדה?", "write a poem about rain"]) assert.ok(!WORKSPACE_RX.test(q), q);
  const gw = fakeGw([{ tool: "tree", args: { path: "Projects" } }, { tool: "tree", args: { path: "Projects" } }, { final: "done" }]);
  const r = await runAgent(gw, { plan: false, goal: "look", fs });
  assert.match(gw.seen[0].messages.at(-1).content, /WORKSPACE MAP:[\s\S]*assets\/public/);
  assert.match(gw.seen[2].messages.at(-1).content, /already ran exactly this/);
  assert.equal(r.steps.length, 1);
});

test("loose JSON from models: raw newlines, code blocks inside the answer, text around it", async () => {
  const { parseJsonLoose } = await import("../core/json.mjs");
  const ans = "## Review\n\n```js\nconst a = 1;\n```\n\nDone.";
  const raw = `I have read all files.\n{"thought":"ok","final":"${ans}"}`;
  assert.equal(parseJsonLoose(raw).final, ans);
  assert.equal(parseJsonLoose('```json\n{"tool":"read","args":{"path":"a.md"}}\n```').tool, "read");
  assert.equal(parseJsonLoose('{"thought":"x","final":"line1\\nline2 with \\"quote\\"", "ops": [ {"op": "mkdir"').final, 'line1\nline2 with "quote"');
  assert.equal(parseJsonLoose("plain text"), null);
});

test("the agent's answer is checked against the files it read; a wrong citation gets one correction round", async () => {
  const fs = memoryFs({ "src/a.js": "function add(a, b) {\n  return a - b;\n}\n" });
  const gw = fakeGw([
    { tool: "read", args: { path: "src/a.js" } },
    { final: "Bug at src/a.js:9: `return a + b;` is wrong." },
    { tool: "read", args: { path: "src/a.js", from: 1, to: 3 } },
    { final: "Bug at src/a.js:2: `return a - b;` subtracts; it should use `return a + b;` instead." },
  ]);
  const r = await runAgent(gw, { plan: false, goal: "find the bug", fs });
  assert.match(gw.seen[2].messages.at(-1).content, /CHECK FAILED[\s\S]*src\/a\.js:9[\s\S]*return a \+ b/);
  assert.match(r.answer, /src\/a\.js:2/);
  assert.match(r.answer, /Checked against the files: 2 of 2/);
  assert.deepEqual(r.checked.bad, []);
});

test("out of steps mid-work: one forced final answer; broken protocol JSON is never shown as the answer", async () => {
  const fs = memoryFs({ "a.md": "hello" });
  const gw = fakeGw([{ tool: "read", args: { path: "a.md" } }, '{"thought":"more","calls":[{"tool":"read","args":{"path":"a.md"', "The file says hello."]);
  const r = await runAgent(gw, { plan: false, goal: "what does a.md say?", fs, maxSteps: 2 });
  assert.equal(r.answer, "The file says hello.");
});

test("team: a planning call goes first and its plan reaches the worker; memory of earlier tasks is shown and grows; find ranks files", async () => {
  const fs = memoryFs({ "shop/cart.js": "export function total(items) { return items.length; }\n", "shop/readme.md": "A shop.\n", "notes/x.md": "unrelated\n" });
  const mem = { lines: ["- 2026-11-01 · earlier task → the shop uses cents"], get() { return this.lines.join("\n"); }, add(l) { this.lines.push(l); } };
  const gw = fakeGw(["1. find the cart code\n2. read it", { tool: "find", args: { query: "cart total items" } }, { final: "The total is in shop/cart.js:1." }]);
  const r = await runAgent(gw, { goal: "review how the cart total is computed in my shop", fs, memory: mem });
  assert.match(gw.seen[0].messages[0].content, /You plan work/);
  assert.match(gw.seen[1].messages.at(-1).content, /PLAN FROM A PLANNING MODEL[\s\S]*find the cart code/);
  assert.match(gw.seen[1].messages.at(-1).content, /MEMORY FROM EARLIER TASKS[\s\S]*uses cents/);
  assert.match(gw.seen[2].messages.at(-1).content, /^RESULT of find[\s\S]*shop\/cart\.js/);
  assert.equal(r.steps[0].tool, "plan");
  assert.equal(mem.lines.length, 2);
});

test("one brain: a normal question streams normally; when the model asks for tools it switches to the agent", async () => {
  const { respond, TOOL_TOKEN } = await import("../core/assistant.mjs");
  const fs = memoryFs({ "notes/todo.md": "- milk\n" });
  const mk = (replies) => ({ models: { a: ["m"] }, async refreshModels() {}, providers: {}, async chat(req, opt) { const c = replies.shift(); opt?.onDelta?.(c); return { content: c, provider: "a", model: "m" }; } });
  let shown = "";
  const r1 = await respond(mk(["Paris is the capital of France."]), { messages: [{ role: "user", content: "capital of France?" }], fs, mode: "fast", onDelta: (d) => (shown += d) });
  assert.equal(shown, "Paris is the capital of France.");
  assert.notEqual(r1.mode, "agent");
  shown = "";
  const r2 = await respond(mk([TOOL_TOKEN, JSON.stringify({ tool: "read", args: { path: "notes/todo.md" } }), JSON.stringify({ final: "Your list has milk." })]),
    { messages: [{ role: "user", content: "what do I still need to buy?" }], fs, mode: "fast", onDelta: (d) => (shown += d), tools: {} });
  assert.equal(r2.mode, "agent");
  assert.ok(!shown.includes(TOOL_TOKEN), "the switch token never reaches the screen");
  assert.match(shown, /Your list has milk/);
});

test("a change 'called' as a tool becomes a proposed change, not an error", async () => {
  const fs = memoryFs({});
  const gw = fakeGw([{ tool: "write", args: { path: "notes/todo.md", content: "- milk\n" } }, { final: "Added a list." }]);
  const r = await runAgent(gw, { plan: false, goal: "make a todo", fs });
  assert.match(gw.seen[1].messages.at(-1).content, /PROPOSED change/);
  assert.equal(r.ops.length, 1);
  assert.equal(r.ops[0].path, "notes/todo.md");
  assert.equal(await fs.exists("notes/todo.md"), false, "nothing changes before approval");
});

test("tool calls written in the Hermes/Qwen XML style are understood (measured on a free 1.7B model)", async () => {
  const { parseJsonLoose } = await import("../core/json.mjs");
  assert.deepEqual(parseJsonLoose("<tool_call> <function=tree> <parameter=path> Projects/demo-app </parameter> </function> </tool_call>"),
    { tool: "tree", args: { path: "Projects/demo-app" } });
  assert.deepEqual(parseJsonLoose('<tool_call>{"name":"read","arguments":{"path":"a.js"}}</tool_call>'), { tool: "read", args: { path: "a.js" } });
});

test("an empty final answer is not accepted: the agent asks another model", async () => {
  const fs = memoryFs({ "a.txt": "hello" });
  const seenExclude = [];
  const gw = { calls: 0, async chat(req, o) {
    seenExclude.push([...(o.exclude || [])]);
    const first = !(o.exclude || []).length;
    return { content: first ? '{"final":""}' : '{"final":"The folder has a.txt (a.txt:1 says hello)."}', provider: first ? "p" : "q", model: first ? "empty-model" : "good-model" };
  } };
  const r = await runAgent(gw, { goal: "what is in my folder?", fs, plan: false, maxSteps: 6 });
  assert.match(r.answer, /a\.txt/);
  assert.deepEqual(seenExclude.at(-1), ["p:empty-model"]);
});

test("native tool calls with an empty text are taken as the agent's tool calls", async () => {
  const fs = memoryFs({ "notes.txt": "buy milk" });
  let n = 0;
  const gw = { async chat() {
    n++;
    if (n === 1) return { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"notes.txt"}' } }], provider: "p", model: "m" };
    return { content: '{"final":"notes.txt says: buy milk (notes.txt:1)"}', provider: "p", model: "m" };
  } };
  const r = await runAgent(gw, { goal: "what does notes.txt say?", fs, plan: false, maxSteps: 5 });
  assert.equal(r.steps[0].tool, "read");
  assert.match(r.answer, /buy milk/);
});

test("a project named without its extension is found: tree/read point at the real file instead of an empty folder", async () => {
  const fs = memoryFs({ "Projects/DJ-TiTo-23.8.html": "<html>decks</html>", "Projects/notes.txt": "x" });
  let n = 0, seen = "";
  const gw = { async chat(req) {
    n++;
    if (n === 1) return { content: '{"tool":"tree","args":{"path":"Projects/DJ-TiTo-23.8"}}', provider: "p", model: "m" };
    if (n === 2) seen = req.messages.at(-1).content;
    if (n === 2) return { content: '{"tool":"read","args":{"path":"Projects/DJ-TiTo-23.8.html"}}', provider: "p", model: "m" };
    return { content: '{"final":"It is one HTML file (Projects/DJ-TiTo-23.8.html:1)."}', provider: "p", model: "m" };
  } };
  const r = await runAgent(gw, { goal: "study my project DJ-TiTo-23.8", fs, plan: false, maxSteps: 5 });
  assert.match(seen, /DID YOU MEAN: Projects\/DJ-TiTo-23\.8\.html/);
  assert.match(r.answer, /HTML file/);
});

test("an answer that describes files it never opened is sent back to read them", async () => {
  const fs = memoryFs({ "P/a.json": '{"x":1}', "P/b.md": "# B", "P/c.txt": "c" });
  let n = 0, nudged = "";
  const gw = { async chat(req) {
    n++;
    if (n === 1) return { content: '{"final":"a.json defines 12 API paths, b.md documents Django 4.2 and c.txt lists secrets."}', provider: "p", model: "m" };
    if (n === 2) { nudged = req.messages.at(-1).content; return { content: '{"calls":[{"tool":"read","args":{"path":"P/a.json"}},{"tool":"read","args":{"path":"P/b.md"}},{"tool":"read","args":{"path":"P/c.txt"}}]}', provider: "p", model: "m" }; }
    return { content: '{"final":"a.json holds {\\"x\\":1}, b.md is a heading, c.txt is one letter."}', provider: "p", model: "m" };
  } };
  const r = await runAgent(gw, { goal: "study P", fs, plan: false, maxSteps: 6 });
  assert.match(nudged, /never read: a\.json, b\.md, c\.txt/);
  assert.match(r.answer, /one letter/);
});

test("edit op: an exact unique replacement on a big file, previewed as a small diff, applied and undone", async () => {
  const { checkOps, preview, apply, undo, memoryFs } = await import("../core/agent.mjs");
  const big = Array.from({ length: 12000 }, (_, i) => `line ${i + 1}`).join("\n").replace("line 9000", "for (let i = 1; i < n; i++) sum += a[i];");
  const fs = memoryFs({ "P/app.html": big });
  const { ops } = checkOps([{ op: "edit", path: "P/app.html", old: "for (let i = 1; i < n; i++)", new: "for (let i = 0; i < n; i++)", why: "off-by-one" },
                             { op: "edit", path: "P/app.html", old: "line 1", new: "x" }]);
  const pv = await preview(fs, ops);
  assert.equal(pv[0].stats.line, 9000);
  assert.ok(pv[0].diff.length < 10);
  assert.match(pv[1].label, /more than once/);
  const j = await apply(fs, { id: "e1", goal: "fix", ops: [ops[0]] }, [0]);
  assert.match(await fs.read("P/app.html"), /let i = 0; i < n/);
  assert.equal((await fs.read("P/app.html")).split("\n").length, 12000);
  await undo(fs, j);
  assert.equal(await fs.read("P/app.html"), big);
});

test("skills: the agent can search the library and load a procedure when the host provides it", async () => {
  const fs = memoryFs({ "a.js": "x" });
  let n = 0, sysText = "";
  const gw = { async chat(req) {
    n++; sysText = sysText || req.messages[0].content;
    if (n === 1) return { content: '{"tool":"skill_search","args":{"query":"code review"}}', provider: "p", model: "m" };
    if (n === 2) return { content: '{"tool":"skill_load","args":{"id":"s1"}}', provider: "p", model: "m" };
    return { content: '{"final":"Reviewed with the checklist."}', provider: "p", model: "m" };
  } };
  const skills = { search: () => "s1 · review-checklist (skill)", load: (id) => `SKILL ${id}: check inputs, errors, tests` };
  const r = await runAgent(gw, { goal: "review a.js", fs, plan: false, maxSteps: 5, skills });
  assert.match(sysText, /skill_search/);
  assert.match(r.steps[1].result, /SKILL s1/);
});

test("claims are attacked by another family and settled by a program on the files (tonight's two wrong review claims)", async () => {
  const app = ["<script>", "async function boot(ctx) {",
    "  try { await ctx.audioWorklet.addModule('forge-worklet.js'); }",
    "  catch (e) { const u = URL.createObjectURL(new Blob([WORKLET_SRC])); await ctx.audioWorklet.addModule(u); }",
    "}", "panel.innerHTML = rows.join('');", "</script>"].join("\n");
  const fs = memoryFs({ "P/app.html": app });
  let n = 0, fixMsg = "", challengerFamily = "";
  const gw = { async chat(req, o) {
    if (/hostile fact-checker/.test(req.messages[0].content)) {
      challengerFamily = o.avoidFamily;
      return { provider: "q", model: "deepseek-v4", content: JSON.stringify({ checks: [
        { claim: "the code never uses innerHTML", file: "P/app.html", pattern: "innerHTML", refuted_if: "found" },
        { claim: "without forge-worklet.js the audio engine cannot start", file: "app.html", pattern: "catch[\\s\\S]{0,200}Blob", refuted_if: "found" },
        { claim: "boot loads a worklet", file: "P/app.html", pattern: "addModule", refuted_if: "not_found" }] }) };
    }
    n++;
    if (n === 1) return { provider: "p", model: "gemini-x", content: '{"tool":"read","args":{"path":"P/app.html"}}' };
    if (n === 2) return { provider: "p", model: "gemini-x", content: JSON.stringify({ final: "Review of P/app.html: CRITICAL — without forge-worklet.js the audio engine cannot start, so the app is non-functional. Security: the code never uses innerHTML, so there is no injection risk. Overall the structure is simple and readable." }) };
    fixMsg = req.messages.at(-1).content;
    return { provider: "p", model: "gemini-x", content: JSON.stringify({ final: "Review of P/app.html: if forge-worklet.js is missing the engine falls back to a built-in copy (P/app.html:4). innerHTML is used (P/app.html:6) — check what goes into rows." }) };
  } };
  const r = await runAgent(gw, { goal: "review P/app.html", fs, plan: false, maxSteps: 8 });
  assert.equal(challengerFamily, "gemini", "the checker avoids the author's family");
  assert.match(fixMsg, /DISPROVED BY THE FILES/);
  assert.match(fixMsg, /innerHTML.*found 1×/s);
  assert.match(fixMsg, /cannot start.*found 1×.*app\.html:4/s);
  assert.doesNotMatch(fixMsg, /boot loads a worklet/, "an upheld claim is not sent back");
  assert.match(r.answer, /falls back/);
  assert.match(r.answer, /2 disproved:/); assert.match(r.answer, /✗ "the code never uses innerHTML"/);
});

test("compare: claimed vs actual between two versions (single files with different names, folders, archives)", async () => {
  const { compareVersions } = await import("../core/versions.mjs");
  const { workspaceReader, makeZipFor } = { workspaceReader: (await import("../core/agent.mjs")).workspaceReader };
  const v1 = "<script>\nfunction total(a) {\n  let s = 0;\n  for (let i = 1; i < a.length; i++) s += a[i];\n  return s;\n}\nfunction save() {\n  localStorage.x = 1;\n}\n</script>";
  const v2 = "<script>\nfunction total(a) {\n  let s = 0;\n  for (let i = 0; i < a.length; i++) s += a[i];\n  return s;\n}\nfunction exportMp3() {\n  return 1;\n}\n</script>";
  const fs = memoryFs({ "In/app-v1.html": v1, "In/app-v2.html": v2, "A/app.html": v1, "A/readme.md": "x", "B/app.html": v2, "B/new.css": "a{}" });
  const r = await compareVersions(workspaceReader(fs), "In/app-v1.html", "In/app-v2.html");
  assert.match(r.text, /REWRITTEN: function total/);
  assert.match(r.text, /NEW: function exportMp3/);
  assert.match(r.text, /REMOVED: function save/);
  const f = await compareVersions(workspaceReader(fs), "A", "B");
  assert.deepEqual(f.files.added, ["new.css"]); assert.deepEqual(f.files.removed, ["readme.md"]);
  assert.match(f.text, /CHANGED app\.html: \+3 −3 lines/);
  void makeZipFor;
});

test("citation check: inline code spans are read correctly and line ranges are citations, not quotes", async () => {
  const { checkClaims } = await import("../core/agent.mjs");
  const seen = new Map([["P/a.html", Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")]]);
  const r = await checkClaims("Uses `innerHTML` for dynamic UI updates. Evidence at `P/a.html:8`, listeners at `P/a.html:9-10`.", seen, { text: async () => null });
  assert.deepEqual(r.bad, []);
});

test("a reply in Python dict style is still understood as a tool call (measured on the PC)", async () => {
  const { parseJsonLoose } = await import("../core/json.mjs");
  assert.deepEqual(parseJsonLoose("{'thought': \"it's the review skill\", 'tool': 'skill_load', 'args': {'id': '83de42fe51', 'deep': True}}"),
    { thought: "it's the review skill", tool: "skill_load", args: { id: "83de42fe51", deep: true } });
});

test("an answer about a named file it never opened, or in the wrong language, is sent back", async () => {
  const fs = memoryFs({ "P/app.html": "<script>\nfunction f() {\n  return 1;\n}\n</script>" });
  let n = 0; const asks = [];
  const gw = { async chat(req) {
    n++; if (n > 1) asks.push(req.messages.at(-1).content);
    if (n === 1) return { provider: "p", model: "m", content: JSON.stringify({ final: "由于文件很大，审查结果：存在多个严重问题，建议重构。" }) };
    if (n === 2) return { provider: "p", model: "m", content: JSON.stringify({ final: "Review: the app has serious problems and should be split into modules." }) };
    if (n === 3) return { provider: "p", model: "m", content: '{"tool":"read","args":{"path":"P/app.html"}}' };
    return { provider: "p", model: "m", content: JSON.stringify({ final: "P/app.html has one function f (P/app.html:2) that returns 1." }) };
  } };
  const r = await runAgent(gw, { goal: "review P/app.html", fs, plan: false, maxSteps: 8, noChallenge: true });
  assert.match(asks[0], /wrong language/);
  assert.match(asks[1], /not opened P\/app\.html/);
  assert.match(r.answer, /function f/);
});

test("challenge: a check that tests something else than its claim is ignored", async () => {
  const { challenge } = await import("../core/challenge.mjs");
  const files = new Map([["P/app.html", "function a() {}\nfunction b() {}\nel.innerHTML = x;"]]);
  const gw = { async chat() { return { provider: "q", model: "m", content: JSON.stringify({ checks: [
    { claim: "The file contains 12,312 lines of JavaScript", file: "P/app.html", pattern: "function\\s+\\w+\\s*\\(", refuted_if: "found" },
    { claim: "the code never uses innerHTML", file: "P/app.html", pattern: "innerHTML", refuted_if: "found" }] }) }; } };
  const r = await challenge(gw, { answer: "x".repeat(200), files, by: "p:gemini-x" });
  assert.equal(r.tried, 1);
  assert.deepEqual(r.refuted.map((x) => x.claim), ["the code never uses innerHTML"]);
});

test("look: the run screenshot is shown to a vision model; the screen only when the person asked about it", async () => {
  const fs = memoryFs({ "P/app.html": "<button>Go</button>" });
  const calls = [];
  const mk = (goal) => { let n = 0; return { gw: { async chat() { n++;
    if (n === 1) return { provider: "p", model: "m", content: '{"calls":[{"tool":"run_page","args":{"path":"P/app.html"}}]}' };
    if (n === 2) return { provider: "p", model: "m", content: '{"calls":[{"tool":"look","args":{"image":"last_run","question":"is the Go button visible?"}},{"tool":"look","args":{"image":"screen"}}]}' };
    return { provider: "p", model: "m", content: '{"final":"done"}' }; } }, goal }; };
  const see = async (img, q) => { calls.push(img); return `SEEN ${img}: ${q}`; };
  const runPage = async () => ({ text: "RAN", shots: ["/runs/a-loaded.png", "/runs/a-after.png"] });
  const a = mk("check my app P/app.html");
  const r = await runAgent(a.gw, { goal: a.goal, fs, plan: false, maxSteps: 5, runPage, see, noChallenge: true });
  assert.deepEqual(calls, ["/runs/a-after.png"], "the screen was NOT looked at: the person did not ask");
  assert.match(r.steps.find((x) => x.tool === "look" && x.args.image === "screen").result, /Not allowed/);
  calls.length = 0;
  const b = mk("look at my screen and check my app P/app.html");
  await runAgent(b.gw, { goal: b.goal, fs, plan: false, maxSteps: 5, runPage, see, noChallenge: true });
  assert.deepEqual(calls.sort(), ["/runs/a-after.png", "screen"]);
});

test("citation check: web addresses with ports are not file citations", async () => {
  const { checkClaims } = await import("../core/agent.mjs");
  const r = await checkClaims("The gateway is at http://127.0.0.1:11500 and Kestrel at 127.0.0.1:8765; config.json:2 sets the port.", new Map([["config.json", "{\n \"port\": 1\n}"]]), { text: async () => null });
  assert.deepEqual(r.bad, []);
  assert.equal(r.total, 1);
});

test("AGENTS.md at the workspace root is given to the agent first; the git and github tools appear only when provided", async () => {
  const fs = memoryFs({ "AGENTS.md": "Repos live in repos/<name>. Use the github tool for live state.", "repos/app/a.txt": "x" });
  const gw = fakeGw([{ final: "ok" }]);
  await runAgent(gw, { plan: false, goal: "what changed on GitHub?", fs, noChallenge: true, gitRead: async () => "", githubRead: async () => "" });
  const first = gw.seen[0].messages.map((m) => m.content).join("\n");
  assert.match(first, /OWNER'S GUIDE FOR AGENTS[\s\S]*Repos live in repos\/<name>/);
  assert.match(first, /\bgit \{"repo"/); assert.match(first, /\bgithub \{"path"/);
  const gw2 = fakeGw([{ final: "ok" }]);
  await runAgent(gw2, { plan: false, goal: "hi there, look", fs: memoryFs({ "a.txt": "x" }), noChallenge: true });
  const plain = gw2.seen[0].messages.map((m) => m.content).join("\n");
  assert.doesNotMatch(plain, /OWNER'S GUIDE|\bgithub \{"path"/);
});

test("agent prefers the measured models (plan and work), never for private folders, and asks again when a Hebrew request gets an English answer", async () => {
  const seen = [];
  const gw = { async chat(req, opt) { seen.push(opt); const n = seen.length;
    const c = n === 1 ? "1. look" : n === 2 ? { final: "The repository has three branches and the default is main, which is protected by our gate." } : { final: "במאגר יש שלושה ענפים, וברירת המחדל היא main." };
    return { content: typeof c === "string" ? c : JSON.stringify(c), provider: "groq", model: "big" }; } };
  const r = await runAgent(gw, { goal: "תסדר ותבדוק כמה ענפים יש במאגר ומה ברירת המחדל שלו, ותסביר בפירוט את המצב", fs: memoryFs({ "a.txt": "x" }), noChallenge: true,
    models: { plan: "nvidia:strong-plan", work: ["groq:big", "zai:other"] } });
  assert.equal(seen[0].prefer, "nvidia:strong-plan");
  assert.equal(seen[1].prefer, "groq:big");
  assert.match(r.answer, /שלושה ענפים/);
  const seen2 = [];
  const gw2 = { async chat(req, opt) { seen2.push(opt); return { content: JSON.stringify({ final: "ok" }), provider: "local", model: "x" }; } };
  await runAgent(gw2, { plan: false, goal: "list", fs: memoryFs({ "a.txt": "x" }), noChallenge: true, privateData: true, models: { plan: "groq:big", work: ["groq:big"] } });
  assert.equal(seen2[0].prefer, undefined);
});
