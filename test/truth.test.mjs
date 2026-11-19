import { test } from "node:test";
import assert from "node:assert/strict";
import { Gateway } from "../core/router.mjs";
import { verifiedAnswer, triage } from "../core/truth.mjs";
import { run } from "../core/reason.mjs";
import { Search, quoteFound } from "../core/search.mjs";
import { Ledger } from "../core/ledger.mjs";
import { lint, claimsPreserved } from "../core/slop.mjs";

// Fake models answer by role (recognised from the system prompt); every call is logged.
function world(script) {
  const calls = [];
  const models = { glm: "z-ai/glm-5.3", kimi: "moonshotai/kimi-k2.6", ds: "deepseek-ai/deepseek-v4" };
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: Object.values(models).map((id) => ({ id })) }), { status: 200 });
    const b = JSON.parse(init.body);
    const sys = b.messages[0].role === "system" ? b.messages[0].content : "";
    const role = sys.includes("fact auditor") ? "extract" : sys.includes("check one claim against evidence") ? "judge"
      : sys.includes("Two statements") ? "compare" : sys.includes("final answer for the user") ? "synth"
      : sys.startsWith("Tighten") ? "tighten" : "draft";
    calls.push({ role, model: b.model, messages: b.messages });
    const out = script[role]?.(b) ?? "";
    const body = "data: " + JSON.stringify({ choices: [{ delta: { content: out } }] }) + "\n\ndata: [DONE]\n\n";
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const g = new Gateway({ keys: { p: "k" }, allowKeyless: false, fetch: fetchImpl, extraProviders: { p: { name: "p", baseUrl: "http://fake/v1" } } });
  for (const id of Object.keys(g.providers)) if (id !== "p") delete g.providers[id];
  return { g, calls, models };
}

const WIKI = "The Eiffel Tower is a wrought-iron lattice tower in Paris. It was constructed from 1887 to 1889 and was completed in March 1889 as the centrepiece of the World's Fair.";
function wikiSearch() {
  return new Search({ keys: {}, fetch: async (url) => {
    if (url.includes("list=search")) return new Response(JSON.stringify({ query: { search: [{ title: "Eiffel Tower" }] } }), { status: 200 });
    return new Response(JSON.stringify({ query: { pages: { 1: { title: "Eiffel Tower", extract: WIKI } } } }), { status: 200 });
  } });
}
const Q = [{ role: "user", content: "When was the Eiffel Tower completed?" }];
const claim = (o) => JSON.stringify({ claims: [{ text: "The Eiffel Tower was completed in 1889.", type: "date", importance: 3, support: [1], oppose: [2],
  query: "Eiffel Tower completed year", question: "In which year was the Eiffel Tower completed?", ...o }] });

test("triage: verify facts, current events and numbers; not greetings, code or poems", () => {
  assert.equal(triage(Q).kind, "fact");
  assert.equal(triage([{ role: "user", content: "What is the current price of bitcoin?" }]).kind, "current");
  assert.equal(triage([{ role: "user", content: "what is 17.5% of 2480?" }]).kind, "math");
  assert.equal(triage([{ role: "user", content: "מתי הוקם מגדל אייפל?" }]).verify, true);
  assert.equal(triage([{ role: "user", content: "hi" }]).verify, false);
  assert.equal(triage([{ role: "user", content: "write a poem about the sea" }]).verify, false);
  assert.equal(triage([{ role: "user", content: "fix this python function" }]).verify, false);
});

test("a disputed date is settled by evidence with a quote that really is on the page", async () => {
  const { g, calls } = world({
    draft: (b) => (b.model.includes("glm") ? "It was completed in 1889." : "It was completed in 1899."),
    extract: () => claim(),
    judge: () => JSON.stringify({ verdict: "supported", source: 1, quote: "completed in March 1889" }),
    synth: () => "The Eiffel Tower was completed in March 1889 [1].",
  });
  const ledger = new Ledger();
  const r = await verifiedAnswer(g, { messages: Q }, { search: wikiSearch(), ledger });
  assert.equal(r.claims[0].status, "supported");
  assert.equal(r.claims[0].how, "evidence");
  assert.match(r.content, /March 1889 \[1\]/);
  assert.match(r.content, /1 proven/);
  assert.match(r.content, /wikipedia\.org\/wiki\/Eiffel_Tower/);
  const drafters = new Set(calls.filter((c) => c.role === "draft").map((c) => c.model));
  assert.equal(drafters.size, 2);                                   // two different families drafted
  const judge = calls.find((c) => c.role === "judge");
  assert.ok(!drafters.has(judge.model));                            // the judge is a third family
  assert.equal(ledger.lookup("The Eiffel Tower was completed in 1889").verdict, "supported");
});

