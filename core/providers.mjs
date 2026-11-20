// MyChat gateway — provider catalogue.
// Every provider here speaks the OpenAI Chat Completions protocol, so one client covers all of them.
// Keys are created by the person on each site (most allow "Sign in with Google"); they never leave the device
// except to the provider they belong to.
//
// `free` describes the free access as researched in Nov 2026; limits change, so the router learns real limits
// from 429 responses instead of trusting these notes.

export const PROVIDERS = {
  gemini: {
    name: "Google Gemini (AI Studio key)",
    // Native API: the new "AQ." auth keys are rejected by Google's OpenAI-compatible endpoint, the native one takes both formats
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    native: "gemini",
    keyHeader: "x-goog-api-key",
    noTools: true,
    keyUrl: "https://aistudio.google.com/apikey",
    signIn: "Google account",
    free: "Free tier on Flash models; limits shown in AI Studio",
    strengths: ["vision", "long", "chat", "reason"],
  },
  nvidia: {
    name: "NVIDIA build (NIM)",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyUrl: "https://build.nvidia.com/settings/api-keys",
    signIn: "NVIDIA Developer account",
    free: "Free endpoints: GLM-5.x, Kimi, DeepSeek, MiniMax, Nemotron, GPT-OSS (~40 RPM)",
    strengths: ["code", "reason", "long", "chat"],
  },
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/settings/keys",
    signIn: "Google account",
    free: ":free models, 20 RPM / 50 RPD (1,000 RPD after $10 credit); paid models incl. Claude, GLM-5.3",
    strengths: ["code", "reason", "chat", "vision", "long"],
    headers: { "HTTP-Referer": "https://github.com/haran4-cpu/MyChat", "X-Title": "MyChat" },
  },
  groq: {
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    signIn: "Google account",
    free: "~30 RPM, 1K RPD, 200K tokens/day per model; very fast",
    strengths: ["fast", "chat", "code"],
  },
  mistral: {
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    keyUrl: "https://console.mistral.ai/api-keys",
    signIn: "Google account",
    free: "Free plan credits (~$10/month); free mode may train on prompts unless opted out",
    strengths: ["code", "chat"],
  },
  anthropic: {
    name: "Anthropic (Claude, direct)",
    baseUrl: "https://api.anthropic.com/v1",
    keyUrl: "https://console.anthropic.com/settings/keys",
    signIn: "Google account",
    keyHeader: "x-api-key",
    headers: { "anthropic-version": "2023-06-01" },
    free: "Pay per use. Claude.ai subscriptions cannot be used by third-party apps (Anthropic terms)",
    strengths: ["code", "reason", "chat", "vision", "long"],
  },
  huggingface: {
    name: "Hugging Face Inference Providers",
    baseUrl: "https://router.huggingface.co/v1",
    keyUrl: "https://huggingface.co/settings/tokens/new?tokenType=fineGrained",
    signIn: "Hugging Face account (Google works)",
    free: "Small monthly credit; many open models incl. GLM, Kimi, DeepSeek, Qwen via partner providers",
    strengths: ["code", "chat", "reason"],
  },
  zai: {
    name: "Z.ai (GLM)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    signIn: "Google account",
    free: "Paid: GLM-5.3 $1.40/$4.40 per M tokens; GLM-5.3-Flash much cheaper",
    strengths: ["code", "reason", "long"],
  },
  cerebras: {
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    keyUrl: "https://cloud.cerebras.ai/",
    signIn: "Google account",
    free: "$5 / 30-day trial (card required since July 2026); extremely fast",
    strengths: ["fast", "code"],
  },
  sambanova: {
    name: "SambaNova",
    baseUrl: "https://api.sambanova.ai/v1",
    keyUrl: "https://cloud.sambanova.ai/apis",
    signIn: "Google account",
    free: "Small free tier (~20 RPD)",
    strengths: ["fast", "chat"],
  },
  github: {
    name: "GitHub Models",
    baseUrl: "https://models.github.ai/inference",
    keyUrl: "https://github.com/settings/personal-access-tokens",
    signIn: "GitHub account (token with models:read)",
    free: "Status uncertain in late 2026 (reports of retirement); verified live",
    strengths: ["chat", "code"],
  },
  cohere: {
    name: "Cohere",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    keyUrl: "https://dashboard.cohere.com/api-keys",
    signIn: "Google account",
    free: "Free trial key, no card (rate-limited; trial keys are for non-production use)",
    strengths: ["chat", "long"],
  },
  siliconflow: {
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.com/v1",
    keyUrl: "https://cloud.siliconflow.com/account/ak",
    signIn: "Google account",
    free: "Some models permanently free (DeepSeek/Qwen distills, ~1,000 RPM); others pay per use",
    strengths: ["chat", "code", "reason"],
  },
  deepseek: {
    name: "DeepSeek (direct)",
    baseUrl: "https://api.deepseek.com/v1",
    keyUrl: "https://platform.deepseek.com/api_keys",
    signIn: "Google account",
    free: "Pay per use, very cheap; no free tier",
    strengths: ["code", "reason", "chat"],
  },
  openai: {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    signIn: "Google account",
    free: "Pay per use (prepaid credit); no free tier. ChatGPT subscriptions cannot be used by apps",
    strengths: ["code", "reason", "chat", "vision"],
  },
  xai: {
    name: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai/",
    signIn: "Google or X account",
    free: "Pay per use (prepaid credit)",
    strengths: ["chat", "reason", "code"],
  },
  moonshot: {
    name: "Moonshot (Kimi, direct)",
    baseUrl: "https://api.moonshot.ai/v1",
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
    signIn: "Google account",
    free: "Pay per use",
    strengths: ["code", "reason", "long"],
  },
  together: {
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    keyUrl: "https://api.together.ai/settings/api-keys",
    signIn: "Google or GitHub account",
    free: "Pay per use; a few free models",
    strengths: ["chat", "code"],
  },
  fireworks: {
    name: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    keyUrl: "https://fireworks.ai/account/api-keys",
    signIn: "Google or GitHub account",
    free: "Pay per use (small starter credit)",
    strengths: ["chat", "code", "fast"],
  },
  // keyless public gateways: always available, lowest priority, never get private context by default
  kilo: {
    name: "Kilo Gateway (no key)",
    baseUrl: "https://api.kilo.ai/api/gateway",
    keyless: true,
    freeOnly: ":free",   // without a key only models tagged :free answer (others return 401 PAID_MODEL_AUTH_REQUIRED)
    free: "No key, ~200 requests/hour",
    strengths: ["chat", "code"],
  },
  llm7: {
    name: "LLM7 (no key)",
    baseUrl: "https://api.llm7.io/v1",
    keyless: true,
    free: "Anonymous access, small models",
    strengths: ["chat"],
  },
  pollinations: {
    name: "Pollinations (no key)",
    baseUrl: "https://text.pollinations.ai/openai",
    keyless: true,
    noModelList: true,
    models: ["openai"],
    free: "Anonymous, rate-limited per IP",
    strengths: ["chat"],
  },
  // the PC's own local models (only where reachable)
  ollama: {
    name: "Local (Ollama on this PC)",
    baseUrl: "http://127.0.0.1:11434/v1",
    keyless: true,
    local: true,
    free: "Unlimited, private, slow on this CPU",
    strengths: ["private", "offline"],
  },
};

