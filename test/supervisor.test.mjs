import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sup-"));
process.env.MYCHAT_HOME = home;
const sup = await import("../pc/supervisor.mjs");

function svc(status = 200, body = "{}") {
  const s = http.createServer((q, r) => { r.writeHead(s.status); r.end(s.body); });
  s.status = status; s.body = body;
  return new Promise((ok) => s.listen(0, "127.0.0.1", () => ok(s)));
}

test("starts a service that is down, waits while it boots, backs off after 3 failed starts", async () => {
  let starts = 0, t = 1_000_000;
  const s = { id: "x", name: "x", url: "http://127.0.0.1:9/health", graceSec: 30, start: () => (starts++, true) };
  await sup.checkOnce([s], () => t);
  assert.equal(starts, 1);
  t += 10_000; await sup.checkOnce([s], () => t);
  assert.equal(starts, 1, "still inside its boot grace period");
  t += 31_000; await sup.checkOnce([s], () => t);
  t += 31_000; await sup.checkOnce([s], () => t);
  t += 31_000; await sup.checkOnce([s], () => t);
  assert.equal(starts, 3, "three tries, then back-off");
});

test("reloads on new code, but waits while the service is busy", async () => {
  const srv = await svc(200, '{"busy": true}');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-"));
  const f = path.join(dir, "a.py"); fs.writeFileSync(f, "1");
  let starts = 0, stops = 0;
  const s = { id: "k", name: "k", url: `http://127.0.0.1:${srv.address().port}/api/status`, port: 1, graceSec: 5, watch: () => [f],
    idle: (b) => !JSON.parse(b).busy, start: () => (starts++, true), stop: async () => { stops++; } };
  await sup.checkOnce([s]);
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));       // new code arrives
  await sup.checkOnce([s]);
  assert.equal(stops, 0, "busy: not interrupted");
  srv.body = '{"busy": false}';
  await sup.checkOnce([s]);
  assert.equal((stops, starts), 1, "idle: reloaded once");
  srv.close();
});

test("update map: code goes to the right folder; settings, keys and paths outside are never touched", () => {
  assert.equal(sup.localPathFor("core/router.mjs"), path.join(path.resolve("."), "core", "router.mjs"));
  assert.match(sup.localPathFor("kestrel/kestrel/llm.py"), /Kestrel[\\/]kestrel[\\/]llm\.py$/);
  for (const p of ["kestrel/config.json", "README.md", "app/www/main.mjs", "core/../../evil.mjs", ".github/workflows/test.yml",
                   "kestrel/kestrel/__pycache__/llm.cpython-313.pyc", "kestrel/tests/__pycache__/x.pyc"])
    assert.equal(sup.localPathFor(p), null, p);
});

test("update installs only a commit whose CI passed, verifies every file, and backs up what it replaces", async () => {
  const blobOf = (b) => crypto.createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
  let body = Buffer.from("export const v = 1;\n"), head = "abc1234";
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  let ci = [{ name: "engine", status: "completed", conclusion: "failure" }];
  const fetchImpl = async (u) => {
    if (u.endsWith("/commits/main")) return json({ sha: head });
    if (u.includes("/check-runs")) return json({ check_runs: ci });
    if (u.includes("/git/trees/")) return json({ tree: [{ type: "blob", path: "core/zz_test.mjs", sha: blobOf(body) }] });
    if (u.includes("raw.githubusercontent.com")) return new Response(body);
    return new Response("?", { status: 404 });
  };
  await assert.rejects(sup.update({ fetchImpl }), /CI engine=failure/);
  ci = [{ name: "engine", status: "completed", conclusion: "success" }];
  const target = sup.localPathFor("core/zz_test.mjs");
  fs.rmSync(target, { force: true });
  try {
    const first = await sup.update({ fetchImpl });                       // new file: installed and recorded
    assert.equal(first.installed, true);
    assert.equal(fs.readFileSync(target, "utf8"), body.toString());
    body = Buffer.from("export const v = 2;\n"); head = "def5678";
    fs.writeFileSync(target, "export const v = 1;\r\n");               // CRLF only: still what was installed
    const r = await sup.update({ fetchImpl });
    assert.equal(r.installed, true);
    assert.equal(fs.readFileSync(target, "utf8"), body.toString());
    assert.ok(fs.readdirSync(path.join(home, "backups")).length >= 1);
    const again = await sup.update({ fetchImpl });
    assert.deepEqual(again.changed, [], "already up to date");
  } finally { fs.rmSync(target, { force: true }); }
});

