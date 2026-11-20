"""PDF writer with embedded TrueType fonts (so Hebrew/Arabic/any Unicode works),
right-to-left line ordering, tables, page numbers. Plus a best-effort text
extractor. Standard library only.
"""
from __future__ import annotations

import os
import re
import struct
import zlib
from pathlib import Path

from .mdparse import Block, inline, is_rtl

FONT_CANDIDATES = {
    "regular": [r"C:\Windows\Fonts\arial.ttf", r"C:\Windows\Fonts\segoeui.ttf", r"C:\Windows\Fonts\tahoma.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/Library/Fonts/Arial.ttf",
                "/System/Library/Fonts/Supplemental/Arial.ttf"],
    "bold": [r"C:\Windows\Fonts\arialbd.ttf", r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\tahomabd.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/Library/Fonts/Arial Bold.ttf",
             "/System/Library/Fonts/Supplemental/Arial Bold.ttf"],
    "mono": [r"C:\Windows\Fonts\consola.ttf", r"C:\Windows\Fonts\cour.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/Library/Fonts/Courier New.ttf"],
}


class TTF:
    def __init__(self, path: str):
        self.path = path
        self.data = Path(path).read_bytes()
        d = self.data
        n = struct.unpack(">H", d[4:6])[0]
        self.tables = {}
        for i in range(n):
            tag, _, off, ln = struct.unpack(">4sIII", d[12 + 16 * i: 28 + 16 * i])
            self.tables[tag.decode("latin-1")] = (off, ln)
        ho = self.tables["head"][0]
        self.upem = struct.unpack(">H", d[ho + 18:ho + 20])[0]
        self.bbox = struct.unpack(">hhhh", d[ho + 36:ho + 44])
        hh = self.tables["hhea"][0]
        self.ascent, self.descent = struct.unpack(">hh", d[hh + 4:hh + 8])
        nhm = struct.unpack(">H", d[hh + 34:hh + 36])[0]
        mo = self.tables["hmtx"][0]
        self.adv = [struct.unpack(">H", d[mo + 4 * i: mo + 4 * i + 2])[0] for i in range(nhm)]
        self.cmap = self._cmap()
        self.name = re.sub(r"[^A-Za-z0-9]", "", Path(path).stem) or "Font"

    def _cmap(self) -> dict:
        d = self.data
        co = self.tables["cmap"][0]
        nt = struct.unpack(">H", d[co + 2:co + 4])[0]
        subs = {}
        for i in range(nt):
            pid, eid, off = struct.unpack(">HHI", d[co + 4 + 8 * i: co + 12 + 8 * i])
            subs[(pid, eid)] = co + off
        m: dict[int, int] = {}
        for key in ((3, 10), (0, 4), (3, 1), (0, 3)):
            if key not in subs:
                continue
            o = subs[key]
            fmt = struct.unpack(">H", d[o:o + 2])[0]
            if fmt == 12:
                ng = struct.unpack(">I", d[o + 12:o + 16])[0]
                for g in range(ng):
                    s, e, gid = struct.unpack(">III", d[o + 16 + 12 * g: o + 28 + 12 * g])
                    for c in range(s, e + 1):
                        m[c] = gid + (c - s)
                return m
            if fmt == 4:
                segx2 = struct.unpack(">H", d[o + 6:o + 8])[0]
                seg = segx2 // 2
                ends = struct.unpack(f">{seg}H", d[o + 14:o + 14 + segx2])
                starts = struct.unpack(f">{seg}H", d[o + 16 + segx2:o + 16 + 2 * segx2])
                deltas = struct.unpack(f">{seg}h", d[o + 16 + 2 * segx2:o + 16 + 3 * segx2])
                ro_base = o + 16 + 3 * segx2
                ros = struct.unpack(f">{seg}H", d[ro_base:ro_base + segx2])
                for k in range(seg):
                    for c in range(starts[k], ends[k] + 1):
                        if c == 0xFFFF:
                            continue
                        if ros[k] == 0:
                            g = (c + deltas[k]) & 0xFFFF
                        else:
                            a = ro_base + 2 * k + ros[k] + 2 * (c - starts[k])
                            g = struct.unpack(">H", d[a:a + 2])[0]
                            if g:
                                g = (g + deltas[k]) & 0xFFFF
                        if g:
                            m[c] = g
                return m
        return m

    def gid(self, ch: str) -> int:
        return self.cmap.get(ord(ch), 0)

    def width(self, gid: int) -> float:
        a = self.adv[gid] if gid < len(self.adv) else self.adv[-1]
        return a * 1000.0 / self.upem

    def text_width(self, s: str, size: float) -> float:
        return sum(self.width(self.gid(c)) for c in s) * size / 1000.0


