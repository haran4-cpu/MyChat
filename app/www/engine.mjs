// The phone runs the same engine as the PC gateway: routing, failover, Max/Consensus, Truth Engine, web evidence.
import { Gateway } from "./core/router.mjs";
import { run, MODES } from "./core/reason.mjs";
import { Search } from "./core/search.mjs";
import { Ledger } from "./core/ledger.mjs";
import { PROVIDERS } from "./core/providers.mjs";
import { loadKeys, saveKeys } from "./vault.mjs";

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

export async function ask(messages, { mode = "auto", onDelta, onStatus, signal } = {}) {
  if (!Object.keys(state.gw.models).length) await state.gw.refreshModels();
  const r = await run(state.gw, { messages }, { mode, onDelta, onStatus, signal, truth: { search: state.search, ledger: state.ledger } });
  try { if (state.gw.stats.toJSON) lsStore("mychat.stats").save(state.gw.stats.toJSON()); } catch { /* not essential */ }
  return r;
}

export { MODES };