test("update never silently overwrites a file edited on this PC: blocks, keeps it on request, or overwrites with a backup", async () => {
  const blobOf = (b) => crypto.createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
  let body = Buffer.from("export const w = 1;\n"), head = "aaa1111";
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  const fetchImpl = async (u) => {
    if (u.endsWith("/commits/main")) return json({ sha: head });
    if (u.includes("/check-runs")) return json({ check_runs: [{ name: "t", status: "completed", conclusion: "success" }] });
    if (u.includes("/git/trees/")) return json({ tree: [{ type: "blob", path: "core/zz_edit.mjs", sha: blobOf(body) }] });
    if (u.includes("raw.githubusercontent.com")) return new Response(body);
    return new Response("?", { status: 404 });
  };
  const target = sup.localPathFor("core/zz_edit.mjs");
  fs.rmSync(target, { force: true });
  try {
    await sup.update({ fetchImpl });
    const mine = "export const w = 1; // my PC edit\n";
    fs.writeFileSync(target, mine);
    body = Buffer.from("export const w = 2;\n"); head = "bbb2222";
    const check = await sup.update({ fetchImpl, dryRun: true });
    assert.deepEqual(check.localEdits, ["core/zz_edit.mjs"]);
    const blocked = await sup.update({ fetchImpl });
    assert.equal(blocked.installed, false);
    assert.match(blocked.blocked, /edited on this PC/);
    assert.equal(fs.readFileSync(target, "utf8"), mine);
    const kept = await sup.update({ fetchImpl, keepLocal: true });
    assert.deepEqual(kept.kept, ["core/zz_edit.mjs"]);
    assert.equal(fs.readFileSync(target, "utf8"), mine, "local edit kept");
    assert.equal(fs.readFileSync(path.join(kept.pending, "core", "zz_edit.mjs"), "utf8"), body.toString(), "GitHub copy saved for review");
    assert.deepEqual((await sup.update({ fetchImpl, dryRun: true })).localEdits, ["core/zz_edit.mjs"], "still flagged later");
    const forced = await sup.update({ fetchImpl, force: true });
    assert.equal(fs.readFileSync(target, "utf8"), body.toString());
    assert.equal(fs.readFileSync(path.join(forced.backup, path.relative(path.parse(target).root, target)), "utf8"), mine, "backed up first");
    assert.deepEqual((await sup.update({ fetchImpl, dryRun: true })).localEdits, []);
  } finally { fs.rmSync(target, { force: true }); }
});

test("a service already running on old code is reloaded once it is idle; one that reports a fresh start is left alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code2-"));
  const f = path.join(dir, "a.py"); fs.writeFileSync(f, "1");
  const old = await svc(200, JSON.stringify({ busy: false, started_at: (Date.now() - 3600e3) / 1000 }));   // started an hour before the code
  const fresh = await svc(200, JSON.stringify({ busy: false, started_at: (Date.now() + 5000) / 1000 }));
  let reloads = { old: 0, fresh: 0 };
  const mk = (id, srv) => ({ id, name: id, url: `http://127.0.0.1:${srv.address().port}/api/status`, port: 1, graceSec: 5, watch: () => [f],
    idle: (b) => !JSON.parse(b).busy, start: () => (reloads[id]++, true) });
  await sup.checkOnce([mk("old", old), mk("fresh", fresh)]);
  await sup.checkOnce([mk("old", old), mk("fresh", fresh)]);
  assert.deepEqual(reloads, { old: 1, fresh: 0 });
  old.close(); fresh.close();
});

