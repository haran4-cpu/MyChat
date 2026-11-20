"""Kestrel build evaluation: measure, don't guess.

Runs a fixed suite of build tasks through the real BuildEngine (real model, real browser) under one or more
configurations and records, per task: passed (runs clean AND all acceptance tests pass), acceptance tests
passed/total, remaining failures, minutes, model calls, tokens written, repairs used.

The acceptance tests are written by the engine itself, so on top of that every finished page is checked by a
small, FIXED, human-written test set per task (held out: the engine never sees it). That is the honest score:
it cannot be gamed by writing easy tests.

Usage (from the Kestrel folder):
  python tools\\eval_build.py                       # both configs, all tasks
  python tools\\eval_build.py --configs agent       # one config
  python tools\\eval_build.py --tasks counter,todo  # some tasks
Results: logs\\eval-<time>.json and logs\\eval-summary.md (appended).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from kestrel import runcheck  # noqa: E402
from kestrel.audit import AuditLog  # noqa: E402
from kestrel.build import BuildEngine  # noqa: E402
from kestrel.config import HOME, Config  # noqa: E402
from kestrel.guard import Guard  # noqa: E402
from kestrel.llm import Router  # noqa: E402

# Held-out checks use only visible behaviour that any reasonable implementation must show, located by text or
# generic elements (ids are the model's choice, so they are not assumed).
TASKS = {
    "counter": {
        "goal": "Build a counter app in one HTML file: a number display starting at 0 and three buttons '+', '-' and "
                "'Reset'. The count must never go below 0.",
        "held_out": [
            {"name": "plus", "steps": [{"do": "click", "target": "+"}, {"do": "click", "target": "+"},
                                       {"do": "expect", "target": "page", "text_matches": "\\b2\\b"}]},
            {"name": "not below zero", "steps": [{"do": "click", "target": "-"}, {"do": "expect", "target": "page", "text_matches": "\\b0\\b"},
                                                 {"do": "expect", "target": "page", "not_matches": "-1"}]},
            {"name": "reset", "steps": [{"do": "click", "target": "+"}, {"do": "click", "target": "Reset"},
                                        {"do": "expect", "target": "page", "text_matches": "\\b0\\b"}]},
        ]},
    "pomodoro": {
        "goal": "Build a Pomodoro timer in one HTML file with buttons labelled exactly 'Start', 'Pause' and 'Reset', a 25:00 "
                "countdown shown as MM:SS, a circular progress ring, and a beep when time runs out. English UI.",
        "held_out": [
            {"name": "starts at 25:00", "steps": [{"do": "expect", "target": "page", "text_matches": "25:00"}]},
            {"name": "counts down", "steps": [{"do": "click", "target": "Start"}, {"do": "wait", "ms": 3500},
                                              {"do": "expect", "target": "page", "text_matches": "24:5[0-8]"}]},
            {"name": "pause holds", "steps": [{"do": "click", "target": "Start"}, {"do": "wait", "ms": 2500}, {"do": "click", "target": "Pause"},
                                              {"do": "mark", "target": "page"}, {"do": "wait", "ms": 3000}, {"do": "expect_same", "target": "page"}]},
            {"name": "reset", "steps": [{"do": "click", "target": "Start"}, {"do": "wait", "ms": 3000}, {"do": "click", "target": "Reset"},
                                        {"do": "expect", "target": "page", "text_matches": "25:00"}]},
        ]},
    "todo": {
        "goal": "Build a to-do list in one HTML file: a text box and a button labelled 'Add'; each task shows with a checkbox "
                "to mark it done and a button labelled 'Delete'; the list is saved in localStorage. English UI.",
        "held_out": [
            {"name": "add", "steps": [{"do": "type", "target": "input", "text": "buy milk"}, {"do": "click", "target": "Add"},
                                      {"do": "expect", "target": "page", "text_matches": "buy milk"}]},
            {"name": "delete", "steps": [{"do": "type", "target": "input", "text": "walk dog"}, {"do": "click", "target": "Add"},
                                         {"do": "click", "target": "Delete"}, {"do": "expect", "target": "page", "not_matches": "walk dog"}]},
            {"name": "no errors", "steps": [{"do": "type", "target": "input", "text": "x"}, {"do": "click", "target": "Add"},
                                            {"do": "click", "target": "input[type=checkbox]"}, {"do": "expect_no_errors"}]},
        ]},
    "converter": {
        "goal": "Build a temperature converter in one HTML file: a Celsius input and a Fahrenheit input that update each "
                "other live as you type, rounded to one decimal.",
        "held_out": [
            {"name": "c to f", "steps": [{"do": "type", "target": "input", "text": "100"}, {"do": "wait", "ms": 300},
                                         {"do": "expect", "target": "input:nth-of-type(2), input:last-of-type", "text_matches": "^212(\\.0)?$"}]},
            {"name": "zero", "steps": [{"do": "type", "target": "input", "text": "0"}, {"do": "wait", "ms": 300},
                                       {"do": "expect", "target": "input:last-of-type", "text_matches": "^32(\\.0)?$"}]},
        ]},
    "snake": {
        "goal": "Build a Snake game in one HTML file with a canvas: it starts moving right away, arrow keys steer, eating food "
                "grows the snake and adds to a visible 'Score', hitting a wall or itself ends the game, and Space restarts. English UI.",
        "held_out": [
            {"name": "animates", "steps": [{"do": "key", "key": " "}, {"do": "mark", "target": "canvas"}, {"do": "wait", "ms": 1500},
                                           {"do": "expect_changed", "target": "canvas"}]},
            {"name": "steers without errors", "steps": [{"do": "key", "key": " "}, {"do": "key", "key": "ArrowUp"}, {"do": "wait", "ms": 400},
                                                        {"do": "key", "key": "ArrowLeft"}, {"do": "wait", "ms": 400}, {"do": "expect_no_errors"}]},
            {"name": "score visible", "steps": [{"do": "expect", "target": "page", "text_matches": "score|ניקוד|\\b0\\b"}]},
        ]},
}

CONFIGS = {
    "agent": {},                          # Qwen3.5-4B writes the code (current default)
    "coder": {"write_role": "coder"},     # Qwen2.5-Coder-3B writes, Qwen3.5-4B plans/repairs/tests
}


def run_one(cfg: Config, task: str, conf: str, log) -> dict:
    t = TASKS[task]
    audit = AuditLog(cfg.state_dir / "eval-audit.jsonl")
    guard = Guard(cfg, audit, lambda req: "deny")  # an evaluation never writes outside its own build folder
    cfg.data["build"] = {**(cfg.get("build") or {}), **CONFIGS[conf], "deliver": False}
    events = []
    eng = BuildEngine(cfg, guard, Router(cfg), lambda k, d: (events.append((k, d)), k == "progress" and log(f"    {d['text'][:150]}")))
    t0 = time.time()
    try:
        res = eng.run(t["goal"])
    except Exception as e:  # a crash is a result too
        return {"task": task, "config": conf, "error": repr(e), "minutes": round((time.time() - t0) / 60, 1)}
    final = eng.root / f"final_{res['spec']['filename']}"
    held = runcheck.run_tests(final, t["held_out"]) if final.suffix in (".html", ".htm") else []
    return {
        "task": task, "config": conf, "passed": res["ok"],
        "own_tests": f"{sum(1 for x in res.get('test_results') or [] if x.get('ok'))}/{len(res.get('test_results') or [])}",
        "held_out": f"{sum(1 for x in held if x['ok'])}/{len(held)}",
        "held_out_failures": [f"{x['name']}: {x['msg']}" for x in held if not x["ok"]],
        "failures": [f.splitlines()[0][:160] for f in res["failures"]],
        "minutes": round((time.time() - t0) / 60, 1), "llm_calls": res["stats"]["llm_calls"],
        "output_tokens": res["stats"]["output_tokens"], "runs": res["stats"]["runs"],
        "repairs": sum(1 for l in res["log"] if l.startswith("Repair")), "attempts": sum(1 for l in res["log"] if "wrote" in l and "lines" in l),
        "build_dir": res["build_dir"],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--configs", default=",".join(CONFIGS))
    ap.add_argument("--tasks", default=",".join(TASKS))
    a = ap.parse_args()
    cfg = Config()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_json = HOME / "logs" / f"eval-{stamp}.json"
    out_json.parent.mkdir(exist_ok=True)
    progress = HOME / "logs" / "eval-progress.log"

    def log(m):
        with open(progress, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {m}\n")
    results = []
    for task in [x for x in a.tasks.split(",") if x in TASKS]:
        for conf in [x for x in a.configs.split(",") if x in CONFIGS]:
            log(f"=== {task} / {conf}")
            r = run_one(cfg, task, conf, log)
            results.append(r)
            log(f"=== result: {json.dumps(r, ensure_ascii=False)[:400]}")
            out_json.write_text(json.dumps(results, indent=1, ensure_ascii=False), encoding="utf-8")
    lines = [f"\n## Eval {stamp}\n", "| task | config | passed | own tests | held-out | minutes | calls | repairs | attempts |",
             "|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        lines.append(f"| {r['task']} | {r['config']} | {'✓' if r.get('passed') else '✗'} | {r.get('own_tests', '-')} | "
                     f"{r.get('held_out', '-')} | {r.get('minutes')} | {r.get('llm_calls', '-')} | {r.get('repairs', '-')} | {r.get('attempts', '-')} |")
    for conf in CONFIGS:
        rs = [r for r in results if r["config"] == conf and "error" not in r]
        if rs:
            ho = [tuple(map(int, r["held_out"].split("/"))) for r in rs if r["held_out"] != "0/0"]
            lines.append(f"\n**{conf}**: passed {sum(r['passed'] for r in rs)}/{len(rs)}, held-out checks "
                         f"{sum(x for x, _ in ho)}/{sum(y for _, y in ho)}, avg {sum(r['minutes'] for r in rs) / len(rs):.1f} min")
    with open(HOME / "logs" / "eval-summary.md", "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    log("=== all done")


if __name__ == "__main__":
    main()
