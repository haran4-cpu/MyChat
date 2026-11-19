// Known-answer evaluation of the Truth Engine against a single model.
// Usage (gateway running):  node tools/eval_truth.mjs [--modes fast,auto,verified] [--limit 30]
// Scores each answer: correct (matches the known answer, or rejects a false premise), wrong, or no answer;
// "confidently wrong" = wrong without any hedge. Results: eval-truth-<time>.json next to the gateway state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = process.env.MYCHAT_HOME || path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "MyChat");
const URL_ = process.env.MYCHAT_URL || "http://127.0.0.1:11500";
const token = fs.readFileSync(path.join(HOME, "token"), "utf8").trim();

import { SET, HEDGE, normAnswer } from "../core/truthset.mjs";
export { SET };

async function ask(model, q) {
  const t0 = Date.now();
  const r = await fetch(URL_ + "/v1/chat/completions", { method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: q }] }) });
  const j = await r.json();
  return { text: j.choices?.[0]?.message?.content || j.error?.message || "", ms: Date.now() - t0, trace: j.mychat?.trace || [] };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).join(" ").split("--").filter(Boolean).map((a) => a.trim().split(/\s+/)));
  const modes = (args.modes?.[0] || "fast,verified").split(",");
  const limit = Number(args.limit?.[0] || SET.length);
  const rows = [];
  for (const [q, rx, kind] of SET.slice(0, limit)) {
    for (const m of modes) {
      const a = await ask("mychat/" + m, q).catch((e) => ({ text: "ERROR " + e.message, ms: 0, trace: [] }));
      const body = normAnswer(a.text.split("\n---\n")[0]);                      // ignore the Truth Engine footer when scoring
      const ok = rx.test(body);
      rows.push({ q, kind, mode: m, ok, confidentWrong: !ok && !HEDGE.test(body), ms: a.ms, calls: a.trace.length, answer: body.slice(0, 300) });
      console.log(`${ok ? "✓" : "✗"} [${m}] ${q.slice(0, 60)} (${(a.ms / 1000).toFixed(1)}s)`);
    }
  }
  const summary = {};
  for (const m of modes) {
    const r = rows.filter((x) => x.mode === m);
    const by = (k) => r.filter((x) => x.kind === k);
    summary[m] = { accuracy: +(r.filter((x) => x.ok).length / r.length).toFixed(3), confidentlyWrong: r.filter((x) => x.confidentWrong).length,
      traps: `${by("trap").filter((x) => x.ok).length}/${by("trap").length}`, math: `${by("math").filter((x) => x.ok).length}/${by("math").length}`,
      facts: `${by("fact").filter((x) => x.ok).length}/${by("fact").length}`, avgSeconds: +(r.reduce((a, x) => a + x.ms, 0) / r.length / 1000).toFixed(1) };
  }
  const out = path.join(HOME, `eval-truth-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(out, JSON.stringify({ summary, rows }, null, 1));
  console.log("\n" + JSON.stringify(summary, null, 1) + "\n" + out);
}

if (process.argv[1]?.endsWith("eval_truth.mjs")) main();
