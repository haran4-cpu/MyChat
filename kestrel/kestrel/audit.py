"""Tamper-evident action log.

Every entry carries sha256(prev_hash + canonical_json(entry)). Editing or deleting
any past line breaks the chain, which `verify()` detects. The model never writes
here directly; only the guard and the agent loop do.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from pathlib import Path

GENESIS = "0" * 64


def _canon(obj) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


class AuditLog:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._last = self._tail_hash()

    def _tail_hash(self) -> str:
        if not self.path.exists():
            return GENESIS
        last = GENESIS
        with self.path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        last = json.loads(line)["hash"]
                    except (json.JSONDecodeError, KeyError):
                        pass
        return last

    def record(self, event: str, /, **data) -> str:
        with self._lock:
            entry = {"ts": round(time.time(), 3), "kind": event, "data": data, "prev": self._last}
            h = hashlib.sha256((self._last + _canon(entry)).encode("utf-8")).hexdigest()
            entry["hash"] = h
            with self.path.open("a", encoding="utf-8") as f:
                f.write(_canon(entry) + "\n")
            self._last = h
            return h

    def verify(self) -> tuple[bool, int, str]:
        """Returns (ok, entries_checked, message)."""
        if not self.path.exists():
            return True, 0, "empty log"
        prev = GENESIS
        n = 0
        with self.path.open("r", encoding="utf-8") as f:
            for i, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    return False, n, f"line {i}: not JSON"
                h = e.pop("hash", None)
                if e.get("prev") != prev:
                    return False, n, f"line {i}: chain broken (prev mismatch)"
                if hashlib.sha256((prev + _canon(e)).encode("utf-8")).hexdigest() != h:
                    return False, n, f"line {i}: content was modified"
                prev = h
                n += 1
        return True, n, "chain intact"

    def tail(self, n: int = 50) -> list[dict]:
        if not self.path.exists():
            return []
        lines = self.path.read_text(encoding="utf-8").splitlines()[-n:]
        out = []
        for l in lines:
            try:
                out.append(json.loads(l))
            except json.JSONDecodeError:
                pass
        return out
