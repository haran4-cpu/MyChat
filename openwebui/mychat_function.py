"""
title: MyChat
author: MyChat (multi-model gateway)
version: 1.1.0
required_open_webui_version: 0.6.0
description: MyChat inside Open WebUI. Cloud and local models combined per task (Auto, Max, Consensus, Verified/Truth Engine, Fast, Private). Starts the MyChat gateway on this PC by itself; accounts and keys are managed from the "MyChat · Accounts" model without leaving Open WebUI.
"""

import asyncio
import json
import os
import re
import shutil
import subprocess
import time
import urllib.parse
from pathlib import Path
from typing import AsyncGenerator, Optional

import httpx
from pydantic import BaseModel, Field

MODELS = [
    ("auto", "MyChat Auto (best model per task)"),
    ("max", "MyChat Max (draft · cross-family review · revise)"),
    ("verified", "MyChat Verified (Truth Engine: checks facts)"),
    ("consensus", "MyChat Consensus (3 model families)"),
    ("fast", "MyChat Fast"),
    ("private", "MyChat Private (this PC only)"),
    ("accounts", "MyChat · Accounts & keys"),
]

# Shapes of real API keys. A message made only of such tokens is treated as "connect this key", never sent to a model.
KEY_RX = re.compile(r"\b(AIza[\w-]{30,}|nvapi-[\w-]{20,}|gsk_\w{20,}|sk-or-[\w-]{20,}|sk-ant-[\w-]{20,}|hf_\w{20,}|"
                    r"github_pat_\w{20,}|ghp_\w{20,}|csk-\w{20,}|tvly-[\w-]{20,}|jina_\w{20,}|BSA[\w-]{20,}|sk-[\w-]{32,})\b")
ONLY_TOKENS = re.compile(r"^\s*([A-Za-z0-9._-]{24,120}\s*)+$")


