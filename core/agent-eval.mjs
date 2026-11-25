// Agent eval: which model does the owner's real work best? Each candidate model runs the same agent tasks over the
// same folder; an answer counts only if it contains every expected fact (checked by pattern, not by a model), in the
// language of the question. Expected facts can be computed at eval time from git, so the cases stay true as the
// repositories move. The result ranks models by correct answers first, then by time.
//
// case: { id, goal, expect: ["regex", ...], truth?: { git: { repo, args }, pick?: "regex with one group" } }
//   truth.git runs a read-only git command; its output (or pick's first group) must appear in the answer, literally.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function caseExpectations(c, { gitRead } = {}) {
  const want = (Array.isArray(c.expect) ? c.expect : []).map((p) => new RegExp(p, "i"));
  if (c.truth?.git) {
    if (!gitRead) throw new Error(`case ${c.id}: needs git`);
    const out = String(await gitRead(c.truth.git.repo, c.truth.git.args)).trim();
    if (!out || /^\[git\]|^git:/m.test(out)) throw new Error(`case ${c.id}: git truth failed: ${out.slice(0, 160)}`);
    const m = c.truth.pick ? new RegExp(c.truth.pick, "m").exec(out) : [out, out.split("\n")[0]];
    if (!m || !m[1]) throw new Error(`case ${c.id}: truth pattern found nothing`);
    want.push(new RegExp(esc(m[1].trim()), "i"));
  }
  return want;
}

export function scoreAnswer(goal, answer, want) {
  const text = String(answer || "");
  const missing = want.filter((re) => !re.test(text)).map((re) => re.source);
  const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ").replace(/\S*[\\/.]\S*/g, " ");
  const letters = (prose.match(/\p{L}/gu) || []).length, hebrew = (prose.match(/[֐-׿]/g) || []).length;
  const langOk = !/[֐-׿]/.test(goal) || letters < 40 || hebrew / letters >= 0.3;
  return { correct: !missing.length, missing, langOk };
}

/** models: ["provider:model", ...]; run(goal, models) -> agent result ({answer, by, calls, steps}). */
export async function evalAgentModels({ cases, models, run, gitRead, onProgress = () => {}, signal, now = () => Date.now() }) {
  const prepared = [];
  for (const c of cases) prepared.push({ ...c, want: await caseExpectations(c, { gitRead }) });
  const results = [];
  for (const model of models) {
    const row = { model, cases: [], correct: 0, langOk: 0, ms: 0, usedOther: 0, errors: 0 };
    for (const c of prepared) {
      if (signal?.aborted) throw new Error("stopped");
      onProgress({ model, case: c.id });
      const t0 = now();
      let r;
      try { r = await run(c.goal, { plan: model, work: [model] }); }
      catch (e) { r = { answer: "", error: e.message }; row.errors++; }
      const ms = now() - t0, s = scoreAnswer(c.goal, r.answer, c.want);
      // the router may have fallen back to another model: that answer is not this model's
      const used = String(r.by || ""), mine = used === model;
      if (!mine) row.usedOther++;
      const ok = s.correct && mine;
      row.correct += ok ? 1 : 0; row.langOk += s.langOk && mine ? 1 : 0; row.ms += ms;
      row.cases.push({ id: c.id, ok, langOk: s.langOk, missing: s.missing, by: used, calls: r.calls || 0, ms, error: r.error || undefined });
    }
    results.push(row);
  }
  results.sort((a, b) => b.correct - a.correct || b.langOk - a.langOk || a.ms - b.ms);
  const best = results.filter((r) => r.correct > 0);
  return { at: new Date(now()).toISOString(), cases: cases.length, results,
    recommend: best.length ? { plan: best[0].model, work: best.slice(0, 3).map((r) => r.model) } : null };
}
