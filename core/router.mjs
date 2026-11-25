// MyChat gateway — router. Pure JavaScript, no dependencies: runs in Node 18+, a browser/WebView, or a worker.
//
// Each request is classified (no model call), candidate models are ranked by
//   prior quality for the task  x  measured reliability  x  measured speed  x  availability,
// and tried in order with automatic failover. Streams that break mid-answer are continued by the next model.
import { PROVIDERS, priorFor, NOT_CHAT } from "./providers.mjs";

export const TASKS = ["chat", "code", "reason", "long", "vision", "fast"];

const CODE_RX = /```|\b(function|class|def|import|const|let|return|SELECT|npm|pip|git|python|javascript|typescript|html|css|java|rust|golang|kotlin|bash|regex|stack ?trace|exception|compile|refactor|bug|debug)\b|\.(py|js|ts|html|css|json|kt|java|rs|go|cpp|cs)\b|(קוד|סקריפט|באג|פונקציה|תוכנית|אפליקציה|אתר)/i;
const REASON_RX = /\b(why|prove|derive|step by step|analy[sz]e|compare|trade-?offs?|plan|strategy|design|architecture|calculate|probability|optimi[sz]e|evaluate)\b|[∑∫√≤≥]|(למה|הוכח|נתח|השווה|תכנן|ארכיטקטורה|אסטרטגיה|חשב|הסבר לעומק)/i;

export function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content || "").length;
  return Math.ceil(chars / 3.5);
}

export function hasImages(messages) {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p && (p.type === "image_url" || p.type === "input_image")));
}

export function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  }
  return "";
}

/** Classify a request into a task type. Cheap rules only: routing must not cost a model call. */
export function classify(messages) {
  if (hasImages(messages)) return "vision";
  if (estimateTokens(messages) > 60000) return "long";
  const t = lastUserText(messages);
  const ctx = messages.slice(-4).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
  if (CODE_RX.test(t) || (t.length < 120 && CODE_RX.test(ctx) && /```/.test(ctx))) return "code";
  if (REASON_RX.test(t) || t.length > 1200) return "reason";
  if (t.length < 80 && messages.length <= 3) return "fast";
  return "chat";
}

export function family(model) {
  const m = model.toLowerCase();
  for (const f of ["claude", "gemini", "gemma", "glm", "kimi", "deepseek", "qwen", "llama", "mistral", "codestral", "minimax",
                   "nemotron", "gpt-oss", "gpt", "phi", "grok", "command"]) {
    if (m.includes(f)) return f === "codestral" ? "mistral" : f;
  }
  return m.split("/").pop().split(/[-:]/)[0];
}

const EMPTY_STAT = Object.freeze({ ok: 0, fail: 0, ttft: null, tps: null, cooldownUntil: 0, lastError: "", day: "", today: 0 });

class Stats {
  constructor() { this.m = new Map(); }
  key(p, model) { return p + "|" + model; }
  get(p, model) {
    const k = this.key(p, model);
    if (!this.m.has(k)) this.m.set(k, { ok: 0, fail: 0, ttft: null, tps: null, cooldownUntil: 0, lastError: "", day: "", today: 0 });
    return this.m.get(k);
  }
  success(p, model, ttftMs, tps) {
    const s = this.get(p, model);
    s.ok++; s.at = Date.now();
    s.ttft = s.ttft == null ? ttftMs : s.ttft * 0.7 + ttftMs * 0.3;
    if (tps) s.tps = s.tps == null ? tps : s.tps * 0.7 + tps * 0.3;
  }
  failure(p, model, err, cooldownMs) {
    const s = this.get(p, model);
    s.fail++; s.at = Date.now();
    s.lastError = String(err).slice(0, 200);
    if (cooldownMs) s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + cooldownMs);
  }
  count(p, model) {
    const s = this.get(p, model), d = new Date().toISOString().slice(0, 10);
    if (s.day !== d) { s.day = d; s.today = 0; }
    s.today++;
  }
  peek(p, model) { return this.m.get(this.key(p, model)) || EMPTY_STAT; }   // reading never creates an entry
  reliability(p, model) {
    const s = this.peek(p, model);
    return (s.ok + 1) / (s.ok + s.fail + 2); // Laplace: unknown = 0.5, earns trust with use
  }
  /** Saved file keeps only models that were actually used (measured: 771 entries, ~6 working, 138 KB). */
  toJSON() {
    const now = Date.now(), out = {};
    for (const [k, v] of this.m) {
      if (!v.ok && !v.fail) continue;
      if (!v.ok && (v.at || 0) < now - 14 * 86400e3) continue;   // failures older than two weeks are forgotten
      out[k] = v;
    }
    return out;
  }
  load(obj) { for (const [k, v] of Object.entries(obj || {})) this.m.set(k, v); }
}

