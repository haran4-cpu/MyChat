# Kestrel — a local engineering agent for your Ollama models

Kestrel turns the Qwen models already on this PC into an agent that reads, writes and organises files,
builds Word/Excel/PowerPoint/PDF documents, runs long multi-step missions, and checks its own work with
code instead of trusting the model's word. Standard-library Python only: no installs, works offline.

## Start

1. Make sure Ollama is running (the llama icon in the tray).
2. First time only: double-click **setup.bat**. It creates three model profiles from the models you
   already have (no download), checks the installation and runs the offline test suite.
3. Double-click **start.bat**. Your browser opens `http://127.0.0.1:8765`.
4. Optional: **smoke-test.bat** gives your real model a small task and checks the result (a few minutes on CPU).

## Inside Open WebUI (your main interface)

Kestrel also appears in Open WebUI (http://127.0.0.1:8080) as two models: **Kestrel** and
**Kestrel Mission (long task)**. Approvals pop up as Open WebUI confirmation dialogs, every tool step
shows as a collapsible card, and created files are links. Codex's gateway models (local-smart,
local-code-fast, local-code-edit, /calc, /rename, /fill) stay exactly as they were.

1. Run **start-background.bat** (Kestrel without a window; stop-kestrel.bat stops it).
2. The function is installed in Open WebUI as "Kestrel". If you ever need to reinstall it:
   `python -m kestrel openwebui-pipe` writes `state/openwebui_kestrel_function.py`;
   paste it in Admin Panel → Functions → +.

## What it can do

| Capability | How |
|---|---|
| Work with files and folders | list, read (text, code, docx, xlsx, pptx, pdf), search, find, write, edit, move, make folders |
| Folder access with approval | only approved folders; anything else triggers an *Allow / Deny* card, like Claude's own folder grants |
| Create documents | `.docx .xlsx .pptx .pdf .html` from Markdown, with Hebrew/RTL support; any text format via write_file |
| Long tasks | **Mission**: plan → step-by-step execution → deterministic checks → retry with feedback → review → report; survives restarts (Resume) |
| Engineering discipline | doctrine + 1,005 expert playbooks from Claude Hunter Pro (debugging, TDD, review, architecture...) |
| Commands | run tests, builds, scripts, git (asks first) |
| Fast code fixes | quick_edit: the 3B code model returns only the changed snippet (JSON-schema constrained), code checks it matches exactly once, syntax-checks, and rolls back if the file breaks |
| Exact math | calc: rational arithmetic in code, zero model tokens |
| Long sessions | old turns become a cited outline without any model call; `recall` returns the exact earlier messages |
| One model at a time | before each call Kestrel unloads other resident models (gateway's included) so they don't fight over the CPU |
| Offline / online | offline by default; online mode can send planning/review to Ollama cloud, Anthropic or any OpenAI-compatible API, and falls back to local if the connection fails |
| Accountability | every action goes to a hash-chained audit log; *Verify action log* detects any edit |

## Safety rules (enforced in code, not in the prompt)

- Paths are resolved (symlinks, `..`) before the check; credential folders (`.ssh`, `.aws`, `.env`...) are never touched.
- Every write asks first (switch to *automatic* in Settings when you trust a task). Overwrites keep a backup in `state/backups`.
- Deleting moves to `state/trash`; nothing is destroyed.
- The agent cannot modify Kestrel's own code, its guard or its audit log.
- The web interface only answers on 127.0.0.1 and refuses requests from other websites.

## Models

| Role | Profile | Base | Used for |
|---|---|---|---|
| agent | kestrel-agent | qwen3.5 4B | all tool work (16k context, presence_penalty 0) |
| fast | kestrel-fast | qwen3.5 2B | summarising old history |
| deep | kestrel-deep | qwen3.5 9B | mission plans and reviews (slower, more careful) |

On this PC (i7-6600U, no usable GPU) the 4B model writes about 5–8 tokens/s. Kestrel keeps the system
prompt and tool list byte-identical between calls so Ollama reuses its cache instead of re-reading them.

## Command line

```
python -m kestrel serve            web interface (default)
python -m kestrel chat             terminal chat
python -m kestrel mission "goal"   long mission in the terminal
python -m kestrel resume <id>      continue a paused mission
python -m kestrel allow <folder> [read|write]
python -m kestrel doctor | smoke | verify-audit | setup-models
```

## Files

```
kestrel/      the agent (guard.py = permissions, agent.py = loop, mission.py = long tasks, docs.py/pdfgen.py = documents)
ui/           the web interface (single file, no internet needed)
data/         skills.jsonl.gz playbooks + NOTICE-skills.md (sources and licenses)
models/       Ollama Modelfiles for the three profiles
state/        audit log, memory.md, missions, backups, trash (created on first run)
config.json   settings (also editable in the interface)
```

`KESTREL.md` in the workspace root is read at the start of every session — put project rules there,
the same way Claude Code reads CLAUDE.md.
