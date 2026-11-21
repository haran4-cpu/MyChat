"""Deterministic checks that run outside the model.

The model may claim a file is fine; these checks decide. They parse, they never
execute user code (running tests is run_command, which needs approval).
"""
from __future__ import annotations

import ast
import json
import os
import re
import shutil
import subprocess
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

_OOXML_MAIN = {".docx": "word/document.xml", ".xlsx": "xl/workbook.xml", ".pptx": "ppt/presentation.xml"}


JS_INPUT_TYPES = {".mjs": ("module",), ".cjs": ("commonjs",), ".js": ("module", "commonjs")}


def check_source(ext: str, source: str) -> tuple[str, str]:
    """Return (check name, diagnostic). No name means this format was not parsed."""
    try:
        if ext == ".py":
            ast.parse(source)
            return "Python syntax", ""
        if ext in (".json", ".ipynb"):
            json.loads(source.removeprefix("\ufeff"))
            return "JSON syntax", ""
    except SyntaxError as e:
        return "Python syntax", f"line {e.lineno}: {e.msg}"
    except json.JSONDecodeError as e:
        return "JSON syntax", f"line {e.lineno}, column {e.colno}: {e.msg}"
    if ext not in JS_INPUT_TYPES:
        return "", ""
    node = shutil.which("node")
    if node is None:
        return "JavaScript syntax", "Node.js unavailable for syntax check"
    diagnostic = "JavaScript parser rejected the source"
    for kind in JS_INPUT_TYPES[ext]:
        try:
            r = subprocess.run([node, "--check", f"--input-type={kind}"], input=source.encode("utf-8"),
                               capture_output=True, timeout=8, env={**os.environ, "NODE_OPTIONS": ""})
        except (OSError, subprocess.TimeoutExpired):
            return "JavaScript syntax", "Node.js syntax check could not complete"
        if r.returncode == 0:
            return "JavaScript syntax", ""
        lines = r.stderr.decode("utf-8", "replace").splitlines()
        message = next((line for line in lines if line.startswith("SyntaxError:")), None)
        if message:
            location = next((line for line in lines if line.startswith("[stdin]:")), "")
            diagnostic = f"{location.removeprefix('[stdin]:')}: {message}" if location else message
    return "JavaScript syntax", diagnostic


def check_file(p: Path) -> str:
    """Empty string = ok. Otherwise a short description of the problem."""
    p = Path(p)
    if not p.exists():
        return "file does not exist"
    if p.is_dir():
        return ""
    ext = p.suffix.lower()
    try:
        if p.stat().st_size == 0:
            return "file is empty"
        if ext in (".py", ".json", ".ipynb", *JS_INPUT_TYPES):
            name, error = check_source(ext, p.read_text(encoding="utf-8"))
            return f"{name} error: {error}" if error else ""
        elif ext in (".xml", ".svg"):
            ET.parse(p)
        elif ext in _OOXML_MAIN:
            with zipfile.ZipFile(p) as z:
                bad = z.testzip()
                if bad:
                    return f"corrupt zip member {bad}"
                names = set(z.namelist())
                if "[Content_Types].xml" not in names or _OOXML_MAIN[ext] not in names:
                    return "missing core Office parts"
                for n in names:
                    if n.endswith(".xml") or n.endswith(".rels"):
                        ET.fromstring(z.read(n))
        elif ext == ".pdf":
            b = p.read_bytes()
            if not b.startswith(b"%PDF-") or b"%%EOF" not in b[-1024:]:
                return "not a complete PDF"
            m = re.search(rb"startxref\s+(\d+)", b[-200:])
            if not m or b[int(m.group(1)):int(m.group(1)) + 4] != b"xref":
                return "PDF cross-reference table is broken"
        elif ext in (".html", ".htm"):
            t = p.read_text(encoding="utf-8", errors="replace").lower()
            if "<html" not in t and "<body" not in t and "<div" not in t:
                return "does not look like HTML"
            if t.count("<script") != t.count("</script>"):
                return "unbalanced <script> tags"
        elif ext == ".csv":
            import csv
            with p.open(encoding="utf-8", errors="replace", newline="") as f:
                widths = {len(r) for r in csv.reader(f) if r}
            if len(widths) > 1:
                return f"rows have different column counts: {sorted(widths)}"
        elif ext == ".zip":
            with zipfile.ZipFile(p) as z:
                bad = z.testzip()
                if bad:
                    return f"corrupt member {bad}"
        elif ext in (".ts", ".css", ".java", ".c", ".cpp", ".cs", ".go", ".rs"):
            t = p.read_text(encoding="utf-8", errors="replace")
            src = re.sub(r"//[^\n]*|/\*.*?\*/|\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`", "", t, flags=re.S)
            for o, c in ("{}", "()", "[]"):
                if src.count(o) != src.count(c):
                    return f"unbalanced {o}{c}: {src.count(o)} vs {src.count(c)}"
    except SyntaxError as e:
        return f"Python syntax error line {e.lineno}: {e.msg}"
    except json.JSONDecodeError as e:
        return f"JSON error line {e.lineno} col {e.colno}: {e.msg}"
    except ET.ParseError as e:
        return f"XML error: {e}"
    except zipfile.BadZipFile:
        return "not a valid zip/Office file"
    except UnicodeDecodeError:
        return "not valid UTF-8 text"
    return ""