// Priors: how good a model family is for a task (0-1), by name pattern. Only a starting point:
// the router multiplies these by measured success rate and latency, and the eval harness can override them.
// Ordered most specific first.
export const MODEL_PRIORS = [
  [/claude.*(opus|fable|mythos)/i, { code: 1.0, reason: 1.0, chat: 0.95, long: 0.9, vision: 0.9, fast: 0.3 }],
  [/claude.*sonnet/i, { code: 0.95, reason: 0.9, chat: 0.9, long: 0.9, vision: 0.85, fast: 0.5 }],
  [/glm-?5\.3(?!-?flash)/i, { code: 0.92, reason: 0.9, chat: 0.85, long: 0.9, fast: 0.3 }],
  [/glm-?5/i, { code: 0.85, reason: 0.82, chat: 0.8, long: 0.85, fast: 0.4 }],
  [/kimi.?k[23]/i, { code: 0.88, reason: 0.88, chat: 0.85, long: 0.85, fast: 0.35 }],
  [/deepseek.*(v4|v3\.[2-9]|r[12])/i, { code: 0.86, reason: 0.88, chat: 0.8, long: 0.7, fast: 0.35 }],
  [/gemini.*(pro|3\.\d+-pro)/i, { code: 0.85, reason: 0.9, chat: 0.88, long: 1.0, vision: 1.0, fast: 0.4 }],
  [/gemini.*flash/i, { code: 0.72, reason: 0.72, chat: 0.82, long: 0.95, vision: 0.95, fast: 0.85 }],
  [/minimax.*m2/i, { code: 0.84, reason: 0.8, chat: 0.8, long: 0.85, fast: 0.4 }],
  [/nemotron.*ultra/i, { code: 0.8, reason: 0.86, chat: 0.8, long: 0.95, fast: 0.3 }],
  [/qwen.*coder/i, { code: 0.85, reason: 0.65, chat: 0.65, fast: 0.6 }],
  [/qwen3/i, { code: 0.75, reason: 0.75, chat: 0.75, fast: 0.6 }],
  [/gpt-oss-120b/i, { code: 0.78, reason: 0.8, chat: 0.75, fast: 0.7 }],
  [/gpt-oss-20b/i, { code: 0.62, reason: 0.62, chat: 0.65, fast: 0.9 }],
  [/codestral|devstral/i, { code: 0.8, chat: 0.6, fast: 0.7 }],
  [/mistral.*(large|medium)/i, { code: 0.75, reason: 0.72, chat: 0.8, vision: 0.6, fast: 0.5 }],
  [/llama.?4/i, { code: 0.68, reason: 0.65, chat: 0.75, vision: 0.8, long: 0.8, fast: 0.75 }],
  [/llama.*(70b|405b)/i, { code: 0.65, reason: 0.65, chat: 0.72, fast: 0.6 }],
  [/allam/i, { code: 0.2, reason: 0.3, chat: 0.35, long: 0.2, fast: 0.4 }],   // Arabic-specialist 7B: measured answering Hebrew in Arabic
  [/gemma/i, { code: 0.55, reason: 0.55, chat: 0.65, vision: 0.6, fast: 0.7 }],
  [/(8b|7b|mini|small|nano|lite)/i, { code: 0.45, reason: 0.4, chat: 0.55, fast: 0.95 }],
];

export const DEFAULT_PRIOR = { code: 0.5, reason: 0.5, chat: 0.6, long: 0.4, vision: 0, fast: 0.5 };

export function priorFor(model) {
  for (const [re, p] of MODEL_PRIORS) if (re.test(model)) return { ...DEFAULT_PRIOR, ...p };
  return { ...DEFAULT_PRIOR };
}

// Models that obviously are not chat models (embeddings, image, audio, guard...) are never routed to.
export const NOT_CHAT = /(embed|rerank|whisper|tts|speech|audio|image|flux|stable-diffusion|sdxl|guard|moderation|clip|ocr|parse|retriev|vision-encoder|orpheus|playai|voice|transcrib|nano-banana|computer-use|imagen|veo-|lyria|robotics|native-audio|-live\b|aqa\b)/i;
