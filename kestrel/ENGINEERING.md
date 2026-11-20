# Engineer vs. vibe coder — and how Kestrel is built to be the first

## The argument, fairly stated

**Vibe coding** means describing what you want, accepting what the model produces, running it, and
prompting again when something breaks. It is fast for prototypes, demos and throwaway tools, and it has
let many non-programmers build working things. That part of the argument is real.

What experienced engineers object to is not the AI. It is that vibe coding skips the parts of engineering
that are invisible when things work and decisive when they don't:

| Engineering habit | What goes wrong without it |
|---|---|
| **Understand before changing** — read the code, find the constraints | Fixes that break something two files away |
| **Architecture** — clear boundaries, one responsibility per unit, explicit data flow | Code that only the session that wrote it understands; every change gets riskier |
| **Root-cause debugging** — name the line and the reason before fixing | Symptoms patched, defects kept, evidence destroyed |
| **Verification with evidence** — tests, checks, reading real output | "It works" meaning "it didn't crash once" |
| **Small reversible steps** — one change, one check | Twenty changes, one failure, no idea which caused it |
| **Ownership** — security, data safety, performance, maintainability | Secrets in repos, deleted user data, slow paths no one measured |
| **Saying "I don't know"** | Confident prose hiding guesses |

The honest summary: vibe coding optimises for *the first working version*; engineering optimises for
*the hundredth change still being safe*. Large companies run on the second.

## How Kestrel encodes the engineer's side

Prompts alone don't make a small model disciplined, so most of this is structural:

1. **Doctrine** (`kestrel/doctrine.py`): understand → plan → small step → verify → root cause → design →
   ownership → honesty. Short on purpose so it stays in the cached prefix.
2. **Verification outside the model** (`verify.py`): every file the agent writes is parsed by code
   (Python AST, JSON, XML, Office packages, PDF structure, CSV shape, bracket balance). The result is
   shown to the model immediately, and a mission step only counts as done when these checks pass. The
   model cannot grade its own homework.
3. **Missions** (`mission.py`): plans are explicit JSON with a deliverable and a verification method per
   step; a failed check sends the exact error back for another attempt; after three failures the step is
   marked blocked instead of faking success; a final review step reads the deliverables against the goal.
4. **Playbooks** (`data/skills.jsonl.gz`): 1,005 field-tested methods mined by Claude Hunter Pro —
   debugging, TDD, code review, architecture, security, planning — loaded only when relevant.
5. **Edits, not rewrites**: `edit_file` requires an exact, unique match, which forces reading first and
   keeps changes small and reviewable.
6. **Accountability**: a hash-chained audit log of every action and approval.

## Honest limits

A 4B model on a 2016 laptop CPU is not a frontier model. Kestrel makes it far more reliable and useful
than raw chat — structure, checks, memory, playbooks, resumable long tasks — but it will still be slower
and make more mistakes than a large cloud model. Online mode exists for the moments that need more power
(planning and review), and everything still works when the connection is gone.

## Kestrel Max (Open WebUI): measured limits and how each is handled

Measured on this PC (i7-6600U, 2 cores / 4 threads, CPU only), `tools/bench_ollama.py`, results in `logs/bench.json`:

| Limit | Measurement | Handling |
|---|---|---|
| Prompt reading (prefill) | ~21 tok/s; 4 threads best (2 threads −33%, 3 threads −20%); batch size irrelevant | Stable prompt prefixes + `keep_alive 4h` so Ollama's cache is reused: same prefix 54 s → 4.2 s |
| Hidden "thinking" (Ollama default for Qwen3.5) | 82 s and 400 tokens without an answer vs 4.2 s with it off | Off for writing and chat; on only for planning, diagnosing and reviewing |
| Open WebUI built-in tools | prompt 16,176 tokens (context full, 18 min, truncated) | Builtin Tools capability off for Local Agent models → 4,732 tokens |
| Tool list size | 17 tools; the playbook search led the model into an 18-minute spiral | 13 core tools exposed to Open WebUI (`function_name_filter_list`) |
| Repetition loops on long code | a 15,540-char answer repeating `stopGame()` | `LoopGuard` aborts the stream; retry with stronger repetition penalty; Local Agent capped at 4,096 output tokens with repeat_penalty 1.05 |
| Model never sees its code run | "it doesn't work" → invented "race condition" | `runcheck`: real execution, facts only |
| Fix = full rewrite | 2,185 tokens / 12 min per attempt | JSON edits (whitespace-tolerant), verifier-gated |
| Smaller model (2B) | not faster here (prefill 8.5 tok/s in one sample) | stay on 4B |

### Routing (kestrel/route.py) — no model call
`chat` → one short reply · `agent` → tool agent (files, documents, commands, arithmetic via `calc`) ·
`build` → build engine · `fix` → build engine starting from the code already in the conversation.

