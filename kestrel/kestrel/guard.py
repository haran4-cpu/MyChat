"""The guard: every file-system and command action passes through here.

Rules (enforced in code, not in the prompt):
- A path must resolve inside an approved root. Symlinks and '..' are resolved first.
- Reads need a root in "read" or "write" mode. Writes need "write" mode.
- Outside the roots -> an approval request for folder access (never silent).
- Overwrites keep a backup; deletes move to the trash. Nothing is destroyed.
- Every decision is written to the tamper-evident audit log.
"""
from __future__ import annotations

import os
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .audit import AuditLog
from .config import Config

PROTECTED_PARTS = {
    # never touched, even inside an approved root
    ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".git" + os.sep + "objects",
}
PROTECTED_NAMES = {"id_rsa", "id_ed25519", "id_ecdsa", "credentials", ".env", "auth.json"}


class Denied(Exception):
    pass


@dataclass
class ApprovalRequest:
    kind: str  # "folder" | "write" | "command" | "delete"
    summary: str
    detail: dict = field(default_factory=dict)
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])
    created: float = field(default_factory=time.time)
    decision: str | None = None  # "allow" | "allow_always" | "deny"
    event: threading.Event = field(default_factory=threading.Event)

    def public(self) -> dict:
        return {"id": self.id, "kind": self.kind, "summary": self.summary,
                "detail": self.detail, "created": self.created}


# An approver receives the request and must set .decision (blocking is fine).
Approver = Callable[[ApprovalRequest], str]


def _norm(p: Path) -> Path:
    return Path(os.path.normcase(os.path.realpath(p)))


class Guard:
    def __init__(self, cfg: Config, audit: AuditLog, approver: Approver | None = None):
        self.cfg = cfg
        self.audit = audit
        self.approver = approver or (lambda req: "deny")
        self.session_roots: list[dict] = []
        self.session_auto: set[str] = set()
        ws = Path(cfg["workspace"])
        ws.mkdir(parents=True, exist_ok=True)
        self.workspace = ws
        self.trash = Path(cfg.state_dir) / "trash"
        self.backups = Path(cfg.state_dir) / "backups"

    # ---------- roots ----------
    def roots(self) -> list[dict]:
        rs = [{"path": str(self.workspace), "mode": "write"}]
        rs += list(self.cfg.get("roots") or [])
        rs += self.session_roots
        return rs

    def _root_for(self, p: Path) -> dict | None:
        np = _norm(p)
        best = None
        for r in self.roots():
            rp = _norm(Path(r["path"]))
            if np == rp or rp in np.parents:
                if best is None or len(str(rp)) > len(str(_norm(Path(best["path"])))):
                    best = r
        return best

    def resolve(self, path: str) -> Path:
        """Relative paths are relative to the workspace."""
        if not path or not str(path).strip():
            raise Denied("empty path")
        p = Path(os.path.expandvars(os.path.expanduser(str(path).strip().strip('"'))))
        if not p.is_absolute():
            p = self.workspace / p
        return Path(os.path.realpath(p))

    def _protected(self, p: Path) -> bool:
        s = os.path.normcase(str(p))
        if p.name.lower() in PROTECTED_NAMES:
            return True
        return any(os.path.normcase(os.sep + part + os.sep) in s + os.sep for part in PROTECTED_PARTS)

    # ---------- approvals ----------
    def ask(self, kind: str, summary: str, **detail) -> bool:
        policy_key = {"write": "write", "delete": "write", "command": "command", "folder": "new_folder_access"}[kind]
        if self.cfg["approvals"].get(policy_key) == "auto" or kind in self.session_auto:
            self.audit.record("approval.auto", kind=kind, summary=summary)
            return True
        req = ApprovalRequest(kind=kind, summary=summary, detail=detail)
        decision = self.approver(req) or "deny"
        self.audit.record("approval", kind=kind, summary=summary, decision=decision)
        if decision == "allow_always":
            self.session_auto.add(kind)
        return decision in ("allow", "allow_always")

    def _self_protected(self, p: Path) -> bool:
        """The agent may not rewrite its own code, guard, audit log or state."""
        from .config import HOME
        home, np = _norm(HOME), _norm(p)
        ws = _norm(self.workspace)
        inside_home = np == home or home in np.parents
        inside_ws = np == ws or ws in np.parents
        return inside_home and not inside_ws

    def _ensure_access(self, p: Path, need: str) -> None:
        if self._protected(p):
            self.audit.record("deny.protected", path=str(p))
            raise Denied(f"protected location: {p}")
        if need == "write" and self._self_protected(p):
            self.audit.record("deny.self", path=str(p))
            raise Denied(f"Kestrel's own files are read-only to the agent: {p}")
        r = self._root_for(p)
        if r and (need == "read" or r["mode"] == "write"):
            return
        # request folder access: ask for the nearest existing directory
        folder = p if p.is_dir() else p.parent
        while not folder.exists() and folder != folder.parent:
            folder = folder.parent
        mode = "write" if need == "write" else "read"
        ok = self.ask("folder", f"Allow {mode} access to {folder}?", path=str(folder), mode=mode)
        if not ok:
            raise Denied(f"no {need} access to {p} (folder access was not approved)")
        self.session_roots.append({"path": str(folder), "mode": mode})

    def check_read(self, path: str) -> Path:
        p = self.resolve(path)
        self._ensure_access(p, "read")
        return p

    def check_write(self, path: str, action: str = "write", preview: str = "") -> Path:
        p = self.resolve(path)
        self._ensure_access(p, "write")
        verb = "Overwrite" if p.exists() else "Create"
        if action == "write" and not self.ask("write", f"{verb} {p}", path=str(p), preview=preview[:1500]):
            raise Denied(f"write to {p} was not approved")
        return p

    # ---------- safe mutations ----------
    def backup(self, p: Path) -> str | None:
        if not p.exists() or not p.is_file():
            return None
        dst = self.backups / time.strftime("%Y%m%d") / f"{time.strftime('%H%M%S')}_{uuid.uuid4().hex[:6]}_{p.name}"
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, dst)
        return str(dst)

    def write_bytes(self, path: str, data: bytes, preview: str = "") -> Path:
        p = self.check_write(path, preview=preview)
        p.parent.mkdir(parents=True, exist_ok=True)
        bk = self.backup(p)
        tmp = p.with_name(p.name + f".kestrel-{uuid.uuid4().hex[:6]}.tmp")
        tmp.write_bytes(data)
        os.replace(tmp, p)  # atomic on the same volume
        self.audit.record("file.write", path=str(p), bytes=len(data), backup=bk)
        return p

    def delete(self, path: str) -> str:
        p = self.resolve(path)
        self._ensure_access(p, "write")
        if not p.exists():
            raise Denied(f"not found: {p}")
        if not self.ask("delete", f"Move to Kestrel trash: {p}", path=str(p)):
            raise Denied("delete was not approved")
        dst = self.trash / time.strftime("%Y%m%d-%H%M%S") / p.name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(p), str(dst))
        self.audit.record("file.trash", path=str(p), trash=str(dst))
        return str(dst)

    def move(self, src: str, dst: str) -> Path:
        s = self.resolve(src)
        self._ensure_access(s, "write")
        d = self.check_write(dst, preview=f"move from {s}")
        if d.exists():
            raise Denied(f"destination exists: {d}")
        d.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(s), str(d))
        self.audit.record("file.move", src=str(s), dst=str(d))
        return d
