"""Long missions that survive restarts.

The model never holds the whole mission in its context. State lives on disk:
goal, plan, per-step status, notes, evidence. Each step runs in a fresh, small
context (doctrine + brief + notes), so a mission can run for hours or days on a
small model without the context overflowing. Every touched file is re-checked
by deterministic code before a step counts as done.
"""
from __future__ import annotations

import json
import re
import threading
import time
import uuid
from pathlib import Path

from . import doctrine, verify
from .agent import Session
from .llm import LLMError

PLAN_SCHEMA = {
    "type": "object",
    "properties": {"steps": {"type": "array", "items": {"type": "object", "properties": {
        "title": {"type": "string"}, "deliverable": {"type": "string"}, "verify": {"type": "string"}},
        "required": ["title", "deliverable", "verify"]}}},
    "required": ["steps"],
}


def _parse_plan(text: str) -> list[dict]:
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        raise ValueError("no JSON in plan")
    data = json.loads(m.group(0))
    steps = data.get("steps") if isinstance(data, dict) else data
    out = []
    for s in steps or []:
        if isinstance(s, str):
            s = {"title": s}
        t = str(s.get("title") or "").strip()
        if t:
            out.append({"title": t[:200], "deliverable": str(s.get("deliverable") or "")[:300],
                        "verify": str(s.get("verify") or "")[:300]})
    if not out:
        raise ValueError("empty plan")
    return out[:15]


