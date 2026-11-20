"""Command line: python -m kestrel [serve|chat|mission|resume|doctor|setup-models|allow|verify-audit]"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path

from . import __version__
from .config import HOME, Config


def _console_approver(req) -> str:
    print(f"\n  APPROVAL NEEDED [{req.kind}] {req.summary}")
    prev = req.detail.get("preview")
    if prev:
        print("  ---- preview ----\n  " + "\n  ".join(prev[:800].splitlines()) + "\n  -----------------")
    a = input("  allow? [y]es / [a]lways this session / [N]o: ").strip().lower()
    req.decision = {"y": "allow", "yes": "allow", "a": "allow_always"}.get(a, "deny")
    return req.decision


def cmd_chat(args):
    from .app import App
    app = App(approver=_console_approver)

    def emit(kind, data):
        if kind == "token" and data["kind"] == "content":
            print(data["text"], end="", flush=True)
        elif kind == "tool_call":
            print(f"\n  -> {data['name']} {data['args']}")
        elif kind == "tool_result":
            print(f"  <- {'ok' if data['ok'] else 'FAILED'}: {data['result'][:300]}")
        elif kind == "llm":
            print(f"\n  [{data['model']}: {data['prompt_tokens']} in / {data['output_tokens']} out, {data['seconds']}s]")
    app.hub.emit = emit
    from .agent import Session
    s = Session(app.cfg, app.guard, app.router, app.skills, app.memory, emit)
    print(f"Kestrel {__version__} - terminal chat. Workspace: {app.guard.workspace}. Type /exit to quit.")
    while True:
        try:
            text = input("\nyou> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if text in ("/exit", "/quit"):
            break
        if text:
            r = s.run(text)
            print(f"\n\nkestrel> {r['text']}")


def cmd_mission(args, resume=False):
    from .app import App
    app = App(approver=_console_approver)

    def emit(kind, data):
        if kind == "mission":
            print(f"[mission {data['status']}] " + " ".join(
                {"done": "x", "blocked": "!", "running": ">"}.get(s["status"], ".") for s in data["steps"]))
        elif kind == "tool_call":
            print(f"   -> {data['name']}")
    app.missions.emit = emit
    m = app.missions.resume(args.id) if resume else app.missions.start(args.goal)
    print(f"mission {m.d['id']} - state in {m.root}")
    try:
        while app.missions.busy():
            time.sleep(1)
    except KeyboardInterrupt:
        app.missions.pause()
        print("pausing after the current step... resume later with: kestrel resume", m.d["id"])
        while app.missions.busy():
            time.sleep(1)
    print(f"report: {m.root / 'report.md'}")


def cmd_doctor(args):
    from .llm import OllamaBackend
    from .pdfgen import _find
    from .skills import SkillLibrary
    cfg = Config()
    print(f"Kestrel {__version__}  home={HOME}")
    print(f"Python {sys.version.split()[0]}")
    inst = OllamaBackend(cfg["ollama_url"]).list_models()
    print(f"Ollama at {cfg['ollama_url']}: {'OK, ' + str(len(inst)) + ' models' if inst else 'NOT reachable'}")
    for role, name in cfg["models"].items():
        have = any(n == name or n.split(':')[0] == name for n in inst)
        fb = cfg["fallback_models"][role]
        print(f"  {role:5} {name:16} {'installed' if have else 'missing -> using ' + fb + (' (installed)' if fb in inst else ' (MISSING)')}")
    print(f"Skills: {len(SkillLibrary(HOME / 'data' / 'skills.jsonl.gz'))} playbooks")
    for k in ("regular", "bold", "mono"):
        print(f"PDF font {k}: {_find(k) or 'none (Latin-only fallback)'}")
    print(f"Workspace: {cfg['workspace']}")
    print(f"Online mode: {'ON' if cfg['online']['enabled'] else 'off'}")


def cmd_setup_models(args):
    exe = shutil.which("ollama") or str(Path.home() / "AppData/Local/Programs/Ollama/ollama.exe")
    for name in ("kestrel-agent", "kestrel-fast", "kestrel-deep"):
        mf = HOME / "models" / f"{name}.Modelfile"
        print(f"creating {name} from {mf.name} ...")
        r = subprocess.run([exe, "create", name, "-f", str(mf)], capture_output=True, text=True)
        print("  ok" if r.returncode == 0 else f"  FAILED: {r.stderr.strip()[:400]}")


def cmd_allow(args):
    cfg = Config()
    p = Path(args.folder).resolve()
    if not p.is_dir():
        sys.exit(f"not a folder: {p}")
    cfg.data["roots"] = [r for r in cfg.data.get("roots", []) if r["path"] != str(p)] + [{"path": str(p), "mode": args.mode}]
    cfg.save()
    print(f"approved {p} ({args.mode})")


def cmd_smoke(args):
    """Live test against the real local model: a small task end to end, checked by code."""
    from .app import App
    from .agent import Session
    from . import verify
    app = App(approver=lambda req: setattr(req, "decision", "allow") or "allow")
    sub = app.guard.workspace / "_smoke_test"
    t0 = time.time()
    log = []

    def emit(kind, data):
        if kind == "tool_call":
            print(f"  -> {data['name']}")
        elif kind == "llm":
            log.append(data)
            print(f"     [{data['model']} {data['prompt_tokens']} in / {data['output_tokens']} out, {data['seconds']}s]")
    s = Session(app.cfg, app.guard, app.router, app.skills, app.memory, emit)
    print("Smoke test: the model must create two files with tools. This takes a few minutes on CPU.")
    r = s.run(f"In the folder {sub} create (1) hello.py that prints the result of 2+2, and (2) notes.docx with the "
              "heading 'Smoke test' and one bullet 'it works'. Then call finish.", max_steps=12)
    ok_py = (sub / "hello.py").exists() and not verify.check_file(sub / "hello.py")
    ok_doc = (sub / "notes.docx").exists() and not verify.check_file(sub / "notes.docx")
    gen = sum(d["output_tokens"] for d in log)
    secs = sum(d["seconds"] for d in log)
    print(f"\nhello.py: {'PASS' if ok_py else 'FAIL'}   notes.docx: {'PASS' if ok_doc else 'FAIL'}   "
          f"finish called: {'yes' if r['finished'] else 'no'}")
    print(f"{len(log)} model calls, {gen} tokens generated, {secs:.0f}s in the model, {time.time() - t0:.0f}s total")
    sys.exit(0 if ok_py and ok_doc else 1)


def cmd_openwebui_pipe(args):
    """Write the Open WebUI function with this install's API token filled in."""
    from .app import App
    app = App()
    src = (HOME / "integrations" / "openwebui_pipe.py").read_text(encoding="utf-8")
    out = app.cfg.state_dir / "openwebui_kestrel_function.py"
    out.write_text(src.replace("__KESTREL_TOKEN__", app.api_token), encoding="utf-8")
    print(f"wrote {out}\nOpen WebUI: Admin Panel -> Functions -> + -> paste this file -> Save -> enable it.")


