"""Long-term memory: a plain Markdown file the user can read and edit."""
from __future__ import annotations

import threading
import time
from pathlib import Path


class Memory:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.Lock()
        if not self.path.exists():
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text("# Kestrel memory\n\nOne fact per line. Edit freely.\n\n", encoding="utf-8")

    def add(self, fact: str) -> None:
        fact = " ".join(str(fact).split())[:300]
        if not fact:
            return
        with self._lock:
            existing = self.path.read_text(encoding="utf-8")
            if fact.lower() in existing.lower():
                return
            with self.path.open("a", encoding="utf-8") as f:
                f.write(f"- {fact}  ({time.strftime('%Y-%m-%d')})\n")

    def facts(self, limit: int = 20) -> list[str]:
        lines = [l[2:].strip() for l in self.path.read_text(encoding="utf-8").splitlines() if l.startswith("- ")]
        return lines[-limit:]
