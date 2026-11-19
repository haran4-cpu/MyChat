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
  ["gemini", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["huggingface", /\bhf_[A-Za-z0-9]{30,}\b/],
  ["github", /\b(github_pat_[A-Za-z0-9_]{60,}|gh[pousr]_[A-Za-z0-9]{36,})\b/],
  ["cerebras", /\bcsk-[A-Za-z0-9]{40,}\b/],
];

/** Find every recognisable key in a pasted text (a key page copy, a note, several keys at once). */
export function detectKeys(text) {
  const out = [];
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
export async function validateKey(provider, key, providers, fetchImpl = fetch) {
  const p = providers[provider];
  if (!p) return { ok: false, error: "unknown provider" };
  try {
    const auth = p.keyHeader ? { [p.keyHeader]: key } : { Authorization: "Bearer " + key };
    const r = await fetchImpl(p.baseUrl.replace(/\/$/, "") + "/models", { headers: { ...auth, ...(p.headers || {}) } });
    if (r.status === 401 || r.status === 403) return { ok: false, error: "key rejected" };
    if (!r.ok) return { ok: false, error: "HTTP " + r.status };
    const j = await r.json();
    return { ok: true, models: (j.data || j.models || []).length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function identifyPlainKey(key, providers, candidates = ["mistral", "zai", "sambanova"], fetchImpl = fetch) {
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
  nvidia: { how: "guided", note: "Free endpoints: GLM, Kimi, DeepSeek, MiniMax, Nemotron" },
  groq: { how: "guided", note: "Google account · very fast" },
  anthropic: { how: "guided", note: "Claude directly · pay per use (Claude.ai subscriptions cannot be used by apps)" },
  mistral: { how: "guided", note: "Google account · free plan credits" },
  huggingface: { how: "guided", note: "Token with 'Make calls to Inference Providers'" },
  zai: { how: "guided", note: "GLM-5.3 · pay per use" },
};
