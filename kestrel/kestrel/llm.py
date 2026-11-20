"""Model backends behind one interface.

Internal message format (Ollama-style):
  {"role": "system"|"user"|"assistant"|"tool", "content": str,
   "tool_calls": [{"function": {"name": str, "arguments": dict}}],   # assistant only
   "tool_name": str}                                                 # tool only

Backends: local Ollama (also serves Ollama cloud models), Anthropic, any
OpenAI-compatible endpoint. All use urllib only.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Callable

OnToken = Callable[[str, str], None]  # (kind, text) kind: "content" | "thinking"

import threading as _threading
tls = _threading.local()  # tls.exclusive = False: don't unload other models (e.g. Open WebUI's model is waiting on our tool)


class LLMError(Exception):
    pass


@dataclass
class Reply:
    content: str = ""
    thinking: str = ""
    tool_calls: list = field(default_factory=list)
    prompt_tokens: int = 0
    output_tokens: int = 0
    seconds: float = 0.0
    model: str = ""


def _post(url: str, body: dict, headers: dict | None = None, timeout: float = 1800, stream: bool = False):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:800]
        raise LLMError(f"HTTP {e.code} from {url}: {detail}") from None
    except urllib.error.URLError as e:
        raise LLMError(f"cannot reach {url}: {e.reason}") from None


# ---------------------------------------------------------------------------
# Fallback: small models sometimes print a tool call as text instead of using
# the native channel. Recover it rather than failing the step.
_TC_TAG = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.S)
_FENCE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.S)


def recover_tool_calls(text: str, tool_names: set[str]) -> list:
    found = []
    for rx in (_TC_TAG, _FENCE):
        for m in rx.finditer(text or ""):
            try:
                obj = json.loads(m.group(1))
            except json.JSONDecodeError:
                continue
            name = obj.get("name") or obj.get("tool") or obj.get("function")
            args = obj.get("arguments") or obj.get("args") or obj.get("parameters") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = {}
            if name in tool_names and isinstance(args, dict):
                found.append({"function": {"name": name, "arguments": args}})
        if found:
            break
    return found


# ---------------------------------------------------------------------------
class OllamaBackend:
    def __init__(self, url: str, keep_alive: str = "30m"):
        self.url = url.rstrip("/")
        self.keep_alive = keep_alive

    def loaded(self) -> list[str]:
        try:
            with urllib.request.urlopen(self.url + "/api/ps", timeout=3) as r:
                return [m["name"] for m in json.load(r).get("models", [])]
        except Exception:
            return []

    def unload(self, model: str) -> None:
        try:
            _post(self.url + "/api/generate", {"model": model, "keep_alive": 0}, timeout=15).close()
        except LLMError:
            pass

    def make_exclusive(self, model: str) -> list[str]:
        """Unload every other resident model before using `model`. Returns what was unloaded."""
        others = [m for m in self.loaded() if m != model and m.split(":")[0] != model.split(":")[0]]
        for m in others:
            self.unload(m)
        return others

    def list_models(self) -> list[str]:
        try:
            with urllib.request.urlopen(self.url + "/api/tags", timeout=3) as r:
                return [m["name"] for m in json.load(r).get("models", [])]
        except Exception:
            return []

    def chat(self, model: str, messages: list, tools: list | None = None, *, think: bool = False,
             options: dict | None = None, on_token: OnToken | None = None, fmt=None) -> Reply:
        body = {"model": model, "messages": messages, "stream": True, "keep_alive": self.keep_alive,
                "think": bool(think)}
        if tools:
            body["tools"] = tools
        if options:
            body["options"] = options
        if fmt is not None:
            body["format"] = fmt
        t0 = time.time()
        rep = Reply(model=model)
        resp = _post(self.url + "/api/chat", body, stream=True)
        with resp:
            for raw in resp:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    ev = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if ev.get("error"):
                    raise LLMError(ev["error"])
                msg = ev.get("message") or {}
                if msg.get("thinking"):
                    rep.thinking += msg["thinking"]
                    if on_token:
                        on_token("thinking", msg["thinking"])
                if msg.get("content"):
                    rep.content += msg["content"]
                    if on_token:
                        on_token("content", msg["content"])
                for tc in msg.get("tool_calls") or []:
                    rep.tool_calls.append(tc)
                if ev.get("done"):
                    rep.prompt_tokens = ev.get("prompt_eval_count", 0)
                    rep.output_tokens = ev.get("eval_count", 0)
        rep.seconds = time.time() - t0
        return rep


# ---------------------------------------------------------------------------
def _json_args(a):
    if isinstance(a, dict):
        return a
    try:
        return json.loads(a or "{}")
    except json.JSONDecodeError:
        return {}


class OpenAICompatBackend:
    """Any /v1/chat/completions endpoint (OpenRouter, Groq, DeepSeek, GLM, LM Studio...)."""

    def __init__(self, base_url: str, api_key: str):
        self.base = base_url.rstrip("/")
        self.key = api_key

    def chat(self, model, messages, tools=None, *, think=False, options=None, on_token=None, fmt=None) -> Reply:
        msgs = []
        for i, m in enumerate(messages):
            if m["role"] == "tool":
                msgs.append({"role": "tool", "tool_call_id": m.get("tool_call_id") or f"c{i}", "content": m["content"]})
            elif m["role"] == "assistant" and m.get("tool_calls"):
                msgs.append({"role": "assistant", "content": m.get("content") or None, "tool_calls": [
                    {"id": tc.get("id") or f"c{i}_{j}", "type": "function",
                     "function": {"name": tc["function"]["name"],
                                  "arguments": json.dumps(tc["function"]["arguments"])}}
                    for j, tc in enumerate(m["tool_calls"])]})
            else:
                msgs.append({"role": m["role"], "content": m["content"]})
        body = {"model": model, "messages": msgs}
        if tools:
            body["tools"] = tools
        t0 = time.time()
        with _post(self.base + "/chat/completions", body, {"Authorization": f"Bearer {self.key}"}) as r:
            data = json.load(r)
        ch = data["choices"][0]["message"]
        rep = Reply(content=ch.get("content") or "", model=model, seconds=time.time() - t0)
        for tc in ch.get("tool_calls") or []:
            rep.tool_calls.append({"id": tc.get("id"), "function": {
                "name": tc["function"]["name"], "arguments": _json_args(tc["function"].get("arguments"))}})
        u = data.get("usage") or {}
        rep.prompt_tokens, rep.output_tokens = u.get("prompt_tokens", 0), u.get("completion_tokens", 0)
        if on_token and rep.content:
            on_token("content", rep.content)
        return rep


class AnthropicBackend:
    def __init__(self, api_key: str, base_url: str = "https://api.anthropic.com"):
        self.key = api_key
        self.base = base_url.rstrip("/") or "https://api.anthropic.com"

    def chat(self, model, messages, tools=None, *, think=False, options=None, on_token=None, fmt=None) -> Reply:
        system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
        out: list = []
        for i, m in enumerate(messages):
            if m["role"] == "system":
                continue
            if m["role"] == "tool":
                block = {"type": "tool_result", "tool_use_id": m.get("tool_call_id") or f"t{i}", "content": m["content"]}
                if out and out[-1]["role"] == "user" and isinstance(out[-1]["content"], list):
                    out[-1]["content"].append(block)
                else:
                    out.append({"role": "user", "content": [block]})
            elif m["role"] == "assistant" and m.get("tool_calls"):
                blocks = [{"type": "text", "text": m["content"]}] if m.get("content") else []
                for j, tc in enumerate(m["tool_calls"]):
                    blocks.append({"type": "tool_use", "id": tc.get("id") or f"t{i}_{j}",
                                   "name": tc["function"]["name"], "input": tc["function"]["arguments"]})
                out.append({"role": "assistant", "content": blocks})
            else:
                out.append({"role": m["role"], "content": m["content"] or "(empty)"})
        body = {"model": model, "max_tokens": 8192, "system": system, "messages": out}
        if tools:
            body["tools"] = [{"name": t["function"]["name"], "description": t["function"]["description"],
                              "input_schema": t["function"]["parameters"]} for t in tools]
        t0 = time.time()
        with _post(self.base + "/v1/messages", body,
                   {"x-api-key": self.key, "anthropic-version": "2023-06-01"}) as r:
            data = json.load(r)
        rep = Reply(model=model, seconds=time.time() - t0)
        for b in data.get("content", []):
            if b["type"] == "text":
                rep.content += b["text"]
            elif b["type"] == "tool_use":
                rep.tool_calls.append({"id": b["id"], "function": {"name": b["name"], "arguments": b["input"]}})
        u = data.get("usage") or {}
        rep.prompt_tokens, rep.output_tokens = u.get("input_tokens", 0), u.get("output_tokens", 0)
        if on_token and rep.content:
            on_token("content", rep.content)
        return rep


# ---------------------------------------------------------------------------
class MyChatBackend(OpenAICompatBackend):
    """Kestrel's cloud brain: the MyChat gateway on this PC (http://127.0.0.1:11500/v1). It routes each call to the
    measured-best cloud model with failover. Streams, so the loop guard and the stop button keep working.
    Used only where the person allowed it (see cloud_allowed); every error falls back to the local model."""

    def __init__(self, base_url: str = "http://127.0.0.1:11500/v1", token: str = ""):
        super().__init__(base_url, token or _mychat_token())

    def chat(self, model, messages, tools=None, *, think=False, options=None, on_token=None, fmt=None) -> Reply:
        if tools:  # tool-calling agents stay on the local path; the build engine never sends tools
            return super().chat(model, messages, tools, think=think, options=options, on_token=on_token, fmt=fmt)
        if not self.key:
            raise LLMError("MyChat gateway key not found (is MyChat installed?)")
        msgs = [{"role": m["role"] if m["role"] != "tool" else "user", "content": m.get("content") or ""} for m in messages]
        o = options or {}
        body = {"model": model, "messages": msgs, "stream": True}
        if "temperature" in o:
            body["temperature"] = o["temperature"]
        # No max_tokens: the local caps were tuned for a 4-tok/s CPU, and on reasoning models (GPT-OSS) the hidden
        # reasoning counts toward the cap - measured 2026-11-20: test lists came back cut off. The loop guard, the stop
        # button and the gateway's stall timeout bound runaway answers instead.
        if fmt is not None:
            body["response_format"] = {"type": "json_object"}
            if isinstance(fmt, dict):  # keep the schema in view: json_object mode does not enforce it
                msgs.append({"role": "system", "content": "Reply with JSON only, matching this schema: " + json.dumps(fmt)[:3000]})
        t0 = time.time()
        rep = Reply(model=model)
        with _post(self.base + "/chat/completions", body, {"Authorization": f"Bearer {self.key}"}, timeout=600) as r:
            buf = b""
            for chunk in iter(lambda: r.read(1024), b""):
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.strip()
                    if not line.startswith(b"data: ") or line == b"data: [DONE]":
                        continue
                    try:
                        d = json.loads(line[6:])
                    except ValueError:
                        continue
                    if d.get("error"):
                        raise LLMError(str(d["error"])[:300])
                    delta = (d.get("choices") or [{}])[0].get("delta") or {}
                    txt = delta.get("content") or ""
                    if txt:
                        rep.content += txt
                        if on_token:
                            on_token("content", txt)   # the loop guard / stop button act mid-stream
                    if d.get("model") and d["model"] != model:
                        rep.model = d["model"]
                    u = d.get("usage") or {}
                    if u:
                        rep.prompt_tokens, rep.output_tokens = u.get("prompt_tokens", 0), u.get("completion_tokens", 0)
        if not rep.content.strip():
            raise LLMError("MyChat gateway returned an empty answer")
        if rep.content.lstrip().startswith("**Gateway:**"):
            raise LLMError(rep.content.strip()[:300])
        rep.output_tokens = rep.output_tokens or len(rep.content) // 4
        rep.seconds = time.time() - t0
        return rep


def _mychat_token() -> str:
    home = os.environ.get("MYCHAT_HOME") or os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~/.config"), "MyChat")
    try:
        with open(os.path.join(home, "token"), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def cloud_allowed(cfg, path: str | None) -> bool:
    """The person's rule: cloud models for builds in allowed folders, local models for anything private.
    No path (a fresh build in Kestrel's own build folder) counts as Kestrel's workspace."""
    on = cfg.get("online", {})
    if not (on.get("enabled") and on.get("backend") == "mychat"):
        return False
    brain = cfg.get("brain", {})
    from pathlib import Path as _P
    p = _P(path).resolve() if path else _P(cfg.get("workspace") or ".").resolve()
    def under(root):
        try:
            p.relative_to(_P(root).resolve())
            return True
        except (ValueError, OSError):
            return False
    if any(under(r) for r in brain.get("private_roots", [])):
        return False
    roots = brain.get("cloud_roots") or [cfg.get("workspace") or "."]
    return any(under(r) for r in roots)


class Router:
    """Picks backend + model per role. Offline unless the user enabled online."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.local = OllamaBackend(cfg["ollama_url"], cfg["keep_alive"])
        self._installed: list[str] | None = None

    def installed(self) -> list[str]:
        if self._installed is None:
            self._installed = self.local.list_models()
        return self._installed

    def refresh(self):
        self._installed = None

    def is_online(self, role: str) -> bool:
        return self.pick(role)[2]

    def local_model(self, role: str) -> str:
        want = self.cfg["models"][role]
        inst = self.installed()
        if not inst or any(n == want or n.split(":")[0] == want for n in inst):
            return want
        return self.cfg["fallback_models"][role]

    def pick(self, role: str):
        on = self.cfg["online"]
        if on.get("enabled") and on.get("backend") == "mychat":
            # only inside a task that set tls.cloud_ok (the build engine, for a folder the person allowed)
            if getattr(tls, "cloud_ok", False) and role in on.get("use_for", []):
                model = (on.get("models") or {}).get(role) or on.get("model") or "mychat/auto"
                return MyChatBackend(on.get("base_url") or "http://127.0.0.1:11500/v1"), model, True
            return self.local, self.local_model(role), False
        if on.get("enabled") and role in on.get("use_for", []) and on.get("model"):
            key = os.environ.get(on.get("api_key_env") or "", "")
            b = on.get("backend")
            if b == "ollama-cloud":
                return self.local, on["model"], True
            if b == "anthropic" and key:
                return AnthropicBackend(key, on.get("base_url") or ""), on["model"], True
            if b == "openai-compatible" and key and on.get("base_url"):
                return OpenAICompatBackend(on["base_url"], key), on["model"], True
        return self.local, self.local_model(role), False

    def options(self, online: bool, role: str = "agent") -> dict | None:
        if online:
            return None
        if role == "coder":  # deterministic, short structured answers
            return {"num_ctx": 8192, "temperature": 0, "top_k": 20, "presence_penalty": 0,
                    "repeat_penalty": 1.0, "num_predict": 768, "num_thread": 4, "num_gpu": 0}
        return {"num_ctx": int(self.cfg["num_ctx"])}

    def chat(self, role: str, messages: list, tools=None, *, think=False, on_token=None, fmt=None,
             options: dict | None = None) -> Reply:
        backend, model, online = self.pick(role)
        opts = self.options(online, role)
        if options and not online:
            opts = {**(opts or {}), **options}
        elif options and online:
            opts = {k: v for k, v in options.items() if k in ("temperature", "num_predict")}
        if not online and self.cfg.get("one_model_at_a_time", True) and getattr(tls, "exclusive", True):
            backend.make_exclusive(model)  # cheap (/api/ps); also catches models the gateway loaded meanwhile
        try:
            return backend.chat(model, messages, tools, think=think, options=opts,
                                on_token=on_token, fmt=fmt)
        except LLMError as e:
            if online:  # offline fallback keeps the agent working without internet
                self.last_fallback = str(e)[:200]
                backend, model = self.local, self.local_model(role)
                return backend.chat(model, messages, tools, think=think, options={**(self.options(False, role) or {}), **(options or {})},
                                    on_token=on_token, fmt=fmt)
            raise
