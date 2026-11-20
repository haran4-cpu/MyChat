// Built-in benchmark: measures YOUR connected models on known-answer probes (facts, Hebrew, exact math, code that is
// actually executed) and turns the results into routing pins per task. Optionally compares the Truth Engine (verified)
// with a single fast model on the known-answer set. Runs inside the gateway; progress at GET /bench.
import { spawn } from "node:child_process";
import { priorFor } from "../core/providers.mjs";
import { run } from "../core/reason.mjs";
import { SET, SET_HARD, HEDGE, normAnswer } from "../core/truthset.mjs";

export const PROBES = [
  { task: "reason", q: "What is 17.5% of 2,480? Answer with the number only.", ok: /\b434\b/ },
  { task: "reason", q: "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How many cents does the ball cost? Number only.", ok: /(^|\D)5(\D|$)/ },
  { task: "reason", q: "A price of 80 rises by 15% and then falls by 15%. What is the final price? Number only.", ok: /\b78\.2\b/ },
  { task: "chat", q: "What is the capital of Australia? One word.", ok: /canberra/i },
  { task: "chat", q: "Which element has atomic number 26? One word.", ok: /\biron\b|\bFe\b/i },
  { task: "chat", he: true, q: "מהי בירת אוסטרליה? ענה במילה אחת בעברית.", ok: /קנברה/ },
  { task: "chat", he: true, q: "כמה צלעות יש למשושה? ענה במספר בלבד.", ok: /\b6\b|שש/ },
  { task: "chat", he: true, q: "מי כתב את הרומן 'אהבת ציון'? ענה בשם בלבד, בעברית.", ok: /מאפו/ },
  { task: "chat", he: true, q: "תרגם לעברית מילה אחת: water", ok: /^\W*מים\W*$/ },
  { task: "code", q: "Write a JavaScript function named solve(arr) that returns the second largest DISTINCT number in an array of numbers, or null if there is none. Reply with only the code.",
    test: "solve([3,1,4,4,5])===4 && solve([7,7])===null && solve([-1,-2])===-2 && solve([])===null" },
  { task: "code", q: "Write a JavaScript function named solve(s) that returns true if s is a palindrome when case, spaces and punctuation are ignored. Reply with only the code.",
    test: "solve('A man, a plan, a canal: Panama')===true && solve('race a car')===false && solve('')===true" },
  { task: "code", q: "Write a JavaScript function named solve(n) that returns the n-th Fibonacci number as a BigInt, with solve(0)===0n and solve(1)===1n. It must be fast for n=500. Reply with only the code.",
    test: "solve(0)===0n && solve(1)===1n && solve(10)===55n && solve(500)===139423224561697880139724382870407283950070256587697307264108962948325571622863290691557658876222521294125n" },
];

const TASKS = ["chat", "code", "reason"];