### Build engine (kestrel/build.py)
plan (think, JSON schema: requirements, design, pitfalls) → write whole file (no thinking, LoopGuard) →
**run** (`runcheck`) → repair from the run's findings with numbered code (think, JSON edits) → keep only if
the verifier score does not drop → when passing, requirement-by-requirement review (edits kept only if it
still passes) → if stuck, a fresh candidate at a higher temperature carrying the lessons learned → best
candidate is delivered with one approved write and an honest report.

### Verifier (kestrel/runcheck.py)
HTML: static checks (missing ids, duplicate functions, unbalanced tags, CDN use) + `node --check` per
script + a real headless browser run (Edge/Chrome) with a one-line probe (line numbers stay true) that
records errors, dialogs, timers, frames, listeners and canvas draws, drives keys/clicks, and compares
canvas/DOM snapshots. rAF is driven from virtual time at 60 fps (headless virtual time otherwise yields ~2
frames). A hang is bisected: frozen at start-up vs frozen only on input. Python/JS: compile/`--check`,
then a sandboxed temp-folder run with a timeout — only after the person approves running generated code.

Every control on the page (buttons, checkboxes, selects, `#` links, up to 24) is pressed one at a time and
any error is attributed to the control that caused it ("clicking the control "Short break" throws … line 279").

The verdict is deterministic; the model never grades its own work.

### Measured: why execution, not self-review, is the judge
First real build on this PC (Pomodoro timer, 2026-11-19): plan 7 min, 304 lines written in 11 min, passed the
first run. The model's requirement-by-requirement review (with thinking) concluded for "switching between Work,
Short Break and Long Break": *"Logic: Correct. Requirement Met? Yes."* It was wrong — `data-mode="shortbreak"`
vs `MODES.SHORTBREAK`, so every mode button threw `Cannot read properties of undefined`. The verifier then only
clicked the first button. Fix: press every control. The review stays as a bonus pass whose edits are kept only
if the program still runs clean; it is never the judge.

### Thinking budget
Unbounded thinking on the plan step produced 1,658+ tokens in 7.5 min and was still going. Thinking now streams
until `build.think_budget_chars` (default 3,000 ≈ 750 tokens ≈ 3 min), is cut, and is handed to the answer call
as the model's own notes: depth kept, time bounded.

## Round 3 (2026-11-19): tests as the judge, focused repairs, measured model choice

### Acceptance tests replace self-review
After the first real run the model writes 3-10 tests per build in a tiny step language (`click`, `key`, `type`,
`wait`, `mark`, `expect`, `expect_number` (mm:ss read as seconds), `expect_changed/same` (canvas included),
`expect_visible/hidden`, `expect_no_errors`), against the **page's real inventory** (ids + visible texts captured by
the probe). Tests naming elements that do not exist are discarded before they can mislead a repair. Each test runs
in a fresh headless page on simulated time (5 tests ≈ 10 s). Pass = runs clean AND every test passes; the score
used to keep or discard a change counts failed tests (−40 each). The free-text review now only runs when no
executable tests exist (non-web outputs).

### Arbitration against reward hacking
The repair step may claim a test is wrong (`wrong_tests`). A separate judge call that **never sees the code** gets
only the requirement, the test, how it failed and the claim. Only if it agrees is the test dropped (once per test);
otherwise the code must change. A model cannot argue a failing test away.

### Focused repair context
Prefill (~20 tok/s) dominates repair time. Files over 170 lines are sent as an outline of every declaration with
line numbers plus only the regions the evidence points at (stack-trace lines ±10, functions named in traces,
code touching ids/texts in failing tests). Edits still apply to the whole file.

### Fixes reuse the plan and the tests
Each chat's last build stores spec + tests (`state/chat_builds.json`). "It doesn't work" skips re-planning (~10 min
on this CPU) and re-runs the same acceptance tests, adding the person's follow-up as an extra requirement.

### Evaluation harness (`tools/eval_build.py`)
5 tasks (counter, Pomodoro, to-do with localStorage, temperature converter, Snake) × configurations
(`agent`: Qwen3.5-4B writes; `coder`: Qwen2.5-Coder-3B writes, 4B plans/repairs/tests). Besides the engine's own
tests, every result is scored by a small **held-out, human-written** check set per task that the engine never sees,
so a build cannot look good by writing easy tests. Results: `logs/eval-*.json`, `logs/eval-summary.md`.

### Open WebUI 0.13.4 and sign-in
Upgraded with `tools/upgrade-openwebui.ps1` (stop → full data backup → `uv tool install` → version check → automatic
rollback → start). Lesson: Open WebUI reads `.webui_secret_key` from its working folder; a start from another folder
created a new key and signed every session out. Codex's launcher now always starts from `Documents\Codex\LocalAI` and
passes the key explicitly. `WEBUI_AUTH=False` is not possible with existing users, and a header-trust proxy would let
any local process act as admin, so sessions are instead set to never expire (`JWT_EXPIRES_IN=-1`).
