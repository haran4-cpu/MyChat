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
    s.ok++;
    s.ttft = s.ttft == null ? ttftMs : s.ttft * 0.7 + ttftMs * 0.3;
    if (tps) s.tps = s.tps == null ? tps : s.tps * 0.7 + tps * 0.3;
  }
  failure(p, model, err, cooldownMs) {
    const s = this.get(p, model);
    s.fail++;
    s.lastError = String(err).slice(0, 200);
    if (cooldownMs) s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + cooldownMs);
  }
  count(p, model) {
    const s = this.get(p, model), d = new Date().toISOString().slice(0, 10);
    if (s.day !== d) { s.day = d; s.today = 0; }
    s.today++;
  }
  reliability(p, model) {
    const s = this.get(p, model);
    return (s.ok + 1) / (s.ok + s.fail + 2); // Laplace: unknown = 0.5, earns trust with use
  }
  toJSON() { return Object.fromEntries(this.m); }
  load(obj) { for (const [k, v] of Object.entries(obj || {})) this.m.set(k, v); }
}

export class GatewayError extends Error {
  constructor(msg, attempts) { super(msg); this.attempts = attempts; }
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
    this.log = o.log || (() => {});
    this.firstTokenTimeoutMs = o.firstTokenTimeoutMs || 45000;
    this.pins = o.pins || {};  // task -> ["provider:model", ...] preferred order (from evals)
  }

  enabledProviders() {
    return Object.entries(this.providers).filter(([id, p]) => {
      if (this.disabled[id]) return false;
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
  async refreshModels(force = false) {
    const ids = this.enabledProviders();
    await Promise.all(ids.map(async (id) => {
      const p = this.providers[id];
      if (p.noModelList) { this.models[id] = p.models || []; return; }
      if (!force && this.modelsAt[id] && Date.now() - this.modelsAt[id] < 6 * 3600e3) return;
      try {
        const r = await this.fetch(p.baseUrl.replace(/\/$/, "") + "/models", { headers: this.headers(id) });
        if (r.status === 401 || r.status === 403) { this.disabled[id] = `key rejected (${r.status})`; return; }
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        const list = (j.data || j.models || []).map((m) => (m.id || m.name || "").replace(/^models\//, "")).filter(Boolean);
        this.models[id] = list.filter((m) => !NOT_CHAT.test(m) && (!/:free$/.test(m) || id === "openrouter"));
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
  candidates(task, { needTools = false, needVision = false, privateData = false, exclude = [], families = null, limit = 8 } = {}) {
    const now = Date.now(), out = [];
    for (const id of this.enabledProviders()) {
      const p = this.providers[id];
      if (privateData && p.keyless && !p.local) continue;
      for (const model of this.models[id] || []) {
        if (exclude.includes(id + ":" + model)) continue;
        if (families && !families.includes(family(model))) continue;
        const st = this.stats.get(id, model);
        if (st.cooldownUntil > now) continue;
        const prior = priorFor(model);
        let q = prior[task] ?? prior.chat;
        if (needVision && !(prior.vision > 0)) continue;
        if (needTools && p.keyless && !p.local) q *= 0.5;
        const rel = this.stats.reliability(id, model);
        let speed = 1;
        if (st.ttft != null) speed = task === "fast" ? Math.max(0.3, 1 - st.ttft / 8000) : Math.max(0.6, 1 - st.ttft / 30000);
        let score = q * (0.4 + 0.6 * rel) * speed;
        if (p.keyless && !p.local) score *= 0.6;          // public gateways: last resort
        if (p.local) score *= task === "fast" ? 0.2 : 0.35; // this CPU is slow; local is for private/offline
        if (/:free$/.test(model)) score *= 0.95;
        const pin = (this.pins[task] || []).indexOf(id + ":" + model);
        if (pin >= 0) score += 1 - pin * 0.05;            // measured winners first
        out.push({ provider: id, model, score, family: family(model) });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
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
    let list = this.candidates(task, { needTools: !!req.tools?.length, needVision: hasImages(req.messages),
                                       privateData: opt.privateData, exclude: opt.exclude, families: opt.families });
    if (opt.prefer) {
      const [pp, ...mm] = opt.prefer.split(":"), pm = mm.join(":");
      list = [{ provider: pp, model: pm, score: 99, family: family(pm) }, ...list.filter((c) => !(c.provider === pp && c.model === pm))];
    }
    if (!list.length) throw new GatewayError("No model available: add a key in Connections, or allow the free no-key channels.", []);
    const attempts = [];
    let partial = "";
    for (const c of list) {
      if (opt.signal?.aborted) break;
      const messages = partial
        ? [...req.messages, { role: "assistant", content: partial },
           { role: "user", content: "Your previous answer was cut off. Continue exactly where it stopped, without repeating anything." }]
        : req.messages;
      try {
        const r = await this._call(c, { ...req, messages }, opt, (d) => { partial += d; opt.onDelta?.(d); });
        attempts.push({ ...c, ok: true, ms: r.ms });
        return { ...r, content: partial || r.content, provider: c.provider, model: c.model, task, attempts, ms: Date.now() - t0 };
      } catch (e) {
        attempts.push({ ...c, ok: false, error: String(e.message || e).slice(0, 200) });
        this.log(`fail ${c.provider}:${c.model}: ${e.message}`);
        if (e.fatal) break;
      }
    }
    throw new GatewayError("All models failed: " + attempts.map((a) => `${a.provider}:${a.model} (${a.error})`).join("; "), attempts);
  }

  async _call(c, req, opt, onDelta) {
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
      res = await this.fetch(p.baseUrl.replace(/\/$/, "") + "/chat/completions",
        { method: "POST", headers: this.headers(c.provider), body: JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      clearTimeout(firstTimer);
      this.stats.failure(c.provider, c.model, e, 30000);
      throw e;
    }
    if (!res.ok) {
      clearTimeout(firstTimer);
      const txt = (await res.text().catch(() => "")).slice(0, 300);
      const ra = Number(res.headers.get?.("retry-after")) || 0;
      if (res.status === 429) this.stats.failure(c.provider, c.model, "429 " + txt, Math.max(ra * 1000, 60000));
      else if (res.status === 401 || res.status === 403) { this.disabled[c.provider] = `key rejected (${res.status})`; this.stats.failure(c.provider, c.model, txt); }
      else if (res.status === 404 || res.status === 400) this.stats.failure(c.provider, c.model, txt, 6 * 3600e3); // model gone / unsupported params
      else this.stats.failure(c.provider, c.model, txt, 20000);
      throw new Error(`HTTP ${res.status} ${txt}`);
    }
    let content = "", ttft = 0, usage = null, finish = null;
    const tool = {}; // index -> {id, name, arguments}
    const ct = res.headers.get?.("content-type") || "";
    try {
      if (!ct.includes("text/event-stream") && !res.body?.getReader) {
        const j = await res.json();
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
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
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
      }
    } catch (e) {
      clearTimeout(firstTimer);
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
        name: p.name, enabled: this.enabledProviders().includes(id), disabled: this.disabled[id] || "",
        hasKey: !!this.keys[id], keyless: !!p.keyless, models: (this.models[id] || []).length, free: p.free, keyUrl: p.keyUrl, signIn: p.signIn }])),
      stats: this.stats.toJSON(),
    };
  }
}
