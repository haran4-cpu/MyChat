"""Office/PDF/HTML documents from Markdown, and text extraction back out.

Pure standard library: OOXML is just zipped XML. Right-to-left paragraphs
(Hebrew, Arabic) are detected and marked so Word/PowerPoint/Excel render them
correctly.
"""
from __future__ import annotations

import csv
import datetime as _dt
import html as _html
import io
import re
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape as _x

from . import mdparse
from .mdparse import Block, inline, is_rtl, parse, plain


def X(s) -> str:
    # escape + strip characters XML 1.0 forbids
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(s))
    return _x(s, {'"': "&quot;"})


def _zip(files: dict[str, str | bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        # [Content_Types].xml first, as Office expects
        for name in sorted(files, key=lambda n: (n != "[Content_Types].xml", n)):
            data = files[name]
            z.writestr(name, data.encode("utf-8") if isinstance(data, str) else data)
    return buf.getvalue()


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _core(title: str) -> str:
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            f'<dc:title>{X(title)}</dc:title><dc:creator>Kestrel</dc:creator>'
            f'<dcterms:created xsi:type="dcterms:W3CDTF">{_now()}</dcterms:created>'
            f'<dcterms:modified xsi:type="dcterms:W3CDTF">{_now()}</dcterms:modified>'
            '</cp:coreProperties>')


_REL_HDR = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
_RT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_PKG_RELS = (_REL_HDR +
             f'<Relationship Id="rId1" Type="{_RT}/officeDocument" Target="%s"/>'
             '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
             '</Relationships>')

# ===========================================================================
# DOCX
_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'


def _docx_runs(text: str, rtl: bool, extra_rpr: str = "") -> str:
    out = []
    for run, st in inline(text):
        rpr = extra_rpr
        if st.get("bold"):
            rpr += "<w:b/><w:bCs/>"
        if st.get("italic"):
            rpr += "<w:i/><w:iCs/>"
        if st.get("code"):
            rpr += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>'
        if st.get("link"):
            rpr += '<w:color w:val="1F5FBF"/><w:u w:val="single"/>'
        if rtl:
            rpr += "<w:rtl/>"
        out.append(f'<w:r><w:rPr>{rpr}</w:rPr><w:t xml:space="preserve">{X(run)}</w:t></w:r>')
    return "".join(out)


def _docx_p(text: str, style: str = "", num: tuple | None = None, extra_ppr: str = "", extra_rpr: str = "") -> str:
    rtl = is_rtl(text)
    ppr = f'<w:pStyle w:val="{style}"/>' if style else ""
    if num:
        ppr += f'<w:numPr><w:ilvl w:val="{num[1]}"/><w:numId w:val="{num[0]}"/></w:numPr>'
    if rtl:
        ppr += '<w:bidi/><w:jc w:val="right"/>'
    ppr += extra_ppr
    return f"<w:p><w:pPr>{ppr}</w:pPr>{_docx_runs(text, rtl, extra_rpr)}</w:p>"


def _docx_table(rows: list[list[str]]) -> str:
    rtl = any(is_rtl(c) for r in rows for c in r)
    ncol = max(len(r) for r in rows)
    w = 9000 // max(ncol, 1)
    b = '<w:{0} w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>'
    borders = "".join(b.format(e) for e in ("top", "left", "bottom", "right", "insideH", "insideV"))
    x = [f'<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>'
         f'{"<w:bidiVisual/>" if rtl else ""}<w:tblBorders>{borders}</w:tblBorders></w:tblPr><w:tblGrid>'
         + "".join(f'<w:gridCol w:w="{w}"/>' for _ in range(ncol)) + "</w:tblGrid>"]
    for ri, r in enumerate(rows):
        x.append("<w:tr>" + ('<w:trPr><w:tblHeader/></w:trPr>' if ri == 0 else ""))
        for c in r:
            shade = '<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>' if ri == 0 else ""
            x.append(f'<w:tc><w:tcPr><w:tcW w:w="{w}" w:type="dxa"/>{shade}</w:tcPr>'
                     + _docx_p(c, extra_rpr="<w:b/>" if ri == 0 else "") + "</w:tc>")
        x.append("</w:tr>")
    x.append("</w:tbl>")
    return "".join(x) + "<w:p/>"


_DOCX_STYLES = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles {_W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial" w:eastAsia="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:bidi="he-IL"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="1F3864"/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="1F3864"/><w:sz w:val="34"/><w:szCs w:val="34"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="2F5496"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="2F5496"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="567"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/></w:pPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>'''


def _numbering() -> str:
    def lvls(fmt):
        out = []
        for i in range(6):
            txt = ("•", "◦", "▪")[i % 3] if fmt == "bullet" else f"%{i + 1}."
            out.append(f'<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="{"bullet" if fmt == "bullet" else "decimal"}"/>'
                       f'<w:lvlText w:val="{txt}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{720 + 360 * i}" w:hanging="360"/></w:pPr></w:lvl>')
        return "".join(out)
    return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering {_W}>'
            f'<w:abstractNum w:abstractNumId="0">{lvls("bullet")}</w:abstractNum>'
            f'<w:abstractNum w:abstractNumId="1">{lvls("decimal")}</w:abstractNum>'
            '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
            '%NUMS%</w:numbering>')


def make_docx(md: str, title: str = "") -> bytes:
    blocks = parse(md)
    body = []
    if title and not (blocks and blocks[0].kind == "heading" and blocks[0].level == 1):
        body.append(_docx_p(title, "Title"))
    num_ids, cur_num, prev_kind = [], None, None
    for b in blocks:
        if b.kind == "heading":
            style = "Title" if (b.level == 1 and not body) else f"Heading{min(b.level, 3)}"
            body.append(_docx_p(b.text, style))
        elif b.kind == "para":
            body.append(_docx_p(b.text, "Quote" if b.level else ""))
        elif b.kind == "bullet":
            body.append(_docx_p(b.text, "ListParagraph", (1, min(b.level, 5))))
        elif b.kind == "number":
            if prev_kind != "number":  # restart numbering for each new list
                cur_num = 2 + len(num_ids)
                num_ids.append(cur_num)
            body.append(_docx_p(b.text, "ListParagraph", (cur_num, min(b.level, 5))))
        elif b.kind == "table":
            body.append(_docx_table(b.rows))
        elif b.kind == "code":
            for ln in (b.text.split("\n") or [""]):
                body.append(f'<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:t xml:space="preserve">{X(ln)}</w:t></w:r></w:p>')
        elif b.kind == "break":
            body.append('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
        elif b.kind == "rule":
            body.append('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="A6A6A6"/></w:pBdr></w:pPr></w:p>')
        prev_kind = b.kind
    nums = "".join(f'<w:num w:numId="{n}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>'
                   for n in num_ids)
    doc = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {_W}><w:body>'
           + "".join(body) +
           '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
           '</w:body></w:document>')
    ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
          '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
          '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
          '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
          '</Types>')
    rels = (_REL_HDR + f'<Relationship Id="rId1" Type="{_RT}/styles" Target="styles.xml"/>'
            f'<Relationship Id="rId2" Type="{_RT}/numbering" Target="numbering.xml"/></Relationships>')
    return _zip({"[Content_Types].xml": ct, "_rels/.rels": _PKG_RELS % "word/document.xml",
                 "word/document.xml": doc, "word/styles.xml": _DOCX_STYLES,
                 "word/numbering.xml": _numbering().replace("%NUMS%", nums),
                 "word/_rels/document.xml.rels": rels, "docProps/core.xml": _core(title)})


# ===========================================================================
# XLSX
def _col(n: int) -> str:
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


_NUM = re.compile(r"^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$")


def _xlsx_sheets(md: str) -> list[tuple[str, list[list[str]]]]:
    sheets: list[tuple[str, list[list[str]]]] = []
    name, buf = None, []

    def close():
        if name is None and not any(l.strip() for l in buf):
            return
        text = "\n".join(buf)
        tables = [b.rows for b in parse(text) if b.kind == "table"]
        if tables:
            rows = [r for t in tables for r in t + [[]]][:-1]
        else:  # CSV / TSV
            lines = [l for l in buf if l.strip()]
            delim = "\t" if any("\t" in l for l in lines) else ","
            rows = list(csv.reader(lines, delimiter=delim))
        sheets.append(((name or f"Sheet{len(sheets) + 1}")[:31], rows))

    for line in (md or "").replace("\r\n", "\n").split("\n"):
        m = re.match(r"^#{1,3}\s+(.+)$", line.strip())
        if m:
            close()
            name, buf = re.sub(r'[\\/?*\[\]:]', "-", m.group(1).strip()), []
        else:
            buf.append(line)
    close()
    return sheets or [("Sheet1", [])]


def make_xlsx(md: str, title: str = "") -> bytes:
    sheets = _xlsx_sheets(md)
    files: dict[str, str] = {}
    used = set()
    for si, (name, rows) in enumerate(sheets, 1):
        base, k = name or f"Sheet{si}", 2
        while name.lower() in used:
            name = f"{base[:28]}_{k}"
            k += 1
        used.add(name.lower())
        sheets[si - 1] = (name, rows)
        rtl = any(is_rtl(c) for r in rows for c in r)
        widths: dict[int, int] = {}
        xr = []
        for ri, r in enumerate(rows, 1):
            cells = []
            for ci, raw in enumerate(r):
                v = mdparse.plain(str(raw)).strip()
                if v == "":
                    continue
                ref = f"{_col(ci)}{ri}"
                style = ' s="1"' if ri == 1 else ""
                widths[ci] = max(widths.get(ci, 8), min(len(v) + 2, 60))
                if v.startswith("="):
                    cells.append(f'<c r="{ref}"{style}><f>{X(v[1:])}</f></c>')
                elif _NUM.match(v):
                    cells.append(f'<c r="{ref}"{style}><v>{v.replace(",", "")}</v></c>')
                elif re.match(r"^-?\d+(\.\d+)?%$", v):
                    cells.append(f'<c r="{ref}" s="{3 if ri == 1 else 2}"><v>{float(v[:-1]) / 100}</v></c>')
                else:
                    cells.append(f'<c r="{ref}" t="inlineStr"{style}><is><t xml:space="preserve">{X(v)}</t></is></c>')
            xr.append(f'<row r="{ri}">{"".join(cells)}</row>')
        cols = "".join(f'<col min="{c + 1}" max="{c + 1}" width="{w}" customWidth="1"/>' for c, w in sorted(widths.items()))
        rtl_attr = ' rightToLeft="1"' if rtl else ""
        sel_attr = ' tabSelected="1"' if si == 1 else ""
        freeze = ('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' if len(rows) > 1 else "")
        files[f"xl/worksheets/sheet{si}.xml"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f'<sheetViews><sheetView workbookViewId="0"{rtl_attr}{sel_attr}>{freeze}</sheetView></sheetViews>'
            + (f"<cols>{cols}</cols>" if cols else "") + f'<sheetData>{"".join(xr)}</sheetData></worksheet>')
    wb = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
          '<sheets>' + "".join(f'<sheet name="{X(n)}" sheetId="{i}" r:id="rId{i}"/>' for i, (n, _) in enumerate(sheets, 1)) +
          '</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>')
    wrels = _REL_HDR + "".join(
        f'<Relationship Id="rId{i}" Type="{_RT}/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1, len(sheets) + 1))
    wrels += f'<Relationship Id="rId{len(sheets) + 1}" Type="{_RT}/styles" Target="styles.xml"/></Relationships>'
    styles = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
              '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
              '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
              '<fill><patternFill patternType="solid"><fgColor rgb="FFD9E2F3"/><bgColor indexed="64"/></patternFill></fill></fills>'
              '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
              '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
              '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
              '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
              '<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
              '<xf numFmtId="10" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/></cellXfs>'
              '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')
    ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
          + "".join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                    for i in range(1, len(sheets) + 1)) +
          '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>')
    files.update({"[Content_Types].xml": ct, "_rels/.rels": _PKG_RELS % "xl/workbook.xml", "xl/workbook.xml": wb,
                  "xl/_rels/workbook.xml.rels": wrels, "xl/styles.xml": styles, "docProps/core.xml": _core(title)})
    return _zip(files)


# ===========================================================================
# PPTX
_P = ('xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"')
_EMU_W, _EMU_H = 12192000, 6858000  # 16:9

_THEME = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Kestrel"><a:themeElements>
<a:clrScheme name="Kestrel"><a:dk1><a:srgbClr val="1A1A2E"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F3864"/></a:dk2><a:lt2><a:srgbClr val="EEF2F8"/></a:lt2>
<a:accent1><a:srgbClr val="2F5496"/></a:accent1><a:accent2><a:srgbClr val="C55A11"/></a:accent2><a:accent3><a:srgbClr val="548235"/></a:accent3><a:accent4><a:srgbClr val="7030A0"/></a:accent4><a:accent5><a:srgbClr val="00B0F0"/></a:accent5><a:accent6><a:srgbClr val="BF9000"/></a:accent6>
<a:hlink><a:srgbClr val="1F5FBF"/></a:hlink><a:folHlink><a:srgbClr val="7030A0"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Kestrel"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface="Arial"/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Kestrel"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>'''

_SP_TREE_HDR = ('<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
                '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>')


def _pp_runs(text: str, size: int, bold=False, color="1A1A2E") -> str:
    rtl = is_rtl(text)
    out = []
    for run, st in inline(text) or [("", {})]:
        b = ' b="1"' if (bold or st.get("bold")) else ""
        i = ' i="1"' if st.get("italic") else ""
        font = '<a:latin typeface="Consolas"/>' if st.get("code") else ""
        out.append(f'<a:r><a:rPr lang="{"he-IL" if rtl else "en-US"}" sz="{size}"{b}{i} dirty="0">'
                   f'<a:solidFill><a:srgbClr val="{color}"/></a:solidFill>{font}</a:rPr><a:t>{X(run)}</a:t></a:r>')
    return "".join(out)


def _pp_para(text: str, size: int, bold=False, color="1A1A2E", bullet=False, level=0, align=None) -> str:
    rtl = is_rtl(text)
    attrs = f' lvl="{level}"' if level else ""
    if rtl:
        attrs += ' rtl="1"'
    al = align or ("r" if rtl else "l")
    attrs += f' algn="{al}"'
    if bullet:
        ind = 285750 + level * 342900
        attrs += f' marL="{ind}" indent="-285750"'
        bu = '<a:buFont typeface="Arial"/><a:buChar char="•"/>'
    else:
        bu = "<a:buNone/>"
    return (f'<a:p><a:pPr{attrs}><a:spcBef><a:spcPts val="600"/></a:spcBef>{bu}</a:pPr>'
            f'{_pp_runs(text, size, bold, color)}</a:p>')


def _pp_box(sid: int, name: str, x, y, w, h, paras: str, fill: str | None = None, anchor="t") -> str:
    sp = f'<a:solidFill><a:srgbClr val="{fill}"/></a:solidFill>' if fill else "<a:noFill/>"
    return (f'<p:sp><p:nvSpPr><p:cNvPr id="{sid}" name="{name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            f'<p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{w}" cy="{h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>{sp}</p:spPr>'
            f'<p:txBody><a:bodyPr wrap="square" lIns="91440" rIns="91440" tIns="45720" bIns="45720" anchor="{anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>{paras}</p:txBody></p:sp>')


def _pp_table(sid: int, rows: list[list[str]], x, y, w, h) -> str:
    ncol = max(len(r) for r in rows)
    cw = w // ncol
    rh = min(h // max(len(rows), 1), 457200)
    grid = "".join(f'<a:gridCol w="{cw}"/>' for _ in range(ncol))
    trs = []
    for ri, r in enumerate(rows):
        tcs = []
        for c in r:
            fill = "D9E2F3" if ri == 0 else ("FFFFFF" if ri % 2 else "F4F6FA")
            tcs.append(f'<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>{_pp_para(c, 1400, bold=ri == 0)}</a:txBody>'
                       f'<a:tcPr><a:solidFill><a:srgbClr val="{fill}"/></a:solidFill></a:tcPr></a:tc>')
        trs.append(f'<a:tr h="{rh}">{"".join(tcs)}</a:tr>')
    return (f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="{sid}" name="Table {sid}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>'
            f'<p:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{w}" cy="{rh * len(rows)}"/></p:xfrm>'
            f'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/>'
            f'<a:tblGrid>{grid}</a:tblGrid>{"".join(trs)}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>')


def _slides_from_md(md: str, title: str) -> list[dict]:
    slides: list[dict] = []
    cur = None
    for b in parse(md):
        if b.kind == "heading" and b.level <= 2 or b.kind == "rule":
            if b.kind == "rule":
                cur = None
                continue
            cur = {"title": b.text, "blocks": [], "level": b.level}
            slides.append(cur)
            continue
        if cur is None:
            cur = {"title": title if not slides else "", "blocks": [], "level": 1}
            slides.append(cur)
        cur["blocks"].append(b)
    return slides or [{"title": title, "blocks": [], "level": 1}]


def make_pptx(md: str, title: str = "") -> bytes:
    slides = _slides_from_md(md, title)
    files: dict[str, str] = {}
    M = 457200
    for n, s in enumerate(slides, 1):
        shapes = []
        is_cover = n == 1 and not s["blocks"] or (n == 1 and len(s["blocks"]) <= 1 and all(b.kind == "para" for b in s["blocks"]))
        if is_cover:
            shapes.append(f'<p:sp><p:nvSpPr><p:cNvPr id="10" name="Band"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{_EMU_W}" cy="{_EMU_H}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill></p:spPr></p:sp>')
            shapes.append(_pp_box(2, "Title", M * 2, 2200000, _EMU_W - M * 4, 1300000,
                                  _pp_para(s["title"] or title, 4400, True, "FFFFFF", align="ctr"), anchor="b"))
            sub = " ".join(b.text for b in s["blocks"]) if s["blocks"] else ""
            if sub:
                shapes.append(_pp_box(3, "Subtitle", M * 2, 3600000, _EMU_W - M * 4, 900000,
                                      _pp_para(sub, 2200, False, "D9E2F3", align="ctr")))
        else:
            shapes.append(_pp_box(2, "Title", M, 300000, _EMU_W - 2 * M, 900000,
                                  _pp_para(s["title"], 3200, True, "1F3864"), anchor="b"))
            shapes.append(f'<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="9" name="Rule"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="{M}" y="1250000"/><a:ext cx="{_EMU_W - 2 * M}" cy="0"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="28575"><a:solidFill><a:srgbClr val="C55A11"/></a:solidFill></a:ln></p:spPr></p:cxnSp>')
            paras, tables = [], [b for b in s["blocks"] if b.kind == "table"]
            for b in s["blocks"]:
                if b.kind in ("bullet", "number"):
                    paras.append(_pp_para(b.text, 2000 if b.level == 0 else 1800, bullet=True, level=min(b.level, 4)))
                elif b.kind == "para":
                    paras.append(_pp_para(b.text, 2000))
                elif b.kind == "heading":
                    paras.append(_pp_para(b.text, 2200, bold=True, color="2F5496"))
                elif b.kind == "code":
                    for ln in b.text.split("\n")[:14]:
                        paras.append(_pp_para(f"`{ln}`" if ln.strip() else " ", 1400))
            top, avail = 1450000, _EMU_H - 1450000 - M
            if paras:
                hgt = avail if not tables else min(avail // 2, 420000 * len(paras) + 200000)
                shapes.append(_pp_box(3, "Body", M, top, _EMU_W - 2 * M, hgt, "".join(paras)))
                top += hgt
            if tables:
                shapes.append(_pp_table(4, tables[0].rows, M, top + 100000, _EMU_W - 2 * M, _EMU_H - top - M))
        files[f"ppt/slides/slide{n}.xml"] = (
            f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld {_P}><p:cSld><p:spTree>{_SP_TREE_HDR}'
            + "".join(shapes) + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>')
        files[f"ppt/slides/_rels/slide{n}.xml.rels"] = (
            _REL_HDR + f'<Relationship Id="rId1" Type="{_RT}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>')
    n_sl = len(slides)
    files["ppt/presentation.xml"] = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation {_P} saveSubsetFonts="1">'
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>'
        + "".join(f'<p:sldId id="{255 + i}" r:id="rId{i + 2}"/>' for i in range(1, n_sl + 1)) +
        f'</p:sldIdLst><p:sldSz cx="{_EMU_W}" cy="{_EMU_H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>')
    files["ppt/_rels/presentation.xml.rels"] = (
        _REL_HDR + f'<Relationship Id="rId1" Type="{_RT}/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
        + "".join(f'<Relationship Id="rId{i + 2}" Type="{_RT}/slide" Target="slides/slide{i}.xml"/>' for i in range(1, n_sl + 1))
        + f'<Relationship Id="rId{n_sl + 3}" Type="{_RT}/theme" Target="theme/theme1.xml"/></Relationships>')
    files["ppt/slideMasters/slideMaster1.xml"] = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster {_P}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'
        f'<p:spTree>{_SP_TREE_HDR}</p:spTree></p:cSld>'
        '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
        '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
        '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>')
    files["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = (
        _REL_HDR + f'<Relationship Id="rId1" Type="{_RT}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
        f'<Relationship Id="rId2" Type="{_RT}/theme" Target="../theme/theme1.xml"/></Relationships>')
    files["ppt/slideLayouts/slideLayout1.xml"] = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout {_P} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>{_SP_TREE_HDR}</p:spTree></p:cSld>'
        '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>')
    files["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = (
        _REL_HDR + f'<Relationship Id="rId1" Type="{_RT}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>')
    files["ppt/theme/theme1.xml"] = _THEME
    files["docProps/core.xml"] = _core(title)
    files["_rels/.rels"] = _PKG_RELS % "ppt/presentation.xml"
    files["[Content_Types].xml"] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
        + "".join(f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
                  for i in range(1, n_sl + 1)) +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>')
    return _zip(files)


# ===========================================================================
# HTML
def _html_inline(text: str) -> str:
    out = []
    for run, st in inline(text):
        h = _html.escape(run)
        if st.get("bold"):
            h = f"<strong>{h}</strong>"
        if st.get("italic"):
            h = f"<em>{h}</em>"
        if st.get("code"):
            h = f"<code>{h}</code>"
        if st.get("link"):
            h = f'<a href="{_html.escape(st["link"])}">{h}</a>'
        out.append(h)
    return "".join(out)


def make_html(md: str, title: str = "") -> bytes:
    parts, stack = [], []

    def close_lists(to=0):
        while len(stack) > to:
            parts.append(f"</{stack.pop()}>")

    for b in parse(md):
        if b.kind in ("bullet", "number"):
            tag = "ul" if b.kind == "bullet" else "ol"
            while len(stack) > b.level + 1:
                parts.append(f"</{stack.pop()}>")
            if len(stack) == b.level + 1 and stack[-1] != tag:
                parts.append(f"</{stack.pop()}>")
            while len(stack) < b.level + 1:
                parts.append(f"<{tag}>")
                stack.append(tag)
            parts.append(f'<li dir="auto">{_html_inline(b.text)}</li>')
            continue
        close_lists()
        if b.kind == "heading":
            parts.append(f'<h{b.level} dir="auto">{_html_inline(b.text)}</h{b.level}>')
        elif b.kind == "para":
            tag = "blockquote" if b.level else "p"
            parts.append(f'<{tag} dir="auto">{_html_inline(b.text)}</{tag}>')
        elif b.kind == "table":
            head = "".join(f"<th>{_html_inline(c)}</th>" for c in b.rows[0])
            body = "".join("<tr>" + "".join(f"<td>{_html_inline(c)}</td>" for c in r) + "</tr>" for r in b.rows[1:])
            parts.append(f'<table dir="auto"><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>')
        elif b.kind == "code":
            parts.append(f"<pre><code>{_html.escape(b.text)}</code></pre>")
        elif b.kind in ("rule", "break"):
            parts.append("<hr>")
    close_lists()
    css = ("body{font:16px/1.6 system-ui,Segoe UI,Arial,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1a1a2e}"
           "h1,h2,h3{color:#1f3864;line-height:1.25}table{border-collapse:collapse;margin:1rem 0;width:100%}"
           "th,td{border:1px solid #c8d0e0;padding:.4rem .6rem;text-align:start}th{background:#d9e2f3}"
           "pre{background:#f4f6fa;padding:.8rem;overflow:auto;border-radius:6px}code{background:#f4f6fa;padding:0 .2rem;border-radius:3px}"
           "blockquote{border-inline-start:4px solid #c8d0e0;margin:0;padding-inline-start:1rem;color:#555}")
    doc = (f'<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
           f"<title>{_html.escape(title)}</title><style>{css}</style></head><body>{''.join(parts)}</body></html>")
    return doc.encode("utf-8")


def make_pdf(md: str, title: str = "") -> bytes:
    from .pdfgen import render
    return render(parse(md), title)


MAKERS = {".docx": make_docx, ".xlsx": make_xlsx, ".pptx": make_pptx, ".html": make_html, ".htm": make_html,
          ".pdf": make_pdf}


# ===========================================================================
# Extraction
def _xml_text(data: bytes, para_tag: str, text_tag: str) -> list[str]:
    s = data.decode("utf-8", "replace")
    paras = re.split(rf"</{para_tag}>", s)
    out = []
    for p in paras:
        t = "".join(re.findall(rf"<{text_tag}(?:\s[^>]*)?>([^<]*)</{text_tag}>", p))
        t = _html.unescape(t)
        if t.strip():
            out.append(t)
    return out


def _extract_docx(p: Path) -> str:
    with zipfile.ZipFile(p) as z:
        return "\n".join(_xml_text(z.read("word/document.xml"), "w:p", "w:t"))


def _extract_pptx(p: Path) -> str:
    with zipfile.ZipFile(p) as z:
        names = sorted((n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)),
                       key=lambda n: int(re.findall(r"\d+", n)[-1]))
        out = []
        for i, n in enumerate(names, 1):
            out.append(f"--- slide {i} ---")
            out += _xml_text(z.read(n), "a:p", "a:t")
        return "\n".join(out)


def _extract_xlsx(p: Path) -> str:
    with zipfile.ZipFile(p) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            s = z.read("xl/sharedStrings.xml").decode("utf-8", "replace")
            for si in re.findall(r"<si>(.*?)</si>", s, re.S):
                shared.append(_html.unescape("".join(re.findall(r"<t[^>]*>([^<]*)</t>", si))))
        wb = z.read("xl/workbook.xml").decode("utf-8", "replace")
        names = re.findall(r'<sheet [^>]*name="([^"]+)"', wb)
        sheets = sorted((n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n)),
                        key=lambda n: int(re.findall(r"\d+", n)[-1]))
        out = []
        for i, n in enumerate(sheets):
            out.append(f"## {_html.unescape(names[i]) if i < len(names) else n}")
            s = z.read(n).decode("utf-8", "replace")
            for row in re.findall(r"<row[^>]*>(.*?)</row>", s, re.S):
                vals = []
                for attrs, inner in re.findall(r"<c ([^>]*?)(?:/>|>(.*?)</c>)", row, re.S):
                    t = re.search(r't="(\w+)"', attrs)
                    f = re.search(r"<f[^>]*>([^<]*)</f>", inner or "")
                    v = re.search(r"<v>([^<]*)</v>", inner or "")
                    if t and t.group(1) == "s" and v:
                        val = shared[int(v.group(1))] if int(v.group(1)) < len(shared) else ""
                    elif t and t.group(1) == "inlineStr":
                        val = "".join(re.findall(r"<t[^>]*>([^<]*)</t>", inner or ""))
                    elif f:
                        val = "=" + _html.unescape(f.group(1)) + (f" [{v.group(1)}]" if v else "")
                    else:
                        val = v.group(1) if v else ""
                    vals.append(_html.unescape(val))
                out.append(" | ".join(vals))
        return "\n".join(out)


def _extract_pdf(p: Path) -> str:
    from .pdfgen import extract_text
    return extract_text(p.read_bytes())


EXTRACTORS = {".docx": _extract_docx, ".pptx": _extract_pptx, ".xlsx": _extract_xlsx, ".pdf": _extract_pdf}


def extract_text(p: Path) -> str:
    try:
        return EXTRACTORS[p.suffix.lower()](p)
    except (zipfile.BadZipFile, KeyError) as e:
        return f"(could not read {p.name}: {e})"
