import { test } from "node:test";
import assert from "node:assert/strict";
import { readCredential } from "../pc/wincred.mjs";

test("credential reader: target goes over stdin, secret comes back in memory; nothing on other platforms or bad input", async () => {
  let seen = null;
  const exec = (cmd, args, opts, cb) => {
    const stdin = { end: (t) => { seen = { cmd, t, inArgs: args.join(" ").includes("mytarget") }; cb(null, "tok-123\n"); } };
    return { stdin };
  };
  assert.equal(await readCredential("mytarget", { exec, platform: "win32" }), "tok-123");
  assert.equal(seen.cmd, "powershell.exe");
  assert.equal(seen.t, "mytarget\n");
  assert.equal(seen.inArgs, false, "target is not put on the command line");
  assert.equal(await readCredential("mytarget", { exec, platform: "linux" }), null);
  assert.equal(await readCredential("a\nb", { exec, platform: "win32" }), null);
  assert.equal(await readCredential("", { exec, platform: "win32" }), null);
  const missing = (c, a, o, cb) => ({ stdin: { end: () => cb(Object.assign(new Error("x"), { code: 3 }), "") } });
  assert.equal(await readCredential("nothere", { exec: missing, platform: "win32" }), null);
});
