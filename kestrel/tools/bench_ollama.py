"""Kestrel CPU benchmark: measures what actually limits local inference.
Each case sends a fresh (cache-busted) prompt of fixed size and records
Ollama's own timings: prompt-eval tokens/s (prefill) and eval tokens/s (generation)."""
import json, time, random, urllib.request, sys, os
URL = "http://127.0.0.1:11434"
OUT = os.path.join(os.path.dirname(__file__), "..", "logs", "bench.json")
FILLER = ("Kestrel keeps files safe with backups, approvals and an audit log. " * 60)  # ~700 tokens

def post(path, body, timeout=900):
    req = urllib.request.Request(URL + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

def case(name, model, options, think=False, prompt=None, bust=True, predict=48):
    msg = (f"[{random.random()}] " if bust else "") + (prompt or FILLER + "\nIn one sentence: what does Kestrel do?")
    o = {"num_predict": predict, "temperature": 0, **options}
    t0 = time.time()
    r = post("/api/chat", {"model": model, "messages": [{"role": "user", "content": msg}], "stream": False,
                           "think": think, "options": o, "keep_alive": "30m"})
    wall = time.time() - t0
    pe, pd = r.get("prompt_eval_count", 0), r.get("prompt_eval_duration", 1) / 1e9
    ec, ed = r.get("eval_count", 0), r.get("eval_duration", 1) / 1e9
    res = {"case": name, "model": model, "options": options, "think": think, "wall_s": round(wall, 1),
           "prompt_tokens": pe, "prefill_tps": round(pe / pd, 2) if pd else None,
           "gen_tokens": ec, "gen_tps": round(ec / ed, 2) if ed else None,
           "load_s": round(r.get("load_duration", 0) / 1e9, 1),
           "thinking_chars": len((r.get("message") or {}).get("thinking") or "")}
    results.append(res); save(); return res

def save(done=False):
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"done": done, "t": time.ctime(), "results": results}, f, indent=1)

results = []
M = "kestrel-agent:latest"
try:
    case("warmup", M, {"num_thread": 4}, predict=4)
    case("threads4_batch512", M, {"num_thread": 4, "num_batch": 512})
    case("threads2_batch512", M, {"num_thread": 2, "num_batch": 512})
    case("threads3_batch512", M, {"num_thread": 3, "num_batch": 512})
    case("threads4_batch128", M, {"num_thread": 4, "num_batch": 128})
    case("cache_hit_same_prefix", M, {"num_thread": 4}, bust=False)
    case("cache_hit_same_prefix_2", M, {"num_thread": 4}, bust=False)
    q = "A shop sells pens at 3 for 2 shekels. How much do 12 pens cost? Answer briefly."
    case("think_default(None)", M, {"num_thread": 4}, think=None, prompt=q, predict=400)
    case("think_off", M, {"num_thread": 4}, think=False, prompt=q, predict=400)
    case("model_2b", "qwen3.5:2b-q4_K_M", {"num_thread": 4})
except Exception as e:
    results.append({"error": repr(e)})
save(done=True)
