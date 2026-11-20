"""Tiny Markdown block/inline parser shared by every document maker."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

RTL_RX = re.compile(r"[֐-ࣿיִ-﷿ﹰ-﻿]")
LTR_RX = re.compile(r"[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]")


def is_rtl(text: str) -> bool:
    """Base direction by first strong character (Unicode bidi rule P2)."""
    for ch in text:
        if RTL_RX.match(ch):
            return True
        if LTR_RX.match(ch):
            return False
    return False


@dataclass
class Block:
    kind: str  # heading | para | bullet | number | table | code | break | rule
    text: str = ""
    level: int = 0
    rows: list = field(default_factory=list)


_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")


def _cells(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def parse(md: str) -> list[Block]:
    lines = (md or "").replace("\r\n", "\n").replace("\t", "    ").split("\n")
    out: list[Block] = []
    para: list[str] = []
    i = 0

    def flush():
        if para:
            out.append(Block("para", " ".join(x.strip() for x in para)))
            para.clear()

    while i < len(lines):
        line = lines[i]
        s = line.strip()
        if s.startswith("```"):
            flush()
            code = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code.append(lines[i])
                i += 1
            out.append(Block("code", "\n".join(code)))
            i += 1
            continue
        if not s:
            flush()
            i += 1
            continue
        if s in ("\\pagebreak", "<!-- pagebreak -->", "[pagebreak]"):
            flush()
            out.append(Block("break"))
            i += 1
            continue
        if re.fullmatch(r"(-{3,}|\*{3,}|_{3,})", s):
            flush()
            out.append(Block("rule"))
            i += 1
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", s)
        if m:
            flush()
            out.append(Block("heading", m.group(2).strip().rstrip("#").strip(), len(m.group(1))))
            i += 1
            continue
        if "|" in s and i + 1 < len(lines) and _TABLE_SEP.match(lines[i + 1]):
            flush()
            rows = [_cells(s)]
            i += 2
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                rows.append(_cells(lines[i]))
                i += 1
            w = max(len(r) for r in rows)
            rows = [r + [""] * (w - len(r)) for r in rows]
            out.append(Block("table", rows=rows))
            continue
        m = re.match(r"^(\s*)[-*+]\s+(.*)$", line)
        if m:
            flush()
            out.append(Block("bullet", m.group(2).strip(), len(m.group(1)) // 2))
            i += 1
            continue
        m = re.match(r"^(\s*)\d+[.)]\s+(.*)$", line)
        if m:
            flush()
            out.append(Block("number", m.group(2).strip(), len(m.group(1)) // 2))
            i += 1
            continue
        if s.startswith(">"):
            flush()
            out.append(Block("para", s.lstrip("> ").strip(), 1))
            i += 1
            continue
        para.append(s)
        i += 1
    flush()
    return out


_INLINE = re.compile(r"(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))")


def inline(text: str) -> list[tuple[str, dict]]:
    """Split text into (run, style) where style has bold/italic/code/link."""
    runs = []
    pos = 0
    for m in _INLINE.finditer(text):
        if m.start() > pos:
            runs.append((text[pos:m.start()], {}))
        t = m.group(0)
        if t.startswith("**") or t.startswith("__"):
            runs.append((t[2:-2], {"bold": True}))
        elif t.startswith("`"):
            runs.append((t[1:-1], {"code": True}))
        elif t.startswith("["):
            mm = re.match(r"\[([^\]]+)\]\(([^)]+)\)", t)
            runs.append((mm.group(1), {"link": mm.group(2)}))
        else:
            runs.append((t[1:-1], {"italic": True}))
        pos = m.end()
    if pos < len(text):
        runs.append((text[pos:], {}))
    return [r for r in runs if r[0]]


def plain(text: str) -> str:
    return "".join(r for r, _ in inline(text))