/** An answer that stopped mid-sentence: no "stop" from the provider and no sentence end. Tool calls are complete by themselves. */
export function cutOff(r) {
  if (r.tool_calls?.length) return false;
  const t = (r.content || "").trimEnd();
  if (!t) return false;
  if (r.finish_reason === "length") return true;
  // even with "stop": an answer that ends on "written by" / "נכתב על ידי" is not an answer
  return /(?:^|\s)(by|of|the|and|to|is|was|are|a|an|in|with|from|על ידי|של|את|הוא|היא|כי|עם|הם|מאת)$/iu.test(t) || /[,(\-–—:]$/.test(t) && t.length < 400;
}

/** More Arabic letters than Hebrew ones (the answer to a Hebrew question came back in the wrong script). */
export function wrongScript(t) {
  const ar = (t.match(/[\u0600-\u06FF]/g) || []).length, he = (t.match(/[\u0590-\u05FF]/g) || []).length;
  return ar > 3 && ar > he;
}

/** OpenAI-style request -> Gemini native generateContent body. */
// Account has no money: park the provider. NOT plain "billing" (Gemini's ordinary quota message says "check your plan and billing").
const BILLING_RX = /insufficient.{0,12}(balance|credit|funds)|purchase pre-?paid credits|payment required|out of credits|exceeded your monthly included credits|(allowance|usage limit).{0,24}(exhausted|exceeded|used up|reached)/i;
// A free daily allowance is used up: park until it resets (OpenRouter free models reset at 00:00 UTC).
const DAILY_RX = /free-models-per-day|per.?day.{0,30}(limit|exceeded)|daily (limit|quota)/i;
/** "2m59.56s", "7.66s", "120ms", "30" (seconds) or an epoch -> milliseconds from now. */
export function parseResetMs(v) {
  if (v == null || v === "") return 60e3;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) { const n = Number(s); return n > 1e12 ? Math.max(0, n - Date.now()) : n > 1e9 ? Math.max(0, n * 1000 - Date.now()) : n * 1000; }
  let ms = 0;
  for (const [, n, u] of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) ms += Number(n) * { ms: 1, s: 1e3, m: 60e3, h: 3600e3 }[u];
  return ms || 60e3;
}
const nextUtcMidnight = () => { const d = new Date(); d.setUTCHours(24, 0, 30, 0); return d.getTime(); };

export function toGemini(req) {
  const contents = [], sys = [];
  const parts = (c) => {
    if (typeof c === "string") return [{ text: c }];
    return (c || []).map((x) => {
      if (x.type === "text") return { text: x.text };
      const url = x.image_url?.url || "";
      const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
      return m ? { inlineData: { mimeType: m[1], data: m[2] } } : { text: url };
    });
  };
  for (const m of req.messages || []) {
    if (m.role === "system") { sys.push(...parts(m.content).filter((p) => p.text)); continue; }
    const role = m.role === "assistant" ? "model" : "user";
    const ps = m.role === "tool" ? [{ text: "Tool result: " + (typeof m.content === "string" ? m.content : JSON.stringify(m.content)) }] : parts(m.content);
    if (!ps.length) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...ps); else contents.push({ role, parts: ps });
  }
  const gc = {};
  if (req.temperature !== undefined) gc.temperature = req.temperature;
  if (req.top_p !== undefined) gc.topP = req.top_p;
  if (req.max_tokens !== undefined) gc.maxOutputTokens = req.max_tokens;
  if (req.stop) gc.stopSequences = [].concat(req.stop);
  if (req.response_format?.type === "json_object" || req.response_format?.type === "json_schema") gc.responseMimeType = "application/json";
  const out = { contents };
  if (sys.length) out.systemInstruction = { parts: sys };
  if (Object.keys(gc).length) out.generationConfig = gc;
  return out;
}

