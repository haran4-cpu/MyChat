"""Expert playbook library distilled from Claude Hunter Pro's DNA (permissive
licenses only). BM25 search over name/description/headings; full text is
loaded only when the model asks, so it never bloats the prompt.
"""
from __future__ import annotations

import gzip
import json
import math
import re
from collections import Counter
from pathlib import Path

_TOK = re.compile(r"[a-z0-9]+")
_STOP = set("a an and are as at be by for from how i in is it of on or that the this to use when with you your".split())


def _tokens(s: str) -> list[str]:
    return [t for t in _TOK.findall(s.lower()) if t not in _STOP and len(t) > 1]


class SkillLibrary:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.items: list[dict] = []
        self._idx = None
        if self.path.exists():
            with gzip.open(self.path, "rt", encoding="utf-8") as f:
                self.items = [json.loads(l) for l in f if l.strip()]
        self.by_id = {s["id"]: s for s in self.items}

    def __len__(self):
        return len(self.items)

    def _build(self):
        docs = []
        for s in self.items:
            heads = " ".join(re.findall(r"^#{1,3}\s+(.+)$", s["content"], re.M))
            text = f"{s['name']} " * 3 + f"{s['description']} " * 2 + heads + " " + s["content"][:2000]
            docs.append(Counter(_tokens(text)))
        n = len(docs)
        df = Counter(t for d in docs for t in d)
        self._idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}
        self._docs = docs
        self._len = [sum(d.values()) for d in docs]
        self._avg = sum(self._len) / max(n, 1)
        self._idx = True

    def search(self, query: str, k: int = 6) -> list[dict]:
        if not self.items:
            return []
        if self._idx is None:
            self._build()
        q = _tokens(query)
        scores = []
        for i, d in enumerate(self._docs):
            sc = 0.0
            for t in q:
                tf = d.get(t)
                if tf:
                    sc += self._idf[t] * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * self._len[i] / self._avg))
            if sc:
                sc *= 1 + self.items[i].get("quality", 50) / 400  # mild preference for well-structured playbooks
                scores.append((sc, i))
        scores.sort(reverse=True)
        return [self.items[i] for _, i in scores[:k]]

    def load(self, sid: str, max_chars: int = 6000) -> str:
        s = self.by_id.get(sid.strip().strip("[]"))
        if not s:
            return f"no skill with id {sid}; use skill_search first"
        body = re.sub(r"^---\n.*?\n---\n", "", s["content"], count=1, flags=re.S).strip()
        if len(body) > max_chars:
            body = body[:max_chars] + "\n... (playbook truncated)"
        return (f"PLAYBOOK: {s['name']}  (source: {s['repo']}, license {s['license']})\n"
                f"Adapt it to this task; tools named in it may not exist here - use your own tools.\n\n{body}")
