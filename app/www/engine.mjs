// The phone runs the same engine as the PC gateway: routing, failover, Max/Consensus, Truth Engine, web evidence.
import { Gateway } from "./core/router.mjs";
import { run, MODES } from "./core/reason.mjs";
import { Search } from "./core/search.mjs";
import { Ledger } from "./core/ledger.mjs";
import { PROVIDERS } from "./core/providers.mjs";
import { loadKeys, saveKeys } from "./vault.mjs";
import { respond } from "./core/assistant.mjs";

// Streaming needs the WebView's own fetch; providers that don't allow browser (CORS) calls go through Capacitor's
// native HTTP instead (complete answer, no token-by-token streaming). The choice is remembered per host.
const webFetch = (globalThis.CapacitorWebFetch || globalThis.fetch).bind(globalThis);
const nativeFetch = globalThis.fetch.bind(globalThis);
const corsOk = new Map(JSON.parse(localStorage.getItem("mychat.cors") || "[]"));
export async function smartFetch(url, init) {
  const host = new URL(url).host;
  if (nativeFetch !== webFetch && corsOk.get(host) === false) return nativeFetch(url, init);
  try {
    const r = await webFetch(url, init);
    if (!corsOk.get(host)) { corsOk.set(host, true); localStorage.setItem("mychat.cors", JSON.stringify([...corsOk])); }
    return r;
  } catch (e) {
    if (init?.signal?.aborted || nativeFetch === webFetch) throw e;
    corsOk.set(host, false);
    localStorage.setItem("mychat.cors", JSON.stringify([...corsOk]));
    return nativeFetch(url, init);
  }
}

const lsStore = (slot, max = 400_000) => ({
  load: () => { try { return JSON.parse(localStorage.getItem(slot) || "null"); } catch { return null; } },
  save: (v) => { const s = JSON.stringify(v); if (s.length < max) localStorage.setItem(slot, s); },
});

export const state = { keys: {}, gw: null, search: null, ledger: new Ledger(lsStore("mychat.ledger")), settings: {} };

export function settings() {
  try { return { allowKeyless: true, pins: {}, ...JSON.parse(localStorage.getItem("mychat.settings") || "{}") }; } catch { return { allowKeyless: true, pins: {} }; }
}
export function saveSettings(s) { localStorage.setItem("mychat.settings", JSON.stringify(s)); state.settings = s; build(); }

export function build() {
  state.settings = settings();
  const extra = { anthropic: { ...PROVIDERS.anthropic, headers: { ...(PROVIDERS.anthropic.headers || {}), "anthropic-dangerous-direct-browser-access": "true" } } };
  state.gw = new Gateway({ keys: state.keys, fetch: smartFetch, allowKeyless: state.settings.allowKeyless, allowLocal: false,
                           pins: state.settings.pins, extraProviders: extra });
  const statsSaved = lsStore("mychat.stats").load();
  if (statsSaved && state.gw.stats.load) state.gw.stats.load(statsSaved);
  state.search = new Search({ keys: state.keys, fetch: smartFetch });
  return state.gw;
}

export async function init() {
  state.keys = await loadKeys();
  build();
  state.gw.refreshModels().catch(() => {});
  return state;
}

export async function setKey(provider, key) {
  if (key) state.keys[provider] = key; else delete state.keys[provider];
  await saveKeys(state.keys);
  build();
  await state.gw.refreshModels(true).catch(() => {});
}

// ---------------------------------------------------------------- your PC as the brain (phone link)
// When the PC is paired and reachable (home Wi-Fi or Tailscale), the phone sends the work there: all the PC's accounts,
// local models and folders. If the PC can't be reached, the phone answers on its own as before.
let pcCache = { at: 0, base: null };
export async function pcLink(force = false) {
  const pc = state.settings.pc;
  if (!pc?.token || !pc.urls?.length) return null;
  if (!force && Date.now() - pcCache.at < 60000) return pcCache.base;
  let base = null;
  for (const u of pc.urls) {
    try { const r = await smartFetch(u + "/health", { signal: AbortSignal.timeout(2000) }); if (r.ok) { base = u; break; } } catch { /* next */ }
  }
  pcCache = { at: Date.now(), base };
  return base;
}
export function pcGateway(base) {
  const H = { Authorization: "Bearer " + state.settings.pc.token, "Content-Type": "application/json" };
  return {
    remote: true,
    async chat(req, opt = {}) {
      const model = opt.privateData ? "mychat/private" : opt.task === "fast" ? "mychat/fast" : "mychat/auto";
      const r = await smartFetch(base + "/v1/chat/completions", { method: "POST", headers: H, signal: opt.signal,
        body: JSON.stringify({ model, messages: req.messages, temperature: req.temperature, stream: false }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || "PC: HTTP " + r.status);
      return { content: j.choices?.[0]?.message?.content || "", provider: "pc", model: `${j.mychat?.provider || "?"}:${j.mychat?.model || "?"}` };
    },
  };
}
/** The engine for long work: the PC when linked, else this phone. */
export async function brain() { const b = await pcLink(); return b ? pcGateway(b) : state.gw; }

async function askPc(base, messages, { mode, onDelta, onStatus, signal }) {
  onStatus?.("On your PC…");
  const r = await smartFetch(base + "/v1/chat/completions", { method: "POST", signal,
    headers: { Authorization: "Bearer " + state.settings.pc.token, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "mychat/" + mode, messages, stream: true }) });
  if (!r.ok) throw new Error("PC: HTTP " + r.status);
  let content = "", why = "";
  if (r.body?.getReader) {
    const rd = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, k).trim(); buf = buf.slice(k + 2);
        if (!line.startsWith("data:") || line === "data: [DONE]") continue;
        try { const d = JSON.parse(line.slice(5)).choices?.[0]?.delta || {}; if (d.content) { content += d.content; onDelta?.(d.content); } if (d.reasoning_content) { why += d.reasoning_content; onStatus?.(d.reasoning_content.trim().split("\n").pop()); } } catch { /* partial */ }
      }
    }
  } else { content = await r.text(); onDelta?.(content); }
  const last = why.trim().split("\n").pop() || "";
  return { content, mode, trace: [{ step: "pc", by: last.replace(/^\[[^\]]*\]\s*/, "") || "your PC" }] };
}