class Base14:
    """Fallback when no TrueType font exists: Helvetica, Latin-1 only."""
    name = "Helvetica"

    def text_width(self, s, size):
        w = 0
        for c in s:
            w += 278 if c in " il.,;:'|!" else 611 if c.isupper() else 556
        return w * size / 1000.0


def _find(kind: str) -> str | None:
    for p in FONT_CANDIDATES[kind]:
        if os.path.exists(p):
            return p
    return None


# ---------------------------------------------------------------------------
_MIRROR = str.maketrans("()[]{}<>", ")(][}{><")
_R = re.compile(r"[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]")
_L = re.compile(r"[0-9A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]")


def visual(line: str, base_rtl: bool) -> str:
    """Logical -> visual order for one line (simplified Unicode bidi)."""
    if not base_rtl and not _R.search(line):
        return line
    cls = ["R" if _R.match(c) else "L" if _L.match(c) else "N" for c in line]
    n = len(cls)
    for i in range(n):  # resolve neutrals from neighbours
        if cls[i] != "N":
            continue
        j = i - 1
        while j >= 0 and cls[j] == "N":
            j -= 1
        k = i + 1
        while k < n and cls[k] == "N":
            k += 1
        prev = cls[j] if j >= 0 else ("R" if base_rtl else "L")
        nxt = cls[k] if k < n and cls[k] in "RL" else ("R" if base_rtl else "L")
        cls[i] = prev if prev == nxt else ("R" if base_rtl else "L")
    groups, cur, cc = [], "", None
    for c, t in zip(line, cls):
        if t != cc and cur:
            groups.append((cc, cur))
            cur = ""
        cc = t
        cur += c
    if cur:
        groups.append((cc, cur))
    out = [(t, g[::-1].translate(_MIRROR) if t == "R" else g) for t, g in groups]
    if base_rtl:
        out.reverse()
    return "".join(g for _, g in out)


