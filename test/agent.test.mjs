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
  const p = await plan(gw, { goal: "add bread to my todo, archive docs, remove old.txt", fs });
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
  const r = await plan(fakeGw(["The folder is empty."]), { goal: "x", fs: memoryFs() });
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
  const r = await runAgent(gw, { goal: "what is this?", fs, onStep: (s) => steps.push(s) });
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
  const r = await runAgent(gw, { goal: "look", fs });
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
  const r = await runAgent(gw, { goal: "find the bug", fs });
  assert.match(gw.seen[2].messages.at(-1).content, /CHECK FAILED[\s\S]*src\/a\.js:9[\s\S]*return a \+ b/);
  assert.match(r.answer, /src\/a\.js:2/);
  assert.match(r.answer, /Checked against the files: 2 of 2/);
  assert.deepEqual(r.checked.bad, []);
});