export async function ask(messages, { mode = "auto", onDelta, onStatus, signal } = {}) {
  const base = await pcLink();
  if (base) {
    try { return await askPc(base, messages, { mode, onDelta, onStatus, signal }); }
    catch (e) { if (signal?.aborted) throw e; pcCache = { at: Date.now(), base: null }; onStatus?.("PC not reachable — answering on the phone"); }
  }
  if (!Object.keys(state.gw.models).length) await state.gw.refreshModels();
  const r = await run(state.gw, { messages }, { mode, onDelta, onStatus, signal, truth: { search: state.search, ledger: state.ledger } });
  try { if (state.gw.stats.toJSON) lsStore("mychat.stats").save(state.gw.stats.toJSON()); } catch { /* not essential */ }
  return r;
}

// ---------------------------------------------------------------- the one assistant (phone or PC)
export const memory = {
  get: () => localStorage.getItem("mychat.memory") || "",
  add: (line) => { const t = ((localStorage.getItem("mychat.memory") || "") + line + "\n").split("\n").filter(Boolean).slice(-200); localStorage.setItem("mychat.memory", t.join("\n") + "\n"); },
};
/** A job on the PC, polled. If the connection drops, keeps retrying (the PC keeps working); resumable by id. */
export async function pollJob(base, id, { onDelta, onStatus, signal, shown = 0 } = {}) {
  const H = { Authorization: "Bearer " + state.settings.pc.token };
  let fails = 0, lastStatus = "";
  for (;;) {
    if (signal?.aborted) throw new Error("stopped");
    try {
      const j = await (await smartFetch(base + "/jobs/" + id, { headers: H, signal: AbortSignal.timeout(15000) })).json();
      fails = 0;
      if (j.content?.length > shown) { onDelta?.(j.content.slice(shown)); shown = j.content.length; }
      if (j.statusLine && j.statusLine !== lastStatus) { lastStatus = j.statusLine; onStatus?.("PC · " + j.statusLine); }
      if (j.status === "done") return { content: j.content, ...(j.result || {}), remote: base, trace: [{ step: "pc", by: (j.result?.trace || []).map((t) => t.by).filter(Boolean).pop() || "your PC" }] };
      if (j.status === "error") throw Object.assign(new Error(j.error || "failed on the PC"), { final: true, detail: j.detail });
      if (!j.id) throw Object.assign(new Error("the PC no longer has this job"), { final: true });
    } catch (e) {
      if (e.final || signal?.aborted) throw e;
      if (++fails > 120) throw new Error("lost the connection to your PC; the answer is kept there — open this chat again later");
      onStatus?.("Waiting for your PC… (it keeps working)");
    }
    await new Promise((r) => setTimeout(r, fails ? Math.min(10000, 1500 * fails) : 1200));
  }
}
export async function assistant(messages, { mode = "auto", onDelta, onStatus, onStep, signal, fs, tools, onJob } = {}) {
  const base = await pcLink();
  if (base) {
    try {
      const r = await smartFetch(base + "/jobs", { method: "POST", signal, headers: { Authorization: "Bearer " + state.settings.pc.token, "Content-Type": "application/json" },
        body: JSON.stringify({ mode, messages: messages.map(({ role, content }) => ({ role, content })) }) });
      const job = await r.json();
      if (job.id) { onJob?.(job.id, base); return await pollJob(base, job.id, { onDelta, onStatus, signal }); }
    } catch (e) { if (signal?.aborted || e.final) throw e; pcCache = { at: Date.now(), base: null }; onStatus?.("PC not reachable — working on the phone"); }
  }
  if (!Object.keys(state.gw.models).length) await state.gw.refreshModels();
  const r = await respond(state.gw, { messages, fs, mode, onDelta, onStatus, onStep, signal, memory, tools,
    truth: { search: state.search, ledger: state.ledger } });
  try { if (state.gw.stats.toJSON) lsStore("mychat.stats").save(state.gw.stats.toJSON()); } catch { /* not essential */ }
  return r;
}

export { MODES };
