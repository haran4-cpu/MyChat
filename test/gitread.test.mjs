import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitReader, githubReader } from "../pc/gitread.mjs";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "gitread-"));
const repo = path.join(ws, "proj");
fs.mkdirSync(repo);
const g = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.com", ...a]);
g("init", "-q", "-b", "main"); fs.writeFileSync(path.join(repo, "a.txt"), "one\n"); g("add", "."); g("commit", "-qm", "first");
fs.writeFileSync(path.join(repo, "a.txt"), "two\n"); g("commit", "-qam", "second");

test("git reader: real read commands work inside the workspace", async () => {
  const git = gitReader(ws);
  assert.match(await git("proj", ["log", "--oneline"]), /second[\s\S]*first/);
  assert.match(await git("proj", ["show", "--stat", "HEAD"]), /a\.txt/);
  assert.match(await git("proj", ["diff", "HEAD~1", "HEAD"]), /-one\n\+two/);
  assert.match(await git("proj", ["log", "-p", "-1"]), /\+two/);
  assert.match(await git("proj", ["branch", "-a"]), /main/);
});

test("git reader: anything that writes, runs programs or leaves the workspace is refused", async () => {
  const git = gitReader(ws);
  const before = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString();
  for (const args of [["commit", "-m", "x"], ["push"], ["checkout", "main"], ["reset", "--hard"], ["config", "user.name", "x"], ["branch", "-D", "main"],
                      ["log", "--output=/tmp/x"], ["diff", "--ext-diff"], ["tag", "-d", "v1"], ["remote", "add", "x", "y"], ["stash", "drop"], ["worktree", "add", "x"]]) {
    assert.match(await git("proj", args), /not allowed|only read/, args.join(" "));
  }
  assert.match(await git("../..", ["log"]), /inside the workspace/);
  assert.match(await git("proj", "log"), /give args as a list/);
  assert.equal(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString(), before, "nothing changed");
});

test("github reader: GET only, only the configured account, compact output", async () => {
  const seen = [];
  const fetchImpl = async (u, o) => { seen.push({ u, o }); return new Response(JSON.stringify([{ sha: "abc", html_url: "x", commit: { message: "m" } }]), { status: 200 }); };
  const gh = githubReader({ owner: "acme", token: "t0k", fetchImpl });
  const out = await gh("/repos/acme/app/commits?per_page=5");
  assert.match(out, /"sha":"abc"/); assert.doesNotMatch(out, /html_url/);
  assert.equal(seen[0].o.headers.Authorization, "Bearer t0k"); assert.equal(seen[0].o.method, undefined);
  assert.match(await gh("/repos/other/app/commits"), /only GET/);
  assert.match(await gh("/user"), /only GET/);
  assert.match(await gh("https://evil.example/repos/acme/x"), /only GET/);
  assert.match(await githubReader({ owner: "acme", token: null, fetchImpl })("/repos/acme/app"), /no read key/);
  assert.equal(seen.length, 1);
});
