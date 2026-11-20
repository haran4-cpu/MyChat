// Proof by running and a parser-built code map (no model involved in either).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { outline, outlineText } from "../core/codemap.mjs";
import { checkPage, findBrowser } from "../pc/pagecheck.mjs";
import { runAgent, memoryFs } from "../core/agent.mjs";

const APP = `<!doctype html><html><head><title>Demo decks</title></head><body>
<button id="play">Play</button><button id="load">Load track</button><button id="wipe">Delete all</button>
<script>
class Deck {
  constructor() { this.t = 0; }
  play() { const re = /{x}/; return re.test("{x}"); }
}
function loadTrack(d) {
  const deck = null;
  return deck.load(d);
}
const A = new Deck();
document.getElementById("play").addEventListener("click", () => A.play());
document.getElementById("load").onclick = () => loadTrack(1);
</script></body></html>`;

test("code map: exact line ranges from a parser, regex braces don't break it, element ids and handlers listed", () => {
  const o = outline(APP, "app.html");
  const deck = o.items.find((i) => i.name === "Deck"), lt = o.items.find((i) => i.name === "loadTrack");
  assert.deepEqual([deck.from, deck.to], [4, 7]);
  assert.deepEqual([lt.from, lt.to], [8, 11]);
  assert.deepEqual(o.ids, ["play", "load", "wipe"]);
  assert.ok(o.events.some((e) => e.event === "click"));
  assert.match(outlineText(o), /L8-11 {2}function loadTrack\(d\)/);
});

test("run_page: a real headless browser finds the error behind a button, and never presses 'Delete all'", { skip: !findBrowser() && "no browser" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-page-")), f = path.join(dir, "app.html");
  fs.writeFileSync(f, APP);
  const r = await checkPage(f, { outDir: dir, waitMs: 300 });
  assert.equal(r.title, "Demo decks");
  assert.ok(r.errors.some((e) => /reading 'load'/.test(e.text) && e.when === 'click "Load track"' && /app\.html:10/.test(e.where)), r.text);
  assert.ok(r.skipped.includes("Delete all"));
  assert.ok(!r.clicked.some((c) => c.label === "Delete all"));
  assert.ok(r.shots.every((s) => fs.existsSync(s)));
});

test("the agent uses outline and run_page, and a run's names don't count as 'described without reading'", async () => {
  const fs2 = memoryFs({ "P/app.html": APP });
  let n = 0;
  const gw = { async chat(req) {
    n++;
    if (n === 1) return { content: '{"calls":[{"tool":"outline","args":{"path":"P/app.html"}},{"tool":"run_page","args":{"path":"P/app.html"}}]}', provider: "p", model: "m" };
    return { content: '{"final":"Pressing Load track throws in loadTrack (P/app.html:10); manifest.webmanifest and icon.svg are missing."}', provider: "p", model: "m" };
  } };
  const runPage = async () => ({ text: "ERRORS: - [click \"Load track\"] TypeError @ app.html:10\nFailed: manifest.webmanifest icon.svg" });
  const r = await runAgent(gw, { goal: "does my app work?", fs: fs2, plan: false, maxSteps: 5, runPage });
  assert.deepEqual(r.steps.map((s) => s.tool).sort(), ["outline", "run_page"]);
  assert.match(r.steps.find((s) => s.tool === "outline").result, /MAP of P\/app\.html/);
  assert.equal(n, 2, "no 'never read' loop for names that came from the run");
  assert.match(r.answer, /1 of 1 citation/);
});
