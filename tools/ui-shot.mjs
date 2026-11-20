// Real-use check of the phone UI in headless Chrome (390×844), with the AI providers replaced by a scripted fake world.
// node tools/ui-shot.mjs <scenario> <out-prefix>
// Scenarios exercise what the person actually does: type, send, switch modes, read the answer — then screenshots.
import { spawn } from "node:child_process";
import fs from "node:fs";
const [scenario = "quota", out = "/tmp/shot"] = process.argv.slice(2);
const port = 5180 + Math.floor(Math.random() * 50), dbg = 9400 + Math.floor(Math.random() * 50);
const srv = spawn("node", ["app/scripts/serve.mjs"], { env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
// --remote-debugging-pipe: no WebSocket (Node's WebSocket goes through the HTTP proxy in some sandboxes and never opens)
const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--remote-debugging-pipe", "--lang=en-US", "about:blank"],
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bye = (c) => { chrome.kill("SIGKILL"); srv.kill(); process.exit(c); };
let id = 0, buf = "", session = null; const pend = new Map(); const logs = [];
chrome.stdio[4].on("data", (chunk) => {
  buf += chunk; let i;
  while ((i = buf.indexOf("\0")) >= 0) {
    const d = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === "Runtime.consoleAPICalled") logs.push(d.params.type + ": " + d.params.args.map((a) => a.value ?? a.description).join(" "));
    if (d.method === "Runtime.exceptionThrown") logs.push("EXCEPTION: " + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
  }
});
const raw = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pend.set(i, r); chrome.stdio[3].write(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0"); });
const send = (method, params = {}) => raw(method, params, session);
let target = null;
for (let i = 0; i < 100 && !target; i++) { const t = await raw("Target.getTargets"); target = t.result?.targetInfos?.find((x) => x.type === "page"); if (!target) await sleep(200); }
if (!target) { console.error("no chrome page"); bye(2); }
session = (await raw("Target.attachToTarget", { targetId: target.targetId, flatten: true })).result.sessionId;
const ev = async (expression) => { const r = (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result; if (r?.exceptionDetails) console.log("EVAL ERROR:", r.exceptionDetails.exception?.description?.slice(0, 200)); return r?.result?.value; };
const shot = async (name) => { const s = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(`${out}-${name}.png`, Buffer.from(s.result.data, "base64")); console.log("shot", `${out}-${name}.png`); };
await send("Runtime.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

// The fake world. Providers answer like the real ones (SSE chunks, Google's 429 JSON, 503s).
const FAKE = fs.readFileSync(new URL("./fake-world.js", import.meta.url), "utf8");
await send("Page.addScriptToEvaluateOnNewDocument", { source: FAKE });
const base = `http://127.0.0.1:${port}/`;
await send("Page.navigate", { url: base });
await sleep(1500);
const mode = scenario === "max" ? "max" : "auto";
await ev(`localStorage.clear(); localStorage.setItem("fake.scenario", ${JSON.stringify(scenario)}); localStorage.setItem("mychat.mode", "${mode}");
  localStorage.setItem("mychat.onboarded", "1");
  ${scenario === "stale" ? `localStorage.setItem("mychat.stats", JSON.stringify({ "pollinations|openai": { ok: 0, fail: 3, ttft: null, tps: null, cooldownUntil: 0, lastError: "Failed to fetch", day: "", today: 0, at: Date.now() - 3600e3 } }));` : ""}
  true`);
await send("Page.reload"); await sleep(2000); console.error("reloaded");
// a Gemini key, as on the phone in the screenshot (+ Groq in the "max" scenario, so a second family exists)
await ev(`(async () => { const m = await import("./engine.mjs"); await m.setKey("gemini", "AIzaSyFAKE-for-ui-test-000000000000000"); ${scenario === "max" ? `await m.setKey("groq", "gsk_FAKEfakeFAKEfakeFAKEfakeFAKEfakeFAKEfake0000000000");` : ""} return true; })()`);
await send("Page.reload"); await sleep(2000); console.error("reloaded");
await shot("0-start");
const results = {}, fails = [];
const expect = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) fails.push(what); };
const ask = async (text, name, waitMs = 30000) => {
  await ev(`(() => { const i = document.querySelector("#msg"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("#sendForm").requestSubmit(); return true; })()`);
  await sleep(700); await shot(name + "-live");
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) { if (await ev(`!document.querySelector("#sendBtn").classList.contains("stop")`)) break; await sleep(300); }
  await sleep(400); await shot(name);
  const r = { answer: await ev(`[...document.querySelectorAll("#messages .msg.bot")].pop()?.innerText || ""`),
    who: await ev(`[...document.querySelectorAll("#messages .who")].pop()?.innerText || ""`),
    error: await ev(`[...document.querySelectorAll("#messages .errcard")].pop()?.innerText || ""`), calls: await ev(`__S.calls.length`) };
  results[name] = r;
  console.log(name, "→", JSON.stringify(r.answer.slice(0, 200)), "| who:", JSON.stringify(r.who), "| error:", JSON.stringify(r.error.slice(0, 200)));
  return r;
};
if (scenario === "max") {
  const r = await ask("write a python function that sums a list, with a loop", "1-code");
  expect(/^Max · drafted \+ reviewed: 1 fixed/.test(r.who), "Max drafts, gets a review from another family, fixes what it found");
  expect(/range\(len\(xs\)\):/.test(r.answer) && !/len\(xs\) - 1/.test(r.answer), "the answer shown is the fixed one");
}
else if (scenario === "agent") {
  await ev(`(async () => { const f = await import("./files.mjs"); const fs = await f.workspace(); await fs.write("Inbox/notes.txt", "TODO release notes\\nTODO icons\\nTODO store page\\ndone: build\\ndone: tests\\ndone: docs\\ndone: keys\\n"); return fs.kind; })()`).then((k) => console.log("workspace", k));
  await ev(`document.querySelector('[data-view="agent"], #tab-agent, nav button:nth-child(2)').click(), true`); await sleep(800);
  await ev(`(() => { const g = document.querySelector("textarea.goal"); g.value = "Summarise Inbox/notes.txt and save the summary"; [...document.querySelectorAll("button")].find((b) => b.textContent === "Start").click(); return true; })()`);
  await sleep(900); await shot("1-agent-live");
  const t0 = Date.now(); while (Date.now() - t0 < 30000) { if (await ev(`![...document.querySelectorAll("button")].some((b) => b.textContent === "Stop")`)) break; await sleep(300); }
  await sleep(500); await shot("1-agent");
  await ev(`document.querySelector("details.work")?.setAttribute("open", ""), document.querySelector(".opsbox")?.scrollIntoView(), true`); await sleep(300); await shot("2-agent-steps");
  // approve → the file exists; undo → it is gone again (the promise: nothing changes without you, everything can be undone)
  const exists = `(async () => { const f = await import("./files.mjs"); const fs = await f.workspace(); try { return (await fs.read("Inbox/summary.md")).slice(0, 40); } catch { return "(none)"; } })()`;
  const before = await ev(exists);
  await ev(`[...document.querySelectorAll("button")].find((b) => b.textContent === "Approve and apply").click(), true`); await sleep(1500);
  const applied = await ev(exists);
  await shot("3-applied");
  await ev(`[...document.querySelectorAll("button")].find((b) => b.textContent === "Undo").click(), true`); await sleep(1500);
  const undone = await ev(exists);
  expect(before === "(none)" && /# Summary/.test(applied) && undone === "(none)", "agent: nothing changes before approval, approve writes the file, Undo removes it");
  expect(await ev(`document.querySelectorAll(".timeline .tl.tool").length >= 4`), "agent: steps shown as a readable timeline");
}
else {
  const a = await ask("היי", "1-hi"), b = await ask("compare option A and option B for me", "2-chat");
  if (scenario === "dead") {
    expect(/^Couldn't get an answer/.test(a.error) && !/[{}]/.test(a.error), "nothing works: a plain-words error card, no raw JSON");
    expect(/free no-key channels/.test(b.error), "the card says which accounts failed and why");
  } else {
    expect(/היי|שלום/.test(a.answer), "Hebrew greeting answered although the Google account is out of quota");
    expect(/^Auto · quick answer/.test(a.who), "label: the chosen mode + what it did (quick answer)");
    expect(/Option/.test(b.answer) && /^Auto · best model/.test(b.who), "a second question also answered, labelled truthfully");
  }
}
if (logs.length) console.log("CONSOLE:\n" + logs.slice(-12).join("\n"));
const exc = logs.filter((l) => l.startsWith("EXCEPTION"));
expect(!exc.length, "no uncaught exceptions in the page");
console.log(fails.length ? `${fails.length} FAILED` : "ALL PASSED");
bye(fails.length ? 1 : 0);