test("private repo: updates send the saved key, download through the API, and explain a missing key", async () => {
  const blobOf = (b) => crypto.createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
  const body = Buffer.from("export const p = 1;\n"), seen = [];
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  const fetchImpl = async (u, o = {}) => {
    seen.push({ u, auth: o.headers?.Authorization, accept: o.headers?.Accept });
    if (!o.headers?.Authorization) return new Response("{}", { status: 404 });
    if (u.endsWith("/commits/main")) return json({ sha: "ccc3333" });
    if (u.includes("/check-runs")) return json({ check_runs: [{ name: "t", status: "completed", conclusion: "success" }] });
    if (u.includes("/git/trees/")) return json({ tree: [{ type: "blob", path: "core/zz_priv.mjs", sha: blobOf(body) }] });
    if (u.includes("/git/blobs/")) return new Response(body);
    return new Response("?", { status: 404 });
  };
  await assert.rejects(sup.update({ fetchImpl, githubToken: null }), /private; save a GitHub key/);
  const target = sup.localPathFor("core/zz_priv.mjs");
  fs.rmSync(target, { force: true });
  try {
    const r = await sup.update({ fetchImpl, githubToken: "github_pat_test" });
    assert.equal(r.installed, true);
    assert.equal(fs.readFileSync(target, "utf8"), body.toString());
    const dl = seen.find((s) => s.u.includes("/git/blobs/"));
    assert.equal(dl.auth, "Bearer github_pat_test");
    assert.equal(dl.accept, "application/vnd.github.raw");
    assert.ok(!seen.some((s) => s.u.includes("raw.githubusercontent.com")));
  } finally { fs.rmSync(target, { force: true }); }
});

test("saving the update key: format checked, verified against GitHub, stored only when it can read the repo", async () => {
  const stored = [];
  const write = async (t, k) => (stored.push([t, k]), true);
  assert.equal((await sup.saveGithubKey("hello", { write })).ok, false);
  const no = await sup.saveGithubKey("github_pat_" + "x".repeat(30), { write, fetchImpl: async () => new Response("{}", { status: 404 }) });
  assert.equal(no.ok, false); assert.match(no.error, /cannot read/); assert.equal(stored.length, 0);
  const yes = await sup.saveGithubKey("github_pat_" + "y".repeat(30), { write, fetchImpl: async () => new Response("{}", { status: 200 }) });
  assert.equal(yes.ok, true); assert.equal(JSON.stringify(yes).includes("yyyy"), false, "key is never echoed");
  assert.deepEqual(stored, [[sup.GITHUB_CREDENTIAL, "github_pat_" + "y".repeat(30)]]);
});

test("MyChat reloads new code only when idle (no sign-in, request or job), and at most 15 minutes late", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code3-"));
  const f = path.join(dir, "s.mjs"); fs.writeFileSync(f, "1");
  const busy = await svc(200, JSON.stringify({ busy: true, why: ["ChatGPT sign-in in progress"], startedAt: Date.now() - 3600e3 }));
  let t = Date.now(), reloads = 0;
  const s = { id: "gw", name: "gw", url: `http://127.0.0.1:${busy.address().port}/health`, port: 1, graceSec: 5, watch: () => [f],
    idle: (b) => !JSON.parse(b).busy, maxWaitMs: 15 * 60e3, start: () => (reloads++, true) };
  await sup.checkOnce([s], () => t);
  t += 60e3; await sup.checkOnce([s], () => t);
  assert.equal(reloads, 0, "busy: waits");
  t += 16 * 60e3; await sup.checkOnce([s], () => t);
  assert.equal(reloads, 1, "overdue: reloads anyway");
  busy.close();
});
