"""Local web interface on 127.0.0.1 only. No external assets: works offline."""
from __future__ import annotations

import json
import mimetypes
import threading
import time
import urllib.parse
import webbrowser
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .app import App
from .config import HOME

UI = HOME / "ui" / "index.html"


def make_handler(app: App):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _json(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 5_000_000:
                return {}
            try:
                return json.loads(self.rfile.read(n) or b"{}")
            except json.JSONDecodeError:
                return {}

        def _same_origin(self) -> bool:
            # block other web pages from driving the agent (CSRF / DNS rebinding)
            host = (self.headers.get("Host") or "").split(":")[0]
            origin = self.headers.get("Origin")
            if host not in ("127.0.0.1", "localhost"):
                return False
            if origin and urllib.parse.urlparse(origin).hostname not in ("127.0.0.1", "localhost"):
                return False
            return True

        def _token_ok(self) -> bool:
            import hmac
            auth = self.headers.get("Authorization") or ""
            return hmac.compare_digest(auth.removeprefix("Bearer ").strip(), app.api_token)

        def _runs_get(self, u, q):
            if not self._token_ok():
                return self._json({"error": "bad token"}, 401)
            parts = u.path.strip("/").split("/")  # api/runs/<id>/events
            if len(parts) == 4 and parts[3] == "events":
                after = int(q.get("after", ["0"])[0] or 0)
                wait = min(float(q.get("wait", ["20"])[0] or 20), 30)
                if parts[2] not in app.hub.runs:  # Kestrel restarted or the run expired: say so instead of waiting forever
                    return self._json({"error": "unknown run"}, 404)
                return self._json({"events": app.hub.run_events(parts[2], after, wait)})
            return self._json({"error": "not found"}, 404)

        def _runs_post(self, u, b):
            if not self._token_ok():
                return self._json({"error": "bad token"}, 401)
            parts = u.path.strip("/").split("/")
            if len(parts) == 2:  # POST /api/runs
                try:
                    rid = app.start_run(b.get("messages") or [], str(b.get("chat_id") or ""), b.get("mode", "agent"))
                except ValueError as e:
                    return self._json({"error": str(e)}, 400)
                return self._json({"id": rid})
            if len(parts) == 4 and parts[3] == "approve":
                return self._json({"ok": app.decide(b.get("approval_id", ""), b.get("decision", "deny"))})
            if len(parts) == 4 and parts[3] == "stop":
                app.stop_run(parts[2])
                return self._json({"ok": True})
            return self._json({"error": "not found"}, 404)

        def do_GET(self):
            if not self._same_origin():
                return self._json({"error": "forbidden"}, 403)
            u = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(u.query)
            if u.path.startswith("/api/runs/"):
                return self._runs_get(u, q)
            if u.path == "/openapi.json":
                if not self._token_ok():
                    return self._json({"error": "bad token"}, 401)
                return self._json(app.openapi())
            if u.path in ("/", "/index.html"):
                body = UI.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif u.path == "/api/status":
                self._json(app.status())
            elif u.path == "/api/history":
                self._json(list(app.hub.history))
            elif u.path == "/api/audit":
                ok, n, msg = app.audit.verify()
                self._json({"ok": ok, "entries": n, "message": msg, "tail": app.audit.tail(60)})
            elif u.path == "/api/mission":
                from .mission import Mission
                try:
                    self._json(Mission.load(app.cfg.state_dir, q.get("id", [""])[0]).d)
                except (OSError, json.JSONDecodeError):
                    self._json({"error": "not found"}, 404)
            elif u.path == "/api/file":
                self._file(q.get("path", [""])[0])
            elif u.path == "/api/events":
                self._sse()
            else:
                self._json({"error": "not found"}, 404)

        def _file(self, path: str):
            try:
                p = app.guard.resolve(path)
            except Exception:
                return self._json({"error": "bad path"}, 400)
            if not app.guard._root_for(p) or app.guard._protected(p) or not p.is_file():
                return self._json({"error": "not available"}, 404)
            data = p.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(p.name)[0] or "application/octet-stream")
            self.send_header("Content-Disposition", f"inline; filename*=UTF-8''{urllib.parse.quote(p.name)}")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _sse(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            q = app.hub.subscribe()
            try:
                last_ping = time.time()
                while True:
                    app.hub.wait(q, 15)
                    while q:
                        ev = q.popleft()
                        self.wfile.write(f"data: {json.dumps(ev, ensure_ascii=False, default=str)}\n\n".encode("utf-8"))
                    if time.time() - last_ping > 14:
                        self.wfile.write(b": ping\n\n")
                        last_ping = time.time()
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                pass
            finally:
                app.hub.unsubscribe(q)

        def do_POST(self):
            if not self._same_origin():
                return self._json({"error": "forbidden"}, 403)
            u = urllib.parse.urlparse(self.path)
            b = self._body()
            if u.path == "/api/runs" or u.path.startswith("/api/runs/"):
                return self._runs_post(u, b)
            if u.path == "/api/backup":  # browser-side config backups (e.g. Open WebUI before Kestrel changes it)
                if (b.get("token") or "") != app.api_token:
                    return self._json({"error": "bad token"}, 401)
                import re as _re
                import time as _time
                name = _re.sub(r"[^A-Za-z0-9_.-]", "_", str(b.get("name") or "backup"))[:60]
                out = app.cfg.state_dir / "backups" / f"{_time.strftime('%Y%m%d-%H%M%S')}-{name}.json"
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_text(str(b.get("data") or ""), encoding="utf-8")
                app.audit.record("backup.saved", path=str(out), bytes=len(str(b.get("data") or "")))
                return self._json({"ok": True, "path": str(out)})
            if u.path.startswith("/tools/"):
                if not self._token_ok():
                    return self._json({"error": "bad token"}, 401)
                out, ok = app.tool_call(u.path[len("/tools/"):], b)
                return self._json({"ok": ok, "result": out})
            if u.path == "/api/chat":
                text = (b.get("text") or "").strip()
                if not text:
                    return self._json({"ok": False, "error": "empty"})
                if text.startswith("/mission "):
                    return self._mission_start(text[9:].strip())
                ok = app.send(text)
                self._json({"ok": ok, "error": None if ok else "busy: wait for the current answer or press Stop"})
            elif u.path == "/api/new":
                app.new_chat()
                self._json({"ok": True})
            elif u.path == "/api/approve":
                self._json({"ok": app.decide(b.get("id", ""), b.get("decision", "deny"))})
            elif u.path == "/api/stop":
                app.stop_all()
                self._json({"ok": True})
            elif u.path == "/api/mission/start":
                self._mission_start((b.get("goal") or "").strip())
            elif u.path == "/api/mission/resume":
                try:
                    m = app.missions.resume(b.get("id", ""))
                    self._json({"ok": True, "id": m.d["id"]})
                except Exception as e:
                    self._json({"ok": False, "error": str(e)})
            elif u.path == "/api/settings":
                self._settings(b)
            elif u.path == "/api/roots":
                self._roots(b)
            else:
                self._json({"error": "not found"}, 404)

        def _mission_start(self, goal: str):
            if not goal:
                return self._json({"ok": False, "error": "empty goal"})
            try:
                m = app.missions.start(goal)
                self._json({"ok": True, "id": m.d["id"]})
            except RuntimeError as e:
                self._json({"ok": False, "error": str(e)})

        def _settings(self, b: dict):
            c = app.cfg.data
            ap = b.get("approvals") or {}
            for k in ("write", "command", "new_folder_access"):
                if ap.get(k) in ("ask", "auto"):
                    c["approvals"][k] = ap[k]
            on = b.get("online") or {}
            for k in ("enabled", "allow_web_fetch"):
                if k in on:
                    c["online"][k] = bool(on[k])
            for k in ("backend", "model", "base_url", "api_key_env"):
                if k in on and isinstance(on[k], str):
                    c["online"][k] = on[k].strip()
            if "think_when_acting" in b:
                c["think_when_acting"] = bool(b["think_when_acting"])
            app.cfg.save()
            app.audit.record("settings", approvals=c["approvals"], online={k: c["online"][k] for k in ("enabled", "backend", "model")})
            self._json({"ok": True})

        def _roots(self, b: dict):
            path, mode, action = (b.get("path") or "").strip(), b.get("mode", "read"), b.get("action", "add")
            roots = app.cfg.data.setdefault("roots", [])
            if action == "remove":
                app.cfg.data["roots"] = [r for r in roots if r["path"] != path]
            else:
                p = Path(path)
                if not p.is_dir():
                    return self._json({"ok": False, "error": "folder does not exist"})
                app.cfg.data["roots"] = [r for r in roots if r["path"] != str(p)] + [{"path": str(p), "mode": "write" if mode == "write" else "read"}]
            app.cfg.save()
            app.audit.record("roots", action=action, path=path, mode=mode)
            self._json({"ok": True, "roots": app.guard.roots()})

    return H


def serve(port: int | None = None, open_browser: bool = True):
    app = App()
    port = port or int(app.cfg["ui_port"])
    class LocalServer(ThreadingHTTPServer):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            allow_reuse_address = False

        def server_bind(self):
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            super().server_bind()

    srv = LocalServer(("127.0.0.1", port), make_handler(app))
    srv.daemon_threads = True
    url = f"http://127.0.0.1:{port}/"
    print(f"Kestrel is running at {url}  (Ctrl+C to stop)")
    print(f"Workspace: {app.guard.workspace}")
    inst = app.router.installed()
    print("Ollama:", "connected, " + str(len(inst)) + " models" if inst else "NOT reachable - start Ollama first")
    if open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
        app.stop_all()
        srv.shutdown()
