// MyChat — Truth Engine: several models as a filter against slop and false claims.
//
// Why not just vote: models share training data and therefore errors, so agreement is weak evidence;
// disagreement is a strong warning. So every claim is anchored, in this order:
//   1. truth memory (already settled)       4. evidence: web/Wikipedia; the judge must quote the page and the
//   2. exact arithmetic (math claims)          quote is checked by string match (no quote on the page = no proof)
//   3. -                                     5. independent questioning: a model of another family answers the
//                                              question WITHOUT seeing the draft (chain-of-verification)
// then votes weighted by each model's learned reliability (Dawid–Skene, see ledger.mjs), with disagreement
// lowering confidence. The final answer is synthesised from settled claims only; refuted ones are corrected,
// unproven ones are marked. A deterministic slop pass tightens the prose without changing any fact.
import { classify, family, lastUserText } from "./router.mjs";
import { evaluate, approxEqual } from "./exact.mjs";
import { lint, claimsPreserved } from "./slop.mjs";
import { quoteFound } from "./search.mjs";

const CURRENT_RX = /\b(today|now|current(ly)?|latest|recent(ly)?|this (year|month|week)|news|price|cost|rate|ceo|president|prime minister|version|release[sd]?|20[2-9]\d)\b|(היום|עכשיו|נוכחי|אחרון|השנה|החודש|מחיר|עלות|מנכ"ל|נשיא|ראש הממשלה|גרסה|חדשות)/i;
const FACT_RX = /\b(who|what|when|where|which|how (many|much|long|far|old|big)|is it true|did|does|was|were|population|capital|founded|invented|born|died|distance|height|largest|smallest|first)\b|(מי |מה |מתי|איפה|היכן|כמה|האם נכון|האם זה נכון|אוכלוסי|בירה|נוסד|הומצא|נולד|נפטר|מרחק|גובה|הגדול|הראשון)/i;
const MATH_RX = /\d[\d,.]*\s*(%|percent|[-+*/^×÷])\s*\d|\d[\d,.]*\s*(%|percent)\s*(of|מ)\s*\d|\b(calculate|compute|how much is|sum of|average of)\b|(חשב|תחשב|כמה זה|ממוצע|סכום)/i;
const CREATIVE_RX = /\b(write|compose)\s+(a |an )?(poem|story|song|joke|haiku|limerick|lyrics|tagline|slogan)|(שיר|סיפור|בדיחה|סלוגן)\b/i;
const OPINION_RX = /\b(what do you think|your opinion|should i|do you like|recommend)\b|(מה דעתך|כדאי לי|האם כדאי|תמליץ)/i;

/** Decide whether an answer needs verification. Rules only: this runs before any model call. */
export function triage(messages) {
  const t = lastUserText(messages);
  if (CREATIVE_RX.test(t)) return { kind: "creative", verify: false };
  const task = classify(messages);
  if (task === "code") return { kind: "code", verify: false };   // code is verified by running it (Kestrel / app sandbox)
  if (MATH_RX.test(t)) return { kind: "math", verify: true };
  if (CURRENT_RX.test(t)) return { kind: "current", verify: true };
  if (FACT_RX.test(t)) return { kind: "fact", verify: true };
  if (OPINION_RX.test(t)) return { kind: "opinion", verify: false };
  if (task === "reason" && /\d/.test(t)) return { kind: "fact", verify: true };
  return { kind: "chat", verify: false };
}

const EXTRACT_SYS = `You are a meticulous fact auditor. You receive a question and several draft answers written independently by different AI models.
List the factual claims the drafts make that a reader would rely on (max 14). Merge claims that say the same thing across drafts.
For each claim give:
- "text": the claim as one standalone sentence (no pronouns that need context)
- "type": "fact" | "number" | "date" | "math" | "advice" | "opinion"
- "importance": 3 if the answer depends on it, 2 if relevant, 1 if minor
- "support": draft numbers that state or imply it; "oppose": draft numbers that contradict it
- "query": a web search query that would confirm or refute it
- "question": the claim turned into a neutral question that does not reveal the claimed answer
- for "math" only: "expr" (the arithmetic as an expression, e.g. "17.5% of 2480") and "value" (the result the draft states)
Do not invent claims the drafts do not make. Reply with JSON only: {"claims":[...]}`;

const JUDGE_SYS = `You check one claim against evidence excerpts from web pages. Use ONLY the excerpts, not your memory.
Reply with JSON only: {"verdict":"supported"|"refuted"|"insufficient","source":<excerpt number>,"quote":"<exact words copied from that excerpt that prove it>","correction":"<the correct statement if refuted>"}
"supported"/"refuted" require a quote copied character-for-character from the excerpt. If the excerpts do not settle it, say "insufficient".`;

const COMPARE_SYS = `Two statements are given: a CLAIM and an independent ANSWER to the same question. Do they agree on the facts?
Reply with JSON only: {"relation":"agree"|"disagree"|"unclear"}`;

const SYNTH_SYS = `You write the final answer for the user from audited material. Rules:
- Use the verified claims as the backbone. Never state a REFUTED claim; use its correction instead.
- Claims marked UNVERIFIED or DISPUTED may be mentioned only with an explicit "(unverified)" and without inventing details.
- Cite evidence-backed claims with [n] matching the sources list. Do not invent sources.
- No filler, no empty praise, no boilerplate opener or closer. Be direct and concrete.
- Answer in the language of the question.`;

function parseJson(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function excerpts(results, query, per = 1400) {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  return results.slice(0, 4).map((r) => {
    const t = r.text || r.snippet || "";
    let best = 0, at = 0;
    for (let i = 0; i < t.length; i += 200) {
      const w = t.slice(i, i + per).toLowerCase();
      const s = words.reduce((a, x) => a + (w.includes(x) ? 1 : 0), 0);
      if (s > best) { best = s; at = i; }
    }
    return { url: r.url, title: r.title, text: t.slice(at, at + per) || r.snippet || "" };
  }).filter((e) => e.text);
}

/**
 * @param gw    Gateway
 * @param req   OpenAI-style request
 * @param o     { search?: Search, ledger?: Ledger, onStatus, onDelta, signal, privateData, maxCheck=8, drafts=2 }
 */
export async function verifiedAnswer(gw, req, o = {}) {
  const status = o.onStatus || (() => {});
  const q = lastUserText(req.messages);
  const tri = triage(req.messages);
  const trace = [];
  const domain = tri.kind === "current" ? "current" : tri.kind === "math" ? "math" : "fact";
  if (!Object.keys(gw.models).length) await gw.refreshModels();
  const call = (r, extra = {}) => gw.chat(r, { signal: o.signal, privateData: o.privateData, ...extra });

  // 1. independent drafts from different families
  status("Independent drafts from different model families…");
  const pool = gw.candidates(classify(req.messages) === "fast" ? "chat" : classify(req.messages), { privateData: o.privateData, limit: 30 });
  const picks = [];
  for (const c of pool) if (!picks.some((p) => p.family === c.family)) { picks.push(c); if (picks.length === (o.drafts || 2)) break; }
  const drafts = (await Promise.allSettled((picks.length ? picks : [null]).map((c) =>
    call(req, c ? { prefer: `${c.provider}:${c.model}`, families: [c.family] } : {}))))
    .filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (!drafts.length) throw new Error("no model could draft an answer");
  drafts.forEach((d, i) => trace.push({ step: `draft ${i + 1}`, by: `${d.provider}:${d.model}` }));
  const draftModel = drafts.map((d) => `${d.provider}:${d.model}`);
  const used = new Set(drafts.map((d) => family(d.model)));
  const other = (task) => gw.candidates(task, { privateData: o.privateData }).find((c) => !used.has(c.family));

  // 2. claim ledger for this answer
  status("Extracting claims…");
  let claims = [];
  try {
    const ex = await call({ temperature: 0, messages: [{ role: "system", content: EXTRACT_SYS },
      { role: "user", content: `QUESTION:\n${q}\n\n` + drafts.map((d, i) => `DRAFT ${i + 1}:\n${d.content}`).join("\n\n") }] }, { task: "reason" });
    claims = (parseJson(ex.content)?.claims || []).filter((c) => c && c.text).slice(0, 14);
    trace.push({ step: "claims", by: `${ex.provider}:${ex.model}`, n: claims.length });
  } catch (e) {
    trace.push({ step: "claim extraction failed", error: String(e.message).slice(0, 120) });
  }

  // 3. settle claims: memory -> exact math -> evidence -> independent questioning -> weighted votes
  const sources = [];
  const srcIndex = (url, title) => { let i = sources.findIndex((s) => s.url === url); if (i < 0) { sources.push({ url, title }); i = sources.length - 1; } return i + 1; };
  const toCheck = claims.map((c, i) => ({ c, i })).filter(({ c }) => c.type !== "opinion" && c.type !== "advice")
    .sort((a, b) => (b.c.importance || 1) + (b.c.oppose?.length ? 2 : 0) - (a.c.importance || 1) - (a.c.oppose?.length ? 2 : 0))
    .slice(0, o.maxCheck || 8);
  const settled = claims.map((c) => ({ ...c, status: c.type === "opinion" || c.type === "advice" ? "opinion" : "unchecked" }));
  let questioned = 0;
  for (const { c, i } of toCheck) {
    if (o.signal?.aborted) break;
    const s = settled[i];
    const supporters = (c.support || []).map((n) => draftModel[n - 1]).filter(Boolean);
    const opposers = (c.oppose || []).map((n) => draftModel[n - 1]).filter(Boolean);
    const known = o.ledger?.lookup(c.text);
    if (known) { s.status = known.verdict; s.how = "memory"; s.evidence = known.evidence; continue; }
    if (c.type === "math" && c.expr && c.value !== undefined) {
      try {
        const v = evaluate(String(c.expr));
        s.status = approxEqual(v, c.value) ? "supported" : "refuted";
        s.how = "exact arithmetic";
        if (s.status === "refuted") s.correction = `${c.expr} = ${v.toString(6)}`;
        o.ledger?.record({ text: c.text, verdict: s.status, supporters, opposers, domain: "math" });
        continue;
      } catch { /* not plain arithmetic: fall through to evidence */ }
    }
    if (o.search && c.query) {
      status(`Checking: ${c.text.slice(0, 70)}…`);
      try {
        const ev = excerpts(await o.search.evidence(c.query), c.query);
        if (ev.length) {
          const judge = other("reason");
          const jr = await call({ temperature: 0, messages: [{ role: "system", content: JUDGE_SYS },
            { role: "user", content: `CLAIM: ${c.text}\n\n` + ev.map((e, k) => `EXCERPT ${k + 1} (${e.url}):\n${e.text}`).join("\n\n") }] },
            { task: "reason", ...(judge ? { prefer: `${judge.provider}:${judge.model}` } : {}) });
          const j = parseJson(jr.content);
          const src = ev[(Number(j?.source) || 1) - 1];
          if (j && (j.verdict === "supported" || j.verdict === "refuted")) {
            if (src && j.quote && quoteFound(j.quote, src.text)) {
              s.status = j.verdict; s.how = "evidence"; s.quote = j.quote; s.correction = j.correction || "";
              s.src = srcIndex(src.url, src.title);
              s.evidence = [{ url: src.url, quote: j.quote }];
              o.ledger?.record({ text: c.text, verdict: j.verdict, evidence: s.evidence, supporters, opposers, domain, current: tri.kind === "current" });
              continue;
            }
            s.note = "judge's quote not found on the page: not counted as proof";
          }
        }
      } catch (e) { s.note = "search failed: " + String(e.message).slice(0, 60); }
    }
    // independent questioning for disputed/important claims (the draft is never shown)
    if ((opposers.length || (c.importance || 1) >= 3) && c.question && questioned < 3) {
      const ind = other(domain === "math" ? "reason" : "chat");
      if (ind) {
        questioned++;
        status(`Independent check by ${ind.model}…`);
        try {
          const a = await call({ temperature: 0.2, messages: [{ role: "user", content: c.question + "\nAnswer briefly and factually. If you are not sure, say so." }] },
            { prefer: `${ind.provider}:${ind.model}`, families: [ind.family] });
          const cmp = parseJson((await call({ temperature: 0, messages: [{ role: "system", content: COMPARE_SYS },
            { role: "user", content: `CLAIM: ${c.text}\nANSWER: ${a.content}` }] }, { task: "fast" })).content);
          const m = `${a.provider}:${a.model}`;
          if (cmp?.relation === "agree") supporters.push(m);
          else if (cmp?.relation === "disagree") opposers.push(m);
          s.independent = { by: m, relation: cmp?.relation || "unclear" };
        } catch { /* best effort */ }
      }
    }
    const w = o.ledger ? o.ledger.weight(supporters, opposers, domain) : supporters.length - opposers.length;
    s.status = opposers.length && supporters.length ? "disputed" : w > 0.8 && !opposers.length ? "agreed" : opposers.length ? "doubtful" : "unverified";
    s.how = "weighted votes";
    o.ledger?.record({ text: c.text, verdict: "insufficient", supporters, opposers, domain });
  }
  if (o.ledger && o.ledger.d.votes.length % 10 === 0) o.ledger.estimate();

  // 4. synthesis from settled claims
  status("Writing the verified answer…");
  const label = { supported: "VERIFIED", refuted: "REFUTED", agreed: "AGREED (not independently verified)", disputed: "DISPUTED",
                  doubtful: "DOUBTFUL", unverified: "UNVERIFIED", unchecked: "UNVERIFIED", opinion: "OPINION/ADVICE" };
  const table = settled.map((s, i) => `${i + 1}. [${label[s.status]}${s.src ? ` · source [${s.src}]` : ""}] ${s.text}` +
    (s.correction ? ` → CORRECTION: ${s.correction}` : "") + (s.quote ? ` (quote: "${s.quote.slice(0, 160)}")` : "")).join("\n");
  const best = drafts.map((d, i) => ({ d, score: settled.reduce((a, s) => a + ((s.support || []).includes(i + 1) ? (s.status === "refuted" ? -3 : s.status === "supported" ? 2 : 0.5) : 0), 0) }))
    .sort((a, b) => b.score - a.score)[0].d;
  let content;
  if (!settled.length) {
    content = best.content;
    trace.push({ step: "no checkable claims: best draft kept" });
  } else {
    const synth = await call({ temperature: 0.3, messages: [{ role: "system", content: SYNTH_SYS },
      { role: "user", content: `QUESTION:\n${q}\n\nAUDITED CLAIMS:\n${table}\n\nSOURCES:\n${sources.map((s, i) => `[${i + 1}] ${s.title || ""} ${s.url}`).join("\n") || "(none)"}\n\nBEST DRAFT (style and structure reference; its claims are audited above):\n${best.content}` }] },
      { task: "reason", prefer: `${best.provider}:${best.model}` });
    content = synth.content;
    trace.push({ step: "synthesis", by: `${synth.provider}:${synth.model}` });
  }

  // 5. slop filter (deterministic check; a rewrite is kept only if every fact survives)
  const sl = lint(content);
  if (sl.score >= 15) {
    try {
      const tight = await call({ temperature: 0.2, messages: [{ role: "system", content: "Tighten this answer: remove filler, boilerplate openers/closers, empty praise, vague phrases and repetition. Change NOTHING factual: keep every number, name, citation [n], link, code block and negation. Same language. Output only the rewritten answer." },
        { role: "user", content }] }, { task: "fast" });
      const kept = claimsPreserved(content, tight.content);
      if (kept.ok && lint(tight.content).score < sl.score) { content = tight.content; trace.push({ step: "slop tightened", from: sl.score }); }
      else trace.push({ step: "slop rewrite rejected", why: kept.lost || "not cleaner" });
    } catch { /* keep original */ }
  }

  const count = (st) => settled.filter((s) => s.status === st).length;
  const footer = settled.length
    ? `\n\n---\n*Truth Engine: ${settled.length} claims · ${count("supported")} proven · ${count("refuted")} corrected · ` +
      `${count("agreed")} agreed · ${count("disputed") + count("doubtful") + count("unverified") + count("unchecked")} unverified*` +
      (sources.length ? "\n" + sources.map((s, i) => `[${i + 1}] ${s.url}`).join("\n") : "")
    : "";
  content += footer;
  o.onDelta?.(content);
  return { content, provider: best.provider, model: best.model, task: tri.kind, mode: "verified", trace, claims: settled, sources, slop: lint(content).score };
}