def cmd_verify_audit(args):
    from .audit import AuditLog
    ok, n, msg = AuditLog(Config().state_dir / "audit.jsonl").verify()
    print(f"{'OK' if ok else 'TAMPERED'}: {n} entries, {msg}")
    sys.exit(0 if ok else 1)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="kestrel", description="Local engineering agent for Ollama models")
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("serve", help="web interface (default)")
    s.add_argument("--port", type=int)
    s.add_argument("--no-browser", action="store_true")
    sub.add_parser("chat", help="terminal chat")
    m = sub.add_parser("mission", help="run a long mission")
    m.add_argument("goal")
    r = sub.add_parser("resume", help="resume a mission")
    r.add_argument("id")
    sub.add_parser("doctor", help="check the installation")
    sub.add_parser("setup-models", help="create the kestrel-* Ollama model profiles")
    a = sub.add_parser("allow", help="approve a folder permanently")
    a.add_argument("folder")
    a.add_argument("mode", nargs="?", default="read", choices=["read", "write"])
    sub.add_parser("verify-audit", help="check the action log was not modified")
    sub.add_parser("smoke", help="live end-to-end test with your local model")
    sub.add_parser("openwebui-pipe", help="write the Open WebUI function file (with your token)")
    args = ap.parse_args(argv)
    if args.cmd in (None, "serve"):
        from .server import serve
        serve(getattr(args, "port", None), not getattr(args, "no_browser", False))
    elif args.cmd == "chat":
        cmd_chat(args)
    elif args.cmd == "mission":
        cmd_mission(args)
    elif args.cmd == "resume":
        cmd_mission(args, resume=True)
    elif args.cmd == "doctor":
        cmd_doctor(args)
    elif args.cmd == "setup-models":
        cmd_setup_models(args)
    elif args.cmd == "allow":
        cmd_allow(args)
    elif args.cmd == "verify-audit":
        cmd_verify_audit(args)
    elif args.cmd == "smoke":
        cmd_smoke(args)
    elif args.cmd == "openwebui-pipe":
        cmd_openwebui_pipe(args)


if __name__ == "__main__":
    main()
