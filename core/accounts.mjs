// MyChat — connecting accounts, as easily as each provider allows (and only in ways they allow).
//
//  one-tap   OpenRouter OAuth PKCE: sign in (Google works) -> the app receives a user-controlled key.
//            One account reaches Claude, GPT, Gemini, GLM, Kimi, DeepSeek, ... No client registration, no secret.
//  guided    Providers without an app-OAuth program (Gemini, NVIDIA, Groq, Mistral, Anthropic, Z.ai, HF token):
//            open the exact key page, the person signs in with Google there, copies the key; the app recognises
//            the key by its shape, checks it live and stores it.
//  never     Consumer-subscription logins (Claude.ai, Gemini CLI): forbidden for third-party apps, accounts get blocked.
// Pure JavaScript (WebCrypto), runs in Node 18+, browsers and WebViews.

const b64url = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export async function pkcePair() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const verifier = b64url(raw);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

export function openRouterAuthUrl(callbackUrl, challenge) {
  return "https://openrouter.ai/auth?callback_url=" + encodeURIComponent(callbackUrl) +
         "&code_challenge=" + challenge + "&code_challenge_method=S256";
}

/** Exchange the code from the callback for the person's OpenRouter key. */
export async function openRouterExchange(code, verifier, fetchImpl = fetch) {
  const r = await fetchImpl("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  if (!r.ok) throw new Error(`OpenRouter refused the code (HTTP ${r.status})`);
  const j = await r.json();
  if (!j.key) throw new Error("OpenRouter returned no key");
  return j.key;
}

// Recognise a pasted key by its shape. Order matters: most specific first.
export const KEY_SHAPES = [
  ["openrouter", /\bsk-or-v1-[A-Za-z0-9]{40,}\b/],
  ["anthropic", /\bsk-ant-api\d\d-[A-Za-z0-9_-]{40,}\b/],
  ["nvidia", /\bnvapi-[A-Za-z0-9_-]{40,}\b/],
  ["groq", /\bgsk_[A-Za-z0-9]{40,}\b/],
  ["google", /\bAIza[0-9A-Za-z_-]{35}\|[A-Za-z0-9:_-]{8,}/],   // Google Programmable Search: API_KEY|ENGINE_ID
  ["gemini", /\bAIza[0-9A-Za-z_-]{35}\b(?!\|)/],
  ["gemini", /\bAQ\.[A-Za-z0-9_-][A-Za-z0-9_.-]{30,}/],          // Google's new Auth key format (AI Studio, 2026)
  ["huggingface", /\bhf_[A-Za-z0-9]{30,}\b/],
  ["github", /\b(github_pat_[A-Za-z0-9_]{60,}|gh[pousr]_[A-Za-z0-9]{36,})\b/],
  ["cerebras", /\bcsk-[A-Za-z0-9]{40,}\b/],
  ["xai", /\bxai-[A-Za-z0-9]{40,}\b/],
  ["openai", /\bsk-(proj|svcacct|admin)-[A-Za-z0-9_-]{40,}\b/],
  ["fireworks", /\bfw_[A-Za-z0-9]{20,}\b/],
  ["tavily", /\btvly-[A-Za-z0-9_-]{20,}\b/],
  ["jina", /\bjina_[A-Za-z0-9_-]{40,}\b/],
  ["brave", /\bBSA[A-Za-z0-9_-]{20,}\b/],
];
export const SEARCH_KEYS = new Set(["tavily", "jina", "brave", "serper", "google", "exa"]);

/** Find every recognisable key in a pasted text (a key page copy, a note, several keys at once). */
export function detectKeys(text) {
  const out = [];
  const whole = String(text || "").trim();
  if (/^[a-f0-9]{40}$/.test(whole)) return [{ provider: "serper", key: whole }];                 // Serper: 40 hex
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(whole)) return [{ provider: "exa", key: whole }];
  for (const [provider, rx] of KEY_SHAPES) {
    const g = new RegExp(rx.source, "g");
    for (const m of String(text || "").matchAll(g)) if (!out.some((o) => o.key === m[0])) out.push({ provider, key: m[0] });
  }
  return out;
}

/**
 * Check a key against its provider without spending tokens (model list). Returns { ok, models, error }.
 * For keys whose shape is ambiguous (Mistral, Z.ai: plain 32-char strings), call with `candidates` to try each.
 */
const AUTH_ERR = /api[ _-]?key|unauthori[sz]ed|authenticat|invalid.{0,20}(key|token)|permission|forbidden/i;

