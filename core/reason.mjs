// MyChat gateway — reasoning strategies on top of the router. Each one is a known way to buy quality with
// extra model calls; which one runs is chosen per request (model name) and its value is measured by evals.
//
//  fast       one call, fastest capable model
//  auto       one call, best model for the task (classified without a model call)
//  max        code/analysis: draft -> independent review by a DIFFERENT model family -> revise only if the
//             review found real problems. Different families make different mistakes, so the reviewer is not
//             blind to the drafter's errors the way self-review is (measured: a 4B model approved its own bug).
//  consensus  3 drafts from 3 different families in parallel, then an aggregator that sees all of them and
//             their disagreements (mixture-of-agents + self-consistency). For facts, math, decisions.
import { classify, family, lastUserText } from "./router.mjs";
import { verifiedAnswer, checkedAnswer, triage } from "./truth.mjs";

export const MODES = {
  fast: "Fastest capable model",
  auto: "Best model for the task; factual answers stream at once and are checked right after",
  max: "Draft, cross-family review, revise (code and analysis)",
  consensus: "Three model families answer, an aggregator reconciles them",
  verified: "Truth Engine: claims checked against evidence, exact math and independent models",
};

// Severity tiers (blocker / major / minor; only the first two cost a fix round) as in the MIT-licensed
// awesome-skills/code-review-skill, found with Claude Hunter Pro's DNA library. Minor points no longer trigger a rewrite
// that can make a good answer worse.
const REVIEW_SYS = "You are an independent senior reviewer. Another model wrote the answer below. Check it against the request. " +
  "Look for real defects only: wrong facts, logic or math errors, code that would not run or does not do what was asked, " +
  "missing requirements, unsafe advice. Ignore style and wording. Reply with JSON only: " +
  '{"verdict":"ok"|"revise","issues":[{"severity":"blocker"|"major"|"minor","where":"exact place","fix":"the concrete fix"}, ...]} ' +
  "blocker = wrong or broken; major = a requirement missed or a real risk; minor = everything else. verdict is revise only if there is a blocker or major issue.";
const REVISE_NOTE = "An independent reviewer (a different model) found these problems in your answer. Fix every real one and give " +
  "the complete corrected answer (not a list of changes). If an issue is wrong, keep your version for that point.\n\nIssues:\n";
const AGG_SYS = "You are given a question and several independent answers from different AI models. Produce the single best " +
  "answer: where they agree, be confident; where they disagree, work out which is right and say why briefly; never copy an " +
  "error just because it appears more than once. Answer in the language of the question.";

function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/**
 * @param {import('./router.mjs').Gateway} gw
 * @param {object} req  OpenAI-style request
 * @param {object} o    { mode, onDelta, onStatus, signal, privateData }
 */
export async function run(gw, req, o = {}) {
  const mode = MODES[o.mode] ? o.mode : "auto";
  const status = o.onStatus || (() => {});
  const base = { onDelta: o.onDelta, signal: o.signal, privateData: o.privateData };
  const task = classify(req.messages);
  const deep = ["code", "reason", "long"].includes(task);
  const trace = [];
  if (!Object.keys(gw.models).length) await gw.refreshModels();  // strategies pick models before the first call

  // Truth Engine: always in "verified"; automatically in "auto"/"max" for factual, current and numeric questions.
  const tOpt = { ...(o.truth || {}), onStatus: o.onStatus, onDelta: o.onDelta, signal: o.signal, privateData: o.privateData };
  // Verified: the full audit (several drafts, every claim judged). Auto/Max on a factual question: the answer streams at
  // once and is checked right after it (measured on the hard set: same accuracy goal, ~3 calls instead of 8–15).
  if (!req.tools?.length && mode === "verified") return { ...(await verifiedAnswer(gw, req, tOpt)), mode, route: "several drafts, every claim judged" };
  if (!req.tools?.length && (mode === "auto" || mode === "max" || mode === "checked") && o.truth && (mode === "checked" || triage(req.messages).verify)) {
    // the label stays the mode the person chose (it used to say "checked", which looked like the switch was ignored)
    return { ...(await checkedAnswer(gw, req, { ...tOpt, quality: mode === "max" || deep })), mode, route: "answered, then fact-checked" };
  }
  // What each mode really does (measured 2026-11-20 on the phone: Auto and Max gave the same single answer to almost
  // everything, so the mode switch looked broken). Every result says which route it took (`route`).
  const text = lastUserText(req.messages);
  const one = async (route, t, extra = {}) => {
    const r = await gw.chat(req, { ...base, task: t, ...extra });
    return { ...r, mode, route, trace: [{ step: "answer", by: `${r.provider}:${r.model}` }] };
  };
  if (mode === "fast") return one("fastest model", "fast");
  if (req.tools?.length) return one("direct (tools)", task, { quality: true });
  if (mode === "auto") {
    if (task === "fast") return one("quick answer", "fast");
    // real work (code, analysis, a long question) gets a second opinion from another model family
    if (deep && (task === "code" ? text.length > 60 : text.length > 200)) return reviewed(gw, req, o, task === "fast" ? "chat" : task, mode, trace, "auto");
    return one("best model for the task", task, { quality: deep });
  }
  if (mode === "max") {
    // strongest model, never the fastest; a greeting needs no review, everything else is drafted, reviewed and fixed
    const t = task === "fast" ? "chat" : task;
    if (task === "fast" && text.length < 25) return one("strongest model", t, { quality: true });
    return reviewed(gw, req, o, t, mode, trace, "max");
  }
  // consensus
  status("Asking three model families…");
  const pool = gw.candidates(task === "fast" ? "chat" : task, { privateData: o.privateData, limit: 30, diverse: true });
  const picks = [];
  for (const c of pool) if (!picks.some((p) => p.family === c.family)) { picks.push(c); if (picks.length === 3) break; }
  if (picks.length < 2) {
    const r = await gw.chat(req, { ...base, task });
    return { ...r, mode, route: "one family only (consensus needs two)", trace: [{ step: "consensus skipped: fewer than two model families available" }] };
  }
  const drafts = (await Promise.allSettled(picks.map((c) =>
    gw.chat(req, { task, prefer: `${c.provider}:${c.model}`, signal: o.signal, privateData: o.privateData, families: [c.family] }))))
    .filter((r) => r.status === "fulfilled").map((r) => r.value);
  drafts.forEach((d) => trace.push({ step: "proposal", by: `${d.provider}:${d.model}` }));
  if (drafts.length === 1) { o.onDelta?.(drafts[0].content); return { ...drafts[0], mode, route: "one proposal survived", trace }; }
  if (!drafts.length) throw new Error("all proposers failed");
  status(`Reconciling ${drafts.length} answers…`);
  const used = new Set(drafts.map((d) => family(d.model)));
  const agg = gw.candidates("reason", { privateData: o.privateData, diverse: true }).find((c) => !used.has(c.family)) ||
              gw.candidates("reason", { privateData: o.privateData, diverse: true })[0];
  const r = await gw.chat({ messages: [{ role: "system", content: AGG_SYS },
    { role: "user", content: `QUESTION:\n${lastUserText(req.messages)}\n\n` +
      drafts.map((d, i) => `ANSWER ${i + 1} (${d.model}):\n${d.content}`).join("\n\n")}] },
    { ...base, task: "reason", prefer: agg ? `${agg.provider}:${agg.model}` : undefined });
  trace.push({ step: "aggregate", by: `${r.provider}:${r.model}` });
  return { ...r, mode, route: `${drafts.length} families answered, reconciled`, trace };
}

