"""Decide how much machinery a message deserves. Pure rules: no model call, so routing costs nothing.

chat   -> one short model reply (greetings, questions, explanations)
agent  -> the tool agent (files, folders, documents, commands on this PC)
build  -> the build engine (write a program/page/script that must actually work)
fix    -> the build engine starting from code already in the conversation or a named code file
"""
from __future__ import annotations

import re

_BUILD_VERB = (r"\b(build|create|make|write|generate|code|implement|develop|program)\b|"
               r"(בנה|תבנה|לבנות|צור|תיצור|ליצור|כתוב|תכתוב|לכתוב|תייצר|לייצר|תפתח|לפתח|תתכנת|לתכנת|הכן|תכין)")
_BUILD_NOUN = (r"\b(code|script|program|app|application|game|website|web ?page|page|html|css|javascript|js|python|py|"
               r"function|class|tool|calculator|bot|api|server|cli|component|widget|animation|simulation)\b|"
               r"\.(py|html?|js|mjs|ts)\b|"
               r"(קוד|סקריפט|תוכנה|תוכנית|אפליקציה|משחק|אתר|דף|עמוד|פונקציה|מחשבון|כלי|בוט|שרת|אנימציה|סימולציה)")
_FIX = (r"\b(fix|bug|broken|doesn'?t work|does not work|not working|error|crash|debug|why .*(not|fail))\b|"
        r"(לא עובד|לא עובדת|לא פועל|תקן|תתקן|לתקן|באג|שגיאה|קורס|נתקע|למה זה לא|תקלה|גרסה מתוקנת)")
_AGENT = (r"\b(file|folder|directory|docx|xlsx|pptx|pdf|excel|word|powerpoint|spreadsheet|document|rename|move|copy|delete|"
          r"organi[sz]e|list)\b|[a-z]:\\|"
          r"(קובץ|קבצים|תיקי|מסמך|אקסל|וורד|מצגת|גיליון|העבר|תעביר|שנה שם|מחק|תמחק|סדר|תסדר|רשימת קבצים)")
_CODE_BLOCK = re.compile(r"```[\w+-]*\s*\n(.*?)```", re.S)


def last_code(history: list[dict]) -> str:
    """Largest code block in the most recent assistant message that has one."""
    for m in reversed(history):
        if m.get("role") != "assistant":
            continue
        blocks = _CODE_BLOCK.findall(m.get("content") or "")
        if blocks:
            return max(blocks, key=len)
    return ""


def code_paths(history: list[dict], text: str = "") -> list[str]:
    """Windows paths of code files mentioned in the conversation, newest first."""
    out = []
    for m in [{"content": text}] + list(reversed(history)):
        for p in re.findall(r"[A-Za-z]:\\[^\s`'\"<>|*?]+?\.(?:html?|py|js|mjs|css|ts)\b", m.get("content") or ""):
            if p not in out:
                out.append(p)
    return out


def classify(text: str, history: list[dict], has_code: bool = False) -> str:
    t = text.lower()
    if re.search(r"(?:^|[.!?]\s*)(?:please\s+)?(?:run|start|launch|execute)\s+(?:the\s+)?(?:server|tests?|build|command|npm|node|git)\b|(?:^|[.!?]\s*)(?:תריץ|הרץ|תפעיל|הפעל)\s", t):
        return "agent"
    if re.search(_FIX, t) and (has_code or last_code(history) or code_paths(history, text) or re.search(r"\.(py|html?|js)\b", t)):
        return "fix"
    if re.search(_BUILD_VERB, t) and re.search(_BUILD_NOUN, t):
        # "create a Word document" is agent work, not a program
        if re.search(r"\b(docx|xlsx|pptx|pdf|word|excel|powerpoint|spreadsheet|document)\b|(מסמך|וורד|אקסל|מצגת|גיליון)", t) \
                and not re.search(r"\b(html|python|script|code|game|app)\b|(קוד|סקריפט|משחק|אפליקציה|אתר)", t):
            return "agent"
        return "build"
    if re.search(_AGENT, t):
        return "agent"
    if re.search(r"\d[\d,.]*\s*(%|percent|אחוז|[-+*/^×÷])\s*\d|\d+\s*%\s*(of|מ)|\b(calculate|compute)\b|(חשב|תחשב|כמה זה)", t):
        return "agent"  # exact arithmetic goes through the calc tool, never mental math
    return "chat"


def is_hebrew(text: str) -> bool:
    return bool(re.search(r"[\u0590-\u05FF]", text or ""))
