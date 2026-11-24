import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const url = "http://127.0.0.1:3000";
const candidates = [".", "claude-hunter-pro-main", "claude-hunter-pro-main/claude-hunter-pro-main"];
const root = candidates.map(p => path.resolve(p)).find(p => {
  try { return JSON.parse(fs.readFileSync(path.join(p, "package.json"))).name === "claude-hunter-pro"; }
  catch { return false; }
});
if (!root) throw new Error("Choose the Hunter project or its Projects folder.");
const next = path.join(root, "node_modules/next/dist/bin/next");
if (!fs.existsSync(next)) throw new Error("Hunter dependencies are missing from " + root);
async function ready() {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500), redirect: "manual" });
    return r.ok && /<title>Claude Hunter/i.test(await r.text());
  } catch { return false; }
}
const listening = await new Promise(resolve => {
  const s = net.connect(3000, "127.0.0.1");
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("error", () => resolve(false));
});
let child;
if (!listening) {
  const log = fs.openSync(path.join(root, "hunter-local.stdout.log"), "a");
  try {
    child = spawn(process.execPath, ["--max-old-space-size=2048", next, "dev", "-H", "127.0.0.1", "-p", "3000"], {
      cwd: root, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, detached: true, windowsHide: true, stdio: ["ignore", log, log]
    });
    child.unref();
  } finally { fs.closeSync(log); }
}
let verified = false;
const deadline = Date.now() + 125000;
while (Date.now() < deadline) {
  if (await ready()) { console.log("Verified Claude Hunter page: " + url); verified = true; break; }
  if (child && child.exitCode !== null) break;
  await delay(1500);
}
if (!verified) throw new Error("Hunter homepage did not pass verification on port 3000. See hunter-local.stdout.log in " + root);