export function extractCode(text) {
  const blocks = [...String(text).matchAll(/```[\w-]*\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  return (blocks.sort((a, b) => b.length - a.length)[0] ?? String(text)).trim();
}

/** Run model-written code in a separate Node process with the permission model on (no file writes, no child processes)
 *  and a hard time limit. Returns true only if the test expression is true. */
export function runCodeTest(code, test, timeoutMs = 4000) {
  const src = `${code}\n;process.stdout.write(String(Boolean(${test})));`;
  const attempt = (flag) => new Promise((ok) => {
    const args = [...(flag ? [flag] : []), "--input-type=module", "-e", src];
    const p = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); ok({ out: "timeout", err }); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", () => { clearTimeout(t); ok({ out, err }); });
    p.on("error", (e) => { clearTimeout(t); ok({ out: "", err: e.message }); });
  });
  return (async () => {
    let r = await attempt("--permission");
    if (/bad option|unknown option/i.test(r.err)) r = await attempt("--experimental-permission");
    return r.out.trim() === "true";
  })();
}

/** Candidate models per provider, best prior first. The run tries them in order and keeps the first `perProvider`
 *  that actually answer (a listed model can still be unavailable on the account's plan). */
export function pickModels(gw, { perProvider = 4, openrouterMax = 3, pool = 10 } = {}) {
  const out = [];
  for (const id of gw.enabledProviders()) {
    const p = gw.providers[id];
    if (p.keyless || p.local || !gw.keys[id]) continue;
    const models = gw.models[id] || [];
    const ranked = [];
    for (let k = 0; ranked.length < pool && k < models.length; k++) {
      for (const task of TASKS) {
        const m = [...models].sort((a, b) => (priorFor(b)[task] ?? 0) - (priorFor(a)[task] ?? 0))[k];
        if (m && !ranked.includes(m)) ranked.push(m);
      }
    }
    ranked.slice(0, pool).forEach((model) => out.push({ provider: id, model, keep: id === "openrouter" ? openrouterMax : perProvider }));
  }
  return out;
}

export function pinsFrom(results, minAcc = 0.66) {
  const pins = {};
  for (const task of TASKS) {
    const solid = (r) => (r.acc.chat + r.acc.code + r.acc.reason) / 3 >= 0.6;   // one lucky task is not enough
    pins[task] = results.filter((r) => r.acc[task] >= minAcc && solid(r))
      .sort((a, b) => b.acc[task] - a.acc[task] || a.ms[task] - b.ms[task]).slice(0, 4).map((r) => r.provider + ":" + r.model);
  }
  pins.fast = results.filter((r) => r.acc.chat >= 0.99).sort((a, b) => a.ms.chat - b.ms.chat).slice(0, 4).map((r) => r.provider + ":" + r.model);
  pins.long = pins.reason;
  // Hebrew: models that got every Hebrew probe right go first; models that failed half or more are avoided for Hebrew
  pins.he = results.filter((r) => r.he >= 0.99).sort((a, b) => b.acc.chat - a.acc.chat || a.ms.chat - b.ms.chat).slice(0, 4).map((r) => r.provider + ":" + r.model);
  pins.heBad = results.filter((r) => r.he !== undefined && r.he <= 0.5).map((r) => r.provider + ":" + r.model);
  return pins;
}

export class Bench {
  /** truthTools: the same { search, ledger } real chats get. Without it the Truth Engine runs with no evidence and
   *  Auto never checks (measured mistake, 2026-11-20: earlier runs were made without it). */
  constructor(gw, truthTools = null) { this.gw = gw; this.truthTools = truthTools; this.state = { running: false }; }

  async start({ truth = true, truthLimit = 999, truthSet = "hard", models = true, modes = ["fast", "auto", "verified"], onPins = null } = {}) {
    const QS = (truthSet === "basic" ? SET : truthSet === "all" ? [...SET, ...SET_HARD] : SET_HARD).slice(0, truthLimit);
    if (this.state.running) return this.state;
    const st = this.state = { running: true, startedAt: Date.now(), phase: "models", done: 0, total: 0, models: [], truth: null, log: [] };
    this.stopped = false;
    const gw = this.gw;
    (async () => {
      try {
        await gw.refreshModels(true);
        const picks = models ? pickModels(gw) : [];
        st.total = Object.values(picks.reduce((a, c) => ((a[c.provider] = c.keep), a), {})).reduce((a, k) => a + k, 0) * PROBES.length
                   + (truth ? QS.length * modes.length : 0);
        const byProvider = {};
        for (const c of picks) (byProvider[c.provider] ||= []).push(c);
        // providers in parallel (separate rate limits), models of one provider one after another
        await Promise.all(Object.values(byProvider).map(async (list) => {
          let kept = 0;
          for (const c of list) {
            if (this.stopped || kept >= c.keep || gw.parked[c.provider]?.until > Date.now()) break;
            const row = { provider: c.provider, model: c.model, acc: {}, ms: {}, errors: 0, answers: [] };
            const per = {};
            for (const pr of PROBES) {
              const t0 = Date.now();
              let ok = false, text = "";
              try {
                const r = await gw._call(c, { messages: [{ role: "user", content: pr.q }], temperature: 0, max_tokens: pr.task === "code" ? 2000 : 600 }, {}, () => {});
                text = r.content;
                ok = pr.test ? await runCodeTest(extractCode(text), pr.test) : pr.ok.test(normAnswer(text));
              } catch (e) { row.errors++; text = "ERROR " + String(e.message).slice(0, 120); }
              const ms = Date.now() - t0;
              (per[pr.task] ||= []).push({ ok, ms });
              if (pr.he) (per.he ||= []).push({ ok, ms, script: /[\u0600-\u06FF]/.test(text) && !/[\u0590-\u05FF]/.test(text) });
              row.answers.push({ task: pr.task, ok, ms, text: text.slice(0, 160) });
              st.done++;
              if (row.errors >= 3 && row.answers.every((a) => !a.ok)) break;  // dead or rate-limited: stop spending quota on it
            }
            const he = per.he || [];
            row.he = he.length ? +(he.filter((x) => x.ok).length / he.length).toFixed(2) : 0;
            for (const t of TASKS) {
              const xs = per[t] || [];
              row.acc[t] = xs.length ? +(xs.filter((x) => x.ok).length / PROBES.filter((p) => p.task === t).length).toFixed(2) : 0;
              const good = xs.filter((x) => x.ok);
              row.ms[t] = good.length ? Math.round(good.reduce((a, x) => a + x.ms, 0) / good.length) : 1e9;
            }
            if (row.errors >= 3 && row.answers.every((a) => !a.ok)) { st.skipped = [...(st.skipped || []), `${c.provider}:${c.model}`]; continue; }
            kept++;
            st.models.push(row);
            st.log.push(`${c.provider}:${c.model} chat ${row.acc.chat} code ${row.acc.code} reason ${row.acc.reason}`);
          }
        }));
        if (models) { st.pins = pinsFrom(st.models); if (onPins) onPins(st.pins); }
        if (truth) {
          st.phase = "truth";
          const rows = [];
          for (const [q, rx, kind] of QS) {
            if (this.stopped) break;
            for (const mode of modes) {
              const t0 = Date.now(), c0 = gw.calls || 0;
              let text = "", first = 0;
              try { text = (await run(gw, { messages: [{ role: "user", content: q }] }, { mode, truth: this.truthTools || undefined,
                                                                                       onDelta: () => { if (!first) first = Date.now() - t0; } })).content; }
              catch (e) { text = "ERROR " + e.message; }
              const body = normAnswer(text.split("\n---\n")[0]);
              const ok = rx.test(body);
              rows.push({ q, kind, mode, ok, error: text.startsWith("ERROR"), confidentWrong: !ok && !HEDGE.test(body), ms: Date.now() - t0, firstMs: first, calls: (gw.calls || 0) - c0, answer: body.slice(0, 200) });
              st.done++;
            }
          }
          const sum = {};
          for (const mode of modes) {
            const r = rows.filter((x) => x.mode === mode), by = (k) => r.filter((x) => x.kind === k);
            if (!r.length) continue;
            sum[mode] = { accuracy: +(r.filter((x) => x.ok).length / r.length).toFixed(3), confidentlyWrong: r.filter((x) => x.confidentWrong).length,
              traps: `${by("trap").filter((x) => x.ok).length}/${by("trap").length}`, math: `${by("math").filter((x) => x.ok).length}/${by("math").length}`,
              facts: `${by("fact").filter((x) => x.ok).length}/${by("fact").length}`, avgSeconds: +(r.reduce((a, x) => a + x.ms, 0) / r.length / 1000).toFixed(1),
              firstWordSeconds: +(r.reduce((a, x) => a + (x.firstMs || x.ms), 0) / r.length / 1000).toFixed(1), avgCalls: +(r.reduce((a, x) => a + x.calls, 0) / r.length).toFixed(1) };
          }
          st.truth = { summary: sum, rows, withEvidence: !!this.truthTools?.search, stopped: this.stopped,
                       errors: rows.filter((r) => r.error).length };
        }
      } catch (e) {
        st.error = e.message;
      } finally {
        st.running = false;
        st.phase = "done";
        st.finishedAt = Date.now();
      }
    })();
    return st;
  }

  /** Stop after the question in progress (a run that hit the daily limits only produces errors). */
  stop() { this.stopped = true; return this.state; }
}
