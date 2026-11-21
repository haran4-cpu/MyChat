# MyChat

One brain, two screens: a model gateway and reasoning layer shared by the PC (Open WebUI + Kestrel) and an
Android app. Plain JavaScript with no dependencies, so the same `core/` runs in Node, a WebView, or a worker.

## Layers

| Layer | Where | What it does |
|---|---|---|
| `core/providers.mjs` | everywhere | Catalogue of OpenAI-compatible providers (Gemini, NVIDIA, OpenRouter, Groq, Mistral, Z.ai, …, keyless gateways, local Ollama) and quality priors per task |
| `core/router.mjs` | everywhere | Classifies each request without a model call (chat / code / reason / long / vision / fast), ranks models by prior × measured reliability × measured speed, fails over on 429/5xx/timeouts, continues a broken stream with the next model, learns rate limits, disables rejected keys |
| `core/reason.mjs` | everywhere | Strategies: `auto`, `fast`, `max` (draft → review by a **different model family** → revise only on real issues), `consensus` (3 families in parallel → aggregator) |
| `core/truth.mjs` | everywhere | **Truth Engine** — independent drafts from different families → claim ledger → each claim settled by truth memory, exact arithmetic, web evidence (the judge's quote must literally appear on the fetched page) or independent questioning (the checker never sees the draft) → votes weighted by learned model reliability → synthesis from settled claims only → deterministic slop pass that may not change a fact. Runs automatically for factual, current and numeric questions |
| `core/ledger.mjs` | everywhere | Truth memory across conversations + Dawid–Skene (one-coin EM) estimate of each model's accuracy per domain, from evidence-checked and unchecked votes |
| `core/search.mjs` | everywhere | Evidence: Wikipedia (keyless) + Brave, Tavily, Serper, Google Programmable Search, Exa; Jina Reader for page text; quote verification |
| `core/exact.mjs`, `core/slop.mjs` | everywhere | Exact rational arithmetic (BigInt); deterministic slop linter (EN/HE) and a fact-preservation check for rewrites |
| `core/accounts.mjs` | everywhere | Connecting accounts: OpenRouter one-tap (OAuth PKCE, sign in with Google → Claude, GPT, Gemini, GLM, Kimi, DeepSeek in one account); every other provider by a guided key flow — paste anything, the key is recognised by its shape, checked live, stored locally |
| `pc/server.mjs` | PC | OpenAI-compatible endpoint on `127.0.0.1:11500` for Open WebUI and Kestrel; team progress streamed as `reasoning_content`; local Connections page for keys |
| Android app | phone | (next phase) new UI + the same `core/` in-app; keys in the Android Keystore |

## Principles

- Keys stay on your devices and go only to the provider they belong to. Nothing in this repo may contain a key.
- Consumer subscriptions (Claude.ai, Gemini CLI login) are never used: both providers forbid it for third-party apps.
- Official access only: keys created on each provider's site (most accept "Sign in with Google"). No borrowed OAuth
  clients and no quota evasion — those get accounts blocked.
- Private chats (`mychat/private`) never leave the PC; public no-key gateways never receive private requests.
- Quality claims are measured: routing priors are starting points, replaced by eval results (`pins`).

## Measured, not claimed

`node tools/eval_truth.mjs --modes fast,verified` runs 29 known-answer questions (math, facts, Hebrew, and
false-premise traps that must be rejected) and reports accuracy, confidently-wrong answers and time per mode.

## Run on the PC

```
node pc/server.mjs        # then open http://127.0.0.1:11500/connections to add keys
npm test
```
State (keys, token, stats) lives in `%APPDATA%\MyChat`.

## Inside Open WebUI (recommended on the PC)

`openwebui/mychat_function.py` is an Open WebUI function. Once installed (Admin Panel → Functions), the MyChat models appear
in Open WebUI's model list, the gateway is started automatically on first use, and **MyChat · Accounts & keys** shows
every provider, a "Sign in with Google → OpenRouter" link that returns to the chat, and a dialog for pasting keys.
A message that is only an API key is connected, never sent to a model.

## Runs by itself (supervisor)

`pc/supervisor.mjs` keeps Ollama, Open WebUI, the MyChat gateway and Kestrel running: it starts what is down, checks
health every 20 s, restarts with back-off, and reloads MyChat/Kestrel when their code changes (Kestrel only when idle).
The Open WebUI function starts it on first use. Status: http://127.0.0.1:11510/status, also in "MyChat · Accounts".
`/update` in that chat installs the newest commit from this repo **only if its CI passed**, verifies every file and
backs up what it replaces. Settings, keys, state and logs are never touched.

Repo layout: `core/` engine (shared by PC and phone) · `pc/` gateway, supervisor, benchmark · `openwebui/` function ·
`app/` Android · `kestrel/` PC agent (Python) · `docs/` sign-in return page.
## On-demand local repair lab

On Windows, open `Repair-Lab.cmd` in the MyChat folder. It runs three small JavaScript repair fixtures against the installed Ollama models. By default it tries the coding model first and passes a useful failure message to the next model only when needed. The first accepted edit ends that trial. The report records proposals, latency, token counts where the backend supplies them, and validation results.

```powershell
.\Repair-Lab.cmd --task safe-integer
.\Repair-Lab.cmd --online --mychat-mode fast
.\Repair-Lab.cmd --online-only --task range
```

`--online` adds the PC MyChat gateway as a fallback. `--online-only` tests its selected mode directly. Those flags can use connected provider quota. The default uses only the local Ollama endpoint. Each run has an eight-minute deadline and at most four attempts per fixture; each provider request also has its own timeout. The fixtures contain synthetic data. Proposals are applied in memory and scored against reviewed equivalent rewrites. The lab writes a fresh report, leaves live projects and model weights alone, and has no scheduled execution.
