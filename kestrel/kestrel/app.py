"""Wires the pieces together. Used by the web server and the CLI."""
from __future__ import annotations

import secrets
import json
import re
import threading
import time
import uuid
from collections import deque

from .agent import Session
from .audit import AuditLog
from .config import HOME, Config
from .guard import ApprovalRequest, Guard
from .llm import Router
from .memory import Memory
from .mission import Mission, MissionRunner
from .skills import SkillLibrary


_tls = threading.local()  # which external run (if any) the current thread works for


class EventHub:
    """Fan-out of agent events to any number of listeners (SSE clients, external runs)."""

    def __init__(self):
        self._subs: list[deque] = []
        self._cv = threading.Condition()
        self.history: deque = deque(maxlen=400)
        self.seq = 0
        self.runs: dict[str, list] = {}

    def emit(self, kind: str, data: dict):
        with self._cv:
            self.seq += 1
            ev = {"seq": self.seq, "kind": kind, "data": data, "ts": time.time()}
            run = getattr(_tls, "run", None)
            if run:
                ev["run"] = run
                if run in self.runs:
                    self.runs[run].append(ev)
            if kind != "token":
                self.history.append(ev)
            for q in self._subs:
                q.append(ev)
            self._cv.notify_all()

    def run_events(self, run: str, after: int, wait: float) -> list:
        deadline = time.time() + wait
        with self._cv:
            while True:
                evs = [e for e in self.runs.get(run, []) if e["seq"] > after]
                left = deadline - time.time()
                if evs or left <= 0:
                    return evs
                self._cv.wait(left)

    def subscribe(self) -> deque:
        q: deque = deque(maxlen=5000)
        with self._cv:
            self._subs.append(q)
        return q

    def unsubscribe(self, q):
        with self._cv:
            if q in self._subs:
                self._subs.remove(q)

    def wait(self, q: deque, timeout: float):
        with self._cv:
            if not q:
                self._cv.wait(timeout)


