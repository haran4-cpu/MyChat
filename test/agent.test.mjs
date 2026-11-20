import { test } from "node:test";
import assert from "node:assert/strict";
import { safeRel, checkOps, plan, preview, apply, undo, memoryFs, lineDiff, tree, TRASH } from "../core/agent.mjs";

const fakeGw = (replies) => {
  const seen = [];
  return { seen, async chat(req) { seen.push(req); const c = replies.shift(); return { content: typeof c === "string" ? c : JSON.stringify(c), provider: "p", model: "m" }; } };
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
    { read: ["notes/todo.md"] },
    { summary: "Add bread, archive docs, remove old.txt", ops: [
      { op: "write", path: "notes/todo.md", content: "- milk\n- eggs\n- bread\n", why: "asked" },
      { op: "mkdir", path: "archive" },
      { op: "move", path: "docs", to: "archive/docs" },
      { op: "delete", path: "old.txt" },
      { op: "write", path: "new/readme.md", content: "# hi" },
      { op: "write", path: "../escape.txt", content: "no" }] },
  ]);
  const p = await plan(gw, { goal: "add bread to my todo, archive docs, remove old.txt", fs });
  assert.deepEqual(p.reads, ["notes/todo.md"]);
  assert.match(gw.seen[1].messages.at(-1).content, /- milk/, "the file it asked for was shown");
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

test("a plan that is not JSON is an error, not a silent no-op", async () => {
  await assert.rejects(plan(fakeGw(["sorry I can't"]), { goal: "x", fs: memoryFs() }), /not valid JSON/);
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
