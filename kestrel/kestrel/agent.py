"""The agent loop: model -> tool calls -> guarded execution -> results -> model.

Design for a slow CPU:
- static system prompt + static tool list = a cacheable prefix
- dynamic facts live in one context message created at session start
- tool results are capped; old history is compacted only when it must be
"""
from __future__ import annotations

import json
import platform
import re
import threading
import time
from pathlib import Path
from typing import Callable

from . import doctrine, tools
from .llm import LLMError, Router, recover_tool_calls

Emit = Callable[[str, dict], None]


def _est_tokens(messages: list) -> int:
    n = 0
    for m in messages:
        n += len(m.get("content") or "")
        for tc in m.get("tool_calls") or []:
            n += len(json.dumps(tc.get("function", {}), ensure_ascii=False))
    return int(n / 3.2)


class Session:
    def __init__(self, cfg, guard, router: Router, skills=None, memory=None, emit: Emit | None = None,
                 system: str = doctrine.CORE, role: str = "agent", tool_groups=("core",)):
        self.cfg, self.guard, self.router = cfg, guard, router
        self.skills, self.memory = skills, memory
        self.emit = emit or (lambda kind, data: None)
        self.role = role
        self.groups = tuple(tool_groups) + (("online",) if cfg["online"].get("allow_web_fetch") else ())
        self.tool_schemas = tools.schemas(self.groups)
        self.tool_names = {t["function"]["name"] for t in self.tool_schemas}
        self.messages: list[dict] = [{"role": "system", "content": system}]
        self.context_sent = False
        self.stop = threading.Event()
        self.stats = {"llm_calls": 0, "tool_calls": 0, "prompt_tokens": 0, "output_tokens": 0, "seconds": 0.0}
        self.ctx = tools.Ctx(guard, cfg, skills, memory, router=router)
        self.ctx.session = self
        self.archive: list[dict] = []  # every message ever sent, for exact recall after compaction

    # ------------------------------------------------------------------
    def context_text(self) -> str:
        roots = "\n".join(f"  - {r['path']} ({r['mode']})" for r in self.guard.roots())
        mem = self.memory.facts(15) if self.memory else []
        notes = ""
        proj = self.guard.workspace / "KESTREL.md"
        if proj.exists():
            notes = "\nProject notes (KESTREL.md):\n" + proj.read_text(encoding="utf-8", errors="replace")[:2000]
        return (f"[context]\nDate: {time.strftime('%Y-%m-%d %A')}\nSystem: {platform.system()} {platform.release()}\n"
                f"Workspace (default for relative paths): {self.guard.workspace}\nApproved folders:\n{roots}\n"
                + ("Things to remember:\n" + "\n".join(f"  - {m}" for m in mem) + "\n" if mem else "")
                + (f"Skill library: {len(self.skills)} playbooks (skill_search)\n" if self.skills else "")
                + notes)

    def _push(self, msg: dict):
        msg["_id"] = f"m{len(self.archive) + 1}"
        self.archive.append(msg)
        self.messages.append(msg)

    def seed_history(self, messages: list, keep: int = 12):
        """Start from an existing conversation (e.g. an Open WebUI chat Kestrel has not seen yet)."""
        prior = [m for m in messages if m.get("role") in ("user", "assistant")][-keep:]
        for m in prior:
            c = m.get("content")
            if isinstance(c, list):
                c = "\n".join(p.get("text", "") for p in c if isinstance(p, dict))
            c = re.sub(r"(?s)<details.*?</details>", "", str(c or "")).strip()[:2000]
            if not c:
                continue
            if m["role"] == "user":
                self.add_user(c)
            else:
                self._push({"role": "assistant", "content": c})

    def add_user(self, text: str):
        if not self.context_sent:
            text = self.context_text() + "\n\n[task]\n" + text
            self.context_sent = True
        self._push({"role": "user", "content": text})

    # ------------------------------------------------------------------
    def _llm(self, think: bool):
        def on_token(kind, t):
            self.emit("token", {"kind": kind, "text": t})
        wire = [{k: v for k, v in m.items() if not k.startswith("_")} for m in self.messages]
        rep = self.router.chat(self.role, wire, self.tool_schemas, think=think, on_token=on_token)
        self.stats["llm_calls"] += 1
        self.stats["prompt_tokens"] += rep.prompt_tokens
        self.stats["output_tokens"] += rep.output_tokens
        self.stats["seconds"] += rep.seconds
        self.emit("llm", {"model": rep.model, "prompt_tokens": rep.prompt_tokens,
                          "output_tokens": rep.output_tokens, "seconds": round(rep.seconds, 1)})
        return rep

    def _compact_if_needed(self):
        """Deterministic compaction (no model call): old turns become a cited outline;
        the exact messages stay in self.archive and come back with the recall tool."""
        budget = int(self.cfg["num_ctx"] * 0.62)
        if _est_tokens(self.messages) < budget or len(self.messages) < 8:
            return
        head, tail = self.messages[:2], self.messages[-6:]
        while tail and tail[0]["role"] == "tool":  # never split a tool call from its results
            tail = tail[1:]
        middle = self.messages[2:len(self.messages) - len(tail)]
        if not middle:
            return
        lines = []
        for m in middle:
            mid = m.get("_id", "?")
            if m.get("tool_calls"):
                for tc in m["tool_calls"]:
                    f = tc.get("function", {})
                    args = f.get("arguments") or {}
                    brief = ", ".join(f"{k}={str(v)[:60]}" for k, v in (args.items() if isinstance(args, dict) else []))
                    lines.append(f"[{mid}] called {f.get('name')}({brief})")
                if (m.get("content") or "").strip():
                    lines.append(f"[{mid}] said: {m['content'].strip()[:160]}")
            elif m["role"] == "tool":
                res = (m.get("content") or "").strip().replace("\n", " ")
                lines.append(f"[{mid}] {m.get('tool_name', 'tool')} -> {res[:140]}")
            else:
                lines.append(f"[{mid}] {m['role']}: {(m.get('content') or '').strip().replace(chr(10), ' ')[:200]}")
        outline = "\n".join(lines[-80:])
        self.messages = head + [{"role": "user", "content":
                                 "[outline of earlier work - exact text available with recall(ids), e.g. recall('m12-m15')]\n" + outline},
                                {"role": "assistant", "content": "Understood. I will recall exact messages when I need them."}] + tail
        self.emit("compacted", {"removed": len(middle), "method": "outline+recall (no model call)"})

    def recall(self, spec: str) -> str:
        ids = set()
        for part in re.split(r"[,\s]+", spec or ""):
            m = re.fullmatch(r"m?(\d+)(?:-m?(\d+))?", part.strip())
            if m:
                a, b = int(m.group(1)), int(m.group(2) or m.group(1))
                ids.update(range(a, min(b, a + 20) + 1))
        out = []
        for m in self.archive:
            if int(m["_id"][1:]) in ids:
                body = m.get("content") or ""
                if m.get("tool_calls"):
                    body += " " + json.dumps([tc.get("function") for tc in m["tool_calls"]], ensure_ascii=False)
                out.append(f"[{m['_id']}] {m['role']}{' ' + m.get('tool_name', '') if m['role'] == 'tool' else ''}: {body}")
        return "\n\n".join(out) or "no such messages"

    # ------------------------------------------------------------------
    def run(self, text: str, max_steps: int | None = None, think: bool | None = None, *, require_finish: bool = False) -> dict:
        """One user turn. Returns {"text", "finished", "steps"}."""
        self.add_user(text)
        self.ctx.finished = None
        self.ctx.verification.clear()
        from .terminal import command_for, run_terminal
        command = command_for(text, self.messages[:-1]) if "run_command" in self.tool_names else None
        if command:
            result = run_terminal(self.ctx, command, self.emit)
            self.stats["tool_calls"] += 1
            self._push({"role": "assistant", "content": result["text"]})
            return result
        max_steps = max_steps or int(self.cfg["max_steps_per_turn"])
        think = self.cfg["think_when_acting"] if think is None else think
        last_calls: list[str] = []
        nudged = False
        final = ""
        for step in range(max_steps):
            if self.stop.is_set():
                final = "(stopped by user)"
                break
            self._compact_if_needed()
            try:
                rep = self._llm(think)
            except LLMError as e:
                self.emit("error", {"message": str(e)})
                return {"text": f"Model error: {e}", "finished": None, "steps": step}
            calls = rep.tool_calls or recover_tool_calls(rep.content, self.tool_names)
            msg = {"role": "assistant", "content": rep.content}
            if calls:
                msg["tool_calls"] = calls
            self._push(msg)
            if not calls:
                if require_finish and not nudged:
                    nudged = True
                    self._push({"role": "user", "content": (
                        "Complete the checks and call the finish tool with concrete evidence. "
                        "If you could not verify the deliverable, start your summary with BLOCKED."
                    )})
                    continue
                if not rep.content.strip() and not nudged:
                    nudged = True
                    self._push({"role": "user", "content": "Continue: either call a tool or give your answer."})
                    continue
                final = rep.content
                break
            for tc in calls:
                fn = tc.get("function", {})
                name, args = fn.get("name", ""), fn.get("arguments") or {}
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except json.JSONDecodeError:
                        args = {}
                sig = name + json.dumps(args, sort_keys=True, ensure_ascii=False)
                self.emit("tool_call", {"name": name, "args": _preview_args(args)})
                result, ok = tools.call(self.ctx, name, args, int(self.cfg["max_tool_result_chars"]))
                self.stats["tool_calls"] += 1
                last_calls.append(sig)
                if last_calls[-3:].count(sig) == 3:
                    result += ("\nNOTE: you made this exact call 3 times. It will not produce a different result. "
                               "Change approach or finish.")
                self.emit("tool_result", {"name": name, "ok": ok, "result": result[:1500]})
                tm = {"role": "tool", "content": result, "tool_name": name}
                if tc.get("id"):
                    tm["tool_call_id"] = tc["id"]
                self._push(tm)
            if self.ctx.finished:
                final = self.ctx.finished["summary"]
                break
        else:
            final = final or "(step limit reached; ask me to continue)"
        answer = {"text": final, "finished": self.ctx.finished, "checks": self.ctx.verification[-20:]}
        self.emit("answer", answer)
        return {**answer, "steps": step + 1}


def _preview_args(args: dict) -> dict:
    out = {}
    for k, v in args.items():
        s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
        out[k] = s if len(s) <= 300 else s[:300] + f"... ({len(s):,} chars)"
    return out
