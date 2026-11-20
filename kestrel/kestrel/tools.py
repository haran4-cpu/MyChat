"""Tools the model can call. Descriptions are deliberately short: on a CPU every
prompt token costs time, and this block is part of the cached prefix.
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
import subprocess
import sys
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import docs, verify
from .guard import Denied, Guard

TEXT_LIMIT_BYTES = 4_000_000
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".next", "dist", "build", ".cache"}


class ToolError(Exception):
    pass


@dataclass
class Tool:
    name: str
    description: str
    params: dict
    required: list
    fn: Callable
    groups: set = field(default_factory=lambda: {"core"})

    def schema(self) -> dict:
        return {"type": "function", "function": {
            "name": self.name, "description": self.description,
            "parameters": {"type": "object", "properties": self.params, "required": self.required}}}


REGISTRY: dict[str, Tool] = {}


def tool(name, description, params=None, required=None, groups=("core",)):
    def deco(fn):
        REGISTRY[name] = Tool(name, description, params or {}, list(required or []), fn, set(groups))
        return fn
    return deco


def S(desc, typ="string", **kw):
    d = {"type": typ, "description": desc}
    d.update(kw)
    return d


# ---------------------------------------------------------------------------
class Ctx:
    """What tools can reach. Built by the agent."""

    def __init__(self, guard: Guard, cfg, skills=None, memory=None, mission=None, router=None):
        self.guard, self.cfg, self.skills, self.memory, self.mission = guard, cfg, skills, memory, mission
        self.router = router
        self.session = None
        self.files_touched: list[str] = []
        self.finished: dict | None = None


def _rel(ctx: Ctx, p: Path) -> str:
    try:
        return str(p.relative_to(ctx.guard.workspace))
    except ValueError:
        return str(p)


def _is_text(p: Path) -> bool:
    try:
        with p.open("rb") as f:
            chunk = f.read(4096)
        return b"\x00" not in chunk
    except OSError:
        return False


# ---------------------------------------------------------------------------
@tool("list_dir", "List a folder. Relative paths are inside the workspace.",
      {"path": S("folder path", default="."), "depth": S("levels, 1-3", "integer")})
def list_dir(ctx: Ctx, path=".", depth=1):
    p = ctx.guard.check_read(path or ".")
    if not p.is_dir():
        raise ToolError(f"not a folder: {p}")
    depth = max(1, min(int(depth or 1), 3))
    out: list[str] = []

    def walk(d: Path, lvl: int):
        try:
            items = sorted(d.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
        except OSError as e:
            out.append("  " * lvl + f"(cannot list: {e})")
            return
        for it in items:
            if len(out) >= 300:
                return
            if it.is_dir():
                if it.name in SKIP_DIRS:
                    out.append("  " * lvl + f"{it.name}/ (skipped)")
                    continue
                out.append("  " * lvl + f"{it.name}/")
                if lvl + 1 < depth:
                    walk(it, lvl + 1)
            else:
                try:
                    sz = it.stat().st_size
                except OSError:
                    sz = -1
                out.append("  " * lvl + f"{it.name}  ({sz:,} B)")

    walk(p, 0)
    if len(out) >= 300:
        out.append("... (truncated at 300 entries; list a subfolder)")
    return f"{p}\n" + ("\n".join(out) or "(empty)")


@tool("read_file", "Read a file (text, code, docx, xlsx, pptx, pdf). Use start/lines for big files.",
      {"path": S("file path"), "start": S("first line, 1-based", "integer"), "lines": S("how many lines (default 200)", "integer")},
      ["path"])
def read_file(ctx: Ctx, path, start=1, lines=200):
    p = ctx.guard.check_read(path)
    if not p.is_file():
        raise ToolError(f"not a file: {p}")
    ext = p.suffix.lower()
    if ext in docs.EXTRACTORS:
        text = docs.extract_text(p)
    else:
        if p.stat().st_size > TEXT_LIMIT_BYTES:
            raise ToolError("file too large to read as text; use search_files")
        if not _is_text(p):
            return f"{p} is binary ({p.stat().st_size:,} bytes); cannot show as text."
        text = p.read_text(encoding="utf-8", errors="replace")
    all_lines = text.splitlines()
    start = max(1, int(start or 1))
    lines = max(1, min(int(lines or 200), 800))
    chunk = all_lines[start - 1:start - 1 + lines]
    body = "\n".join(f"{start + i:>5}| {l}" for i, l in enumerate(chunk))
    more = len(all_lines) - (start - 1 + len(chunk))
    tail = f"\n... {more} more lines (next: start={start + len(chunk)})" if more > 0 else ""
    return f"{p} ({len(all_lines)} lines)\n{body}{tail}"


@tool("search_files", "Regex search inside files under a folder. Returns path:line: text.",
      {"pattern": S("regular expression"), "path": S("folder", default="."), "glob": S("file name filter like *.py")},
      ["pattern"])
def search_files(ctx: Ctx, pattern, path=".", glob="*"):
    root = ctx.guard.check_read(path or ".")
    try:
        rx = re.compile(pattern, re.I)
    except re.error as e:
        raise ToolError(f"bad regex: {e}")
    hits = []
    for r, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if not fnmatch.fnmatch(f.lower(), (glob or "*").lower()):
                continue
            fp = Path(r) / f
            try:
                if fp.stat().st_size > TEXT_LIMIT_BYTES or not _is_text(fp):
                    continue
                with fp.open(encoding="utf-8", errors="replace") as fh:
                    for i, line in enumerate(fh, 1):
                        if rx.search(line):
                            hits.append(f"{_rel(ctx, fp)}:{i}: {line.strip()[:200]}")
                            if len(hits) >= 80:
                                return "\n".join(hits) + "\n... (first 80 matches)"
            except OSError:
                continue
    return "\n".join(hits) or "no matches"


@tool("find_files", "Find files by name pattern (e.g. *.md) under a folder.",
      {"name": S("glob pattern"), "path": S("folder", default=".")}, ["name"])
def find_files(ctx: Ctx, name, path="."):
    root = ctx.guard.check_read(path or ".")
    out = []
    for r, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if fnmatch.fnmatch(f.lower(), name.lower()):
                out.append(_rel(ctx, Path(r) / f))
                if len(out) >= 200:
                    return "\n".join(out) + "\n... (first 200)"
    return "\n".join(out) or "nothing found"


@tool("write_file", "Create or overwrite a text file (code, md, html, csv, json...). Old version is backed up.",
      {"path": S("file path"), "content": S("full file content")}, ["path", "content"])
def write_file(ctx: Ctx, path, content):
    if not isinstance(content, str):
        content = json.dumps(content, indent=2, ensure_ascii=False)
    p = ctx.guard.write_bytes(path, content.encode("utf-8"), preview=content)
    ctx.files_touched.append(str(p))
    issues = verify.check_file(p)
    return f"wrote {p} ({len(content):,} chars)" + (f"\nCHECK FAILED: {issues}" if issues else "\ncheck: ok")


@tool("edit_file", "Replace one exact, unique snippet in a file. Read the file first.",
      {"path": S("file path"), "old": S("exact existing text (must be unique)"), "new": S("replacement text")},
      ["path", "old", "new"])
def edit_file(ctx: Ctx, path, old, new):
    p = ctx.guard.check_read(path)
    if not p.is_file():
        raise ToolError(f"not a file: {p}")
    text = p.read_text(encoding="utf-8")
    n = text.count(old)
    if n == 0:
        # help the model: show the closest line
        first = (old.strip().splitlines() or [""])[0].strip()
        near = [f"{i}: {l}" for i, l in enumerate(text.splitlines(), 1) if first and first[:30] in l][:3]
        raise ToolError("old text not found" + (f"; similar lines: {near}" if near else "; read_file first"))
    if n > 1:
        raise ToolError(f"old text appears {n} times; include more surrounding lines to make it unique")
    out = text.replace(old, new, 1)
    p = ctx.guard.write_bytes(str(p), out.encode("utf-8"), preview=f"--- old\n{old}\n+++ new\n{new}")
    ctx.files_touched.append(str(p))
    issues = verify.check_file(p)
    return f"edited {p}" + (f"\nCHECK FAILED: {issues}" if issues else "\ncheck: ok")


@tool("make_document",
      "Create a formatted document. Type comes from the extension: .docx .xlsx .pptx .pdf .html. "
      "content is Markdown: # headings, - bullets, **bold**, | tables |. pptx: each '# ' starts a slide. "
      "xlsx: '## Sheet' then a Markdown table or CSV lines; cells starting with = are formulas.",
      {"path": S("output file path"), "content": S("Markdown content"), "title": S("document title")},
      ["path", "content"])
def make_document(ctx: Ctx, path, content, title=""):
    ext = Path(path).suffix.lower()
    if ext not in docs.MAKERS:
        raise ToolError(f"unsupported type {ext}; use one of {sorted(docs.MAKERS)} or write_file for text formats")
    data = docs.MAKERS[ext](content, title or Path(path).stem)
    p = ctx.guard.write_bytes(path, data, preview=content)
    ctx.files_touched.append(str(p))
    issues = verify.check_file(p)
    return f"created {p} ({len(data):,} bytes)" + (f"\nCHECK FAILED: {issues}" if issues else "\ncheck: ok (file opens and parses)")


@tool("make_folder", "Create a folder.", {"path": S("folder path")}, ["path"])
def make_folder(ctx: Ctx, path):
    p = ctx.guard.check_write(path, action="mkdir")
    p.mkdir(parents=True, exist_ok=True)
    ctx.guard.audit.record("dir.create", path=str(p))
    return f"folder ready: {p}"


@tool("move_path", "Move or rename a file or folder.", {"src": S("from"), "dst": S("to")}, ["src", "dst"])
def move_path(ctx: Ctx, src, dst):
    return f"moved to {ctx.guard.move(src, dst)}"


@tool("delete_path", "Move a file or folder to the Kestrel trash (recoverable).", {"path": S("path")}, ["path"])
def delete_path(ctx: Ctx, path):
    return f"moved to trash: {ctx.guard.delete(path)}"


@tool("run_command", "Run a shell command (needs approval). Use for tests, builds, git, python scripts.",
      {"command": S("command line"), "cwd": S("working folder", default="."), "timeout": S("seconds (max 900)", "integer")},
      ["command"], groups=("core",))
def run_command(ctx: Ctx, command, cwd=".", timeout=120):
    wd = ctx.guard.check_read(cwd or ".")
    if not ctx.guard.ask("command", f"Run in {wd}: {command}", command=command, cwd=str(wd)):
        raise Denied("command was not approved")
    timeout = max(5, min(int(timeout or 120), 900))
    try:
        r = subprocess.run(command, shell=True, cwd=str(wd), capture_output=True, timeout=timeout,
                           stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        ctx.guard.audit.record("command", command=command, cwd=str(wd), result="timeout")
        raise ToolError(f"timed out after {timeout}s")
    out = _decode(r.stdout) + ("\n[stderr]\n" + _decode(r.stderr) if r.stderr else "")
    ctx.guard.audit.record("command", command=command, cwd=str(wd), exit=r.returncode)
    if len(out) > 6000:
        out = out[:2500] + f"\n... ({len(out) - 5000:,} chars cut) ...\n" + out[-2500:]
    return f"exit code {r.returncode}\n{out}"


def _decode(b: bytes) -> str:
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:  # Windows console code page (e.g. cp862/cp1255 for Hebrew)
        return b.decode("oem" if sys.platform == "win32" else "latin-1", "replace")


@tool("check_file", "Deterministically validate a file: parses JSON/Python/XML/docx/xlsx/pptx/pdf, runs nothing.",
      {"path": S("file path")}, ["path"])
def check_file_tool(ctx: Ctx, path):
    p = ctx.guard.check_read(path)
    issues = verify.check_file(p)
    return f"FAILED: {issues}" if issues else f"ok: {p} is valid"


@tool("skill_search", "Search the expert playbook library (1000+ skills: debugging, tdd, architecture, review...).",
      {"query": S("what you need")}, ["query"], groups=("core",))
def skill_search(ctx: Ctx, query):
    if not ctx.skills:
        return "skill library not installed"
    res = ctx.skills.search(query, k=6)
    return "\n".join(f"[{s['id']}] {s['name']} - {s['description'][:150]}" for s in res) or "no skills found"


@tool("skill_load", "Load a playbook by id from skill_search and follow it.", {"id": S("skill id")}, ["id"])
def skill_load(ctx: Ctx, id):
    if not ctx.skills:
        return "skill library not installed"
    return ctx.skills.load(id, max_chars=6000)


@tool("remember", "Save a durable fact or lesson to long-term memory (one line).", {"fact": S("the fact")}, ["fact"])
def remember(ctx: Ctx, fact):
    if ctx.memory is None:
        return "memory unavailable"
    ctx.memory.add(fact)
    return "saved"


@tool("web_fetch", "Fetch a web page as text (only when online mode allows it).", {"url": S("https URL")}, ["url"],
      groups=("online",))
def web_fetch(ctx: Ctx, url):
    if not (ctx.cfg["online"].get("enabled") and ctx.cfg["online"].get("allow_web_fetch")):
        raise Denied("web access is off (enable online.allow_web_fetch in settings)")
    if not url.startswith(("https://", "http://")):
        raise ToolError("url must start with http(s)://")
    req = urllib.request.Request(url, headers={"User-Agent": "Kestrel/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read(2_000_000).decode(r.headers.get_content_charset() or "utf-8", "replace")
    text = re.sub(r"(?is)<(script|style|noscript).*?</\1>", " ", raw)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = re.sub(r"[ \t]+", " ", re.sub(r"\n\s*\n+", "\n\n", text)).strip()
    ctx.guard.audit.record("web.fetch", url=url, chars=len(text))
    return text[:8000]


@tool("recall", "Get the exact text of earlier messages listed in the outline, e.g. 'm12-m15' or 'm3,m7'.",
      {"ids": S("message ids")}, ["ids"])
def recall(ctx: Ctx, ids):
    sess = getattr(ctx, "session", None)
    return sess.recall(ids) if sess else "recall unavailable"


@tool("calc", "Exact arithmetic without the model: + - * / ** % //, parentheses, fractions, decimals. E.g. '(1/3 + 0.25) * 12'.",
      {"expression": S("arithmetic expression")}, ["expression"])
def calc(ctx: Ctx, expression):
    from .exactcalc import calculate
    return calculate(expression)


@tool("quick_edit",
      "Fast focused code fix in ONE file using the code model: give the file and a one-sentence instruction. "
      "It finds the exact snippet, replaces it, checks syntax. Best for small fixes; use edit_file for multi-part changes.",
      {"path": S("file path"), "instruction": S("what to change, one sentence")}, ["path", "instruction"])
def quick_edit(ctx: Ctx, path, instruction):
    from .coder import propose_edit
    p = ctx.guard.check_read(path)
    if not p.is_file():
        raise ToolError(f"not a file: {p}")
    source = p.read_text(encoding="utf-8")
    proposal, info = propose_edit(ctx.router, source, instruction, p.suffix.lower())
    updated = source.replace(proposal["old"], proposal["replacement"], 1)
    preview = f"--- old\n{proposal['old']}\n+++ new\n{proposal['replacement']}"
    p = ctx.guard.write_bytes(str(p), updated.encode("utf-8"), preview=preview)
    ctx.files_touched.append(str(p))
    issues = verify.check_file(p)
    if issues:  # roll the change back: never leave a file broken by a quick edit
        ctx.guard.write_bytes(str(p), source.encode("utf-8"), preview="(automatic rollback of a broken quick_edit)")
        raise ToolError(f"edit rejected and rolled back - it broke the file: {issues}")
    return f"edited {p} with {info}\n{preview}\ncheck: ok"


@tool("finish", "Call when the task (or mission step) is complete. Give a short summary and the evidence.",
      {"summary": S("what was done"), "evidence": S("how you verified it (checks, outputs, files)")}, ["summary"])
def finish(ctx: Ctx, summary, evidence=""):
    ctx.finished = {"summary": summary, "evidence": evidence, "files": list(dict.fromkeys(ctx.files_touched))}
    return "ok"


# ---------------------------------------------------------------------------
def schemas(groups=("core",)) -> list:
    return [t.schema() for t in REGISTRY.values() if t.groups & set(groups)]


def coerce_args(t: Tool, args: dict) -> dict:
    clean = {}
    for k, v in (args or {}).items():
        if k not in t.params:
            continue  # small models invent parameters; drop them silently
        if t.params[k].get("type") == "integer" and isinstance(v, str):
            try:
                v = int(v.strip())
            except ValueError:
                continue
        clean[k] = v
    missing = [r for r in t.required if r not in clean or clean[r] in (None, "")]
    if missing:
        raise ToolError(f"missing required argument(s): {', '.join(missing)}")
    return clean


def nearby(ctx: Ctx, path: str) -> str:
    """What the person probably meant when a path does not exist (measured 2026-11-20: asked about the project
    "DJ-TiTo-23.8", the local model tried a folder of that name 9 times — the project was the file DJ-TiTo-23.8.html —
    then created the folder and wrote reports about an empty project)."""
    try:
        p = ctx.guard.resolve(path)
    except Exception:
        return ""
    parent = p.parent
    if not parent.is_dir():
        return ""
    want = p.name.lower()
    hits = []
    try:
        for it in parent.iterdir():
            n = it.name.lower()
            if n == want or n.startswith(want + ".") or (Path(n).stem == Path(want).stem and n != want) or (len(want) > 3 and want in n):
                kind = "folder" if it.is_dir() else f"file, {it.stat().st_size:,} B"
                hits.append(f"{it} ({kind})")
    except OSError:
        return ""
    if not hits:
        return ""
    return ("\nDID YOU MEAN: " + "; ".join(hits[:5]) +
            "\nUse that exact path. Do not create a file or folder with the name the person used: what they mean already exists.")


WRITE_TOOLS = {"write_file", "make_folder", "append_file", "edit_file", "move", "delete", "build_doc", "write_docx"}


def call(ctx: Ctx, name: str, args: dict, limit: int = 3000) -> tuple[str, bool]:
    """Returns (result_text, ok)."""
    t = REGISTRY.get(name)
    if not t:
        return f"ERROR: unknown tool '{name}'. Available: {', '.join(REGISTRY)}", False
    # a "step complete" with nothing read is a claim without proof (measured: three mission steps were "completed" by
    # writing reports about files that were never read)
    if name == "finish" and getattr(ctx, "missing", None) and getattr(ctx, "reads", 0) == 0:
        return ("ERROR: nothing was read or produced yet, so nothing can be reported as done. Find and read the actual files "
                "first (list_dir / find_files / read_file), then finish with what you found, citing them."), False
    target = str(args.get("path", "")).strip().strip('"').rstrip("\\/").lower()
    if name in ("make_folder", "write_file", "make_document") and getattr(ctx, "missing", None) and (
            target in ctx.missing or any(target.startswith(m.rstrip("\\/") + sep) for m in ctx.missing for sep in ("\\", "/"))):
        return ("DENIED: you looked for this path a moment ago and it did not exist. Creating it would invent the project. "
                "Look for what the person meant (find_files with part of the name) instead."), False
    try:
        out = t.fn(ctx, **coerce_args(t, args))
        ok = True
        if name in ("read_file", "find_files", "search_files"):
            ctx.reads = getattr(ctx, "reads", 0) + 1
    except Denied as e:
        out, ok = f"DENIED: {e}", False
    except ToolError as e:
        out, ok = f"ERROR: {e}", False
    except Exception as e:  # never let one tool crash the session
        out, ok = f"ERROR: {type(e).__name__}: {e}", False
    if not ok and args.get("path") and re.search(r"not a folder|not found|no such file|does not exist|cannot find", str(out), re.I):
        hint = nearby(ctx, str(args["path"]))
        if hint:   # something with that name exists: the person meant it, so creating the missing path is blocked
            if not hasattr(ctx, "missing"):
                ctx.missing = set()
            ctx.missing.add(str(args["path"]).strip().strip('"').rstrip("\\/").lower())
            out = str(out) + hint
    out = str(out)
    if len(out) > limit:
        out = out[:limit] + f"\n... (cut at {limit} chars; read in smaller pieces)"
    return out, ok
