# MyChat

One brain, two screens: a model gateway and reasoning layer shared by the PC (Open WebUI + Kestrel) and an
Android app. Plain JavaScript with no dependencies, so the same `core/` runs in Node, a WebView, or a worker.

## Layers

| Layer | Where | What it does |
|---|---|---|
| `core/providers.mjs` | everywhere | Catalogue of OpenAI-compatible providers (Gemini, NVIDIA, OpenRouter, Groq, Mistral, Z.ai, …, keyless gateways, local Ollama) and quality priors per task |
| `core/router.mjs` | everywhere | Classifies each request without a model call (chat / code / reason / long / vision / fast), ranks models by prior × measured reliability × measured speed, fails over on 429/5xx/timeouts, continues a broken stream with the next model, learns rate limits, disables rejected keys |
| `core/reason.mjs` | everywhere | Strategies: `auto`, `fast`, `max` (draft → review by a **different model family** → revise only on real issues), `consensus` (3 families in parallel → aggregator) |
| `pc/server.mjs` | PC | OpenAI-compatible endpoint on `127.0.0.1:11500` for Open WebUI and Kestrel; team progress streamed as `reasoning_content`; local Connections page for keys |
| Android app | phone | (next phase) new UI + the same `core/` in-app; keys in the Android Keystore |

## Principles

- Keys stay on your devices and go only to the provider they belong to. Nothing in this repo may contain a key.
- Official access only: keys created on each provider's site (most accept "Sign in with Google"). No borrowed OAuth
  clients and no quota evasion — those get accounts blocked.
- Private chats (`mychat/private`) never leave the PC; public no-key gateways never receive private requests.
- Quality claims are measured: routing priors are starting points, replaced by eval results (`pins`).

## Run on the PC

```
node pc/server.mjs        # then open http://127.0.0.1:11500/connections to add keys
npm test
```
State (keys, token, stats) lives in `%APPDATA%\MyChat`.