class Mission:
    def __init__(self, root: Path, data: dict):
        self.root = Path(root)
        self.d = data
        self._lock = threading.Lock()

    # ---------- persistence ----------
    @classmethod
    def create(cls, state_dir: Path, goal: str) -> "Mission":
        mid = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        root = Path(state_dir) / "missions" / mid
        root.mkdir(parents=True, exist_ok=True)
        m = cls(root, {"id": mid, "goal": goal, "status": "planning", "created": time.time(),
                       "steps": [], "notes": [], "files": [], "review": None, "log": []})
        m.save()
        return m

    @classmethod
    def load(cls, state_dir: Path, mid: str) -> "Mission":
        root = Path(state_dir) / "missions" / mid
        return cls(root, json.loads((root / "mission.json").read_text(encoding="utf-8")))

    @staticmethod
    def list(state_dir: Path) -> list[dict]:
        base = Path(state_dir) / "missions"
        out = []
        for p in sorted(base.glob("*/mission.json"), reverse=True):
            try:
                d = json.loads(p.read_text(encoding="utf-8"))
                done = sum(1 for s in d["steps"] if s["status"] == "done")
                out.append({"id": d["id"], "goal": d["goal"][:160], "status": d["status"],
                            "progress": f"{done}/{len(d['steps'])}"})
            except (OSError, json.JSONDecodeError, KeyError):
                continue
        return out

    def save(self):
        with self._lock:
            tmp = self.root / "mission.json.tmp"
            tmp.write_text(json.dumps(self.d, indent=2, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self.root / "mission.json")

    def log(self, msg: str):
        self.d["log"].append(f"{time.strftime('%H:%M:%S')} {msg}")
        self.d["log"] = self.d["log"][-300:]
        self.save()

    # ---------- brief ----------
    def brief(self, current: int) -> str:
        lines = [f"MISSION GOAL:\n{self.d['goal']}\n", "PLAN:"]
        for i, s in enumerate(self.d["steps"]):
            mark = {"done": "[x]", "blocked": "[!]", "running": "[>]"}.get(s["status"], "[ ]")
            lines.append(f"{mark} {i + 1}. {s['title']}")
        notes = self.d["notes"][-8:]
        if notes:
            lines.append("\nNOTES FROM DONE STEPS:")
            lines += [f"- {n}" for n in notes]
        if self.d["files"]:
            lines.append("\nFILES SO FAR: " + ", ".join(self.d["files"][-25:]))
        s = self.d["steps"][current]
        lines.append(f"\nYOUR STEP NOW: {current + 1}. {s['title']}\nDeliverable: {s['deliverable']}\nVerify by: {s['verify']}")
        if s.get("feedback"):
            lines.append(f"\nPREVIOUS ATTEMPT FAILED VERIFICATION:\n{s['feedback']}\nFix that first.")
        return "\n".join(lines)


class MissionRunner:
    """Runs a mission in a background thread; emits progress events."""

    def __init__(self, cfg, guard, router, skills, memory, emit):
        self.cfg, self.guard, self.router = cfg, guard, router
        self.skills, self.memory, self.emit = skills, memory, emit
        self.current: Mission | None = None
        self.session: Session | None = None
        self.stop = threading.Event()
        self.thread: threading.Thread | None = None

    def busy(self) -> bool:
        return bool(self.thread and self.thread.is_alive())

    def _state(self, m: Mission):
        self.emit("mission", {k: m.d[k] for k in ("id", "goal", "status", "steps", "files", "review")} | {"log": m.d["log"][-12:]})

    # ---------- planning ----------
    def plan(self, m: Mission):
        m.log("planning")
        self._state(m)
        msgs = [{"role": "system", "content": doctrine.PLANNER},
                {"role": "user", "content": f"Goal:\n{m.d['goal']}\n\nWorkspace: {self.guard.workspace}"}]
        last_err = ""
        for attempt in range(3):
            try:
                rep = self.router.chat("deep", msgs, None, think=self.cfg["think_when_planning"], fmt=PLAN_SCHEMA)
                steps = _parse_plan(rep.content)
                break
            except (LLMError, ValueError, json.JSONDecodeError) as e:
                last_err = str(e)
                m.log(f"plan attempt {attempt + 1} failed: {e}")
        else:
            raise RuntimeError(f"could not produce a plan: {last_err}")
        steps.append({"title": "Review all deliverables against the goal and fix any defects",
                      "deliverable": "review notes; corrected files",
                      "verify": "every deliverable exists, opens, and matches the goal"})
        m.d["steps"] = [dict(s, status="pending", attempts=0, summary="", evidence="") for s in steps]
        m.d["status"] = "ready"
        m.log(f"plan ready: {len(steps)} steps")
        self._state(m)

    # ---------- execution ----------
    def _run_step(self, m: Mission, i: int) -> bool:
        s = m.d["steps"][i]
        s["status"], s["attempts"] = "running", s["attempts"] + 1
        m.log(f"step {i + 1} attempt {s['attempts']}: {s['title']}")
        self._state(m)
        self.session = Session(self.cfg, self.guard, self.router, self.skills, self.memory, self.emit,
                               system=doctrine.CORE + "\n\n" + doctrine.STEP)
        self.session.stop = self.stop
        res = self.session.run(m.brief(i), max_steps=int(self.cfg["mission"]["max_tool_calls_per_step"]))
        fin = res.get("finished")
        if self.stop.is_set() and not fin:
            s["status"] = "pending"
            return False
        files = list(dict.fromkeys((fin or {}).get("files", []) or self.session.ctx.files_touched))
        problems = []
        for f in files:  # deterministic verification, outside the model
            issue = verify.check_file(Path(f))
            if issue:
                problems.append(f"{f}: {issue}")
        if not fin:
            problems.append("step ended without calling finish (no summary/evidence)")
        elif fin["summary"].strip().upper().startswith("BLOCKED"):
            s["status"], s["summary"] = "blocked", fin["summary"]
            m.log(f"step {i + 1} blocked: {fin['summary'][:200]}")
            return False
        if problems:
            s["feedback"] = "\n".join(problems)[:1500]
            s["status"] = "pending"
            m.log(f"step {i + 1} failed verification: {s['feedback'][:300]}")
            return False
        s.update(status="done", summary=fin["summary"][:800], evidence=(fin.get("evidence") or "")[:800])
        s.pop("feedback", None)
        m.d["notes"].append(f"Step {i + 1} ({s['title']}): {fin['summary'][:400]}")
        for f in files:
            if f not in m.d["files"]:
                m.d["files"].append(f)
        m.log(f"step {i + 1} done")
        return True

    def run(self, m: Mission):
        self.current = m
        self.stop.clear()
        try:
            if not m.d["steps"]:
                self.plan(m)
            m.d["status"] = "running"
            m.save()
            max_att = int(self.cfg["mission"]["max_attempts_per_step"])
            for i, s in enumerate(m.d["steps"]):
                while s["status"] in ("pending", "running") and not self.stop.is_set():
                    if s["attempts"] >= max_att:
                        s["status"] = "blocked"
                        s["summary"] = f"BLOCKED after {max_att} attempts: {s.get('feedback', '')[:300]}"
                        m.log(f"step {i + 1} gave up after {max_att} attempts")
                        break
                    self._run_step(m, i)
                    m.save()
                    self._state(m)
                if self.stop.is_set():
                    m.d["status"] = "paused"
                    m.log("paused by user")
                    break
            else:
                blocked = [i + 1 for i, s in enumerate(m.d["steps"]) if s["status"] == "blocked"]
                m.d["status"] = "done" if not blocked else "done_with_blocks"
                self._report(m)
                m.log(f"mission finished ({m.d['status']})")
        except Exception as e:  # keep state; the mission can be resumed
            m.d["status"] = "error"
            m.log(f"error: {type(e).__name__}: {e}")
        finally:
            m.save()
            self._state(m)

    def _report(self, m: Mission):
        lines = [f"# Mission report\n\n**Goal:** {m.d['goal']}\n\n**Status:** {m.d['status']}\n", "## Steps\n"]
        for i, s in enumerate(m.d["steps"], 1):
            lines.append(f"### {i}. {s['title']} - {s['status']}\n\n{s.get('summary', '')}\n")
            if s.get("evidence"):
                lines.append(f"Evidence: {s['evidence']}\n")
        if m.d["files"]:
            lines.append("## Files\n\n" + "\n".join(f"- {f}" for f in m.d["files"]))
        (m.root / "report.md").write_text("\n".join(lines), encoding="utf-8")

    def start(self, goal: str) -> Mission:
        if self.busy():
            raise RuntimeError("a mission is already running")
        m = Mission.create(self.cfg.state_dir, goal)
        self.thread = threading.Thread(target=self.run, args=(m,), daemon=True)
        self.thread.start()
        return m

    def resume(self, mid: str) -> Mission:
        if self.busy():
            raise RuntimeError("a mission is already running")
        m = Mission.load(self.cfg.state_dir, mid)
        for s in m.d["steps"]:
            if s["status"] == "running":
                s["status"] = "pending"
            if s["status"] == "blocked" and s["attempts"] < int(self.cfg["mission"]["max_attempts_per_step"]) + 2:
                s["status"], s["attempts"] = "pending", 0
        self.thread = threading.Thread(target=self.run, args=(m,), daemon=True)
        self.thread.start()
        return m

    def pause(self):
        self.stop.set()