/** Gemini native response chunk -> OpenAI-style chunk (thought parts are dropped). */
export function fromGemini(j, whole = false) {
  const cand = j.candidates?.[0] || {};
  const text = (cand.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join("");
  const fr = cand.finishReason && cand.finishReason !== "FINISH_REASON_UNSPECIFIED" ? (cand.finishReason === "MAX_TOKENS" ? "length" : "stop") : null;
  const usage = j.usageMetadata ? { prompt_tokens: j.usageMetadata.promptTokenCount, completion_tokens: j.usageMetadata.candidatesTokenCount } : undefined;
  if (j.promptFeedback?.blockReason && !text) throw new Error("blocked by Gemini: " + j.promptFeedback.blockReason);
  return whole ? { choices: [{ message: { content: text }, finish_reason: fr }], usage }
               : { choices: [{ delta: { content: text }, finish_reason: fr }], usage };
}

export class GatewayError extends Error {
  constructor(msg, attempts) {
    super(msg); this.attempts = attempts;
    const short = (e) => String(e).replace(/\s+/g, " ").slice(0, 120);
    this.detail = (attempts || []).map((a) => `${a.provider}:${a.model} — ${a.ok ? "ok" : short(a.error)}`).join("\n");
  }
}

/** Why nothing answered, in words a person can act on (measured: the phone showed a raw Google JSON error). */
export function humanFailure(attempts, providers = {}, allowKeyless = true) {
  if (!attempts?.length) return "No model could answer: no account is connected. Add a free key in Accounts, or turn on the free no-key channels.";
  const why = {};
  for (const a of attempts) {
    const e = String(a.error || "");
    const r = /\b429\b|quota|rate.?limit|too many requests/i.test(e) ? "out of free quota for now"
      : /\b50[234]\b|overload|unavailable|high demand/i.test(e) ? "busy (overloaded)"
      : /\b40[13]\b|key rejected|unauthori[sz]ed|invalid api key/i.test(e) ? "key rejected"
      : /too long/i.test(e) ? "message too long for it"
      : /failed to fetch|network|ECONN|ENOTFOUND|timed? ?out|aborted|stalled/i.test(e) ? "not reachable (network)"
      : /another script/i.test(e) ? "answered in the wrong language"
      : "error";
    const name = providers[a.provider]?.keyless && !providers[a.provider]?.local ? "free no-key channels"
      : (providers[a.provider]?.name || a.provider).replace(/\s*\(.*\)$/, "");
    (why[name] ||= new Set()).add(r);
  }
  const lines = Object.entries(why).map(([n, rs]) => `${n}: ${[...rs].join(", ")}`);
  const tips = ["wait a minute and ask again"];
  if (Object.keys(why).length < 3) tips.push("add another free account in Accounts (Groq, OpenRouter, Cerebras, Mistral…) so one empty account can't stop you");
  if (!allowKeyless) tips.push("or turn on the free no-key channels");
  return `No model could answer right now (${attempts.length} tried). ${lines.join(" · ")}. You can ${tips.join(", ")}.`;
}

export class Gateway {
  /**
   * @param {object} o
   * @param {Record<string,string|string[]>} o.keys  provider id -> key (or several keys of the SAME account/org)
   * @param {typeof fetch} [o.fetch]
   * @param {boolean} [o.allowKeyless=true]  public no-key gateways (never receive requests marked private)
   * @param {boolean} [o.allowLocal=false]   the PC's Ollama
   * @param {object}  [o.extraProviders]      custom OpenAI-compatible endpoints
   */
  constructor(o = {}) {
    this.keys = o.keys || {};
    this.fetch = o.fetch || globalThis.fetch.bind(globalThis);
    this.allowKeyless = o.allowKeyless !== false;
    this.allowLocal = !!o.allowLocal;
    this.providers = { ...PROVIDERS, ...(o.extraProviders || {}) };
    this.stats = new Stats();
    this.models = {};          // provider -> [model ids]
    this.modelsAt = {};
    this.disabled = {};        // provider -> reason (bad key etc.)
    this.parked = {};          // provider -> { until, reason } (no credit / balance): retried after a while, shown on Accounts
    this.limits = {};          // provider -> { remaining, resetAt } from rate-limit headers
    this.ctx = {};             // provider -> model -> context window in tokens (when the provider lists it)
    this.quotaHits = {};       // provider -> [{ model, at }] recent 429s (several models of one account in a row = the account is out)
    this.quotaStrikes = {};    // provider -> how many times it was paused today (pause doubles: 15 min, 30, 60, 120)
    this.requests = 0;
    this.idleTimeoutMs = o.idleTimeoutMs || 45000;
    this.explore = null;
    this.log = o.log || (() => {});
    this.firstTokenTimeoutMs = o.firstTokenTimeoutMs || 45000;
    this.pins = o.pins || {};  // task -> ["provider:model", ...] preferred order (from evals)
  }

  enabledProviders() {
    return Object.entries(this.providers).filter(([id, p]) => {
      if (this.disabled[id]) return false;
      if (this.parked[id] && this.parked[id].until > Date.now()) return false;
      if (p.local) return this.allowLocal;
      if (p.keyless) return this.allowKeyless;
      return !!this.keyFor(id);
    }).map(([id]) => id);
  }

  keyFor(id) {
    const k = this.keys[id];
    if (!k) return "";
    if (Array.isArray(k)) { // several keys of the same account: use them in turn (not to evade per-account limits)
      this._rr = (this._rr || 0) + 1;
      return k[this._rr % k.length];
    }
    return k;
  }

  headers(id) {
    const p = this.providers[id], h = { "Content-Type": "application/json", ...(p.headers || {}) };
    const k = this.keyFor(id);
    if (k) { if (p.keyHeader) h[p.keyHeader] = k; else h.Authorization = "Bearer " + k; }
    return h;
  }

  /** Discover each provider's models (cached 6 h). Failures disable nothing: the provider just has no list. */
  async refreshModels(force = false, only = null) {
    const ids = this.enabledProviders().filter((id) => !only || only.includes(id));
    await Promise.all(ids.map(async (id) => {
      const p = this.providers[id];
      if (p.noModelList) { this.models[id] = p.models || []; return; }
      if (!force && this.modelsAt[id] && Date.now() - this.modelsAt[id] < 6 * 3600e3) return;
      try {
        const r = await this.fetch(p.baseUrl.replace(/\/$/, "") + "/models" + (p.native === "gemini" ? "?pageSize=1000" : ""), { headers: this.headers(id) });
        if (r.status === 401 || r.status === 403) { this.disabled[id] = `key rejected (${r.status})`; return; }
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        for (const m of j.data || j.models || []) {   // context window when the provider tells it (OpenRouter, Groq, Gemini, Kilo…)
          const n = m.context_length || m.context_window || m.inputTokenLimit || m.max_context_length || m.top_provider?.context_length;
          if (n) (this.ctx[id] ||= {})[(m.id || m.name || "").replace(/^models\//, "")] = Number(n);
        }
        const list = (j.data || j.models || []).filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
          .map((m) => (m.id || m.name || "").replace(/^models\//, "")).filter(Boolean);
        this.models[id] = list.filter((m) => !NOT_CHAT.test(m) && (!/:free$/.test(m) || id === "openrouter" || p.freeOnly));
        if (p.freeOnly && !this.keys[id]) this.models[id] = this.models[id].filter((m) => m.endsWith(p.freeOnly));
        if (id === "openrouter" && !this.paidOpenRouter) this.models[id] = this.models[id].filter((m) => m.endsWith(":free"));
        this.modelsAt[id] = Date.now();
      } catch (e) {
        this.log(`models ${id}: ${e.message}`);
        if (p.models) this.models[id] = p.models;
      }
    }));
    return this.models;
  }

  /** Rank (provider, model) pairs for a task. */
  candidates(task, { needTools = false, needVision = false, privateData = false, exclude = [], families = null, limit = 8, lang = "", diverse = false, quality = false, avoidFamily = "" } = {}) {
    const now = Date.now(), out = [];
    for (const id of this.enabledProviders()) {
      const p = this.providers[id];
      if (privateData && p.keyless && !p.local) continue;
      for (const model of this.models[id] || []) {
        if (exclude.includes(id + ":" + model)) continue;
        if (families && !families.includes(family(model))) continue;
        const st = this.stats.peek(id, model);
        if (st.cooldownUntil > now) continue;
        // never answered after 3 tries: dead on this account — for 6 hours, not forever (measured on the phone: a few
        // offline minutes marked every free channel dead for two weeks, and only one exhausted account was left)
        if (!st.ok && st.fail >= 3 && now - (st.at || 0) < 6 * 3600e3) continue;
        // asked for other families or to avoid models (Truth Engine judge, Max reviewer): diversity beats the pool
        const pool = diverse || families || exclude.length ? null : this.pool(id);
        const pinned = Object.values(this.pins).some((l) => Array.isArray(l) && l.includes(id + ":" + model));
        const prior = priorFor(model);
        let q = prior[task] ?? prior.chat;
        // Max: a strong model this account has not proven yet still gets a chance (measured on the PC: Max drafted with
        // gemini-flash-lite because it was the only Gemini model that had answered before)
        const strongUntried = quality && q >= 0.8 && !st.fail;
        // a provider with a small allowance (Puter) is kept for Max and the agent, never spent on everyday chat
        if (p.reserve && !quality && !pinned) continue;
        if (pool && !pool.has(model) && !pinned && !strongUntried && !(this.explore && this.explore.provider === id && this.explore.model === model)) continue;
        if (quality && /(\b|[-_])(lite|mini|nano|tiny|small|8b|7b|3b|1b)(\b|[-_])/i.test(model)) q *= 0.6;
        if (needVision && !(prior.vision > 0)) continue;
        if (needTools && p.noTools) continue;
        if (needTools && p.keyless && !p.local) q *= 0.5;
        const rel = this.stats.reliability(id, model);
        let speed = 1;
        if (st.ttft != null && !quality) speed = task === "fast" ? Math.max(0.3, 1 - st.ttft / 8000) : Math.max(0.6, 1 - st.ttft / 30000);
        let score = q * (quality ? 0.7 + 0.3 * rel : 0.4 + 0.6 * rel) * speed;   // Max: strength first, a few lucky answers don't outrank it
        if (diverse && st.ok > 0) score *= 1.5;             // other families: proven models first, untried ones still possible
        if (p.keyless && !p.local) score *= 0.6;          // public gateways: last resort
        if (p.local) score *= task === "fast" ? 0.2 : 0.35; // this CPU is slow; local is for private/offline
        if (/:free$/.test(model)) score *= 0.95;
        const lim = this.limits[id];                        // provider says it is nearly out of requests: go elsewhere first
        if (lim && lim.resetAt > now && lim.remaining <= 2) score *= 0.25;
        const pin = (this.pins[task] || []).indexOf(id + ":" + model);
        // measured winners first — in Max only a nudge: the benchmark rewards speed, Max wants strength (measured on the
        // PC: a pinned flash-lite model kept drafting every Max answer)
        if (pin >= 0) score += (1 - pin * 0.05) * (quality ? 0.15 : 1);
        if (lang === "he" && this.pins.he) {               // measured: some fast models answer Hebrew with gibberish or in Arabic
          const hp = this.pins.he.indexOf(id + ":" + model);
          if (hp >= 0) score += (1.2 - hp * 0.05) * (quality ? 0.1 : 1);
          else if ((this.pins.heBad || []).includes(id + ":" + model)) score *= 0.1;
        }
        if (lang === "he" && st.heWrong && !(this.pins.he || []).includes(id + ":" + model)) score *= 0.05;   // caught answering in Arabic
        // small models are weak in Hebrew (measured: a 7B "mini" model got "capital of Canada?" wrong) unless measured good
        if (lang === "he" && /(\b|[-_])(1b|3b|7b|8b|a1b|a3b|mini|nano|tiny|small|lite)\b/i.test(model) && !(this.pins.he || []).includes(id + ":" + model)) score *= 0.35;
        // tiny models (≤4B) can chat but not work: measured 2026-11-20, a 1.7B free model was picked for the agent and
        // answered in its own tool format; for code, analysis, long and tool work they come last
        if (task !== "fast" && task !== "chat" && /(\b|[-_])(0\.\d+b|1(\.\d)?b|2b|3b|4b|e2b|e4b)\b/i.test(model)) score *= 0.15;
        if (avoidFamily && family(model) === avoidFamily) score *= 0.05;   // a checker from another family, unless none is left
        out.push({ provider: id, model, score, family: family(model) });
      }
    }
    out.sort((a, b) => b.score - a.score);
    // Measured 2026-11-20: with one account out of quota, all 8 slots were its models (37 Gemini models listed) and
    // every request failed before reaching the accounts that still worked. At most 3 per account in the list;
    // the rest go to other accounts (unless only one account is asked for).
    if (quality) {
      // Retain one strong, previously reachable account ahead of catalog-only candidates.
      const index = out.findIndex(c => {
        const p = this.providers[c.provider], prior = priorFor(c.model);
        return !p.local && !p.keyless && this.stats.peek(c.provider, c.model).ok > 0
          && (prior[task] ?? prior.chat) >= 0.8 && !/(?:^|[-_/])(lite|mini|nano|tiny|small)(?:$|[-_/])/i.test(c.model);
      });
      if (index > 0) out.unshift(out.splice(index, 1)[0]);
    }
    const perProvider = {}, first = [], rest = [];
    for (const c of out) ((perProvider[c.provider] = (perProvider[c.provider] || 0) + 1) <= 3 ? first : rest).push(c);
    return [...first, ...rest].slice(0, limit);
  }

  /** Pauses survive a restart (measured: after an update the gateway forgot that Groq and OpenRouter were out for the day). */
  exportState() { return { parked: this.parked, quotaStrikes: this.quotaStrikes }; }
  importState(o) {
    const now = Date.now();
    for (const [id, v] of Object.entries(o?.parked || {})) if (v && v.until > now) this.parked[id] = v;
    Object.assign(this.quotaStrikes, o?.quotaStrikes || {});
  }

  /** A 429 from several different models of one account within 2 minutes means the account (not the model) is out:
   *  pause the whole account instead of walking through its model list. */
  noteQuota(id, model) {
    const now = Date.now();
    const hits = (this.quotaHits[id] = (this.quotaHits[id] || []).filter((h) => now - h.at < 120000 && h.model !== model));
    hits.push({ model, at: now });
    if (hits.length < 3) return;
    const day = new Date().toISOString().slice(0, 10), st = this.quotaStrikes[id];
    const n = st?.day === day ? st.n + 1 : 1;
    this.quotaStrikes[id] = { day, n };
    const mins = Math.min(120, 15 * 2 ** (n - 1));
    this.parked[id] = { until: now + mins * 60000, reason: `out of quota on several models — paused ${mins} min` };
    this.quotaHits[id] = [];
  }

  /** The models of one account that have actually answered. null = nothing proven yet (cold start: everything is open).
   *  Measured: 771 models listed, ~6 answered; trying the rest cost seconds on every request. */
  pool(id) {
    const ok = (this.models[id] || []).filter((m) => this.stats.peek(id, m).ok > 0);
    return ok.length ? new Set(ok) : null;
  }

  /** Once in a while, give one untried model of a proven account a chance (new models appear; pools must not fossilise). */
  pickExplore(task) {
    this.explore = null;
    if (++this.requests % 15 !== 0) return;
    const now = Date.now();
    const options = [];
    for (const id of this.enabledProviders()) {
      const p = this.providers[id];
      if (p.local || p.keyless || this.parked[id]?.until > now || !this.pool(id)) continue;
      for (const m of this.models[id] || []) {
        const st = this.stats.peek(id, m);
        if (!st.ok && !st.fail && !NOT_CHAT.test(m)) options.push({ provider: id, model: m, q: priorFor(m)[task] ?? 0 });
      }
    }
    options.sort((a, b) => b.q - a.q);
    if (options.length) this.explore = options[0];
  }

  /** Read rate-limit headers (Groq, OpenRouter and others send them) so the next request can avoid an exhausted account. */
  noteLimits(id, headers) {
    const g = (n) => headers?.get?.(n);
    const rem = g("x-ratelimit-remaining-requests") ?? g("x-ratelimit-remaining");
    if (rem == null) return;
    const reset = g("x-ratelimit-reset-requests") ?? g("x-ratelimit-reset");
    this.limits[id] = { remaining: Number(rem), resetAt: Date.now() + parseResetMs(reset) };
  }

  /**
   * Routed chat completion with failover.
   * req: OpenAI-style { messages, tools?, temperature?, max_tokens?, response_format? }
   * opt: { task?, onDelta?(text), signal?, privateData?, prefer?: "provider:model", exclude?, families? }
   * returns { content, tool_calls, provider, model, task, usage, attempts, ms }
   */
  async chat(req, opt = {}) {
    const t0 = Date.now();
    if (!Object.keys(this.models).length) await this.refreshModels();
    const task = opt.task || classify(req.messages);
    this.pickExplore(task);
    const lang = /[\u0590-\u05FF]/.test(lastUserText(req.messages)) ? "he" : "";
    const need = estimateTokens(req.messages) + 2000;
    let list = this.candidates(task, { needTools: !!req.tools?.length, needVision: hasImages(req.messages),
                                       privateData: opt.privateData, exclude: opt.exclude, families: opt.families, lang, quality: opt.quality, avoidFamily: opt.avoidFamily });
    if (opt.prefer) {
      const [pp, ...mm] = opt.prefer.split(":"), pm = mm.join(":");
      list = [{ provider: pp, model: pm, score: 99, family: family(pm) }, ...list.filter((c) => !(c.provider === pp && c.model === pm))];
    }
    // Offline safety net: a local model is always the last resort, even when 8 cloud candidates rank above it
    // (without internet they all fail fast and the local one answers).
    if (!list.some((c) => this.providers[c.provider]?.local)) {
      const local = this.candidates(task, { needTools: !!req.tools?.length, needVision: hasImages(req.messages), privateData: opt.privateData,
                                            exclude: opt.exclude, limit: 200 }).find((c) => this.providers[c.provider]?.local);
      if (local) list.push(local);
    }
    // an empty list is not the end: the rescue round below re-checks every account (measured: after a long run every
    // free channel was cooling down and the next task failed at once with "No model available")
    const attempts = [];
    let partial = "", kept = null, fatal = false;
    for (const c of list) {
      if (opt.signal?.aborted) break;
      const win = this.ctx[c.provider]?.[c.model];
      if (win && need > win * 0.92) { attempts.push({ ...c, ok: false, error: `too long for this model (${need} > ${win} tokens)` }); continue; }
      if (this.disabled[c.provider] || this.parked[c.provider]?.until > Date.now()) continue;   // found out during this request
      const messages = partial
        ? [...req.messages, { role: "assistant", content: partial },
           { role: "user", content: "Your previous answer was cut off. Continue exactly where it stopped, without repeating anything." }]
        : req.messages;
      // Hebrew question: hold the first words back until the script is clear. Measured 2026-11-20: a small Arabic
      // model answered "what is the capital of Canada?" (in Hebrew) with an Arabic text about Bitcoin.
      let held = "", passed = lang !== "he" || !!partial;
      const flush = (final) => {
        const letters = (held.match(/\p{L}/gu) || []).length;
        if (!final && letters < 12 && held.length < 80) return;
        if (wrongScript(held)) { const e = new Error("answered a Hebrew question in another script (Arabic)"); e.wrongLang = true; throw e; }
        passed = true; partial += held; if (held) opt.onDelta?.(held); held = "";
      };
      const sink = (d) => { if (passed) { partial += d; opt.onDelta?.(d); } else { held += d; flush(false); } };
      try {
        const r = await this._call(c, { ...req, messages }, opt, sink);
        if (!passed) flush(true);
        attempts.push({ ...c, ok: true, ms: r.ms });
        const out = { ...r, content: partial || r.content, provider: c.provider, model: c.model, task, attempts, ms: Date.now() - t0 };
        // Ended without "stop" in the middle of a sentence (measured: "The book was written by" and nothing more):
        // the next model continues it, like a broken stream. If nobody can, the partial answer is still returned.
        if (cutOff(out) && list.indexOf(c) < list.length - 1 && !opt.signal?.aborted) {
          kept = out; this.log(`cut off ${c.provider}:${c.model} (finish ${r.finish_reason || "none"}), continuing with the next model`); continue;
        }
        return out;
      } catch (e) {
        if (e.wrongLang) { const st = this.stats.get(c.provider, c.model); st.heWrong = (st.heWrong || 0) + 1; }
        attempts.push({ ...c, ok: false, error: String(e.message || e).slice(0, 200) });
        this.log(`fail ${c.provider}:${c.model}: ${e.message}`);
        if (e.fatal) { fatal = true; break; }
      }
    }
    if (kept) return { ...kept, content: partial || kept.content, attempts, ms: Date.now() - t0 };
    // Rescue round. Measured 2026-11-20 on the phone: "hi" failed after 6 Gemini models (quota, 503) while other
    // accounts and the free no-key channels were never tried. Before giving up, every other account gets one try with
    // its best model, ignoring cool-downs and "dead" marks (those are guesses; this is the last chance).
    if (!opt.signal?.aborted && !opt.noRescue && !fatal) {
      const tried = new Set(attempts.map((a) => a.provider));
      const missing = this.enabledProviders().filter((id) => !tried.has(id) && !(this.models[id] || []).length);
      if (missing.length) await this.refreshModels(true, missing).catch(() => {});
      for (const id of this.enabledProviders()) {
        if (tried.has(id) || opt.signal?.aborted) continue;
        if (opt.privateData && this.providers[id].keyless && !this.providers[id].local) continue;
        const best = (this.models[id] || []).filter((m) => !NOT_CHAT.test(m) && !(opt.exclude || []).includes(id + ":" + m) && (!opt.families || opt.families.includes(family(m))))
          .map((m) => ({ provider: id, model: m, score: (priorFor(m)[task] ?? priorFor(m).chat) + (this.stats.peek(id, m).ok ? 1 : 0), family: family(m) }))
          .sort((a, b) => b.score - a.score)[0];
        if (!best) continue;
        try {
          let text = "";
          const r = await this._call(best, req, opt, (d) => { text += d; opt.onDelta?.(d); });
          if (lang === "he" && wrongScript(r.content)) throw new Error("answered a Hebrew question in another script (Arabic)");
          attempts.push({ ...best, ok: true, ms: r.ms, rescue: true });
          return { ...r, content: text || r.content, provider: id, model: best.model, task, attempts, ms: Date.now() - t0 };
        } catch (e) {
          attempts.push({ ...best, ok: false, error: String(e.message || e).slice(0, 200), rescue: true });
          this.log(`rescue fail ${id}:${best.model}: ${e.message}`);
        }
      }
    }
    throw new GatewayError(humanFailure(attempts, this.providers, this.allowKeyless), attempts);
  }

  async _call(c, req, opt, onDelta) {
    this.calls = (this.calls || 0) + 1;
    const p = this.providers[c.provider];
    const body = { model: c.model, messages: req.messages, stream: true };
    for (const k of ["temperature", "top_p", "max_tokens", "tools", "tool_choice", "response_format", "stop", "seed"]) {
      if (req[k] !== undefined) body[k] = req[k];
    }
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    opt.signal?.addEventListener?.("abort", onAbort);
    let firstTimer = setTimeout(() => ctl.abort(), this.firstTokenTimeoutMs);
    const t0 = Date.now();
    this.stats.count(c.provider, c.model);
    let res;
    try {
      const url = p.native === "gemini"
        ? `${p.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(c.model)}:streamGenerateContent?alt=sse`
        : p.baseUrl.replace(/\/$/, "") + "/chat/completions";
      res = await this.fetch(url, { method: "POST", headers: this.headers(c.provider),
        body: JSON.stringify(p.native === "gemini" ? toGemini(req) : body), signal: ctl.signal });
    } catch (e) {
      clearTimeout(firstTimer);
      this.stats.failure(c.provider, c.model, e, 30000);
      throw e;
    }
    if (!res.ok) {
      clearTimeout(firstTimer);
      const full = await res.text().catch(() => ""), txt = full.slice(0, 300);
      const ra = Number(res.headers.get?.("retry-after")) || 0;
      this.noteLimits(c.provider, res.headers);
      const accountRequirement = c.provider === "vercel" && res.status === 403 && full.includes("customer_verification_required")
        ? "AI Gateway account verification requires a valid payment method"
        : c.provider === "sambanova" && res.status === 402 && full.includes("PAYMENT_METHOD_REQUIRED")
          ? "a payment method is required on this account" : "";
      if (accountRequirement) {
        this.parked[c.provider] = { until: Date.now() + 3600e3, reason: accountRequirement };
        this.stats.failure(c.provider, c.model, accountRequirement, 3600e3);
      } else if ((res.status === 402 || BILLING_RX.test(txt)) && this.providers[c.provider]?.freeModels && !this.providers[c.provider].freeModels.test(c.model)) {
        // no credit, but this account also has free models (Z.ai's GLM Flash): only the paid model is set aside
        this.stats.failure(c.provider, c.model, "paid model, no credit: " + txt, 24 * 3600e3);
      } else if (res.status === 402 || BILLING_RX.test(txt)) {
        // the account itself has no credit: park the whole provider instead of trying its models one by one
        this.parked[c.provider] = { until: Date.now() + 6 * 3600e3, reason: "no credit or balance on this account" };
        this.stats.failure(c.provider, c.model, txt, 6 * 3600e3);
      } else if (res.status === 429 && /limit:\s*0\b|quotaValue"\s*:\s*"?0(?:"|[,}])|free.?tier.{0,40}not|not available on the free/i.test(full)) {
        this.stats.failure(c.provider, c.model, "not on this plan: " + txt, 24 * 3600e3);
      } else if (res.status === 429 && (p.native === "gemini" || /PerDay[A-Za-z]*PerModel|PerModel[A-Za-z]*PerDay/.test(full))) {
        const daily = /PerDay|per.?day|daily/i.test(full);
        this.stats.failure(c.provider, c.model, "model quota: " + txt, Math.max(ra * 1000, daily ? 3600e3 : 60000));
      } else if (res.status === 429 && DAILY_RX.test(txt)) {
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        const until = reset > Date.now() && reset <= Date.now() + 25 * 3600e3 ? reset : nextUtcMidnight();
        this.parked[c.provider] = { until, reason: "free daily limit reached (resets " + new Date(until).toISOString() + ")" };
        this.stats.failure(c.provider, c.model, txt, 3600e3);
      } else if (res.status === 429) { this.stats.failure(c.provider, c.model, "429 " + txt, Math.max(ra * 1000, 60000)); this.noteQuota(c.provider, c.model); }
      else if (res.status === 403) this.stats.failure(c.provider, c.model, "model access denied", 3600e3);
      else if (res.status === 401) { this.disabled[c.provider] = `key rejected (${res.status})`; this.stats.failure(c.provider, c.model, txt); }
      else if ((res.status === 400 || res.status === 413) && /context|too long|too many tokens|maximum.{0,20}(length|tokens)|request too large|payload too large/i.test(txt))
        this.stats.failure(c.provider, c.model, "too long: " + txt, 0);   // this request was too big for it; the model is fine
      else if (res.status === 404 || res.status === 400) this.stats.failure(c.provider, c.model, txt, 6 * 3600e3); // model gone / unsupported params
      else this.stats.failure(c.provider, c.model, txt, 20000);
      throw new Error(`HTTP ${res.status} ${txt}`);
    }
    this.noteLimits(c.provider, res.headers);
    let content = "", ttft = 0, usage = null, finish = null;
    const tool = {}; // index -> {id, name, arguments}
    const ct = res.headers.get?.("content-type") || "";
    try {
      if (!ct.includes("text/event-stream") && !res.body?.getReader) {
        let j = await res.json();
        if (p.native === "gemini") j = fromGemini(Array.isArray(j) ? j[0] || {} : j, true);
        clearTimeout(firstTimer);
        ttft = Date.now() - t0;
        const m = j.choices?.[0]?.message || {};
        content = m.content || "";
        if (content) onDelta(content);
        (m.tool_calls || []).forEach((tc, i) => (tool[i] = { id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments || "" }));
        usage = j.usage;
        finish = j.choices?.[0]?.finish_reason;
      } else {
        const reader = res.body.getReader(), dec = new TextDecoder();
        let buf = "", idleTimer = null;
        // Measured 2026-11-20: a stream that stalls after its first words hung a whole benchmark for minutes.
        // No bytes for idleTimeoutMs = the stream is dead: abort, count it as a failure, fail over (the partial
        // answer is kept and continued by the next model).
        const idle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => ctl.abort(), this.idleTimeoutMs); };
        idle();
        try {
        for (;;) {
          let value, done;
          try { ({ value, done } = await reader.read()); }
          catch (e) { clearTimeout(idleTimer); throw ctl.signal.aborted && !opt.signal?.aborted ? new Error(`stream stalled (no data for ${this.idleTimeoutMs / 1000} s)`) : e; }
          if (done) { clearTimeout(idleTimer); break; }
          idle();
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            let j;
            try { j = JSON.parse(data); } catch { continue; }
            if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
            if (p.native === "gemini") j = fromGemini(j);
            const ch = j.choices?.[0];
            if (j.usage) usage = j.usage;
            if (!ch) continue;
            if (ch.finish_reason) finish = ch.finish_reason;
            const d = ch.delta || {};
            const piece = d.content || "";
            if ((piece || d.tool_calls || d.reasoning || d.reasoning_content) && firstTimer) { clearTimeout(firstTimer); firstTimer = null; ttft = Date.now() - t0; }
            if (piece) { content += piece; onDelta(piece); }
            for (const tc of d.tool_calls || []) {
              const k = tc.index ?? 0;
              tool[k] = tool[k] || { id: "", name: "", arguments: "" };
              if (tc.id) tool[k].id = tc.id;
              if (tc.function?.name) tool[k].name += tc.function.name;
              if (tc.function?.arguments) tool[k].arguments += tc.function.arguments;
            }
          }
        }
        } finally { clearTimeout(idleTimer); }   // an error mid-stream (provider error, wrong script) must not leave the timer alive
      }
    } catch (e) {
      clearTimeout(firstTimer);
      ctl.abort();
      this.stats.failure(c.provider, c.model, e, 30000);
      throw e;
    } finally {
      opt.signal?.removeEventListener?.("abort", onAbort);
    }
    clearTimeout(firstTimer);
    const tool_calls = Object.values(tool).filter((t) => t.name).map((t, i) => ({ id: t.id || "call_" + i, type: "function", function: { name: t.name, arguments: t.arguments } }));
    if (!content && !tool_calls.length) {
      this.stats.failure(c.provider, c.model, "empty answer", 60000);
      throw new Error("empty answer");
    }
    const ms = Date.now() - t0, outTok = usage?.completion_tokens || Math.ceil(content.length / 4);
    this.stats.success(c.provider, c.model, ttft || ms, outTok / Math.max(0.001, (ms - ttft) / 1000));
    return { content, tool_calls, usage, finish_reason: finish, ms };
  }

  status() {
    return {
      providers: Object.fromEntries(Object.entries(this.providers).map(([id, p]) => [id, {
        name: p.name, enabled: this.enabledProviders().includes(id),
        disabled: this.disabled[id] || (this.parked[id]?.until > Date.now() ? this.parked[id].reason : ""),
        hasKey: !!this.keys[id], keyless: !!p.keyless, models: (this.models[id] || []).length, free: p.free, keyUrl: p.keyUrl, signIn: p.signIn }])),
      stats: this.stats.toJSON(),
    };
  }
}
