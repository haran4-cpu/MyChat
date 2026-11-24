"""Recognize direct terminal actions while keeping shell text out of conversation history routing."""
import os
import re
from pathlib import Path
from . import tools

_HUNTER = r"(?:hunter|האנטר|הצייד|claude-hunter-pro)(?:\s+pro)?"
_START = rf"(?:/hunter start|(?:run|launch|start) (?:the )?{_HUNTER}|(?:הפעל|תפעיל|הרץ|תריץ|פתח)(?: לי)? (?:את )?(?:השרת של )?ה?{_HUNTER})[.! ]*"
_FOLLOWUP = r"(?:אני לא עושה כלום[ ,]*)?(?:תעשה בשבילי|תפעיל אותו|תפעיל אתה|תתחבר אתה|אתה כן יכול תנסה יש לך|do it for me)[.! ]*"

def command_for(text, history):
    exact = re.fullmatch(r"/terminal[ \t]+([^\r\n\x00]{1,4000})", text.strip(), re.I)
    if exact:
        return exact.group(1)
    launch = re.fullmatch(_START, text.strip(), re.I)
    if not launch and re.fullmatch(_FOLLOWUP, text.strip(), re.I):
        prior = next((m for m in reversed(history) if m.get("role") == "assistant"), {})
        context = str(prior.get("content") or "")
        launch = re.search(_HUNTER, context, re.I) and re.search(r"localhost:3000|bun run dev|npm run dev", context[-3500:], re.I)
    if launch:
        from .config import HOME
        node = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "nodejs/node.exe"
        launcher = HOME.parent / "MyChat/pc/launch-hunter.mjs"
        if node.is_file() and launcher.is_file():
            return f'"{node}" "{launcher}"'
    return None

def run_terminal(ctx, command, emit):
    args = {"command": command, "cwd": ".", "timeout": 150}
    emit("tool_call", {"name": "run_command", "args": args})
    output, ok = tools.call(ctx, "run_command", args, 6000)
    passed = ok and output.splitlines()[:1] == ["exit code 0"]
    emit("tool_result", {"name": "run_command", "ok": passed, "result": output})
    answer = {"text": output, "finished": None, "checks": ctx.verification[-1:]}
    emit("answer", answer)
    return {**answer, "steps": 1}