test("a judge that invents its quote proves nothing", async () => {
  const { g } = world({
    draft: () => "It was completed in 1899.",
    extract: () => claim({ text: "The Eiffel Tower was completed in 1899.", support: [1, 2], oppose: [] }),
    judge: () => JSON.stringify({ verdict: "supported", source: 1, quote: "the tower was finished in 1899 after delays" }),
    synth: (b) => "Answer: " + b.messages[1].content.match(/\[(\w+)/)[1],
  });
  const r = await verifiedAnswer(g, { messages: Q }, { search: wikiSearch(), ledger: new Ledger() });
  assert.notEqual(r.claims[0].status, "supported");
  assert.match(r.claims[0].note, /quote not found/);
  assert.equal(quoteFound("completed in March 1889", WIKI), true);
  assert.equal(quoteFound("finished in 1899 after delays", WIKI), false);
});

test("arithmetic claims are computed exactly, not voted on", async () => {
  const { g, calls } = world({
    draft: () => "17.5% of 2480 is 430.",
    extract: () => JSON.stringify({ claims: [{ text: "17.5% of 2480 is 430", type: "math", importance: 3, support: [1, 2], expr: "17.5% of 2480", value: "430" }] }),
    synth: (b) => (b.messages[1].content.includes("CORRECTION: 17.5% of 2480 = 434") ? "17.5% of 2,480 is 434." : "wrong"),
  });
  const r = await verifiedAnswer(g, { messages: [{ role: "user", content: "what is 17.5% of 2480?" }] }, { ledger: new Ledger() });
  assert.equal(r.claims[0].status, "refuted");
  assert.equal(r.claims[0].how, "exact arithmetic");
  assert.match(r.content, /434/);
  assert.match(r.content, /1 corrected/);
  assert.ok(!calls.some((c) => c.role === "judge"));
});

test("truth memory: a settled claim is reused, not re-checked", async () => {
  const ledger = new Ledger();
  ledger.record({ text: "The Eiffel Tower was completed in 1889.", verdict: "supported", evidence: [{ url: "u", quote: "q" }], domain: "fact" });
  const { g, calls } = world({ draft: () => "1889.", extract: () => claim({ oppose: [] }), synth: () => "1889." });
  const r = await verifiedAnswer(g, { messages: Q }, { search: wikiSearch(), ledger });
  assert.equal(r.claims[0].how, "memory");
  assert.ok(!calls.some((c) => c.role === "judge"));
});

test("independent questioning never shows the draft to the checker", async () => {
  const { g, calls } = world({
    draft: (b) => (b.model.includes("glm") ? "Completed in 1889." : "Completed in 1899."),
    extract: () => claim(),
    compare: () => JSON.stringify({ relation: "agree" }),
    synth: () => "1889.",
  });
  const r = await verifiedAnswer(g, { messages: Q }, { ledger: new Ledger() });   // no search: must fall back to questioning
  const indep = calls.find((c) => c.role === "draft" && c.messages[0].content.startsWith("In which year"));
  assert.ok(indep, "an independent question was asked");
  assert.ok(!JSON.stringify(indep.messages).includes("1889") && !JSON.stringify(indep.messages).includes("1899"));
  assert.equal(r.claims[0].independent.relation, "agree");
  assert.equal(r.claims[0].status, "disputed");                      // still one opposer: shown as disputed, not as fact
});

test("slop: tightened only when every fact survives", () => {
  const sloppy = "Great question! As an AI, I can tell you the tower is 330 m tall and opened in 1889. I hope this helps!";
  assert.ok(lint(sloppy).score >= 15);
  assert.equal(claimsPreserved(sloppy, "The tower is 330 m tall and opened in 1889.").ok, true);
  assert.equal(claimsPreserved(sloppy, "The tower is tall and opened in 1889.").ok, false);
});

test("Dawid–Skene: learns which model is reliable, even from unlabelled votes", () => {
  const L = new Ledger();
  for (let i = 0; i < 10; i++) L.record({ text: "fact " + i, verdict: i % 2 ? "supported" : "refuted", supporters: i % 2 ? ["good"] : ["bad"], opposers: i % 2 ? ["bad"] : ["good"], domain: "fact" });
  for (let i = 0; i < 10; i++) L.record({ text: "open " + i, verdict: "insufficient", supporters: ["good", "mid"], opposers: ["bad"], domain: "fact" });
  L.estimate();
  assert.ok(L.reliability("good", "fact") > 0.85);
  assert.ok(L.reliability("bad", "fact") < 0.2);
  assert.ok(L.reliability("mid", "fact") > 0.6);                    // learned only from agreeing with the reliable model
  assert.ok(L.weight(["good"], ["bad"], "fact") > 0);
});

test("auto mode hands factual questions to the Truth Engine and leaves chit-chat alone", async () => {
  const { g, calls } = world({ draft: () => "1889.", extract: () => claim({ oppose: [] }), judge: () => JSON.stringify({ verdict: "supported", source: 1, quote: "completed in March 1889" }), synth: () => "1889 [1]." });
  const r1 = await run(g, { messages: Q }, { mode: "auto", truth: { search: wikiSearch(), ledger: new Ledger() } });
  assert.equal(r1.mode, "verified");
  const before = calls.length;
  const r2 = await run(g, { messages: [{ role: "user", content: "hi" }] }, { mode: "auto", truth: { search: wikiSearch(), ledger: new Ledger() } });
  assert.notEqual(r2.mode, "verified");
  assert.equal(calls.length - before, 1);
});

test("Wikipedia: identified request, Hebrew falls back to the quoted title and to English, failures are recorded", async () => {
  const { Search } = await import("../core/search.mjs");
  const seen = [];
  const fake = async (url, init) => {
    const u = new URL(url); seen.push({ host: u.host, q: u.searchParams.get("srsearch"), ua: init?.headers?.["User-Agent"] || init?.headers?.["Api-User-Agent"] });
    const j = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (u.searchParams.get("list") === "search") {
      if (u.host.startsWith("he.") && u.searchParams.get("srsearch") === "אהבת ציון") return j({ query: { search: [{ title: "אהבת ציון" }] } });
      return j({ query: { search: [] } });
    }
    return j({ query: { pages: { 1: { title: "אהבת ציון", extract: "אהבת ציון הוא רומן מאת אברהם מאפו" } } } });
  };
  const s = new Search({ fetch: fake });
  const r = await s.wikipedia("מי כתב את הרומן 'אהבת ציון'?", 1);
  assert.equal(r[0].title, "אהבת ציון");
  assert.ok(seen.every((x) => /MyChat/.test(x.ua)));
  assert.ok(seen.some((x) => x.q === "אהבת ציון"));
  const bad = new Search({ fetch: async () => new Response("blocked", { status: 403 }) });
  assert.deepEqual(await bad.evidence("Eiffel Tower height"), []);
  assert.match(bad.errors[0].error, /403/);
});

test("small talk is never routed to the slow fact-checking path", async () => {
  const { triage } = await import("../core/truth.mjs");
  for (const t of ["בדיקה: מה שלומך?", "היי", "מה נשמע?", "thanks!", "Hello there", "who are you?"])
    assert.equal(triage([{ role: "user", content: t }]).verify, false, t);
  assert.equal(triage([{ role: "user", content: "מי כתב את אהבת ציון?" }]).verify, true);
  assert.equal(triage([{ role: "user", content: "What is the capital of Burkina Faso?" }]).verify, true);
});

test("premise check: a title no encyclopedia page connects to the named author makes the drafts say so", async () => {
  const { verifiedAnswer } = await import("../core/truth.mjs");
  const seenSystem = [];
  const gw = { models: { a: ["m"] }, refreshModels: async () => {}, candidates: () => [{ provider: "a", model: "m", family: "fa" }],
    chat: async (req) => { const sys = req.messages.find((m) => m.role === "system")?.content || ""; seenSystem.push(sys);
      return { content: sys.startsWith("Premise check") ? "I can't find such a play." : '{"claims":[]}', provider: "a", model: "m" }; } };
  const search = { wikipedia: async () => [{ title: "Dido", text: "Dido was the queen of Tyre and founder of Carthage." }], evidence: async () => [] };
  await verifiedAnswer(gw, { messages: [{ role: "user", content: "Summarise the plot of Shakespeare's play 'The Queen of Tyre'." }] }, { search, drafts: 1 });
  assert.ok(seenSystem.some((s) => s.startsWith("Premise check")));
  seenSystem.length = 0;
  const real = { wikipedia: async () => [{ title: "Hamlet", text: "Hamlet is a tragedy by William Shakespeare." }], evidence: async () => [] };
  await verifiedAnswer(gw, { messages: [{ role: "user", content: "Summarise Shakespeare's play 'Hamlet'." }] }, { search: real, drafts: 1 });
  assert.ok(!seenSystem.some((s) => s.startsWith("Premise check")));
});