# ---------------------------------------------------------------------------
class Doc:
    W, H, M = 595.28, 841.89, 56.0

    def __init__(self):
        self.fonts = {}
        reg = _find("regular")
        self.fallback = reg is None
        if reg:
            self.fonts["R"] = TTF(reg)
            b, m = _find("bold"), _find("mono")
            self.fonts["B"] = TTF(b) if b else self.fonts["R"]
            self.fonts["M"] = TTF(m) if m else self.fonts["R"]
        else:
            self.fonts = {"R": Base14(), "B": Base14(), "M": Base14()}
        self.used = {k: set() for k in "RBM"}
        self.pages: list[list[str]] = []
        self.new_page()

    # -- page/flow --
    def new_page(self):
        self.pages.append([])
        self.y = self.H - self.M

    def need(self, h: float):
        if self.y - h < self.M + 14:
            self.new_page()

    def _enc(self, key: str, s: str) -> str:
        f = self.fonts[key]
        if isinstance(f, Base14):
            b = s.encode("latin-1", "replace")
            return "(" + b.decode("latin-1").replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ")"
        gids = [f.gid(c) for c in s]
        for c, g in zip(s, gids):
            self.used[key].add((g, c))
        return "<" + "".join(f"{g:04X}" for g in gids) + ">"

    def text(self, x, y, s, key="R", size=11.0, color=(0.1, 0.1, 0.18), page=-1):
        if not s:
            return
        r, g, b = color
        self.pages[page].append(f"BT {r:.3f} {g:.3f} {b:.3f} rg /F{key} {size:.2f} Tf {x:.2f} {y:.2f} Td {self._enc(key, s)} Tj ET")

    def rect(self, x, y, w, h, fill=None, stroke=None, lw=0.5):
        ops = []
        if fill:
            ops.append(f"{fill[0]:.3f} {fill[1]:.3f} {fill[2]:.3f} rg")
        if stroke:
            ops.append(f"{stroke[0]:.3f} {stroke[1]:.3f} {stroke[2]:.3f} RG {lw} w")
        op = "B" if fill and stroke else ("f" if fill else "S")
        ops.append(f"{x:.2f} {y:.2f} {w:.2f} {h:.2f} re {op}")
        self.pages[-1].append(" ".join(ops))

    def line(self, x1, y1, x2, y2, color=(0.65, 0.65, 0.65), lw=0.6):
        self.pages[-1].append(f"{color[0]:.3f} {color[1]:.3f} {color[2]:.3f} RG {lw} w {x1:.2f} {y1:.2f} m {x2:.2f} {y2:.2f} l S")

    # -- wrapping --
    def wrap(self, runs: list[tuple[str, str]], width: float, size: float) -> list[list[tuple[str, str]]]:
        """runs: [(text, fontkey)] -> lines of runs."""
        words: list[tuple[str, str]] = []
        for t, k in runs:
            for part in re.split(r"(\s+)", t):
                if part:
                    words.append((part, k))
        lines, cur, w = [], [], 0.0
        for part, k in words:
            pw = self.fonts[k].text_width(part, size)
            if part.isspace():
                if cur:
                    cur.append((" ", k))
                    w += self.fonts[k].text_width(" ", size)
                continue
            if w + pw > width and cur:
                while cur and cur[-1][0] == " ":
                    cur.pop()
                lines.append(cur)
                cur, w = [], 0.0
            while pw > width and len(part) > 1:  # hard-break very long words
                n = max(1, int(len(part) * width / pw) - 1)
                lines.append([(part[:n], k)])
                part = part[n:]
                pw = self.fonts[k].text_width(part, size)
            cur.append((part, k))
            w += pw
        while cur and cur[-1][0] == " ":
            cur.pop()
        if cur:
            lines.append(cur)
        return lines or [[("", "R")]]

    def paragraph(self, text: str, size=11.0, key="R", indent=0.0, bullet: str | None = None,
                  color=(0.1, 0.1, 0.18), space_after=6.0, mono=False):
        rtl = is_rtl(text)
        runs = [(text, "M")] if mono else [(t, "B" if st.get("bold") else key) for t, st in inline(text)]
        if rtl:  # styled runs and bidi reordering do not mix well; keep paragraph font
            runs = [("".join(t for t, _ in runs), key)]
        width = self.W - 2 * self.M - indent
        lead = size * 1.42
        for li, ln in enumerate(self.wrap(runs, width, size)):
            self.need(lead)
            self.y -= lead
            if rtl:
                s = visual("".join(t for t, _ in ln), True)
                k = ln[0][1]
                x = self.W - self.M - indent - self.fonts[k].text_width(s, size)
                self.text(x, self.y, s, k, size, color)
                if bullet and li == 0:
                    self.text(self.W - self.M - indent + 6, self.y, bullet, "R", size, color)
            else:
                x = self.M + indent
                if bullet and li == 0:
                    self.text(x - 12, self.y, bullet, "R", size, color)
                for t, k in ln:
                    s = visual(t, False)
                    self.text(x, self.y, s, k, size, color)
                    x += self.fonts[k].text_width(t, size)
        self.y -= space_after

    def table(self, rows: list[list[str]], size=9.5):
        if not rows:
            return
        rtl = any(is_rtl(c) for r in rows for c in r)
        ncol = max(len(r) for r in rows)
        width = self.W - 2 * self.M
        cw = width / ncol
        pad, lead = 4.0, size * 1.35
        for ri, r in enumerate(rows):
            r = list(r) + [""] * (ncol - len(r))
            if rtl:
                r = r[::-1]
            key = "B" if ri == 0 else "R"
            cells = [self.wrap([(c, key)], cw - 2 * pad, size) for c in r]
            h = max(len(c) for c in cells) * lead + 2 * pad
            if self.y - h < self.M + 14:
                self.new_page()
            top = self.y
            if ri == 0:
                self.rect(self.M, top - h, width, h, fill=(0.85, 0.89, 0.95))
            for ci, lines in enumerate(cells):
                x0 = self.M + ci * cw
                self.rect(x0, top - h, cw, h, stroke=(0.7, 0.74, 0.82))
                yy = top - pad
                for ln in lines:
                    yy -= lead
                    s = "".join(t for t, _ in ln)
                    vrtl = is_rtl(s)
                    vs = visual(s, vrtl)
                    tw = self.fonts[key].text_width(vs, size)
                    x = x0 + cw - pad - tw if vrtl else x0 + pad
                    self.text(x, yy + 3, vs, key, size)
            self.y = top - h
        self.y -= 8

    # -- output --
    def _font_objs(self, key: str, start: int) -> tuple[list[bytes], int]:
        f = self.fonts[key]
        if isinstance(f, Base14):
            return [f"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".encode()], start
        used = sorted(self.used[key])
        gids = sorted({g for g, _ in used})
        wtxt = " ".join(f"{g} [{int(round(f.width(g)))}]" for g in gids)
        comp = zlib.compress(f.data, 9)
        cmap_lines = "\n".join(f"<{g:04X}> <{''.join(f'{ord(c):04X}' if ord(c) < 0x10000 else _utf16(c) for c in ch)}>"
                               for g, ch in {g: c for g, c in used}.items())
        n = len({g for g, _ in used})
        tounicode = ("/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def "
                     "/CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n"
                     + _chunks_bfchar(cmap_lines) +
                     "\nendcmap CMapName currentdict /CMap defineresource pop end end").encode()
        name = f"{chr(65 + start % 26)}AAAAA+{f.name}"
        bb = " ".join(str(int(v * 1000 / f.upem)) for v in f.bbox)
        objs = [
            # start: Type0
            f"<< /Type /Font /Subtype /Type0 /BaseFont /{name} /Encoding /Identity-H /DescendantFonts [{start + 1} 0 R] /ToUnicode {start + 4} 0 R >>".encode(),
            f"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
            f"/FontDescriptor {start + 2} 0 R /W [{wtxt}] /CIDToGIDMap /Identity >>".encode(),
            f"<< /Type /FontDescriptor /FontName /{name} /Flags 32 /FontBBox [{bb}] /ItalicAngle 0 "
            f"/Ascent {int(f.ascent * 1000 / f.upem)} /Descent {int(f.descent * 1000 / f.upem)} /CapHeight 700 /StemV 80 /FontFile2 {start + 3} 0 R >>".encode(),
            b"<< /Length %d /Length1 %d /Filter /FlateDecode >>\nstream\n" % (len(comp), len(f.data)) + comp + b"\nendstream",
            b"<< /Length %d >>\nstream\n" % len(tounicode) + tounicode + b"\nendstream",
        ]
        return objs, start

    def output(self, title: str) -> bytes:
        total = len(self.pages)
        for i in range(total):  # footer page numbers
            s = f"{i + 1} / {total}"
            w = self.fonts["R"].text_width(s, 8.5)
            self.text((self.W - w) / 2, self.M / 2, s, "R", 8.5, (0.5, 0.5, 0.5), page=i)
        objs: list[bytes] = [b"", b""]  # 1 catalog, 2 pages
        font_refs = {}
        for key in "RBM":
            if not self.used[key] and key != "R" and not isinstance(self.fonts[key], Base14):
                continue
            if isinstance(self.fonts[key], Base14) and key != "R":
                font_refs[key] = font_refs.get("R")
                continue
            start = len(objs) + 1
            fobjs, _ = self._font_objs(key, start)
            objs += fobjs
            font_refs[key] = start
        fdict = " ".join(f"/F{k} {v} 0 R" for k, v in font_refs.items() if v)
        page_ids = []
        for ops in self.pages:
            content = zlib.compress("\n".join(ops).encode("latin-1"))
            objs.append(b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(content) + content + b"\nendstream")
            cid = len(objs)
            objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {self.W} {self.H}] /Resources << /Font << {fdict} >> >> /Contents {cid} 0 R >>".encode())
            page_ids.append(len(objs))
        info = f"<< /Title {_pdfstr(title)} /Producer (Kestrel) >>".encode()
        objs.append(info)
        info_id = len(objs)
        objs[0] = b"<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /DisplayDocTitle true >> >>"
        objs[1] = f"<< /Type /Pages /Kids [{' '.join(f'{p} 0 R' for p in page_ids)}] /Count {len(page_ids)} >>".encode()
        out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        offs = []
        for i, o in enumerate(objs, 1):
            offs.append(len(out))
            out += f"{i} 0 obj\n".encode() + o + b"\nendobj\n"
        xref = len(out)
        out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
        for o in offs:
            out += f"{o:010d} 00000 n \n".encode()
        out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R /Info {info_id} 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
        return bytes(out)