/** Draft with the strongest model, an independent review by another model family, a fix round when it found real defects. */
async function reviewed(gw, req, o, task, mode, trace, why) {
  const status = o.onStatus || (() => {});
  const base = { onDelta: o.onDelta, signal: o.signal, privateData: o.privateData };
  const quality = mode === "max" || ["code", "reason", "long"].includes(task);
  status(`Drafting with the strongest ${task} model…`);
  const draft = await gw.chat(req, { task, signal: o.signal, privateData: o.privateData, quality });
  trace.push({ step: "draft", by: `${draft.provider}:${draft.model}` });
  const fam = family(draft.model);
  const reviewers = gw.candidates(task, { privateData: o.privateData, diverse: true, quality }).filter((c) => c.family !== fam);
  if (!reviewers.length) {
    o.onDelta?.(draft.content);
    trace.push({ step: "review skipped: no second model family available" });
    return { ...draft, mode, route: "single model (no second family for review)", trace };
  }
  status(`Independent review by ${reviewers[0].model.split("/").pop()}…`);
  let review = null;
  try {
    const rv = await gw.chat({ messages: [{ role: "system", content: REVIEW_SYS },
      { role: "user", content: `REQUEST:\n${lastUserText(req.messages)}\n\nANSWER TO REVIEW:\n${draft.content}` }], temperature: 0.1 },
      { task: task === "code" ? "code" : "reason", prefer: `${reviewers[0].provider}:${reviewers[0].model}`,
        families: [...new Set(reviewers.map((c) => c.family))], signal: o.signal, privateData: o.privateData });
    review = parseJson(rv.content);
    trace.push({ step: "review", by: `${rv.provider}:${rv.model}`, verdict: review?.verdict, issues: review?.issues?.length || 0 });
  } catch (e) {
    trace.push({ step: "review failed", error: String(e.message).slice(0, 120) });
  }
  const issues = (review?.issues || []).map((x) => typeof x === "string" ? x
      : x && typeof x === "object" && x.severity !== "minor" ? `${x.severity ? `[${x.severity}] ` : ""}${x.where ? x.where + ": " : ""}${x.fix || x.issue || ""}` : "")
    .filter((x) => x && x.trim()).slice(0, 12);
  if (!review || review.verdict !== "revise" || !issues.length) {
    o.onDelta?.(draft.content);
    return { ...draft, mode, route: review ? "drafted + reviewed: no defects found" : "drafted (review failed)", trace };
  }
  status(`Fixing ${issues.length} issue${issues.length > 1 ? "s" : ""} the reviewer found…`);
  const fixed = await gw.chat({ ...req, messages: [...req.messages, { role: "assistant", content: draft.content },
    { role: "user", content: REVISE_NOTE + issues.map((x, i) => `${i + 1}. ${x}`).join("\n") }] },
    { ...base, task, prefer: `${draft.provider}:${draft.model}` });
  trace.push({ step: "revise", by: `${fixed.provider}:${fixed.model}` });
  return { ...fixed, mode, route: `drafted + reviewed: ${issues.length} fixed`, trace, issues, why };
}
