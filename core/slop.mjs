// MyChat — slop linter. Deterministic: no model judges its own fluff.
// Finds filler, empty praise, vague quantities, hedging stacks, boilerplate, repetition and unsupported
// superlatives in English and Hebrew; returns findings and a 0-100 score (0 = clean).
// claimsPreserved() makes sure a "tightening" rewrite did not change facts (numbers, names, URLs, negations).

const RULES = [
  // [id, regex, weight, why]
  ["filler-opener", /^(great question|good question|certainly|absolutely|of course|sure thing|i'?d be happy to|happy to help|let'?s dive in|let me (help|explain))[!,.:\s]/im, 6, "empty opener"],
  ["filler-he", /^(שאלה מצוינת|שאלה טובה|בהחלט|בשמחה|כמובן|אשמח לעזור)[!,.:\s]/m, 6, "empty opener"],
  ["as-ai", /\bas an ai( language model)?\b|כמודל שפה|כבינה מלאכותית/i, 8, "self-reference boilerplate"],
  ["delve", /\b(delve|tapestry|testament to|in today'?s (fast-paced|digital) world|ever-evolving|navigat(e|ing) the (complexities|landscape)|unlock(ing)? the (power|potential)|game[- ]changer|seamless(ly)?|robust and scalable|cutting-edge)\b/i, 4, "stock phrase"],
  ["hype-he", /(מהפכני|פורץ דרך|חסר תקדים|ברמה עולמית|הטוב ביותר בעולם)/, 3, "unsupported superlative"],
  ["superlative", /\b(the best|the most (powerful|advanced|comprehensive)|unparalleled|unmatched|revolutionary|world-class|state-of-the-art)\b/i, 3, "unsupported superlative"],
  ["vague-qty", /\b(many experts|studies show|research (shows|suggests)|it is (widely|generally) (known|believed)|some (say|argue)|numerous|countless|a (wide )?(variety|range) of)\b|(מחקרים מראים|מומחים רבים|ידוע ש)/i, 4, "vague source or quantity"],
  ["hedge-stack", /\b(might|may|could|possibly|perhaps|potentially)\b[^.]{0,40}\b(might|may|could|possibly|perhaps|potentially)\b/i, 3, "stacked hedging"],
  ["closer", /(i hope this helps|let me know if you (have|need)|feel free to (ask|reach out)|happy coding|אם יש לך שאלות נוספות|מקווה שזה עוזר|אל תהסס)/i, 5, "boilerplate closer"],
  ["in-conclusion", /^(in conclusion|in summary|to summarize|overall),/im, 2, "throat-clearing summary"],
  ["important-note", /\b(it'?s (important|worth|crucial) to (note|mention|remember) that)\b|(חשוב לציין ש)/i, 2, "throat-clearing"],
];

function sentences(text) {
  return String(text).replace(/```[\s\S]*?```/g, " ").split(/(?<=[.!?。])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 15);
}

export function lint(text) {
  const t = String(text || "");
  const prose = t.replace(/```[\s\S]*?```/g, " ");
  const findings = [];
  let score = 0;
  for (const [id, rx, w, why] of RULES) {
    const g = new RegExp(rx.source, rx.flags.includes("g") ? rx.flags : rx.flags + "g");
    const hits = [...prose.matchAll(g)].map((m) => m[0]).slice(0, 5);
    if (hits.length) {
      findings.push({ id, why, hits });
      score += w * Math.min(hits.length, 3);
    }
  }
  // repetition: the same sentence (normalised) or the same 6-word run more than once
  const seen = new Map();
  for (const s of sentences(t)) {
    const k = s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ");
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  const dup = [...seen.entries()].filter(([, n]) => n > 1);
  if (dup.length) { findings.push({ id: "repeat", why: "repeated sentence", hits: dup.map(([k]) => k.slice(0, 60)) }); score += 8 * dup.length; }
  const words = prose.toLowerCase().split(/\s+/).filter(Boolean);
  const grams = new Map();
  for (let i = 0; i + 6 <= words.length; i++) { const g = words.slice(i, i + 6).join(" "); grams.set(g, (grams.get(g) || 0) + 1); }
  const rep = [...grams.values()].filter((n) => n > 2).length;
  if (rep > 2) { findings.push({ id: "repeat-runs", why: "repeated phrasing", hits: [] }); score += Math.min(15, rep); }
  // density: long answer that says little (few concrete tokens: numbers, names, code)
  const concrete = (prose.match(/\d|[A-Z][a-z]+[A-Z]|`[^`]+`|https?:\/\//g) || []).length;
  if (words.length > 250 && concrete / words.length < 0.01) { findings.push({ id: "low-density", why: "long but not concrete", hits: [] }); score += 6; }
  return { score: Math.min(100, score), findings };
}

/** The facts a rewrite must not change: numbers (with units), URLs, code spans, capitalised names, negations. */
export function factPrint(text) {
  const t = String(text || "");
  const nums = (t.match(/-?\d[\d,.]*\s?(%|°[CF]?|km|kg|mb|gb|ms|s|m|x|\$|₪|€)?/gi) || []).map((x) => x.replace(/,/g, "").trim());
  const urls = t.match(/https?:\/\/[^\s)\]]+/g) || [];
  const code = t.match(/`[^`]+`/g) || [];
  const names = (t.match(/\b[A-Z][a-zA-Z0-9.-]{2,}(?:\s[A-Z][a-zA-Z0-9.-]{2,})*/g) || []).filter((n) => !/^(The|This|That|These|It|In|If|For|And|But|However|Also|When|What|How|Why)$/.test(n));
  const neg = (t.match(/\b(not|never|no|cannot|isn't|doesn't|won't)\b|(לא|אין|אסור|אינו|אינה)/gi) || []).length;
  return { nums: new Set(nums), urls: new Set(urls), code: new Set(code), names: new Set(names), neg };
}

/** True if `after` keeps every number, URL and code span of `before`, almost all names, and the same polarity. */
export function claimsPreserved(before, after) {
  const a = factPrint(before), b = factPrint(after);
  for (const k of ["nums", "urls", "code"]) for (const x of a[k]) if (!b[k].has(x)) return { ok: false, lost: `${k}: ${x}` };
  const lostNames = [...a.names].filter((n) => !String(after).includes(n));
  if (lostNames.length > Math.max(1, a.names.size * 0.1)) return { ok: false, lost: "names: " + lostNames.slice(0, 3).join(", ") };
  if (Math.abs(a.neg - b.neg) > Math.max(1, a.neg * 0.2)) return { ok: false, lost: "negations changed" };
  return { ok: true };
}