def _utf16(c: str) -> str:
    v = ord(c) - 0x10000
    return f"{0xD800 + (v >> 10):04X}{0xDC00 + (v & 0x3FF):04X}"


def _chunks_bfchar(lines: str) -> str:
    ls = [l for l in lines.split("\n") if l]
    out = []
    for i in range(0, len(ls), 100):
        part = ls[i:i + 100]
        out.append(f"{len(part)} beginbfchar\n" + "\n".join(part) + "\nendbfchar")
    return "\n".join(out)


def _pdfstr(s: str) -> str:
    try:
        b = s.encode("latin-1")
        return "(" + b.decode("latin-1").replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ")"
    except UnicodeEncodeError:
        return "<FEFF" + s.encode("utf-16-be").hex().upper() + ">"


def render(blocks: list[Block], title: str = "") -> bytes:
    d = Doc()
    dark = (0.12, 0.22, 0.39)
    if title and not (blocks and blocks[0].kind == "heading" and blocks[0].level == 1):
        d.paragraph(title, 22, "B", color=dark, space_after=10)
    num = 0
    for b in blocks:
        if b.kind != "number":
            num = 0
        if b.kind == "heading":
            size = {1: 20, 2: 15.5, 3: 13}.get(b.level, 12)
            d.need(size * 3)
            d.y -= size * 0.4
            d.paragraph(b.text, size, "B", color=dark, space_after=4)
            if b.level <= 2:
                d.line(d.M, d.y - 1, d.W - d.M, d.y - 1, (0.77, 0.35, 0.07) if b.level == 1 else (0.75, 0.78, 0.85))
                d.y -= 7
        elif b.kind == "para":
            d.paragraph(b.text, 11, indent=18 if b.level else 0, color=(0.33, 0.33, 0.33) if b.level else (0.1, 0.1, 0.18))
        elif b.kind == "bullet":
            d.paragraph(b.text, 11, indent=18 + 16 * b.level, bullet="•", space_after=2)
        elif b.kind == "number":
            num += 1
            d.paragraph(b.text, 11, indent=20 + 16 * b.level, bullet=f"{num}.", space_after=2)
        elif b.kind == "table":
            d.table(b.rows)
        elif b.kind == "code":
            lines = b.text.split("\n")
            for ln in lines:
                d.need(13)
                d.y -= 12.6
                d.rect(d.M, d.y - 3.5, d.W - 2 * d.M, 12.6, fill=(0.955, 0.965, 0.98))
                d.text(d.M + 6, d.y, ln.expandtabs(4)[:110], "M", 9)
            d.y -= 8
        elif b.kind == "rule":
            d.need(12)
            d.line(d.M, d.y - 4, d.W - d.M, d.y - 4)
            d.y -= 12
        elif b.kind == "break":
            d.new_page()
    return d.output(title)


