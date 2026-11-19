// MyChat — claim ledger ("truth memory") and learned model reliability.
//
// Every claim the Truth Engine settles is remembered with its verdict and evidence, so later answers neither
// re-check it nor contradict it. Current-events claims expire (the world changes); others are kept.
//
// Model reliability per domain is estimated the Dawid–Skene way (one-coin model): each model m has an accuracy
// p[m,domain]. Claims checked against evidence give labelled outcomes; claims that could not be checked still
// carry information through the pattern of which models supported or opposed them. EM over both estimates p
// without needing an answer key, and the Truth Engine weighs votes by log-odds of p, so a historically sloppy
// model's agreement is worth less than a careful one's.
import { norm } from "./search.mjs";

const STOP = new Set("the a an of in on at to is are was were be been and or for with as by from that this it its which who what when where how than then into about over under 's".split(" "));
// sentence punctuation is not part of a word ("1889." == "1889"), decimal points are ("3.5")
const tokens = (s) => norm(s).replace(/\.(?!\d)|(?<!\d)\./g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
const jaccard = (a, b) => { const A = new Set(a), B = new Set(b); let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i || 1); };

export function memoryStore(init) {
  let d = init || null;
  return { load: () => d, save: (v) => { d = v; } };
}

export class Ledger {
  constructor(store = memoryStore()) {
    this.store = store;
    this.d = store.load() || { claims: {}, votes: [], rel: {} };
    this.d.claims ||= {}; this.d.votes ||= []; this.d.rel ||= {};
  }
  key(text) { return tokens(text).sort().join(" ").slice(0, 300); }
  save() { this.store.save(this.d); }

  /** A settled claim close enough to `text` (same key, or ≥0.8 token overlap), unless it has expired. */
  lookup(text) {
    const now = Date.now(), k = this.key(text);
    const fresh = (c) => c && (!c.expires || c.expires > now);
    if (fresh(this.d.claims[k])) return this.d.claims[k];
    const t = k.split(" ");
    let best = null, bs = 0;
    for (const c of Object.values(this.d.claims).slice(-5000)) {
      if (!fresh(c)) continue;
      const s = jaccard(t, c.key.split(" "));
      if (s > bs) { bs = s; best = c; }
    }
    return bs >= 0.8 ? best : null;
  }

  /**
   * Remember a settled claim and the votes models cast on it.
   * verdict: "supported" | "refuted" | "insufficient";  supporters/opposers: model ids;  domain: task class
   */
  record({ text, verdict, evidence = [], supporters = [], opposers = [], domain = "fact", current = false }) {
    const k = this.key(text);
    if (verdict !== "insufficient") {
      this.d.claims[k] = { key: k, text, verdict, evidence: evidence.slice(0, 3), domain, at: Date.now(),
                           expires: current ? Date.now() + 7 * 864e5 : 0 };
    }
    this.d.votes.push({ k, domain, s: supporters, o: opposers, label: verdict === "supported" ? 1 : verdict === "refuted" ? 0 : null });
    if (this.d.votes.length > 20000) this.d.votes.splice(0, this.d.votes.length - 20000);
    this.save();
  }

  /** Dawid–Skene (one-coin) EM over labelled and unlabelled votes. Updates this.d.rel["model|domain"]. */
  estimate(iterations = 20) {
    const byDomain = {};
    for (const v of this.d.votes) (byDomain[v.domain] ||= []).push(v);
    for (const [domain, votes] of Object.entries(byDomain)) {
      const models = new Set();
      votes.forEach((v) => { v.s.forEach((m) => models.add(m)); v.o.forEach((m) => models.add(m)); });
      const p = {};
      models.forEach((m) => (p[m] = 0.7));
      let prior = 0.7;
      let post = votes.map((v) => (v.label ?? 0.5));
      for (let it = 0; it < iterations; it++) {
        // E-step: probability each claim is true (labelled claims stay fixed)
        post = votes.map((v) => {
          if (v.label !== null && v.label !== undefined) return v.label;
          let lt = Math.log(prior), lf = Math.log(1 - prior);
          for (const m of v.s) { lt += Math.log(p[m]); lf += Math.log(1 - p[m]); }
          for (const m of v.o) { lt += Math.log(1 - p[m]); lf += Math.log(p[m]); }
          return 1 / (1 + Math.exp(lf - lt));
        });
        // M-step: each model's accuracy = expected agreement with the truth (Beta(2,1) prior keeps it sane)
        const right = {}, n = {};
        models.forEach((m) => { right[m] = 2; n[m] = 3; });
        votes.forEach((v, i) => {
          for (const m of v.s) { right[m] += post[i]; n[m] += 1; }
          for (const m of v.o) { right[m] += 1 - post[i]; n[m] += 1; }
        });
        models.forEach((m) => (p[m] = Math.min(0.99, Math.max(0.01, right[m] / n[m]))));
        prior = Math.min(0.95, Math.max(0.05, (post.reduce((a, b) => a + b, 0) + 1) / (post.length + 2)));
      }
      models.forEach((m) => (this.d.rel[m + "|" + domain] = { p: p[m], n: votes.filter((v) => v.s.includes(m) || v.o.includes(m)).length }));
    }
    this.save();
    return this.d.rel;
  }

  /** Accuracy estimate for a model in a domain (0.7 when unknown). */
  reliability(model, domain) { return this.d.rel[model + "|" + domain]?.p ?? 0.7; }

  /** Weighted support for a claim: sum of log-odds of supporters minus opposers (Dawid–Skene voting weight). */
  weight(supporters, opposers, domain) {
    const lo = (m) => { const p = this.reliability(m, domain); return Math.log(p / (1 - p)); };
    return supporters.reduce((a, m) => a + lo(m), 0) - opposers.reduce((a, m) => a + lo(m), 0);
  }
}
