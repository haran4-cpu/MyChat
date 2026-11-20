"""Deterministic checks that run outside the model.

The model may claim a file is fine; these checks decide. They parse, they never
execute user code (running tests is run_command, which needs approval).
"""
from __future__ import annotations

import ast
import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

_OOXML_MAIN = {".docx": "word/document.xml", ".xlsx": "xl/workbook.xml", ".pptx": "ppt/presentation.xml"}


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
        if ext == ".py":
            ast.parse(p.read_text(encoding="utf-8"), filename=str(p))
        elif ext in (".json", ".ipynb"):
            json.loads(p.read_text(encoding="utf-8"))
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
        elif ext in (".js", ".mjs", ".ts", ".css", ".java", ".c", ".cpp", ".cs", ".go", ".rs"):
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
