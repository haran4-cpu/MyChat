"""Configuration: one JSON file next to the install, merged over defaults."""
from __future__ import annotations

import copy
import json
import os
import threading
from pathlib import Path

HOME = Path(os.environ.get("KESTREL_HOME") or Path(__file__).resolve().parent.parent)

DEFAULTS: dict = {
    "ollama_url": "http://127.0.0.1:11434",
    # Model roles. "agent" does the work, "fast" routes/summarizes, "deep" plans/reviews.
    "models": {
        "agent": "kestrel-agent",
        "fast": "kestrel-fast",
        "deep": "kestrel-deep",
        "coder": "qwen2.5-coder:3b",
    },
    # Fallbacks used when the kestrel-* profiles have not been created yet.
    "fallback_models": {
        "agent": "qwen3.5:4b-q4_K_M",
        "fast": "qwen3.5:2b-q4_K_M",
        "deep": "qwen3.5:9b-q4_K_M",
        "coder": "qwen2.5-coder:3b",
    },
    # Keep only the model in use loaded: two resident models on a 4-thread CPU fight for memory bandwidth.
    "one_model_at_a_time": True,
    "num_ctx": 16384,
    "keep_alive": "30m",
    "think_when_planning": True,
    "think_when_acting": False,
    # Online mode: off by default. Backends: "ollama-cloud" | "anthropic" | "openai-compatible"
    "online": {
        "enabled": False,
        "backend": "ollama-cloud",
        "model": "",
        "base_url": "",
        "api_key_env": "KESTREL_API_KEY",
        "use_for": ["deep"],  # roles that go online when enabled
        "allow_web_fetch": False,
    },
    # backend "mychat": the build engine thinks with MyChat's cloud models, only for folders listed in cloud_roots
    # (default: the workspace) and never for private_roots. Chat/agent tasks with tools stay local.
    "brain": {"cloud_roots": [], "private_roots": []},
    # Folders the agent may touch. mode: "read" or "write".
    "roots": [],
    # Approval policy: "ask" or "auto"
    "approvals": {
        "write": "ask",
        "command": "ask",
        "new_folder_access": "ask",
    },
    "workspace": "",  # default output folder; created on first use
    "max_tool_result_chars": 3000,
    "max_steps_per_turn": 24,
    "mission": {
        "max_attempts_per_step": 3,
        "max_tool_calls_per_step": 30,
    },
    "ui_port": 8765,
}

_lock = threading.RLock()


def _deep_merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


class Config:
    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path else HOME / "config.json"
        self.data = copy.deepcopy(DEFAULTS)
        self.load()

    def load(self) -> None:
        with _lock:
            if self.path.exists():
                try:
                    user = json.loads(self.path.read_text(encoding="utf-8"))
                except json.JSONDecodeError as e:
                    raise SystemExit(f"config.json is not valid JSON: {e}")
                self.data = _deep_merge(DEFAULTS, user)
            if not self.data.get("workspace"):
                self.data["workspace"] = str(HOME / "workspace")

    def save(self) -> None:
        with _lock:
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data, indent=2, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, self.path)

    def __getitem__(self, k):
        return self.data[k]

    def get(self, k, default=None):
        return self.data.get(k, default)

    @property
    def state_dir(self) -> Path:
        p = HOME / "state"
        p.mkdir(parents=True, exist_ok=True)
        return p
