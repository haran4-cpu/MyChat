// Live evaluation: the real engine against real models (no mocks), on tasks like the ones that failed on the phone.
// Runs on GitHub's servers (they can reach the providers). Without keys it uses only the free no-key channels, so this
// measures the floor: what MyChat does with nothing connected. Keys can be given as the MYCHAT_KEYS_JSON secret.
//   node tools/live-eval.mjs [--only=access,review,...]
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Gateway } from "../core/router.mjs";
import { run } from "../core/reason.mjs";
import { Search } from "../core/search.mjs";
import { runAgent, apply } from "../core/agent.mjs";
import { study } from "../core/digest.mjs";
import { evaluate } from "../core/exact.mjs";
import { makeZip, extractZip } from "../core/zip.mjs";
import { nodeFs } from "../pc/agentfs.mjs";

const keys = JSON.parse(process.env.MYCHAT_KEYS_JSON || "{}");
const gw = new Gateway({ keys, allowKeyless: true, allowLocal: false });
const search = new Search({ keys });
const only = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const results = [];

// ---------------------------------------------------------------- fixture: a small app with three planted bugs
const root = await fs.mkdtemp(path.join(os.tmpdir(), "mychat-live-"));
const files = {
  "Projects/demo-app/package.json": JSON.stringify({ name: "demo-shop", version: "1.0.0", scripts: { start: "node server.js" } }, null, 2),
  "Projects/demo-app/README.md": "# Demo shop\nA tiny shop: cart, login, user search.\n",
  "Projects/demo-app/src/cart.js": "// Cart total in cents\nexport function total(items) {\n  let sum = 0;\n  for (let i = 1; i < items.length; i++) {\n    sum += items[i].price * items[i].qty;\n  }\n  return sum;\n}\n",
  "Projects/demo-app/src/auth.js": "// Remember the user's API key between visits\nexport function saveKey(key) {\n  localStorage.setItem(\"apiKey\", key);\n}\nexport function loadKey() {\n  return localStorage.getItem(\"apiKey\");\n}\n",
  "Projects/demo-app/src/users.js": "import { db } from \"./db.js\";\n// Find users by name for the admin search box\nexport async function findUser(name) {\n  const sql = \"SELECT * FROM users WHERE name = '\" + name + \"'\";\n  return db.query(sql);\n}\n",
  "Projects/demo-app/src/db.js": "export const db = { query: async (sql) => [] };\n",
};
for (const [p, t] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true }); await fs.writeFile(path.join(root, p), t); }
const wfs = nodeFs(root);
const tools = { search, evaluate: (e) => evaluate(e).toString(12) };