class App:
    def __init__(self, cfg: Config | None = None, approver=None):
        self.cfg = cfg or Config()
        self.hub = EventHub()
        self.audit = AuditLog(self.cfg.state_dir / "audit.jsonl")
        self.pending: dict[str, ApprovalRequest] = {}
        self.guard = Guard(self.cfg, self.audit, approver or self.web_approver)
        self.router = Router(self.cfg)
        self.skills = SkillLibrary(HOME / "data" / "skills.jsonl.gz")
        self.memory = Memory(self.cfg.state_dir / "memory.md")
        self.missions = MissionRunner(self.cfg, self.guard, self.router, self.skills, self.memory, self.hub.emit)
        self.chat: Session | None = None
        self.chat_lock = threading.Lock()
        self.chat_thread: threading.Thread | None = None
        self.chats: dict[str, Session] = {}        # external chats (Open WebUI) by chat id
        self.run_threads: dict[str, threading.Thread] = {}
        self.run_stops: dict[str, threading.Event] = {}
        self._builds_file = self.cfg.state_dir / "chat_builds.json"  # chat_id -> last build, survives restarts
        try:
            self.last_builds: dict[str, dict] = json.loads(self._builds_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.last_builds = {}
        self.model_lock = threading.Lock()         # one agent run at a time: one model resident on a 4-thread CPU
        tok = self.cfg.state_dir / "api_token"
        if not tok.exists():
            tok.write_text(secrets.token_urlsafe(32), encoding="utf-8")
        self.api_token = tok.read_text(encoding="utf-8").strip()

    # ---- tool server (Open WebUI calls Kestrel tools for ANY model) ----
    TOOL_SERVER_TOOLS = ("list_dir", "read_file", "search_files", "find_files", "write_file", "edit_file",
                         "make_document", "make_folder", "move_path", "delete_path", "run_command", "check_file",
                         "calc", "quick_edit", "skill_search", "skill_load", "remember")

    def tool_call(self, name: str, args: dict) -> tuple[str, bool]:
        from . import llm as _llm
        from . import tools as _tools
        if name not in self.TOOL_SERVER_TOOLS:
            return f"ERROR: unknown tool {name}", False
        _tls.via = "tool-server"
        _llm.tls.exclusive = False
        try:
            ctx = _tools.Ctx(self.guard, self.cfg, self.skills, self.memory, router=self.router)
            out, ok = _tools.call(ctx, name, args or {}, limit=int(self.cfg["max_tool_result_chars"]) * 2)
            if not ok and "folder access was not approved" in out:
                out += (f"\nApproved folders: {', '.join(r['path'] for r in self.guard.roots())}. "
                        f"To add one, the user opens http://127.0.0.1:{self.cfg['ui_port']} -> Approved folders.")
            self.hub.emit("tool_server", {"name": name, "ok": ok})
            return out, ok
        finally:
            _tls.via = None
            _llm.tls.exclusive = True

    def openapi(self) -> dict:
        from . import tools as _tools
        paths = {}
        for name in self.TOOL_SERVER_TOOLS:
            t = _tools.REGISTRY[name]
            paths[f"/tools/{name}"] = {"post": {
                "operationId": name, "summary": t.description,
                "description": t.description + " (Runs on the user's PC through Kestrel; limited to approved folders.)",
                "requestBody": {"required": True, "content": {"application/json": {"schema": {
                    "type": "object", "properties": t.params, "required": t.required}}}},
                "responses": {"200": {"description": "result", "content": {"application/json": {"schema": {
                    "type": "object", "properties": {"ok": {"type": "boolean"}, "result": {"type": "string"}}}}}}}}}
        return {"openapi": "3.1.0", "info": {"title": "Kestrel - safe computer tools", "version": "1.2.0",
                "description": "Files and folders (approved folders only, backups, recoverable trash), Office/PDF documents, "
                               "exact math, verified code edits, 1,005 expert playbooks, memory, commands. Every action is "
                               "written to a tamper-evident audit log."},
                "servers": [{"url": f"http://127.0.0.1:{self.cfg['ui_port']}"}], "paths": paths}

    # ---- external runs (Open WebUI pipe) ----
    def start_run(self, messages: list, chat_id: str = "", mode: str = "agent") -> str:
        rid = uuid.uuid4().hex[:12]
        for old in list(self.hub.runs)[:-40]:  # keep the last 40 runs' events
            self.hub.runs.pop(old, None)
        self.hub.runs[rid] = []
        user_msgs = [m for m in messages if m.get("role") == "user"]
        if not user_msgs:
            raise ValueError("no user message")
        text = _text(user_msgs[-1].get("content"))

        def work():
            _tls.run = rid
            try:
                with self.model_lock:
                    self.hub.emit("run_started", {"mode": mode})
                    if mode == "max":
                        self._run_max(messages, text, chat_id, rid)
                    elif mode == "mission":
                        m = Mission.create(self.cfg.state_dir, text)
                        self.missions.thread = threading.current_thread()
                        self.missions.run(m)
                        rep = m.root / "report.md"
                        self.hub.emit("answer", {"text": rep.read_text(encoding="utf-8") if rep.exists() else f"Mission {m.d['status']}",
                                                 "finished": {"files": m.d["files"]}})
                    else:
                        s = self.chats.get(chat_id) if chat_id else None
                        if s is None:
                            s = Session(self.cfg, self.guard, self.router, self.skills, self.memory, self.hub.emit)
                            s.seed_history(messages[:-1])
                            if chat_id:
                                self.chats[chat_id] = s
                        s.stop.clear()
                        s.run(text)
            except Exception as e:
                self.hub.emit("error", {"message": f"{type(e).__name__}: {e}"})
            finally:
                self.hub.emit("run_done", {})
                _tls.run = None
        t = threading.Thread(target=work, daemon=True)
        self.run_threads[rid] = t
        t.start()
        return rid

    def _run_max(self, messages: list, text: str, chat_id: str, rid: str):
        """Kestrel Max: route by what the message needs, then use the right machinery."""
        from .build import BuildEngine, answer_markdown
        from .route import classify, is_hebrew, last_code
        from .route import code_paths
        stop = threading.Event()  # registered first, so a stop that arrives during routing is never lost
        self.run_stops[rid] = stop
        history = [{"role": m.get("role"), "content": _text(m.get("content"))} for m in messages[:-1]]
        try:  # what Open WebUI actually sent: kept for diagnosing routing
            (self.cfg.state_dir / "last_max_request.json").write_text(json.dumps(
                {"chat_id": chat_id, "messages": [{"role": m["role"], "len": len(m["content"] or ""), "head": (m["content"] or "")[:300],
                                                   "tail": (m["content"] or "")[-300:]} for m in history + [{"role": "user", "content": text}]]},
                ensure_ascii=False, indent=1), encoding="utf-8")
        except OSError:
            pass
        remembered = self.last_builds.get(chat_id) if chat_id else None
        kind = classify(text, history, has_code=bool(remembered))
        self.hub.emit("route", {"kind": kind})
        if kind in ("build", "fix"):
            existing, goal, target = "", text, ""
            if kind == "fix":
                # Open WebUI may strip collapsed blocks from history, so do not rely on the chat text alone:
                # 1) the code this chat's last build produced, 2) a code block in the history, 3) a code file named in it
                existing = (remembered or {}).get("code", "") or last_code(history)
                target = (remembered or {}).get("path") or ""
                for pth in code_paths(history, text):
                    if existing and target:
                        break
                    try:
                        body = self.guard.check_read(pth).read_text(encoding="utf-8", errors="replace")
                    except Exception:
                        continue
                    target = target or pth
                    existing = existing or body
                earlier = [m["content"] for m in history if m["role"] == "user" and not re.search(r"^\s*.{0,40}$", m["content"] or "")]
                if (remembered or {}).get("goal"):
                    goal = f"{remembered['goal']}\n\nFollow-up from the person: {text}"
                else:
                    goal = (f"{earlier[-1]}\n\nFollow-up from the person: {text}" if earlier else text)
            try:
                eng = BuildEngine(self.cfg, self.guard, self.router, self.hub.emit, stop)
                prior = remembered if kind == "fix" else None
                res = eng.run(goal, existing, target, spec=(prior or {}).get("spec"), tests=(prior or {}).get("tests"))
            finally:
                self.run_stops.pop(rid, None)
            if chat_id:
                self.last_builds[chat_id] = {"code": res["code"], "path": res.get("path"), "goal": goal.split("\n\nFollow-up")[0],
                                             "spec": res.get("spec"), "tests": res.get("tests") or [], "t": time.time()}
                keep = sorted(self.last_builds.items(), key=lambda kv: kv[1].get("t", 0))[-200:]
                self.last_builds = dict(keep)
                try:
                    self._builds_file.write_text(json.dumps(self.last_builds, ensure_ascii=False), encoding="utf-8")
                except OSError:
                    pass
            self.hub.emit("answer", {"text": answer_markdown(res, is_hebrew(text)),
                                     "finished": {"files": [res["path"]] if res.get("path") else []}})
            return
        if kind == "chat":
            sys_p = ("You are a helpful, precise assistant running locally on the person's PC. Answer directly and "
                     "concisely in the person's language. If you are not sure, say so; never invent facts.")
            msgs = [{"role": "system", "content": sys_p}] + [m for m in history[-8:] if m["content"]] + \
                   [{"role": "user", "content": text}]
            out = []

            def on_tok(k, t):
                if k == "content":
                    out.append(t)
                    self.hub.emit("token", {"kind": "content", "text": t})
            from .build import LoopGuard
            g = LoopGuard()

            def guarded(k, t):
                g.feed(k, t)
                on_tok(k, t)
            try:
                rep = self.router.chat("agent", msgs, None, think=False, on_token=guarded,
                                       options={"num_predict": 1500, "repeat_penalty": 1.08, "temperature": 0.5})
                self.hub.emit("llm", {"model": rep.model, "prompt_tokens": rep.prompt_tokens,
                                      "output_tokens": rep.output_tokens, "seconds": round(rep.seconds, 1)})
            except Exception as e:
                if type(e).__name__ != "Degenerate":
                    raise
            self.hub.emit("answer", {"text": "".join(out)})
            return
        s = self.chats.get(chat_id) if chat_id else None
        if s is None:
            s = Session(self.cfg, self.guard, self.router, self.skills, self.memory, self.hub.emit)
            s.seed_history(messages[:-1])
            if chat_id:
                self.chats[chat_id] = s
        s.stop.clear()
        s.run(text)

    def stop_run(self, rid: str):
        ev = self.run_stops.get(rid)
        if ev:
            ev.set()
        for s in self.chats.values():
            s.stop.set()
        self.missions.pause()
        for req in list(self.pending.values()):
            if req.detail.get("run") == rid:
                req.decision = "deny"
                req.event.set()

    # ---- approvals through the UI ----
    def web_approver(self, req: ApprovalRequest) -> str:
        if getattr(_tls, "via", None) == "tool-server":
            # Open WebUI already showed its Allow/Deny card for this tool call. Kestrel still enforces the hard
            # limits (approved folders, protected paths, backups, trash, audit) - but a NEW folder is never
            # granted from a model's tool call: the person adds folders in Kestrel's own page.
            req.decision = "deny" if req.kind == "folder" else "allow"
            self.audit.record("approval.openwebui", kind=req.kind, summary=req.summary, decision=req.decision)
            return req.decision
        req.detail["run"] = getattr(_tls, "run", None)
        self.pending[req.id] = req
        self.hub.emit("approval", req.public())
        req.event.wait(timeout=900)
        self.pending.pop(req.id, None)
        self.hub.emit("approval_done", {"id": req.id, "decision": req.decision or "deny (timeout)"})
        return req.decision or "deny"

    def decide(self, rid: str, decision: str) -> bool:
        req = self.pending.get(rid)
        if not req or decision not in ("allow", "allow_always", "deny"):
            return False
        req.decision = decision
        req.event.set()
        return True

    # ---- chat ----
    def new_chat(self):
        self.chat = Session(self.cfg, self.guard, self.router, self.skills, self.memory, self.hub.emit)

    def send(self, text: str) -> bool:
        if self.chat_thread and self.chat_thread.is_alive():
            return False
        if self.chat is None:
            self.new_chat()
        self.chat.stop.clear()

        def work():
            with self.chat_lock, self.model_lock:
                self.hub.emit("busy", {"busy": True})
                try:
                    self.chat.run(text)
                except Exception as e:
                    self.hub.emit("error", {"message": f"{type(e).__name__}: {e}"})
                finally:
                    self.hub.emit("stats", self.chat.stats)
                    self.hub.emit("busy", {"busy": False})
        self.chat_thread = threading.Thread(target=work, daemon=True)
        self.chat_thread.start()
        return True

    def stop_all(self):
        if self.chat:
            self.chat.stop.set()
        self.missions.pause()
        for req in list(self.pending.values()):
            req.decision = "deny"
            req.event.set()

    def status(self) -> dict:
        inst = self.router.installed()
        if not inst:  # Ollama may have started after Kestrel
            self.router.refresh()
            inst = self.router.installed()
        return {
            "started_at": _STARTED_AT,   # the supervisor compares this with the code on disk to know if a reload is due
            "ollama": bool(inst), "installed_models": inst,
            "models": {r: self.router.pick(r)[1] for r in ("agent", "fast", "deep")},
            "online": self.cfg["online"].get("enabled", False),
            "workspace": str(self.guard.workspace), "roots": self.guard.roots(),
            "skills": len(self.skills), "missions": Mission.list(self.cfg.state_dir)[:20],
            "pending": [r.public() for r in self.pending.values()],
            # busy also while an Open WebUI "Max" run builds: the supervisor only reloads Kestrel when idle
            "busy": bool(self.chat_thread and self.chat_thread.is_alive()) or self.missions.busy() or bool(self.run_stops),
            "approvals": self.cfg["approvals"],
        }


_STARTED_AT = time.time()


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):  # OpenAI multi-part content
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return str(content or "")
