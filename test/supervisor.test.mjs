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
  for (const p of ["kestrel/config.json", "README.md", "app/www/main.mjs", "core/../../evil.mjs", ".github/workflows/test.yml"])
    assert.equal(sup.localPathFor(p), null, p);
});

test("update installs only a commit whose CI passed, verifies every file, and backs up what it replaces", async () => {
  const body = Buffer.from("export const v = 2;\n");
  const blob = crypto.createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  let ci = [{ name: "engine", status: "completed", conclusion: "failure" }];
  const fetchImpl = async (u) => {
    if (u.endsWith("/commits/main")) return json({ sha: "abc1234" });
    if (u.includes("/check-runs")) return json({ check_runs: ci });
    if (u.includes("/git/trees/")) return json({ tree: [{ type: "blob", path: "core/zz_test.mjs", sha: blob }] });
    if (u.includes("raw.githubusercontent.com")) return new Response(body);
    return new Response("?", { status: 404 });
  };
  await assert.rejects(sup.update({ fetchImpl }), /CI engine=failure/);
  ci = [{ name: "engine", status: "completed", conclusion: "success" }];
  const target = sup.localPathFor("core/zz_test.mjs");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "export const v = 1;\n");
  try {
    const r = await sup.update({ fetchImpl });
    assert.equal(r.installed, true);
    assert.equal(fs.readFileSync(target, "utf8"), body.toString());
    assert.ok(fs.readdirSync(path.join(home, "backups")).length === 1);
    const again = await sup.update({ fetchImpl });
    assert.deepEqual(again.changed, [], "already up to date");
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