export async function validateKey(provider, key, providers, fetchImpl = fetch) {
  const p = providers[provider];
  if (!p) return { ok: false, error: "unknown provider" };
  const base = p.baseUrl.replace(/\/$/, "");
  const hdr = (k) => ({ ...(p.headers || {}), ...(p.keyHeader ? { [p.keyHeader]: k } : { Authorization: "Bearer " + k }) });
  try {
    const r = await fetchImpl(base + "/models" + (p.native === "gemini" ? "?pageSize=1000" : ""), { headers: hdr(key) });
    if (r.status === 401 || r.status === 403) return { ok: false, error: "key rejected" };
    if (!r.ok) return { ok: false, error: "HTTP " + r.status };
    const j = await r.json();
    const models = (j.data || j.models || []).map((m) => (m.id || m.name || "").replace(/^models\//, "")).filter(Boolean);
    // Some providers list their models without any key: a 200 there proves nothing. Measured: SambaNova accepted a Gemini key.
    const bogus = await fetchImpl(base + "/models", { headers: hdr("mychat-invalid-key-probe") }).catch(() => null);
    if (bogus && bogus.ok && p.native !== "gemini") {
      const model = models.find((m) => !/embed|whisper|tts|guard|rerank/i.test(m)) || models[0];
      if (!model) return { ok: false, error: "could not check the key (no models)" };
      const c = await fetchImpl(base + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", ...hdr(key) },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }) });
      const txt = c.ok ? "" : await c.text().catch(() => "");
      if (c.status === 401 || c.status === 403 || (!c.ok && c.status !== 429 && AUTH_ERR.test(txt))) return { ok: false, error: "key rejected" };
    }
    return { ok: true, models: models.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export const PLAIN_KEY_PROVIDERS = ["mistral", "zai", "sambanova", "cohere", "siliconflow", "deepseek", "moonshot", "together"];
export async function identifyPlainKey(key, providers, candidates = PLAIN_KEY_PROVIDERS, fetchImpl = fetch) {
  for (const c of candidates) {
    const v = await validateKey(c, key, providers, fetchImpl);
    if (v.ok) return { provider: c, ...v };
  }
  return null;
}

/** How each provider is connected, for the Accounts screen. */
export const CONNECT = {
  openrouter: { how: "one-tap", label: "Connect with OpenRouter", note: "Sign in with Google · Claude, GPT, Gemini, GLM, Kimi, DeepSeek in one account" },
  puter: { how: "one-tap-web", label: "Connect Puter", note: "App only (browser SDK) · usage billed to your Puter account" },
  gemini: { how: "guided", note: "Google account · free tier" },
  nvidia: { how: "guided", note: "Free for prototyping (phone check once): DeepSeek, Kimi, Qwen3, GLM, MiniMax, Nemotron · ~40 requests/min" },
  groq: { how: "guided", note: "Google account · very fast" },
  anthropic: { how: "guided", note: "Claude directly · pay per use (Claude.ai subscriptions cannot be used by apps)" },
  mistral: { how: "guided", note: "Google account · Free mode, no card: Mistral Large, Devstral (coding), Codestral" },
  huggingface: { how: "guided", note: "Token with 'Make calls to Inference Providers'" },
  zai: { how: "guided", note: "GLM-5.3 · pay per use" },
  cohere: { how: "guided", note: "Google account · free trial key" },
  siliconflow: { how: "guided", note: "Google account · some models free" },
};

// ---------------------------------------------------------------- moving keys between your devices
// All keys in one encrypted text ("mychat-keys-v1:…") plus a short code shown on the sending device. Send the text any way
// you like (WhatsApp to yourself, e-mail); without the code it is useless (AES-256-GCM, key from PBKDF2-SHA256, 250k rounds).
export const BUNDLE_PREFIX = "mychat-keys-v1:";
const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
export function transferCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", r = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(r, (b) => A[b % A.length]).join("").replace(/(.{4})(?!$)/g, "$1-");
}
async function bundleKey(code, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(code.toUpperCase().replace(/[^A-Z0-9]/g, "")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 250000 }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function exportKeys(keys, code) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify({ v: 1, at: Date.now(), keys }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await bundleKey(code, salt), data));
  return BUNDLE_PREFIX + b64u(salt) + "." + b64u(iv) + "." + b64u(ct);
}
export async function importKeys(text, code) {
  const m = new RegExp(BUNDLE_PREFIX.replace(/[-]/g, "\\-") + "([\\w-]+)\\.([\\w-]+)\\.([\\w-]+)").exec(String(text || ""));
  if (!m) throw new Error("this is not a MyChat keys text");
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(m[2]) }, await bundleKey(code, unb64u(m[1])), unb64u(m[3]));
    return JSON.parse(new TextDecoder().decode(pt)).keys || {};
  } catch { throw new Error("wrong code (or the text was changed)"); }
}
