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

test("credential writer: target and secret go over stdin only; refuses bad input and other platforms", async () => {
  const { writeCredential } = await import("../pc/wincred.mjs");
  let seen;
  const exec = (cmd, args, opts, cb) => ({ stdin: { end: (t) => { seen = { t, inArgs: args.join(" ").includes("s3cret") }; cb(null, "ok"); } } });
  assert.equal(await writeCredential("MyChat/x", "s3cret", { exec, platform: "win32" }), true);
  assert.equal(seen.t, "MyChat/x\ns3cret\n"); assert.equal(seen.inArgs, false);
  assert.equal(await writeCredential("MyChat/x", "a\nb", { exec, platform: "win32" }), false);
  assert.equal(await writeCredential("MyChat/x", "s", { exec, platform: "linux" }), false);
});
