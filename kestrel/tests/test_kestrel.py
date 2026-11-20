"""End-to-end tests with a scripted fake Ollama server (real HTTP + streaming).

Run:  python tests/test_kestrel.py
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TMP_HOME = Path(tempfile.mkdtemp(prefix="kestrel-test-"))
for d in ("ui", "data", "models"):
    if (ROOT / d).exists():
        shutil.copytree(ROOT / d, TMP_HOME / d)
os.environ["KESTREL_HOME"] = str(TMP_HOME)
sys.path.insert(0, str(ROOT))

from kestrel import docs, tools, verify  # noqa: E402
from kestrel.agent import Session  # noqa: E402
from kestrel.audit import AuditLog  # noqa: E402
from kestrel.config import Config  # noqa: E402
from kestrel.guard import Denied, Guard  # noqa: E402
from kestrel.llm import Router, recover_tool_calls  # noqa: E402
from kestrel.memory import Memory  # noqa: E402
from kestrel.mission import Mission, MissionRunner  # noqa: E402
from kestrel.skills import SkillLibrary  # noqa: E402


# ---------------------------------------------------------------------------
class FakeOllama:
    """Scripted /api/chat. Each script item: dict(content=..., tool_calls=[(name, args)]) or a callable(req)->dict."""

    def __init__(self):
        self.script: list = []
        self.requests: list = []
        self.loaded: list = []
        self.unloaded: list = []
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                if self.path.startswith("/api/ps"):
                    body = json.dumps({"models": [{"name": n} for n in fake.loaded]}).encode()
                else:
                    body = json.dumps({"models": [{"name": n} for n in (
                        "qwen3.5:4b-q4_K_M", "qwen3.5:2b-q4_K_M", "qwen3.5:9b-q4_K_M", "qwen2.5-coder:3b")]}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.path.startswith("/api/generate"):  # unload request
                    fake.unloaded.append(req.get("model"))
                    fake.loaded = [m for m in fake.loaded if m != req.get("model")]
                    self.send_response(200)
                    self.send_header("Content-Length", "2")
                    self.end_headers()
                    self.wfile.write(b"{}")
                    return
                fake.requests.append(req)
                fake.loaded = [req["model"]]
                item = fake.script.pop(0) if fake.script else {"content": "(script empty)"}
                if callable(item):
                    item = item(req)
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.end_headers()
                content = item.get("content", "")
                th = item.get("thinking", "")
                for i in range(0, len(th), 7):
                    self.wfile.write((json.dumps({"message": {"role": "assistant", "content": "", "thinking": th[i:i + 7]}, "done": False}) + "\n").encode())
                for i in range(0, len(content), 7):  # stream in chunks
                    self.wfile.write((json.dumps({"message": {"role": "assistant", "content": content[i:i + 7]}, "done": False}) + "\n").encode())
                tcs = [{"function": {"name": n, "arguments": a}} for n, a in item.get("tool_calls", [])]
                if tcs:
                    self.wfile.write((json.dumps({"message": {"role": "assistant", "content": "", "tool_calls": tcs}, "done": False}) + "\n").encode())
                self.wfile.write((json.dumps({"message": {"role": "assistant", "content": ""}, "done": True,
                                              "prompt_eval_count": 100, "eval_count": 20}) + "\n").encode())

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()


FAKE = FakeOllama()


def make_env(approve="allow"):
    home = Path(tempfile.mkdtemp(prefix="kh-"))
    cfg = Config(home / "config.json")
    cfg.data["workspace"] = str(home / "ws")
    cfg.data["ollama_url"] = FAKE.url
    cfg.data.setdefault("roots", [])
    decisions = []

    def approver(req):
        decisions.append(req)
        req.decision = approve if not callable(approve) else approve(req)
        return req.decision
    audit = AuditLog(home / "audit.jsonl")
    g = Guard(cfg, audit, approver)
    g.trash, g.backups = home / "trash", home / "backups"
    cfg.state_dir  # noqa
    return home, cfg, g, audit, decisions


class GuardTests(unittest.TestCase):
    def test_workspace_write_needs_approval_and_backs_up(self):
        home, cfg, g, audit, dec = make_env("allow")
        p = g.write_bytes("a.txt", b"one")
        self.assertEqual(p.read_bytes(), b"one")
        g.write_bytes("a.txt", b"two")
        self.assertEqual(p.read_bytes(), b"two")
        self.assertEqual(len(dec), 2)
        backups = list((home / "backups").rglob("*a.txt"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), b"one")

    def test_denied_write(self):
        home, cfg, g, audit, dec = make_env("deny")
        with self.assertRaises(Denied):
            g.write_bytes("b.txt", b"x")
        self.assertFalse((Path(cfg["workspace"]) / "b.txt").exists())

    def test_outside_root_asks_for_folder_access(self):
        home, cfg, g, audit, dec = make_env(lambda r: "allow" if r.kind == "folder" else "deny")
        outside = Path(tempfile.mkdtemp(prefix="outside-"))
        (outside / "f.txt").write_text("hi")
        p = g.check_read(str(outside / "f.txt"))
        self.assertEqual(p.read_text(), "hi")
        self.assertEqual(dec[0].kind, "folder")
        # second read: already granted for this session, no new question
        g.check_read(str(outside / "f.txt"))
        self.assertEqual(len(dec), 1)

    def test_outside_root_denied(self):
        home, cfg, g, audit, dec = make_env("deny")
        outside = Path(tempfile.mkdtemp(prefix="outside-"))
        with self.assertRaises(Denied):
            g.check_read(str(outside))

    def test_dotdot_escape_is_caught(self):
        home, cfg, g, audit, dec = make_env("deny")
        with self.assertRaises(Denied):
            g.check_read("../../../etc/passwd")

    def test_protected(self):
        home, cfg, g, audit, dec = make_env("allow")
        ssh = Path(cfg["workspace"]) / ".ssh"
        ssh.mkdir(parents=True)
        with self.assertRaises(Denied):
            g.check_read(str(ssh / "id_ed25519"))

    def test_agent_cannot_rewrite_its_own_code(self):
        home, cfg, g, audit, dec = make_env("allow")
        target = TMP_HOME / "kestrel_guard_copy.py"
        with self.assertRaises(Denied):
            g.write_bytes(str(target), b"evil")
        g.check_read(str(TMP_HOME / "ui" / "index.html"))  # reading is fine

    def test_delete_goes_to_trash(self):
        home, cfg, g, audit, dec = make_env("allow")
        g.write_bytes("c.txt", b"keep me")
        dst = g.delete("c.txt")
        self.assertFalse((Path(cfg["workspace"]) / "c.txt").exists())
        self.assertEqual(Path(dst).read_bytes(), b"keep me")

    def test_audit_chain_and_tamper(self):
        home, cfg, g, audit, dec = make_env("allow")
        g.write_bytes("d.txt", b"1")
        g.write_bytes("d.txt", b"2")
        ok, n, _ = audit.verify()
        self.assertTrue(ok)
        self.assertGreaterEqual(n, 4)
        lines = audit.path.read_text().splitlines()
        e = json.loads(lines[1])
        e["data"]["tampered"] = True  # keep the old hash: must be detected
        lines[1] = json.dumps(e)
        audit.path.write_text("\n".join(lines) + "\n")
        ok, n, msg = audit.verify()
        self.assertFalse(ok, msg)


class DocsTests(unittest.TestCase):
    MD = "# Title\n\nPara **b**.\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | =A2*2 |\n\n## שלום\nטקסט בעברית 12.\n"

    def test_all_formats_valid(self):
        d = Path(tempfile.mkdtemp())
        for ext, fn in docs.MAKERS.items():
            p = d / f"t{ext}"
            p.write_bytes(fn(self.MD, "T"))
            self.assertEqual(verify.check_file(p), "", ext)
            if ext in docs.EXTRACTORS:
                txt = docs.extract_text(p)
                self.assertIn("Para", txt if ext != ".xlsx" else "Para" + txt)

    def test_pdf_hebrew_roundtrip(self):
        p = Path(tempfile.mkdtemp()) / "h.pdf"
        p.write_bytes(docs.make_pdf("שלום עולם", "h"))
        self.assertIn("שלום עולם", docs.extract_text(p))

    def test_verify_catches_bad_python_and_json(self):
        d = Path(tempfile.mkdtemp())
        (d / "a.py").write_text("def f(:\n  pass")
        (d / "b.json").write_text("{bad")
        self.assertIn("syntax", verify.check_file(d / "a.py"))
        self.assertIn("JSON", verify.check_file(d / "b.json"))


class LLMTests(unittest.TestCase):
    def test_recover_text_tool_call(self):
        t = 'I will list.\n<tool_call>\n{"name": "list_dir", "arguments": {"path": "."}}\n</tool_call>'
        calls = recover_tool_calls(t, {"list_dir"})
        self.assertEqual(calls[0]["function"]["name"], "list_dir")
        self.assertEqual(recover_tool_calls('```json\n{"name":"nope","arguments":{}}\n```', {"list_dir"}), [])

    def test_router_falls_back_when_profiles_missing(self):
        home, cfg, g, a, d = make_env()
        r = Router(cfg)
        self.assertEqual(r.pick("agent")[1], "qwen3.5:4b-q4_K_M")


class AgentTests(unittest.TestCase):
    def setUp(self):
        FAKE.script.clear()
        FAKE.requests.clear()

    def session(self, approve="allow"):
        home, cfg, g, audit, dec = make_env(approve)
        skills = SkillLibrary(TMP_HOME / "data" / "skills.jsonl.gz")
        events = []
        s = Session(cfg, g, Router(cfg), skills, Memory(home / "mem.md"), lambda k, d: events.append((k, d)))
        return s, cfg, events, dec

    def test_full_tool_loop_creates_files(self):
        s, cfg, events, dec = self.session()
        FAKE.script += [
            {"content": "Let me look.", "tool_calls": [("list_dir", {"path": "."})]},
            {"tool_calls": [("write_file", {"path": "app/main.py", "content": "def add(a, b):\n    return a + b\n"})]},
            {"tool_calls": [("make_document", {"path": "report.docx", "content": "# Report\n\n- added add()"})]},
            {"tool_calls": [("finish", {"summary": "done", "evidence": "check ok"})]},
        ]
        r = s.run("build it")
        ws = Path(cfg["workspace"])
        self.assertEqual(r["text"], "done")
        self.assertTrue((ws / "app/main.py").exists())
        self.assertEqual(verify.check_file(ws / "report.docx"), "")
        self.assertEqual(len(r["finished"]["files"]), 2)
        req = FAKE.requests[0]
        self.assertEqual(req["model"], "qwen3.5:4b-q4_K_M")
        self.assertFalse(req["think"])
        self.assertEqual(req["options"]["num_ctx"], 16384)
        self.assertTrue(any(t["function"]["name"] == "skill_search" for t in req["tools"]))
        self.assertIn("[context]", req["messages"][1]["content"])
        # the cacheable prefix (system + tools) is identical across calls
        self.assertEqual(FAKE.requests[0]["messages"][0], FAKE.requests[-1]["messages"][0])
        self.assertEqual(FAKE.requests[0]["tools"], FAKE.requests[-1]["tools"])

    def test_tool_errors_are_fed_back_not_fatal(self):
        s, cfg, events, dec = self.session()
        FAKE.script += [
            {"tool_calls": [("read_file", {"path": "missing.txt"})]},
            {"tool_calls": [("bogus_tool", {})]},
            {"content": "Could not find the file."},
        ]
        r = s.run("read missing.txt")
        self.assertEqual(r["text"], "Could not find the file.")
        results = [d for k, d in events if k == "tool_result"]
        self.assertFalse(results[0]["ok"])
        self.assertIn("unknown tool", results[1]["result"])

    def test_denied_write_reported(self):
        s, cfg, events, dec = self.session("deny")
        FAKE.script += [{"tool_calls": [("write_file", {"path": "x.txt", "content": "x"})]}, {"content": "ok, not written"}]
        s.run("write x")
        self.assertTrue(any("DENIED" in d["result"] for k, d in events if k == "tool_result"))
        self.assertFalse((Path(cfg["workspace"]) / "x.txt").exists())

    def test_repeat_loop_warning(self):
        s, cfg, events, dec = self.session()
        FAKE.script += [{"tool_calls": [("list_dir", {"path": "."})]}] * 3 + [{"content": "stop"}]
        s.run("loop")
        self.assertIn("3 times", [d for k, d in events if k == "tool_result"][2]["result"])

    def test_text_tool_call_recovered(self):
        s, cfg, events, dec = self.session()
        FAKE.script += [{"content": '<tool_call>{"name":"make_folder","arguments":{"path":"newdir"}}</tool_call>'},
                        {"content": "made"}]
        s.run("make a folder")
        self.assertTrue((Path(cfg["workspace"]) / "newdir").is_dir())

    def test_edit_file_uniqueness(self):
        s, cfg, events, dec = self.session()
        ws = Path(cfg["workspace"])
        (ws / "f.py").write_text("x = 1\nx = 1\n")
        out, ok = tools.call(s.ctx, "edit_file", {"path": "f.py", "old": "x = 1", "new": "x = 2"})
        self.assertFalse(ok)
        self.assertIn("2 times", out)
        out, ok = tools.call(s.ctx, "edit_file", {"path": "f.py", "old": "x = 1\nx = 1", "new": "x = 1\nx = 2"})
        self.assertTrue(ok, out)
        self.assertEqual((ws / "f.py").read_text(), "x = 1\nx = 2\n")

    def test_skill_search(self):
        s, cfg, events, dec = self.session()
        out, ok = tools.call(s.ctx, "skill_search", {"query": "root cause debugging failing test"})
        self.assertTrue(ok)
        self.assertIn("debug", out.lower())
        sid = out.split("]")[0].strip("[")
        body, ok = tools.call(s.ctx, "skill_load", {"id": sid}, limit=10000)
        self.assertIn("PLAYBOOK", body)


class MissionTests(unittest.TestCase):
    def setUp(self):
        FAKE.script.clear()
        FAKE.requests.clear()

    def test_mission_with_retry_and_report(self):
        home, cfg, g, audit, dec = make_env("allow")
        events = []
        runner = MissionRunner(cfg, g, Router(cfg), None, Memory(home / "m.md"), lambda k, d: events.append((k, d)))
        plan = {"steps": [{"title": "Write the module", "deliverable": "calc.py", "verify": "parses"},
                          {"title": "Write the doc", "deliverable": "calc.md", "verify": "exists"}]}
        FAKE.script += [
            {"content": json.dumps(plan)},
            # step 1, attempt 1: broken python -> deterministic check fails
            {"tool_calls": [("write_file", {"path": "calc.py", "content": "def add(a, b)\n    return a+b\n"})]},
            {"tool_calls": [("finish", {"summary": "wrote calc.py", "evidence": "trust me"})]},
            # step 1, attempt 2: fixed
            lambda req: ({"tool_calls": [("write_file", {"path": "calc.py", "content": "def add(a, b):\n    return a + b\n"})]}
                         if "FAILED VERIFICATION" in req["messages"][1]["content"] else {"content": "missing feedback"}),
            {"tool_calls": [("finish", {"summary": "fixed calc.py", "evidence": "check ok"})]},
            # step 2
            {"tool_calls": [("write_file", {"path": "calc.md", "content": "# calc\n"})]},
            {"tool_calls": [("finish", {"summary": "doc written", "evidence": "file exists"})]},
            # review step
            {"tool_calls": [("finish", {"summary": "APPROVED: both deliverables present", "evidence": "read both"})]},
        ]
        m = Mission.create(cfg.state_dir, "make a calculator module and doc")
        runner.run(m)
        self.assertEqual(m.d["status"], "done", m.d["log"])
        self.assertEqual([s["status"] for s in m.d["steps"]], ["done", "done", "done"])
        self.assertEqual(m.d["steps"][0]["attempts"], 2)
        self.assertTrue((m.root / "report.md").exists())
        self.assertFalse(FAKE.requests[0].get("tools"))  # planner call
        self.assertIsInstance(FAKE.requests[0]["format"], dict)
        # resume of a finished mission is a no-op that keeps it done
        m2 = Mission.load(cfg.state_dir, m.d["id"])
        self.assertEqual(m2.d["status"], "done")

    def test_mission_pause_and_resume(self):
        home, cfg, g, audit, dec = make_env("allow")
        runner = MissionRunner(cfg, g, Router(cfg), None, None, lambda k, d: None)
        m = Mission.create(cfg.state_dir, "two files")
        m.d["steps"] = [dict(title=t, deliverable="", verify="", status="pending", attempts=0, summary="", evidence="")
                        for t in ("one", "two")]
        m.save()
        FAKE.script += [{"tool_calls": [("write_file", {"path": "1.txt", "content": "1"})]},
                        lambda req: (runner.stop.set(), {"tool_calls": [("finish", {"summary": "one done"})]})[1]]
        runner.run(m)
        self.assertEqual(m.d["status"], "paused")
        FAKE.script += [{"tool_calls": [("write_file", {"path": "2.txt", "content": "2"})]},
                        {"tool_calls": [("finish", {"summary": "two done"})]}]
        m2 = Mission.load(cfg.state_dir, m.d["id"])
        runner.run(m2)
        self.assertEqual(m2.d["status"], "done", m2.d["log"])
        self.assertTrue((Path(cfg["workspace"]) / "2.txt").exists())


class ServerTests(unittest.TestCase):
    def test_http_api_and_origin_guard(self):
        from kestrel.app import App
        from kestrel.server import make_handler
        cfg = Config(TMP_HOME / "config.json")
        cfg.data["ollama_url"] = FAKE.url
        cfg.save()
        app = App(Config(TMP_HOME / "config.json"))
        srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{srv.server_address[1]}"
        st = json.load(urllib.request.urlopen(base + "/api/status"))
        self.assertTrue(st["ollama"])
        self.assertGreater(st["skills"], 900)
        html = urllib.request.urlopen(base + "/").read()
        self.assertIn(b"KES", html)
        # cross-site request is refused
        req = urllib.request.Request(base + "/api/chat", data=b'{"text":"hi"}', method="POST",
                                     headers={"Content-Type": "application/json", "Origin": "https://evil.example"})
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req)
        self.assertEqual(cm.exception.code, 403)
        FAKE.script.clear()
        FAKE.script.append({"content": "hello from fake"})
        req = urllib.request.Request(base + "/api/chat", data=b'{"text":"hi"}', method="POST",
                                     headers={"Content-Type": "application/json"})
        self.assertTrue(json.load(urllib.request.urlopen(req))["ok"])
        for _ in range(50):
            if any(e["kind"] == "answer" for e in app.hub.history):
                break
            time.sleep(0.1)
        self.assertTrue(any(e["kind"] == "answer" and e["data"]["text"] == "hello from fake" for e in app.hub.history))
        srv.shutdown()


class IntegrationTests(unittest.TestCase):
    """Phase 1+2: Open WebUI pipe <-> Kestrel run API, coder edits, exact calc, outline compaction."""

    def setUp(self):
        FAKE.script.clear()
        FAKE.requests.clear()
        FAKE.loaded, FAKE.unloaded = [], []

    def test_exact_calc(self):
        from kestrel.exactcalc import calculate
        self.assertTrue(calculate("0.1 + 0.2").startswith("3/10"))
        self.assertTrue(calculate("2**100").startswith("1267650600228229401496703205376"))
        with self.assertRaises(ValueError):
            calculate("__import__('os')")

    def test_quick_edit_with_code_model_and_rollback(self):
        home, cfg, g, audit, dec = make_env("allow")
        s = Session(cfg, g, Router(cfg), None, None)
        ws = Path(cfg["workspace"])
        (ws / "m.py").write_text("def area(r):\n    return 3.14 * r\n")
        FAKE.script += [{"content": json.dumps({"old": "3.14 * r", "replacement": "3.14 * r * r"})}]
        out, ok = tools.call(s.ctx, "quick_edit", {"path": "m.py", "instruction": "square the radius"}, limit=5000)
        self.assertTrue(ok, out)
        self.assertIn("r * r", (ws / "m.py").read_text())
        req = FAKE.requests[-1]
        self.assertEqual(req["model"], "qwen2.5-coder:3b")
        self.assertEqual(req["format"]["required"], ["old", "replacement"])
        self.assertEqual(req["options"]["temperature"], 0)
        # an edit that breaks the file is rolled back
        FAKE.script += [{"content": json.dumps({"old": "return 3.14 * r * r", "replacement": "return (3.14 * r * r"})}]
        out, ok = tools.call(s.ctx, "quick_edit", {"path": "m.py", "instruction": "break it"}, limit=5000)
        self.assertFalse(ok)
        self.assertIn("rolled back", out)
        self.assertEqual(verify.check_file(ws / "m.py"), "")

    def test_one_model_at_a_time(self):
        home, cfg, g, audit, dec = make_env("allow")
        FAKE.loaded = ["local-fast:latest", "qwen2.5-coder:3b"]
        s = Session(cfg, g, Router(cfg), None, None)
        FAKE.script += [{"content": "hi"}]
        s.run("hello")
        self.assertEqual(sorted(FAKE.unloaded), ["local-fast:latest", "qwen2.5-coder:3b"])

    def test_outline_compaction_without_model_and_recall(self):
        home, cfg, g, audit, dec = make_env("allow")
        cfg.data["num_ctx"] = 1500  # force compaction early
        s = Session(cfg, g, Router(cfg), None, None)
        for i in range(6):
            FAKE.script.append({"tool_calls": [("write_file", {"path": f"f{i}.txt", "content": f"payload {i} " * 60})]})
        FAKE.script.append({"tool_calls": [("recall", {"ids": "m2-m3"})]})
        FAKE.script.append({"content": "done"})
        events = []
        s.emit = lambda k, d: events.append((k, d))
        s.run("write six files")
        self.assertTrue(any(k == "compacted" for k, d in events))
        # every request was an agent request: no hidden summarizer calls
        self.assertTrue(all(r["model"] == "qwen3.5:4b-q4_K_M" for r in FAKE.requests))
        rec = [d for k, d in events if k == "tool_result" and d["name"] == "recall"][0]["result"]
        self.assertIn("[m2]", rec)
        self.assertIn("write_file", rec)

    def test_tool_server_for_any_openwebui_model(self):
        from kestrel.app import App
        from kestrel.server import make_handler
        home, cfg0, g0, a0, d0 = make_env()
        cfg = Config(home / "config.json")
        cfg.data.update({"ollama_url": FAKE.url, "workspace": str(home / "ws")})
        app = App(cfg)
        srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{srv.server_address[1]}"

        def call(path, body=None, token=app.api_token):
            req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                                         method="POST" if body is not None else "GET",
                                         headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
            try:
                return json.load(urllib.request.urlopen(req))
            except urllib.error.HTTPError as e:
                return {"http": e.code}
        spec = call("/openapi.json")
        self.assertIn("/tools/write_file", spec["paths"])
        self.assertNotIn("/tools/finish", spec["paths"])
        self.assertEqual(call("/openapi.json", token="x"), {"http": 401})
        # a write the user approved in Open WebUI goes through, with backup + audit
        r = call("/tools/make_document", {"path": "plan.docx", "content": "# Plan\n- one"})
        self.assertTrue(r["ok"], r)
        self.assertEqual(verify.check_file(home / "ws" / "plan.docx"), "")
        # a folder that was never approved stays closed, even though Open WebUI approved the call
        outside = Path(tempfile.mkdtemp(prefix="outside-"))
        r = call("/tools/read_file", {"path": str(outside / "x.txt")})
        self.assertFalse(r["ok"])
        self.assertIn("Approved folders", r["result"])
        r = call("/tools/calc", {"expression": "1/3+1/6"})
        self.assertIn("1/2", r["result"])
        log = app.audit.path.read_text()
        self.assertIn("approval.openwebui", log)
        self.assertTrue(app.audit.verify()[0])
        srv.shutdown()

    def test_openwebui_pipe_end_to_end(self):
        import asyncio
        import importlib.util
        from kestrel.app import App
        from kestrel.server import make_handler
        sys.path.insert(0, str(Path(__file__).parent / "shims"))
        try:
            import httpx  # noqa: F401
        except ImportError:
            pass
        home, cfg0, g0, a0, d0 = make_env()
        cfg = Config(home / "config.json")
        cfg.data.update({"ollama_url": FAKE.url, "workspace": str(home / "ws")})
        app = App(cfg)
        srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        spec = importlib.util.spec_from_file_location("owui_pipe", ROOT / "integrations" / "openwebui_pipe.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        pipe = mod.Pipe()
        pipe.valves.KESTREL_URL = f"http://127.0.0.1:{srv.server_address[1]}"
        pipe.valves.KESTREL_TOKEN = app.api_token
        FAKE.script += [{"content": "Creating it.", "tool_calls": [("write_file", {"path": "hi.md", "content": "# hi"})]},
                        {"tool_calls": [("finish", {"summary": "Created hi.md", "evidence": "check ok"})]}]
        asked, statuses = [], []

        async def event_call(ev):
            asked.append(ev)
            return True

        async def emitter(ev):
            statuses.append(ev["data"]["description"])

        async def run():
            out = []
            async for chunk in pipe.pipe({"model": "kestrel_pipe.kestrel", "messages": [{"role": "user", "content": "make hi.md"}]},
                                         __event_emitter__=emitter, __event_call__=event_call, __metadata__={"chat_id": "c1"}):
                out.append(chunk)
            return "".join(out)
        text = asyncio.run(run())
        self.assertTrue((home / "ws" / "hi.md").exists())
        self.assertEqual(len(asked), 1)
        self.assertEqual(asked[0]["type"], "confirmation")
        self.assertIn('<details type="tool_calls"', text)
        self.assertIn("Created hi.md", text)
        self.assertIn("/api/file?path=", text)
        self.assertIn("Done", statuses)
        # the same Open WebUI chat continues the same Kestrel session
        self.assertIn("c1", app.chats)
        # wrong token is refused
        pipe.valves.KESTREL_TOKEN = "nope"
        self.assertIn("token", asyncio.run(run()))
        srv.shutdown()


# ---------------------------------------------------------------------------
GOOD_JS = ("const c=document.getElementById('board'),x=c.getContext('2d');let px=0,dx=2;\n"
           "document.addEventListener('keydown',e=>{if(e.key==='ArrowLeft')dx=-2;if(e.key==='ArrowRight')dx=2;});\n"
           "function loop(){px=(px+dx+200)%200;x.clearRect(0,0,200,200);x.fillRect(px,90,10,10);requestAnimationFrame(loop);}\nloop();\n")
PAGE = "<!DOCTYPE html>\n<html><head><title>g</title></head><body>\n<canvas id=\"board\" width=\"200\" height=\"200\"></canvas>\n<script>\n{js}</script>\n</body></html>\n"


class BuildTests(unittest.TestCase):
    def setUp(self):
        FAKE.script.clear()
        FAKE.requests.clear()

    def test_route(self):
        from kestrel.route import classify
        code = [{"role": "assistant", "content": "x\n```html\n<html></html>\n```"}]
        cases = [("היי", [], "chat"), ("בנה לי משחק סנייק בקובץ html", [], "build"), ("זה לא עובד", code, "fix"),
                 ("Create a Word document named a.docx", [], "agent"), ("write a python script that renames photos", [], "build"),
                 ("What is 17.5% of 2,480?", [], "agent"), ("מה זה רקורסיה?", [], "chat"), ("זה לא עובד", [], "chat")]
        for text, hist, want in cases:
            self.assertEqual(classify(text, hist), want, text)
        # Open WebUI strips collapsed blocks from history: a code file path, or Kestrel's own memory, is enough
        path_only = [{"role": "assistant", "content": "✅ built `C:\\AI-Workspace\\Projects\\pomodoro-timer.html`"}]
        self.assertEqual(classify("זה לא עובד", path_only), "fix")
        self.assertEqual(classify("it doesn't work", [], has_code=True), "fix")

    def test_apply_edit_tolerates_whitespace_and_line_numbers(self):
        from kestrel.build import apply_edit
        code = "function a() {\n    let x = 1;\n    return x;\n}\n"
        self.assertIn("x = 2", apply_edit(code, "let x = 1;", "let x = 2;"))
        out = apply_edit(code, "  2|     let x = 1;\n  3|     return x;", "let x = 3;\nreturn x + 1;")
        self.assertIn("    let x = 3;\n    return x + 1;\n}", out)
        with self.assertRaises(ValueError):
            apply_edit(code, "not there", "y")

    def test_json_loop_guard_stops_single_line_repetition(self):
        from kestrel.build import Degenerate, JsonLoopGuard
        g = JsonLoopGuard()
        g.feed("content", '{"diagnosis": "the timer never resets", "edits": [')
        with self.assertRaises(Degenerate):
            for _ in range(60):
                g.feed("content", '{"old": "let t = 0; start();", "new": "let t = 25*60; start();"}, ')
        ok = JsonLoopGuard()
        for i in range(60):
            ok.feed("content", f'{{"old": "line {i} of the code", "new": "fixed line {i} value {i * 7}"}}, ')

    def test_loop_guard_stops_repetition(self):
        from kestrel.build import Degenerate, LoopGuard
        g = LoopGuard()
        g.feed("content", "function a(){}\n" * 2)
        with self.assertRaises(Degenerate):
            for _ in range(40):
                g.feed("content", "        function stopGame() {\n            isRunning = false;\n        }\n")

    @unittest.skipUnless(__import__("kestrel.runcheck", fromlist=["x"]).find_browser(), "no headless browser")
    def test_build_repairs_from_real_run_then_delivers(self):
        from kestrel.build import BuildEngine, answer_markdown
        home, cfg, g, audit, dec = make_env()
        cfg.data["build"] = {"max_candidates": 2, "max_repairs": 3, "review_passes": 1, "think_budget_chars": 0, "acceptance_tests": False}
        spec = {"filename": "game.html", "summary": "moving square", "interactive": True,
                "requirements": ["square moves", "arrows steer"], "design": ["loop: draw"], "pitfalls": ["wrong ids"]}
        bad = PAGE.replace("{js}", GOOD_JS.replace("'board'", "'canvas'"))
        loop = "```html\n<html><body>\n" + "        function stopGame() {\n            isRunning = false;\n        }\n" * 30
        FAKE.script += [
            {"content": json.dumps(spec)},                         # plan
            {"content": loop},                                     # writer loops -> aborted by LoopGuard
            {"content": "```html\n" + bad + "```"},                # writer (bug: wrong id)
            {"content": json.dumps({"diagnosis": "id mismatch", "edits": [
                {"old": "getElementById('canvas')", "new": "getElementById('board')"}]})},   # repair
            {"content": json.dumps({"defects": []})},              # review: clean
        ]
        events = []
        res = BuildEngine(cfg, g, Router(cfg), lambda k, d: events.append((k, d))).run("make a moving square")
        self.assertTrue(res["ok"], res["report"])
        self.assertIn("getElementById('board')", res["code"])
        self.assertTrue(Path(res["path"]).exists())
        log = "\n".join(res["log"])
        self.assertIn("loop", log)                 # degenerate output was caught
        self.assertIn("✗", log)                    # the first run really failed
        self.assertIn("Repair 1: ✓ passes", log)   # and the repair was proven by a re-run
        self.assertIn("screen changes after keys/clicks: yes", "\n".join(res["facts"]))
        md = answer_markdown(res, hebrew=True)
        self.assertIn("נבנה, הורץ ונבדק", md)
        # the repair prompt carried the verifier's real finding
        self.assertTrue(any("canvas" in json.dumps(r["messages"]) and "runtime error" in json.dumps(r["messages"]) for r in FAKE.requests))

    def test_thinking_budget_cuts_long_reasoning_and_passes_notes_on(self):
        from kestrel.build import SPEC_SCHEMA, BuildEngine
        home, cfg, g, audit, dec = make_env()
        cfg.data["build"] = {"think_budget_chars": 200}
        spec = {"filename": "a.html", "summary": "s", "interactive": True, "requirements": ["r"], "design": ["d"], "pitfalls": ["p"]}
        FAKE.script += [{"thinking": "considering the timer state machine. " * 40, "content": "ignored"},
                        {"content": json.dumps(spec)}]
        eng = BuildEngine(cfg, g, Router(cfg), lambda k, d: None)
        out = eng.json_call([{"role": "system", "content": "x"}, {"role": "user", "content": "plan it"}], SPEC_SCHEMA,
                            think=True, label="plan")
        self.assertEqual(out["filename"], "a.html")
        self.assertTrue(FAKE.requests[0]["think"])                       # first call reasons
        self.assertFalse(FAKE.requests[1]["think"])                      # answer call does not
        self.assertIn("timer state machine", FAKE.requests[1]["messages"][-1]["content"])  # notes carried over
        notes = list(eng.root.glob("thinking_plan_*.md"))[0].read_text()
        self.assertLess(len(notes), 400)                                  # cut at the budget, not 1,500 chars


    def test_pipe_reads_full_history_from_open_webui_store(self):
        import asyncio
        import types
        sys.path.insert(0, str(ROOT / "integrations"))
        sys.path.insert(0, str(ROOT / "tests" / "shims"))
        import openwebui_pipe
        nodes = {"a": {"role": "user", "content": "build a timer", "parentId": None},
                 "b": {"role": "assistant", "content": "done\n<details><summary>Code</summary>\n\n```html\n<html></html>\n```\n</details>", "parentId": "a"},
                 "c": {"role": "user", "content": "it doesn't work", "parentId": "b"},
                 "d": {"role": "assistant", "content": "", "parentId": "c"}}
        chat = types.SimpleNamespace(chat={"history": {"messages": nodes, "currentId": "d"}})
        mod = types.ModuleType("open_webui.models.chats")
        mod.Chats = types.SimpleNamespace(get_chat_by_id=lambda cid: chat if cid == "c1" else None)
        for name in ("open_webui", "open_webui.models"):
            sys.modules.setdefault(name, types.ModuleType(name))
        sys.modules["open_webui.models.chats"] = mod
        try:
            trimmed = [{"role": "user", "content": "it doesn't work"}]
            full = asyncio.run(openwebui_pipe.Pipe._full_history("c1", trimmed))
            self.assertEqual([m["role"] for m in full], ["user", "assistant", "user"])
            self.assertIn("```html", full[1]["content"])
            self.assertEqual(asyncio.run(openwebui_pipe.Pipe._full_history("other", trimmed)), [])   # unknown chat -> fall back
            self.assertEqual(asyncio.run(openwebui_pipe.Pipe._full_history("c1", [{"role": "user", "content": "x"}])), [])  # mismatch -> fall back
        finally:
            sys.modules.pop("open_webui.models.chats", None)

    @unittest.skipUnless(__import__("kestrel.runcheck", fromlist=["x"]).find_browser(), "no headless browser")
    def test_regressing_repair_is_discarded(self):
        from kestrel.build import BuildEngine
        home, cfg, g, audit, dec = make_env()
        cfg.data["build"] = {"max_candidates": 1, "max_repairs": 2, "review_passes": 0, "think_budget_chars": 0, "acceptance_tests": False}
        spec = {"filename": "p.html", "summary": "s", "interactive": True, "requirements": ["r"], "design": ["d"], "pitfalls": ["p"]}
        bad = PAGE.replace("{js}", GOOD_JS.replace("'board'", "'canvas'"))
        worse = {"diagnosis": "x", "edits": [{"old": "let px=0,dx=2;", "new": "let px=0,dx=2; foo(;"}]}
        FAKE.script += [{"content": json.dumps(spec)}, {"content": "```html\n" + bad + "```"},
                        {"content": json.dumps(worse)}, {"content": json.dumps(worse)}]
        res = BuildEngine(cfg, g, Router(cfg), lambda k, d: None).run("x")
        self.assertFalse(res["ok"])
        self.assertNotIn("foo(;", res["code"])     # the kept version is the better one
        self.assertIn("discarded", "\n".join(res["log"]))

    @unittest.skipUnless(__import__("kestrel.runcheck", fromlist=["x"]).find_browser(), "no headless browser")
    def test_fix_replaces_the_original_file_with_backup(self):
        from kestrel.build import BuildEngine
        home, cfg, g, audit, dec = make_env()
        cfg.data["build"] = {"max_candidates": 1, "max_repairs": 1, "review_passes": 0, "think_budget_chars": 0, "acceptance_tests": False}
        ws = Path(cfg["workspace"]); ws.mkdir(parents=True, exist_ok=True)
        orig = ws / "my-game.html"
        bad = PAGE.replace("{js}", GOOD_JS.replace("'board'", "'canvas'"))
        orig.write_text(bad, encoding="utf-8")
        spec = {"filename": "other-name.html", "summary": "s", "interactive": True, "requirements": ["r"], "design": ["d"], "pitfalls": ["p"]}
        FAKE.script += [{"content": json.dumps(spec)},
                        {"content": json.dumps({"diagnosis": "id", "edits": [{"old": "getElementById('canvas')", "new": "getElementById('board')"}]})}]
        res = BuildEngine(cfg, g, Router(cfg), lambda k, d: None).run("fix it", existing=bad, target=str(orig))
        self.assertTrue(res["ok"])
        self.assertEqual(Path(res["path"]), orig.resolve())            # same file, not a new one
        self.assertIn("getElementById('board')", orig.read_text(encoding="utf-8"))
        self.assertTrue(any(g.backups.rglob("*my-game.html*")))         # the broken version was backed up


COUNTER = ("<!DOCTYPE html>\n<html><head><title>c</title></head><body>\n<div id=\"count\">0</div>\n<button id=\"inc\">+</button>\n"
           "<script>\nlet n = 0;\ndocument.getElementById('inc').addEventListener('click', () => {\n    n += 2;\n"
           "    document.getElementById('count').textContent = n;\n});\n</script>\n</body></html>\n")
COUNTER_SPEC = {"filename": "counter.html", "summary": "counter", "interactive": True,
                "requirements": ["Clicking + increases the count by exactly 1"], "design": ["n: count"], "pitfalls": ["off by one"]}
COUNTER_TESTS = {"tests": [{"name": "plus adds one", "requirement": "Clicking + increases the count by exactly 1",
                            "steps": [{"do": "click", "target": "#inc"}, {"do": "expect", "target": "#count", "text_matches": "^1$"}]}]}
FIX_2_TO_1 = {"diagnosis": "adds 2", "edits": [{"old": "n += 2;", "new": "n += 1;"}]}


@unittest.skipUnless(__import__("kestrel.runcheck", fromlist=["x"]).find_browser(), "no headless browser")
class AcceptanceTests(unittest.TestCase):
    def setUp(self):
        FAKE.script.clear()
        FAKE.requests.clear()

    def _engine(self, **build):
        from kestrel.build import BuildEngine
        home, cfg, g, audit, dec = make_env()
        cfg.data["build"] = {"max_candidates": 1, "max_repairs": 3, "review_passes": 1, "think_budget_chars": 0, **build}
        return BuildEngine(cfg, g, Router(cfg), lambda k, d: None)

    def test_runner_language(self):
        from kestrel import runcheck
        d = Path(tempfile.mkdtemp())
        f = d / "c.html"
        f.write_text(COUNTER.replace("n += 2", "n += 1"), encoding="utf-8")
        tests = [{"name": "one", "steps": [{"do": "mark", "target": "#count"}, {"do": "click", "target": "+"},
                                          {"do": "expect_number", "target": "#count", "op": ">", "value": "mark"},
                                          {"do": "expect_changed", "target": "#count"}]},
                 {"name": "bad target", "steps": [{"do": "click", "target": "#nope"}]},
                 {"name": "wrong value", "steps": [{"do": "click", "target": "#inc"}, {"do": "expect", "target": "#count", "text_matches": "^7$"}]}]
        import time as _t
        orig = runcheck._run_tests_one_by_one
        runcheck._run_tests_one_by_one = lambda *a, **k: self.fail("the single-launch runner fell back")
        try:
            t0 = _t.time()
            r = runcheck.run_tests(f, tests)
            print(f"\n  [3 tests in one launch: {_t.time() - t0:.1f}s]")
        finally:
            runcheck._run_tests_one_by_one = orig
        self.assertEqual([x["ok"] for x in r], [True, False, False])
        self.assertIn("could not find", r[1]["msg"])
        self.assertIn('shows "1"', r[2]["msg"])

    def test_nth_target_works_when_inputs_are_wrapped(self):
        """Measured: the converter's hidden checks used 'input:last-of-type', which picks the wrong box when each input
        sits in its own <div> (a normal layout), so correct converters failed."""
        from kestrel import runcheck
        d = Path(tempfile.mkdtemp())
        f = d / "c.html"
        f.write_text("<!doctype html><html><body><div><input id=c></div><div><input id=f></div><script>"
                     "c.oninput=function(){f.value=(c.value*9/5+32).toFixed(1)};</script></body></html>", encoding="utf-8")
        tests = [{"name": "c to f", "steps": [{"do": "type", "target": "1st input", "text": "100"}, {"do": "wait", "ms": 300},
                                              {"do": "expect", "target": "2nd input", "text_matches": "^212(\\.0)?$"}]}]
        r = runcheck.run_tests(f, tests)
        self.assertTrue(r[0]["ok"], r)

    def test_batched_tests_are_isolated_and_a_frozen_test_does_not_sink_the_rest(self):
        from kestrel import runcheck
        d = Path(tempfile.mkdtemp())
        f = d / "s.html"
        f.write_text("<!doctype html><html><head></head><body><span id='v'></span><button id='b'>save</button>"
                     "<button id='hang'>hang</button><script>document.getElementById('v').textContent=localStorage.getItem('k')||'empty';"
                     "document.getElementById('b').onclick=function(){localStorage.setItem('k','full');document.getElementById('v').textContent='full';};"
                     "document.getElementById('hang').onclick=function(){while(true){}};</script></body></html>", encoding="utf-8")
        tests = [{"name": "saves", "steps": [{"do": "click", "target": "#b"}, {"do": "expect", "target": "#v", "text_matches": "^full$"}]},
                 {"name": "starts empty", "steps": [{"do": "expect", "target": "#v", "text_matches": "^empty$"}]},
                 {"name": "freezes", "steps": [{"do": "click", "target": "#hang"}, {"do": "expect", "target": "#v", "text_matches": "x"}]},
                 {"name": "after freeze", "steps": [{"do": "expect", "target": "#v", "text_matches": "^empty$"}]}]
        r = runcheck.run_tests(f, tests)
        self.assertEqual([x["name"] for x in r], ["saves", "starts empty", "freezes", "after freeze"])
        self.assertEqual([x["ok"] for x in r], [True, True, False, True])

    def test_logic_bug_without_errors_is_caught_by_a_test_and_fixed(self):
        FAKE.script += [{"content": json.dumps(COUNTER_SPEC)}, {"content": "```html\n" + COUNTER + "```"},
                        {"content": json.dumps(COUNTER_TESTS)}, {"content": json.dumps(FIX_2_TO_1)}]
        res = self._engine().run("a counter")
        log = "\n".join(res["log"])
        self.assertIn("Wrote 1 acceptance tests", log)
        self.assertIn("test 'plus adds one'", log)          # the run itself was clean; only the test saw the bug
        self.assertIn("Repair 1: ✓ passes", log)
        self.assertIn("n += 1", res["code"])
        self.assertTrue(res["ok"])
        self.assertEqual(len([r for r in FAKE.requests if "review" in json.dumps(r["messages"])[:400].lower()]), 0)  # tests replace review

    def test_judge_must_agree_before_a_test_is_dropped(self):
        wrong = {"tests": [{"name": "plus adds five", "requirement": "Clicking + increases the count by exactly 1",
                            "steps": [{"do": "click", "target": "#inc"}, {"do": "expect", "target": "#count", "text_matches": "^5$"}]}]}
        good_code = COUNTER.replace("n += 2", "n += 1")
        claim = {"diagnosis": "code is right", "edits": [], "wrong_tests": [{"name": "plus adds five", "reason": "requirement says 1"}]}
        FAKE.script += [{"content": json.dumps(COUNTER_SPEC)}, {"content": "```html\n" + good_code + "```"},
                        {"content": json.dumps(wrong)}, {"content": json.dumps(claim)},
                        {"content": json.dumps({"verdict": "test_is_wrong", "reason": "requirement says 1, test expects 5"})}]
        eng = self._engine(max_repairs=1)
        res = eng.run("a counter")
        self.assertIn("dropped", "\n".join(res["log"]))
        self.assertEqual(eng.tests, [])
        # and the judge never saw the program
        judge = [r for r in FAKE.requests if "arbitrate" in json.dumps(r["messages"])]
        self.assertTrue(judge)
        self.assertNotIn("n += 1", json.dumps(judge[0]["messages"]))

    def test_judge_disagreeing_keeps_the_test(self):
        claim = {"diagnosis": "nothing to fix", "edits": [], "wrong_tests": [{"name": "plus adds one", "reason": "I think it is fine"}]}
        FAKE.script += [{"content": json.dumps(COUNTER_SPEC)}, {"content": "```html\n" + COUNTER + "```"},
                        {"content": json.dumps(COUNTER_TESTS)}, {"content": json.dumps(claim)},
                        {"content": json.dumps({"verdict": "test_is_right", "reason": "1 is what the requirement says"})}]
        eng = self._engine(max_repairs=1)
        res = eng.run("a counter")
        self.assertIn("kept", "\n".join(res["log"]))
        self.assertEqual(len(eng.tests), 1)
        self.assertFalse(res["ok"])

    def test_fix_reuses_plan_and_tests(self):
        FAKE.script += [{"content": json.dumps(FIX_2_TO_1)}]
        res = self._engine().run("a counter\n\nFollow-up from the person: it doesn't work", existing=COUNTER,
                                 spec=COUNTER_SPEC, tests=COUNTER_TESTS["tests"])
        self.assertTrue(res["ok"])
        self.assertIn("Reusing the plan", "\n".join(res["log"]))
        self.assertEqual(len(FAKE.requests), 1)            # one model call: the repair. No planning, no test writing.


class FocusTests(unittest.TestCase):
    def test_focus_code_sends_outline_and_regions(self):
        from kestrel.build import focus_code
        body = ["function f%d() {" % i + "\n    return %d;\n}" % i for i in range(80)]
        code = "\n".join(body).replace("return 40;", "return undefinedThing.x;")
        n = code.splitlines().index("    return undefinedThing.x;") + 1
        out = focus_code(code, f"runtime error: Uncaught ReferenceError (line {n}, col 12) | at f40 (file:///x.html:{n}:12)")
        self.assertIn("OUTLINE", out)
        self.assertIn("undefinedThing", out)
        self.assertNotIn("return 70;", out)               # far-away code is not re-sent
        self.assertLess(len(out), len(code))
        self.assertEqual(focus_code("a\nb", "line 1"), "   1| a\n   2| b")  # small files are sent whole


TODO = ("<!DOCTYPE html>\n<html><head><title>t</title></head><body>\n<input id=\"task\"><button id=\"add\">Add</button><ul id=\"list\"></ul>\n"
        "<script>\ndocument.getElementById('add').addEventListener('click', () => {\n    const li = document.createElement('li');\n"
        "    li.innerHTML = document.getElementById('task').value + ' <button class=\"del\">Delete</button>';\n"
        "    li.querySelector('.del').onclick = () => li.remove();\n    document.getElementById('list').appendChild(li);\n});\n</script>\n</body></html>\n")


@unittest.skipUnless(__import__("kestrel.runcheck", fromlist=["x"]).find_browser(), "no headless browser")
class EvalFindingsTests(unittest.TestCase):
    """Regression tests for problems measured in the 2026-11-19 evaluation on the real PC."""
    def setUp(self):
        FAKE.script.clear()
        FAKE.requests.clear()

    def _engine(self, **build):
        from kestrel.build import BuildEngine
        home, cfg, g, audit, dec = make_env()
        cfg.data["build"] = {"max_candidates": 2, "max_repairs": 1, "review_passes": 0, "think_budget_chars": 0, **build}
        return BuildEngine(cfg, g, Router(cfg), lambda k, d: None)

    def test_tests_on_elements_created_later_are_kept(self):
        spec = {"filename": "todo.html", "summary": "todo", "interactive": True, "requirements": ["add and delete tasks"], "design": ["d"], "pitfalls": ["p"]}
        tests = {"tests": [{"name": "delete removes", "requirement": "delete", "steps": [
            {"do": "type", "target": "#task", "text": "milk"}, {"do": "click", "target": "#add"}, {"do": "click", "target": "Delete"},
            {"do": "expect", "target": "#list", "not_matches": "milk"}]},
            {"name": "bogus", "requirement": "x", "steps": [{"do": "click", "target": "#nowhere"}, {"do": "expect_no_errors"}]}]}
        FAKE.script += [{"content": json.dumps(spec)}, {"content": "```html\n" + TODO + "```"}, {"content": json.dumps(tests)}]
        eng = self._engine()
        res = eng.run("todo")
        self.assertEqual([t["name"] for t in eng.tests], ["delete removes"])   # 'Delete' exists only after adding: kept
        self.assertTrue(res["ok"], res["report"])
        self.assertIn("1 of 2 usable", "\n".join(res["log"]))

    def test_fresh_attempt_gets_the_interface_contract_and_lessons(self):
        crash = COUNTER.replace("let n = 0;", "const n = 0;").replace("n += 2;", "n += 1;")
        FAKE.script += [{"content": json.dumps(COUNTER_SPEC)}, {"content": "```html\n" + crash + "```"},
                        {"content": json.dumps(COUNTER_TESTS)},
                        {"content": json.dumps({"diagnosis": "?", "edits": []})},
                        {"content": "```html\n" + COUNTER.replace("n += 2", "n += 1") + "```"}]
        eng = self._engine()
        res = eng.run("a counter")
        writes = [r for r in FAKE.requests if "Write the complete" in json.dumps(r["messages"])]
        self.assertEqual(len(writes), 2)
        second = writes[1]["messages"][-1]["content"]
        self.assertIn("#inc", second)            # same ids as the tests use
        self.assertIn("#count", second)
        self.assertTrue(res["ok"], res["report"])
        lessons = json.loads((eng.cfg.state_dir / "build_lessons.json").read_text())
        self.assertEqual(lessons.get("assignment to constant variable"), 1)
        lessons["assignment to constant variable"] = 3
        (eng.cfg.state_dir / "build_lessons.json").write_text(json.dumps(lessons))
        self.assertIn("`let`", eng.global_lessons())


if __name__ == "__main__":
    unittest.main(verbosity=2)


class CloudBrainTests(unittest.TestCase):
    """Kestrel's cloud brain through the MyChat gateway, and the person's rule for where it may be used."""

    def _gateway(self, parts, status=200):
        import http.server
        seen = []

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                seen.append({"auth": self.headers.get("Authorization"), "body": body})
                self.send_response(status)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for p in parts:
                    self.wfile.write(b"data: " + json.dumps({"model": "groq:openai/gpt-oss-120b", "choices": [{"delta": {"content": p}}]}).encode() + b"\n\n")
                self.wfile.write(b"data: [DONE]\n\n")
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        return f"http://127.0.0.1:{srv.server_port}/v1", seen

    def test_streams_tokens_maps_options_and_json_mode(self):
        from kestrel.llm import MyChatBackend
        url, seen = self._gateway(['{"ok":', ' true}'])
        got = []
        rep = MyChatBackend(url, "tok").chat("mychat/auto", [{"role": "user", "content": "hi"}], fmt={"type": "object"},
                                             options={"temperature": 0.2, "num_predict": 1000}, on_token=lambda k, t: got.append((k, t)))
        self.assertEqual(rep.content, '{"ok": true}')
        self.assertEqual(got, [("content", '{"ok":'), ("content", " true}")])   # streamed: the loop guard sees tokens live
        b = seen[0]["body"]
        self.assertEqual(seen[0]["auth"], "Bearer tok")
        self.assertEqual(b["response_format"], {"type": "json_object"})
        self.assertEqual(b["temperature"], 0.2)
        self.assertNotIn("max_tokens", b)          # reasoning models count hidden reasoning toward the cap
        self.assertEqual(rep.model, "groq:openai/gpt-oss-120b")

    def test_cloud_only_for_allowed_folders_never_private(self):
        from kestrel.llm import cloud_allowed
        d = Path(tempfile.mkdtemp())
        (d / "work" / "private").mkdir(parents=True)
        cfg = {"online": {"enabled": True, "backend": "mychat"}, "workspace": str(d / "work"),
               "brain": {"cloud_roots": [str(d / "work")], "private_roots": [str(d / "work" / "private")]}}
        self.assertTrue(cloud_allowed(cfg, str(d / "work" / "app.html")))
        self.assertFalse(cloud_allowed(cfg, str(d / "work" / "private" / "notes.txt")))
        self.assertFalse(cloud_allowed(cfg, str(d / "elsewhere.txt")))
        self.assertFalse(cloud_allowed({**cfg, "online": {"enabled": False, "backend": "mychat"}}, str(d / "work" / "app.html")))

    def test_router_uses_cloud_only_inside_an_allowed_task_and_falls_back_to_local(self):
        from kestrel import llm
        url, _ = self._gateway([], status=500)
        home = Path(tempfile.mkdtemp())                       # a MyChat install with a key, independent of this machine
        (home / "token").write_text("tok", encoding="utf-8")
        old_home = os.environ.get("MYCHAT_HOME")
        os.environ["MYCHAT_HOME"] = str(home)
        self.addCleanup(lambda: os.environ.__setitem__("MYCHAT_HOME", old_home) if old_home else os.environ.pop("MYCHAT_HOME", None))
        cfg = {"ollama_url": "http://127.0.0.1:9", "keep_alive": "1m", "num_ctx": 4096, "one_model_at_a_time": False,
               "models": {"agent": "a", "coder": "c"}, "fallback_models": {"agent": "a", "coder": "c"},
               "online": {"enabled": True, "backend": "mychat", "base_url": url, "use_for": ["agent", "coder"], "model": "mychat/auto"}}
        r = llm.Router(cfg)
        r._installed = ["a", "c"]
        self.assertFalse(r.pick("agent")[2])                  # chat/agent tasks: local
        llm.tls.cloud_ok = True
        try:
            self.assertTrue(r.pick("coder")[2])                # inside an allowed build: cloud
            calls = []
            r.local.chat = lambda model, *a, **k: (calls.append(model), llm.Reply(content="local answer", model=model))[1]
            rep = r.chat("coder", [{"role": "user", "content": "x"}])
            self.assertEqual((rep.content, calls), ("local answer", ["c"]))   # gateway failed -> local model took over
            self.assertIn("500", r.last_fallback)
        finally:
            llm.tls.cloud_ok = False


class CloudJsonTests(unittest.TestCase):
    def test_bare_list_and_fenced_json_are_accepted_and_cloud_skips_the_think_pass(self):
        from kestrel import build
        calls = []

        class R:
            def is_online(self, role):
                return True

            def chat(self, role, messages, tools, **k):
                calls.append(k.get("think"))
                from kestrel.llm import Reply
                return Reply(content='```json\n[{"name": "t1", "steps": [{"do": "expect", "target": "page", "text_matches": "x"}]}]\n```')
        eng = build.BuildEngine.__new__(build.BuildEngine)
        eng.router, eng.role, eng.think_budget, eng.stop = R(), "agent", 3000, threading.Event()
        eng.stats = {"llm_calls": 0, "seconds": 0.0, "output_tokens": 0}
        eng.emit = lambda *a, **k: None
        d = eng.json_call([{"role": "user", "content": "write tests"}], build.TESTS_SCHEMA, think=True, label="tests")
        self.assertEqual(d["tests"][0]["name"], "t1")
        self.assertEqual(calls, [False])     # one call, no separate thinking pass


class LoopGuardFalsePositiveTests(unittest.TestCase):
    def test_a_list_of_similar_tests_is_not_mistaken_for_a_loop(self):
        """Measured 2026-11-20: cloud-written acceptance tests (12 similar objects) tripped the old guard and were dropped."""
        from kestrel.build import JsonLoopGuard
        tests = [{"name": f"Test {i}: Start counts down", "steps": [{"do": "click", "target": "Start"}, {"do": "wait", "ms": 3000},
                  {"do": "expect", "target": "page", "text_matches": "24:5[0-9]"}]} for i in range(12)]
        txt = json.dumps({"tests": tests})
        g = JsonLoopGuard()
        for i in range(0, len(txt), 17):
            g.feed("content", txt[i:i + 17])