class Pipe:
    class Valves(BaseModel):
        MYCHAT_DIR: str = Field(default=r"C:\AI-Workspace\MyChat", description="Folder with pc\\server.mjs")
        MYCHAT_URL: str = Field(default="http://127.0.0.1:11500", description="Where the gateway listens")
        NODE_PATH: str = Field(default="", description="node.exe (empty = find it automatically)")
        AUTO_START: bool = Field(default=True, description="Start the gateway automatically when it is not running")
        OPEN_WEBUI_URL: str = Field(default="http://127.0.0.1:8080", description="Where to come back after signing in")

    def __init__(self):
        self.type = "manifold"
        self.valves = self.Valves()
        self._start_lock = asyncio.Lock()

    def pipes(self):
        return [{"id": i, "name": n} for i, n in MODELS]

    # ---------------------------------------------------------------- gateway lifecycle
    @staticmethod
    def _home() -> Path:
        if os.environ.get("MYCHAT_HOME"):
            return Path(os.environ["MYCHAT_HOME"])
        base = os.environ.get("APPDATA") or str(Path.home() / ".config")
        return Path(base) / "MyChat"

    def _token(self) -> str:
        try:
            return (self._home() / "token").read_text(encoding="utf-8").strip()
        except OSError:
            return ""

    def _node(self) -> str:
        for c in [self.valves.NODE_PATH, r"C:\Program Files\nodejs\node.exe", shutil.which("node") or ""]:
            if c and Path(c).exists():
                return c
        return ""

    async def _health(self, client: httpx.AsyncClient) -> Optional[dict]:
        try:
            r = await client.get(self.valves.MYCHAT_URL.rstrip("/") + "/health", timeout=1.5)
            return r.json() if r.status_code == 200 else None
        except Exception:
            return None

    async def _healthy(self, client: httpx.AsyncClient) -> bool:
        return (await self._health(client)) is not None

    def _code_mtime(self) -> float:
        d = Path(self.valves.MYCHAT_DIR)
        files = list((d / "core").glob("*.mjs")) + [d / "pc" / "server.mjs"]
        return max((f.stat().st_mtime for f in files if f.exists()), default=0)

    @staticmethod
    def _kill_port_owner(port: int) -> bool:
        """Old gateways have no shutdown endpoint: stop the node.exe that listens on our port (and nothing else)."""
        if os.name != "nt":
            return False
        try:
            out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True, timeout=10).stdout
            pids = {l.split()[-1] for l in out.splitlines() if f"127.0.0.1:{port} " in l and "LISTENING" in l}
            done = False
            for pid in pids:
                img = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"], capture_output=True, text=True, timeout=10).stdout
                if img.lower().startswith('"node.exe"'):
                    subprocess.run(["taskkill", "/PID", pid, "/F"], capture_output=True, timeout=10)
                    done = True
            return done
        except Exception:
            return False

    async def _reload_if_updated(self, client, h: dict, emitter) -> None:
        """When the MyChat files on disk are newer than the running gateway, restart it so updates apply by themselves."""
        started = (h.get("startedAt") or 0) / 1000
        if started and self._code_mtime() <= started + 1:
            return
        await self._status(emitter, "MyChat was updated — reloading the gateway…")
        token = self._token()
        try:
            await client.post(self.valves.MYCHAT_URL.rstrip("/") + "/admin/shutdown", headers={"Authorization": "Bearer " + token}, timeout=5)
        except Exception:
            pass
        for _ in range(12):
            await asyncio.sleep(0.25)
            if not await self._healthy(client):
                return
        port = urllib.parse.urlparse(self.valves.MYCHAT_URL).port or 11500
        await asyncio.to_thread(self._kill_port_owner, port)
        for _ in range(12):
            await asyncio.sleep(0.25)
            if not await self._healthy(client):
                return

    async def _ensure(self, client: httpx.AsyncClient, emitter=None) -> str:
        """Returns "" when the gateway is up, otherwise a message for the person."""
        h = await self._health(client)
        if h is not None:
            await self._reload_if_updated(client, h, emitter)
        if await self._healthy(client):
            return ""
        if not self.valves.AUTO_START:
            return "The MyChat gateway is not running (automatic start is off in this function's settings)."
        async with self._start_lock:
            if await self._healthy(client):
                return ""
            server = Path(self.valves.MYCHAT_DIR) / "pc" / "server.mjs"
            node = self._node()
            if not server.exists():
                return f"MyChat is not installed at `{server}` (change MYCHAT_DIR in this function's settings)."
            if not node:
                return "Node.js was not found. Install it from https://nodejs.org or set NODE_PATH in this function's settings."
            await self._status(emitter, "Starting the MyChat gateway…")
            home = self._home()
            home.mkdir(parents=True, exist_ok=True)
            log = open(home / "gateway-console.log", "ab")
            flags = 0
            if os.name == "nt":  # no console window; keeps running if Open WebUI restarts
                flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
            subprocess.Popen([node, str(server)], cwd=str(server.parent.parent), stdin=subprocess.DEVNULL,
                             stdout=log, stderr=log, creationflags=flags, close_fds=True)
            for _ in range(40):
                await asyncio.sleep(0.25)
                if await self._healthy(client):
                    return ""
            return f"The MyChat gateway did not start. Its log is `{home / 'gateway-console.log'}`."

    async def _status(self, emitter, text: str, done: bool = False):
        if emitter:
            await emitter({"type": "status", "data": {"description": text, "done": done}})

    # ---------------------------------------------------------------- accounts
    async def _paste(self, client, token: str, text: str) -> str:
        r = await client.post(self.valves.MYCHAT_URL.rstrip("/") + "/connections/paste", json={"text": text},
                              headers={"X-MyChat-Token": token}, timeout=60)
        res = (r.json() or {}).get("results") or []
        if not res:
            return "✗ That was not recognised as an API key, so nothing was saved and nothing was sent to any model."
        lines = []
        for x in res:
            if x.get("ok"):
                lines.append(f"✓ **{x.get('name')}** connected — {x.get('models', 0)} models")
            else:
                lines.append(f"✗ **{x.get('name')}** — {x.get('error', 'the key was rejected')}")
        return "\n".join(lines)

    async def _accounts(self, client, token: str, __event_call__) -> str:
        base = self.valves.MYCHAT_URL.rstrip("/")
        st = (await client.get(base + "/status", headers={"Authorization": "Bearer " + token}, timeout=20)).json()
        prov = st.get("providers") or {}
        back = urllib.parse.quote(self.valves.OPEN_WEBUI_URL)
        signin = f"{base}/oauth/openrouter/start?t={urllib.parse.quote(token)}&back={back}"
        out = ["### MyChat · Accounts",
               f"**[Sign in with Google → OpenRouter]({signin})** — one sign-in opens Claude, GPT, Gemini, GLM, Kimi, DeepSeek and more "
               "(it opens in a new tab and brings you back here).", "",
               "| Provider | State | Models | Free tier / key |", "|---|---|---|---|"]
        order = ["openrouter", "gemini", "nvidia", "groq", "anthropic", "mistral", "huggingface", "zai", "cerebras", "sambanova", "github", "ollama"]
        for pid in order + [p for p in prov if p not in order]:
            p = prov.get(pid)
            if not p or (p.get("keyless") and pid != "ollama"):
                continue
            if p.get("disabled"):
                state = "✗ " + str(p["disabled"])[:60]
            elif p.get("hasKey") or pid == "ollama":
                state = "✓ connected" if p.get("models") else "connected (no models yet)"
            else:
                state = "—"
            link = f"[get key]({p['keyUrl']})" if p.get("keyUrl") else ""
            out.append(f"| {p.get('name', pid)} | {state} | {p.get('models') or ''} | {(p.get('free') or '')[:90]} {link} |")
        out += ["", "To add a key: answer the dialog that opens now, or paste the key as a message in this chat. "
                "Keys are checked live and stored only on this PC."]
        msg = "\n".join(out)
        if __event_call__:
            try:
                val = await __event_call__({"type": "input", "data": {
                    "title": "Add API keys to MyChat",
                    "message": "Paste one or more keys (Gemini, NVIDIA, Groq, OpenRouter, Anthropic, Hugging Face, Mistral, Brave, Tavily…). "
                               "The provider is detected automatically. Cancel to skip.",
                    "placeholder": "AIza… · nvapi-… · gsk_… · sk-or-… · sk-ant-… · hf_…"}})
                if isinstance(val, str) and val.strip():
                    msg += "\n\n" + await self._paste(client, token, val)
            except Exception:
                pass
        return msg

    # ---------------------------------------------------------------- chat
    async def pipe(self, body: dict, __user__: Optional[dict] = None, __event_emitter__=None,
                   __event_call__=None, __metadata__: Optional[dict] = None) -> AsyncGenerator[str, None]:
        model = str(body.get("model", "")).split(".", 1)[-1]
        msgs = body.get("messages") or []
        last = next((m.get("content") for m in reversed(msgs) if m.get("role") == "user"), "") or ""
        if isinstance(last, list):
            last = " ".join(p.get("text", "") for p in last if isinstance(p, dict))
        async with httpx.AsyncClient(timeout=None) as client:
            err = await self._ensure(client, __event_emitter__)
            if err:
                await self._status(__event_emitter__, "MyChat gateway unavailable", True)
                yield err
                return
            token = self._token()
            if not token:
                yield f"The gateway is running but its key file was not found in `{self._home()}`."
                return
            # a message that is only API keys connects them; it is never forwarded to a model
            if KEY_RX.search(last) and ONLY_TOKENS.match(last) or (model == "accounts" and ONLY_TOKENS.match(last)):
                yield await self._paste(client, token, last)
                return
            if model == "accounts" or last.strip().lower() in ("/keys", "/accounts", "/connect"):
                yield await self._accounts(client, token, __event_call__)
                return

            req = {"model": "mychat/" + model, "messages": msgs, "stream": True}
            for k in ("temperature", "top_p", "max_tokens"):
                if body.get(k) is not None:
                    req[k] = body[k]
            await self._status(__event_emitter__, "Choosing models…")
            last_status, started = "", time.time()
            try:
                async with client.stream("POST", self.valves.MYCHAT_URL.rstrip("/") + "/v1/chat/completions", json=req,
                                         headers={"Authorization": "Bearer " + token}) as r:
                    if r.status_code != 200:
                        txt = (await r.aread()).decode("utf-8", "replace")
                        try:
                            txt = json.loads(txt)["error"]["message"]
                        except Exception:
                            pass
                        yield f"**MyChat:** {txt}\n\nOpen **MyChat · Accounts & keys** in the model list to connect providers."
                        return
                    buf, said = "", ""
                    async for chunk in r.aiter_text():
                        buf += chunk
                        while "\n" in buf:
                            line, buf = buf.split("\n", 1)
                            if not line.startswith("data: ") or line.strip() == "data: [DONE]":
                                continue
                            try:
                                d = json.loads(line[6:])["choices"][0]["delta"]
                            except Exception:
                                continue
                            rc = d.get("reasoning_content")
                            if rc:  # team progress from the gateway: show it as the live status line
                                for s in rc.strip().splitlines():
                                    s = s.strip("•- *").strip()
                                    if s and s != last_status:
                                        last_status = s
                                        await self._status(__event_emitter__, s[:160])
                            if d.get("content"):
                                said += d["content"]
                                yield d["content"]
                    if "All models failed" in said[:300] or "no model" in said[:300].lower():
                        yield ("\n\nNo cloud provider is connected yet. Pick **MyChat · Accounts & keys** in the model list: "
                               "sign in with Google (OpenRouter) or paste a key, then ask again.")
            except httpx.HTTPError as e:
                yield f"\n\n**MyChat:** connection to the gateway failed ({e})."
            await self._status(__event_emitter__, (last_status[:100] + " · " if last_status else "") +
                               f"{time.time() - started:.0f}s", True)
