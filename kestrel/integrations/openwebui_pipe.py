"""
title: Kestrel
author: Kestrel (local engineering agent)
version: 1.3.0
required_open_webui_version: 0.6.0
description: Kestrel inside Open WebUI - agent loop, approved-folder file work, documents, long missions, deterministic checks and an audit log, all running on your PC. Approvals appear as native Open WebUI confirmation dialogs.
"""

import html
import json
import urllib.parse
from typing import AsyncGenerator, Optional

import httpx
from pydantic import BaseModel, Field


class Pipe:
    class Valves(BaseModel):
        KESTREL_URL: str = Field(default="http://127.0.0.1:8765", description="Where Kestrel runs (start.bat).")
        KESTREL_TOKEN: str = Field(default="__KESTREL_TOKEN__", description="state/api_token in the Kestrel folder.")
        SHOW_MODEL_STATS: bool = Field(default=True, description="Show model speed in the status line.")

    def __init__(self):
        self.type = "manifold"
        self.valves = self.Valves()

    def pipes(self):
        return [{"id": "kestrel-max", "name": "Kestrel Max (plans, runs and verifies)"},
                {"id": "kestrel", "name": "Kestrel"}, {"id": "kestrel-mission", "name": "Kestrel Mission (long task)"}]

    # ------------------------------------------------------------------
    @staticmethod
    def _card(name: str, args: dict, result: str, ok: bool) -> str:
        a = html.escape(json.dumps(args, ensure_ascii=False))
        r = html.escape(json.dumps(result, ensure_ascii=False))
        return (f'\n<details type="tool_calls" done="true" id="k{abs(hash((name, a, r))) % 10**9}" '
                f'name="{html.escape(name)}" arguments="{a}" result="{r}">\n'
                f'<summary>{"✓" if ok else "✗"} {html.escape(name)}</summary>\n{html.escape(result)}\n</details>\n')

    def _file_link(self, path: str) -> str:
        name = path.replace("\\", "/").rsplit("/", 1)[-1]
        return f"[{name}]({self.valves.KESTREL_URL}/api/file?path={urllib.parse.quote(path)})"

    @staticmethod
    async def _full_history(chat_id: str, sent: list) -> list:
        """Open WebUI trims the history it hands to a pipe. Read the whole branch from its own chat store instead,
        so follow-ups like "it doesn't work" still see the earlier build. Falls back to what was sent."""
        if not chat_id or chat_id.startswith("local:"):
            return []
        try:
            from open_webui.models.chats import Chats
            chat = Chats.get_chat_by_id(chat_id)
            if hasattr(chat, "__await__"):  # newer Open WebUI versions made the store async
                chat = await chat
            hist = ((chat.chat or {}).get("history") or {}) if chat else {}
            nodes, cur = hist.get("messages") or {}, hist.get("currentId")
            chain = []
            while cur and cur in nodes and len(chain) < 400:
                chain.append(nodes[cur])
                cur = nodes[cur].get("parentId")
            chain.reverse()
            out = [{"role": m.get("role"), "content": m.get("content") or ""} for m in chain
                   if m.get("role") in ("user", "assistant") and (m.get("content") or "").strip()]
            # the stored chain ends with the empty placeholder for this reply (dropped above) and must end with the new message
            if not out or not sent or out[-1]["role"] != "user" or out[-1]["content"] != (sent[-1].get("content") or ""):
                return []
            return out
        except Exception:
            return []

    async def _status(self, emitter, text: str, done: bool = False):
        if emitter:
            await emitter({"type": "status", "data": {"description": text, "done": done}})

    # ------------------------------------------------------------------
    async def pipe(self, body: dict, __user__: Optional[dict] = None, __event_emitter__=None,
                   __event_call__=None, __metadata__: Optional[dict] = None) -> AsyncGenerator[str, None]:
        base = self.valves.KESTREL_URL.rstrip("/")
        hdr = {"Authorization": f"Bearer {self.valves.KESTREL_TOKEN}"}
        model_id = str(body.get("model", ""))
        mode = "mission" if model_id.endswith("mission") else "max" if model_id.endswith("max") else "agent"
        chat_id = str((__metadata__ or {}).get("chat_id") or "")
        msgs = [{"role": m.get("role"), "content": m.get("content")} for m in body.get("messages", [])
                if m.get("role") in ("user", "assistant")]
        full = await self._full_history(chat_id, msgs)
        if full:
            msgs = full
        rid = None
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=45.0)) as c:
            try:
                r = await c.post(f"{base}/api/runs", json={"messages": msgs, "chat_id": chat_id, "mode": mode}, headers=hdr)
                if r.status_code == 401:
                    yield "**Kestrel:** the token in this function's Valves does not match Kestrel's `state/api_token`."
                    return
                r.raise_for_status()
                rid = r.json()["id"]
            except httpx.HTTPError as e:
                yield f"**Kestrel is not running** ({e}). Start `C:\\AI-Workspace\\Kestrel\\start.bat` and try again."
                return
            await self._status(__event_emitter__, "Kestrel is working on your PC…")
            after, segment, steps, finished, wrote = 0, "", {}, False, False
            try:
                while not finished:
                    try:
                        r = await c.get(f"{base}/api/runs/{rid}/events", params={"after": after, "wait": 20}, headers=hdr)
                        if r.status_code == 404:
                            yield "\n\n**Kestrel was restarted and this run was lost.** Send the message again."
                            finished = True
                            break
                        events = r.json().get("events", [])
                    except (httpx.HTTPError, ValueError):
                        await self._status(__event_emitter__, "Waiting for Kestrel…")
                        continue
                    for ev in events:
                        after = max(after, ev["seq"])
                        k, d = ev["kind"], ev.get("data") or {}
                        if k == "token" and d.get("kind") == "content":
                            segment += d["text"]
                            yield d["text"]
                        elif k == "tool_call":
                            segment = ""
                            self._last_args = d.get("args", {})
                            await self._status(__event_emitter__, f"Running {d.get('name')}…")
                        elif k == "tool_result":
                            yield self._card(d.get("name", ""), getattr(self, "_last_args", {}), d.get("result", ""), d.get("ok", True))
                            wrote = True
                        elif k == "approval":
                            det = d.get("detail") or {}
                            body_md = d.get("summary", "")
                            if det.get("command"):
                                body_md += f"\n\n```\n{det['command']}\n```"
                            if det.get("preview"):
                                body_md += f"\n\n```\n{det['preview'][:1200]}\n```"
                            ok = False
                            if __event_call__:
                                ok = await __event_call__({"type": "confirmation", "data": {
                                    "title": f"Kestrel asks: {d.get('kind', 'action')}", "message": body_md}})
                            await c.post(f"{base}/api/runs/{rid}/approve", headers=hdr,
                                         json={"approval_id": d.get("id"), "decision": "allow" if ok else "deny"})
                            await self._status(__event_emitter__, "Approved" if ok else "Denied")
                        elif k == "llm" and self.valves.SHOW_MODEL_STATS:
                            tps = (d.get("output_tokens") or 0) / max(d.get("seconds") or 1, 0.1)
                            await self._status(__event_emitter__, f"{d.get('model')}: {d.get('prompt_tokens')} in / "
                                                                  f"{d.get('output_tokens')} out · {d.get('seconds')}s · {tps:.1f} tok/s")
                        elif k == "status":
                            await self._status(__event_emitter__, d.get("text", ""))
                        elif k == "progress":
                            yield f"\n- {d.get('text', '')}"
                            segment, wrote = "", True
                        elif k == "route":
                            names = {"chat": "Quick answer", "agent": "Working on your PC", "build": "Build engine: plan → write → run → repair → review",
                                     "fix": "Fix engine: run your code → find the real cause → repair → re-run"}
                            await self._status(__event_emitter__, names.get(d.get("kind"), ""))
                            if d.get("kind") in ("build", "fix"):
                                yield f"**{names[d['kind']]}** — this takes a while on CPU; every step below is real.\n"
                                wrote = True
                        elif k == "compacted":
                            await self._status(__event_emitter__, "Older history condensed to an outline (exact text recallable)")
                        elif k == "mission":
                            for i, s in enumerate(d.get("steps", []), 1):
                                if steps.get(i) != s["status"] and s["status"] in ("done", "blocked"):
                                    mark = "✓" if s["status"] == "done" else "⚠"
                                    yield f"\n{mark} **Step {i}/{len(d['steps'])}:** {s['title']}\n"
                                steps[i] = s["status"]
                            cur = next((f"Step {i}/{len(d['steps'])}: {s['title']}" for i, s in enumerate(d.get("steps", []), 1)
                                        if s["status"] == "running"), d.get("status", ""))
                            await self._status(__event_emitter__, f"Mission · {cur}")
                        elif k == "answer":
                            text = (d.get("text") or "").strip()
                            if text and text != segment.strip():
                                yield ("\n\n" if (segment or wrote) else "") + text
                            files = ((d.get("finished") or {}).get("files")) or []
                            if files:
                                yield "\n\n**Files:** " + " · ".join(self._file_link(f) for f in files[:20])
                            segment = ""
                        elif k == "error":
                            yield f"\n\n**Kestrel error:** {d.get('message')}"
                        elif k == "run_done":
                            finished = True
                await self._status(__event_emitter__, "Done", True)
            finally:
                if not finished and rid:  # user pressed stop in Open WebUI
                    try:
                        await c.post(f"{base}/api/runs/{rid}/stop", headers=hdr, json={})
                    except httpx.HTTPError:
                        pass