# ===========================================================================
# Extraction (best effort; good for simple PDFs and for everything Kestrel writes)
def _streams(data: bytes):
    for m in re.finditer(rb"<<(.*?)>>\s*stream\r?\n", data, re.S):
        start = m.end()
        end = data.find(b"endstream", start)
        if end < 0:
            continue
        raw = data[start:end].rstrip(b"\r\n")
        if b"FlateDecode" in m.group(1):
            try:
                raw = zlib.decompress(raw)
            except zlib.error:
                try:
                    raw = zlib.decompressobj().decompress(raw)
                except zlib.error:
                    continue
        yield m.group(1), raw


def extract_text(data: bytes) -> str:
    cmap: dict[str, str] = {}
    contents = []
    for hdr, s in _streams(data):
        if b"begincmap" in s:
            for a, b in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", s.split(b"beginbfrange")[0]):
                try:
                    cmap[a.decode().upper()] = bytes.fromhex(b.decode()).decode("utf-16-be", "replace")
                except ValueError:
                    pass
            for blk in re.findall(rb"beginbfrange(.*?)endbfrange", s, re.S):
                for a, b, c in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", blk):
                    lo, hi, dst = int(a, 16), int(b, 16), int(c, 16)
                    w = len(a)
                    for k in range(lo, min(hi, lo + 2000) + 1):
                        cmap[f"{k:0{w}X}"] = chr(dst + k - lo)
        elif b"Length1" not in hdr and b"BT" in s and re.search(rb"\b(Tj|TJ)\b", s):
            contents.append(s)
    out_lines = []
    tok_rx = re.compile(rb"<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^\\)])*)\)|([-\d.]+)\s+([-\d.]+)\s+(Td|TD)\b|\b(T\*|')", re.S)
    for s in contents:
        line, last_y = [], None
        for tok in tok_rx.finditer(s):
            if tok.group(1) is not None:
                hx = re.sub(rb"\s", b"", tok.group(1)).decode().upper()
                if cmap:
                    step = 4 if len(next(iter(cmap))) == 4 else 2
                    line.append("".join(cmap.get(hx[i:i + step], "") for i in range(0, len(hx), step)))
                else:
                    line.append(bytes.fromhex(hx).decode("latin-1", "replace"))
            elif tok.group(2) is not None:
                lit = re.sub(rb"\\([nrtbf()\\])", lambda m: {b"n": b"\n", b"r": b"", b"t": b"\t", b"b": b"", b"f": b""}.get(m.group(1), m.group(1)), tok.group(2))
                line.append(lit.decode("latin-1", "replace"))
            elif tok.group(5):
                y = float(tok.group(4))
                if last_y is not None and abs(y - last_y) > 1 and line:
                    out_lines.append("".join(line))
                    line = []
                last_y = y
            else:
                if line:
                    out_lines.append("".join(line))
                    line = []
        if line:
            out_lines.append("".join(line))
    text = "\n".join(visual(l, True) if _R.search(l) else l for l in out_lines if l.strip())
    return text or "(no extractable text; the PDF may be scanned images)"
