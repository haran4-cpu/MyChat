// Minimal CDP driver: open a URL in headless Chrome, poll an expression until truthy, print it, screenshot.
import { spawn } from "node:child_process";
import fs from "node:fs";
const [url, expr, shot, timeoutMs = "30000"] = process.argv.slice(2);
const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--remote-debugging-port=9333", "--window-size=390,844", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 150; i++) { try { const l = await (await fetch("http://127.0.0.1:9333/json")).json(); const p = l.find((x) => x.type === "page"); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } catch {} await sleep(200); }
if (!ws) { console.error("Chrome did not start within 30 s"); chrome.kill(); process.exit(2); }
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pend = new Map(); const logs = [];
ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  if (d.method === "Runtime.consoleAPICalled") logs.push(d.params.type + ": " + d.params.args.map((a) => a.value ?? a.description).join(" "));
  if (d.method === "Runtime.exceptionThrown") logs.push("EXCEPTION: " + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text)); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send("Page.navigate", { url });
const t0 = Date.now(); let val = null;
while (Date.now() - t0 < Number(timeoutMs)) { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true }); val = r.result?.result?.value; if (val) break; await sleep(300); }
console.log("RESULT:", JSON.stringify(val));
if (logs.length) console.log("CONSOLE:\n" + logs.slice(-15).join("\n"));
if (shot) { const s = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(shot, Buffer.from(s.result.data, "base64")); }
chrome.kill("SIGKILL"); process.exit(0);
