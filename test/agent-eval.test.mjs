import { test } from "node:test";
import assert from "node:assert/strict";
import { evalAgentModels, scoreAnswer, caseExpectations } from "../core/agent-eval.mjs";

test("an answer counts only with every expected fact, in the question's language", () => {
  const want = [/web_account\.py/i, /master/i];
  assert.equal(scoreAnswer("which file?", "ops/web_account.py protects main and master", want).correct, true);
  assert.deepEqual(scoreAnswer("which file?", "ops/web_account.py", want).missing, ["master"]);
  assert.equal(scoreAnswer("איזה קובץ מגן על הענפים?", "The file ops/web_account.py protects main and master branches from any direct publishing at all.", want).langOk, false);
  assert.equal(scoreAnswer("איזה קובץ מגן על הענפים?", "הקובץ `ops/web_account.py` מגן על main ועל master מפני פרסום ישיר.", want).langOk, true);
});

test("git truth is computed at eval time and must appear literally", async () => {
  const gitRead = async (repo, args) => (repo === "repos/x" && args[0] === "log" ? "Alice Example\n" : "git: no");
  const want = await caseExpectations({ id: "a", goal: "who?", truth: { git: { repo: "repos/x", args: ["log", "-1", "--format=%an"] } } }, { gitRead });
  assert.ok(want.at(-1).test("the last commit is by Alice Example."));
  await assert.rejects(caseExpectations({ id: "b", truth: { git: { repo: "repos/y", args: ["log"] } } }, { gitRead }), /git truth failed/);
});

test("models are ranked by correct answers, then time; a fallback answer is not credited", async () => {
  let t = 0;
  const run = async (goal, m) => {
    const model = m.work[0];
    if (model === "a:fast-wrong") { t += 1; return { answer: "no idea", by: model }; }
    if (model === "b:slow-right") { t += 50; return { answer: "it is 42", by: model }; }
    t += 5; return { answer: "it is 42", by: "other:fallback" };   // c fell back to another model
  };
  const r = await evalAgentModels({ cases: [{ id: "q", goal: "what?", expect: ["\\b42\\b"] }], models: ["a:fast-wrong", "c:falls-back", "b:slow-right"], run, now: () => t });
  assert.equal(r.results[0].model, "b:slow-right");
  assert.equal(r.results.find((x) => x.model === "c:falls-back").correct, 0);
  assert.equal(r.results.find((x) => x.model === "c:falls-back").usedOther, 1);
  assert.deepEqual(r.recommend, { plan: "b:slow-right", work: ["b:slow-right"] });
});