const leaks = (t) => /"(final|thought|tool)"\s*:/.test(String(t));   // raw protocol JSON must never reach the person
async function task(name, fn) {
  if (only.length && !only.includes(name)) return;
  const t0 = Date.now();
  let r;
  try { r = await fn(); } catch (e) { r = { pass: false, score: 0, detail: "error: " + e.message }; }
  r.name = name; r.seconds = Math.round((Date.now() - t0) / 1000);
  results.push(r);
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${name}  ${r.score ?? ""}  ${r.seconds}s  ${r.by || ""}\n      ${String(r.detail || "").replace(/\n/g, "\n      ").slice(0, 1500)}`);
}
const BUGS = [
  ["off-by-one in cart total (skips the first item)", /(off.by.one|i\s*=\s*1|first item|index 0|skips? the first|items\[0\])/i, "src/cart.js"],
  ["API key stored in plain localStorage", /(localStorage)[\s\S]{0,300}(plain|unencrypt|xss|secur|exposed|steal|readable)|(plain|unencrypt|xss|insecure)[\s\S]{0,300}localStorage/i, "src/auth.js"],
  ["SQL injection in user search", /sql.?injection|injection|parameteri[sz]ed|prepared statement/i, "src/users.js"],
];
const citedOk = async (text) => {   // every path:line it cites must exist and the line must be in range
  const cites = [...String(text).matchAll(/([\w./-]+\.(?:js|json|md)):(\d+)/g)];
  let bad = 0;
  for (const [, p, l] of cites) {
    const cand = [p, "Projects/demo-app/" + p, "Projects/demo-app/src/" + path.basename(p)];
    let ok = false;
    for (const c of cand) { const t = await wfs.read(c).catch(() => null); if (t != null && Number(l) <= t.split("\n").length) { ok = true; break; } }
    if (!ok) bad++;
  }
  return { cites: cites.length, bad };
};

await gw.refreshModels(true);
console.log("models available:", Object.entries(gw.models).map(([k, v]) => `${k}:${v.length}`).join(" "));

await task("chat-he", async () => {
  const r = await run(gw, { messages: [{ role: "user", content: "מהי בירת קנדה? תשובה קצרה." }] }, { mode: "auto", truth: { search } });
  return { pass: /אוטא?ווה|Ottawa/i.test(r.content), score: /אוטא?ווה/.test(r.content) ? 1 : 0.5, by: r.provider + ":" + r.model, detail: r.content.slice(0, 200) };
});

await task("access", async () => {
  const r = await runAgent(gw, { goal: "יש לך גישה לקבצים של הפרויקט שלי? מה יש בו?", fs: wfs, maxSteps: 8, ...tools });
  const denies = /(אין לי גישה|don'?t have access|no access|cannot access|can'?t access)/i.test(r.answer);
  const knows = /demo-app|demo-shop/i.test(r.answer) && /(cart|auth|users)\.js|cart|users/i.test(r.answer);
  return { pass: !denies && knows && !leaks(r.answer), score: (denies ? 0 : 0.5) + (knows ? 0.5 : 0), by: r.by, detail: `steps: ${r.steps.map((s) => s.tool).join(",")}\n${r.answer.slice(0, 600)}` };
});

await task("review", async () => {
  const r = await runAgent(gw, { goal: "Review the project in Projects/demo-app like a senior engineer. List the real bugs, most serious first, each with path:line and the fix.", fs: wfs, maxSteps: 12, ...tools });
  const found = BUGS.filter(([, rx]) => rx.test(r.answer));
  const c = await citedOk(r.answer);
  return { pass: found.length >= 2 && c.bad === 0 && !leaks(r.answer), score: found.length / BUGS.length, by: r.by,
    detail: `found ${found.length}/3: ${found.map((b) => b[0]).join("; ")} · citations ${c.cites} (${c.bad} wrong) · steps: ${r.steps.map((s) => s.tool).join(",")}\n${r.answer.slice(0, 900)}` };
});

await task("deep-read", async () => {
  const list = Object.entries(files).filter(([p]) => p.endsWith(".js")).map(([p, text]) => ({ path: p, text }));
  const r = await study(gw, { question: "What are the real bugs in this code? Most serious first.", files: list, partSize: 400, retryDelayMs: 5000 });
  const found = BUGS.filter(([, rx]) => rx.test(r.answer + "\n" + r.notes.map((n) => n.note).join("\n")));
  return { pass: found.length >= 2 && r.notes.length >= 1, score: found.length / BUGS.length, by: r.by,
    detail: `${r.parts} parts · ${r.notes.length} verified notes · ${r.dropped} unproven dropped · ${r.unread} unread\n${r.answer.slice(0, 600)}` };
});

await task("make-file", async () => {
  const r = await runAgent(gw, { goal: "Create notes/todo.md with a short shopping list: milk, eggs, bread.", fs: wfs, maxSteps: 6, ...tools });
  const op = r.ops.find((o) => o.op === "write" && /notes\/todo\.md$/.test(o.path));
  if (!op) return { pass: false, score: 0, by: r.by, detail: "no write op proposed: " + JSON.stringify(r.ops).slice(0, 300) + "\n" + r.answer.slice(0, 300) };
  const j = await apply(wfs, r);
  const t = await wfs.read("notes/todo.md");
  const ok = !j.error && /milk/i.test(t || "") && /eggs/i.test(t || "") && /bread/i.test(t || "");
  return { pass: ok, score: ok ? 1 : 0.5, by: r.by, detail: (t || "").slice(0, 200) };
});

await task("apk-unpack", async () => {
  const apk = makeZip({ "assets/public/main.mjs": "export const v = 1;\n", "classes.dex": "dex\0bytes", "kotlin/collections/a.kotlin_builtins": "x", "META-INF/CERT.SF": "x" });
  const r = await extractZip(apk, wfs, "Projects/apk-test");
  const okFiles = (await wfs.read("Projects/apk-test/assets/public/main.mjs")) === "export const v = 1;\n" && !(await wfs.exists("Projects/apk-test/kotlin"));
  return { pass: okFiles && r.apk, score: okFiles ? 1 : 0, detail: `apk=${r.apk} kept ${r.files}, left out ${r.left}` };
});

// ---------------------------------------------------------------- report
const pass = results.filter((r) => r.pass).length;
const md = [`## MyChat live evaluation — ${pass}/${results.length} passed`, "", `Accounts: ${Object.keys(keys).length ? Object.keys(keys).join(", ") : "none (free no-key channels only)"}`, "",
  "| Task | Result | Score | Time | Model |", "|---|---|---|---|---|",
  ...results.map((r) => `| ${r.name} | ${r.pass ? "✅" : "❌"} | ${r.score != null ? Math.round(r.score * 100) + "%" : ""} | ${r.seconds}s | ${String(r.by || "").replace(/\|/g, "/")} |`),
  "", ...results.map((r) => `<details><summary>${r.name}</summary>\n\n\`\`\`\n${String(r.detail || "").slice(0, 2500)}\n\`\`\`\n</details>`)].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
await fs.writeFile("live-eval.json", JSON.stringify({ at: new Date().toISOString(), pass, total: results.length, results }, null, 2));
console.log(`\n${pass}/${results.length} passed`);
