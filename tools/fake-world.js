// Scripted stand-ins for the AI providers, used by tools/ui-shot.mjs (runs inside the page before the app).
(() => {
  const real = window.fetch.bind(window), enc = new TextEncoder();
  const S = window.__S = { calls: [], scenario: localStorage.getItem("fake.scenario") || "quota" };
  const sse = (text, delay = 25) => new Response(new ReadableStream({ async start(c) {
    for (const p of text.match(/[\s\S]{1,14}/g) || []) { c.enqueue(enc.encode("data: " + JSON.stringify({ choices: [{ delta: { content: p } }] }) + "\n\n")); await new Promise((r) => setTimeout(r, delay)); }
    c.enqueue(enc.encode("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n")); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
  const gQuota = () => new Response(JSON.stringify({ error: { code: 429, message: "You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20", status: "RESOURCE_EXHAUSTED", details: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] } }), { status: 429 });
  const g503 = () => new Response(JSON.stringify({ error: { code: 503, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } }), { status: 503 });
  const lists = {
    "generativelanguage.googleapis.com": { models: ["gemini-3-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemma-3-27b-it"].map((n) => ({ name: "models/" + n, supportedGenerationMethods: ["generateContent"] })) },
    "api.groq.com": { data: [{ id: "moonshotai/kimi-k2-instruct" }, { id: "llama-3.3-70b-versatile" }] },
    "oai.endpoints.kepler.ai.cloud.ovh.net": { data: [{ id: "gpt-oss-120b" }, { id: "Meta-Llama-3_3-70B-Instruct" }] },
    "api.kilo.ai": { data: [{ id: "x-ai/grok-code-fast-1:free" }] },
    "api.llm7.io": { data: [{ id: "gpt-4.1-nano" }] },
  };
  const reply = (body, host) => {
    const msgs = body.messages || (body.contents || []).map((c) => ({ role: c.role, content: (c.parts || []).map((p) => p.text).join("") }));
    const sys = msgs.find((m) => m.role === "system")?.content || body.systemInstruction?.parts?.[0]?.text || "";
    const last = String(msgs[msgs.length - 1]?.content || "");
    if (/Reply with JSON only, one object per turn/.test(sys)) {   // the agent loop
      const n = msgs.filter((m) => m.role === "assistant" || m.role === "model").length;
      if (n === 0) return JSON.stringify({ thought: "First see what is in the folder.", tool: "tree", args: { path: "" } });
      if (n === 1) return JSON.stringify({ thought: "Read the notes file before summarising it.", calls: [{ tool: "read", args: { path: "Inbox/notes.txt" } }, { tool: "search", args: { query: "TODO" } }] });
      if (n === 2) return JSON.stringify({ thought: "Double-check the count.", tool: "calc", args: { expr: "3 + 4" } });
      return JSON.stringify({ thought: "Enough evidence.", final: "**Summary of Inbox/notes.txt**\n\n- 3 open items, 4 done (Inbox/notes.txt:1-7)\n- The open items are all about the release.\n\nI propose saving this summary next to the notes.",
        ops: [{ op: "write", path: "Inbox/summary.md", content: "# Summary\n\n- 3 open, 4 done\n", why: "keep the summary next to the notes" }] });
    }
    if (/planning model|Make a short plan|PLAN/i.test(sys) && !/Reply with JSON only/.test(sys)) return "1. List the folder. 2. Read the notes. 3. Summarise and propose a file.";
    if (/independent senior reviewer/i.test(sys)) return JSON.stringify(S.scenario === "max" ? { verdict: "revise", issues: ["The loop misses the last element: use range(len(xs)) not range(len(xs) - 1)."] } : { verdict: "ok", issues: [] });
    if (/Extract|claims/i.test(sys) && /JSON/.test(sys)) return JSON.stringify({ claims: [] });
    if (/[֐-׿]/.test(last) && last.length < 10) return "היי! 👋 במה אפשר לעזור היום?";
    if (/reviewer \(a different model\) found/.test(last)) return "Here is the corrected version:\n\n```python\ndef total(xs):\n    s = 0\n    for i in range(len(xs)):\n        s += xs[i]\n    return s\n```\n\n**What changed:** the loop now covers every element — the review caught an off-by-one in the first draft.";
    if (/python|function|code/i.test(last)) return "Sure — a small, tested function:\n\n```python\ndef total(xs):\n    s = 0\n    for i in range(len(xs) - 1):\n        s += xs[i]\n    return s\n```\n\n- Runs in **O(n)**\n- Works on any list of numbers";
    return "**Short answer:** yes.\n\nHere is why, in three points:\n\n1. It is simple.\n2. It is tested.\n3. It is fast.\n\n| Option | Speed | Cost |\n|---|---|---|\n| A | fast | free |\n| B | slow | paid |";
  };
  window.fetch = async (url, init = {}) => {
    const u = new URL(String(url), location.href);
    if (u.origin === location.origin) return real(url, init);
    S.calls.push(u.host + u.pathname);
    await new Promise((r) => setTimeout(r, 60));
    if (/wikipedia|duckduckgo|jina|github\.com|api\.github/.test(u.host)) return new Response(JSON.stringify({ query: { search: [] } }), { status: 200 });
    // "stale": the free channels were unreachable at the moment the app started (phone just woke up / switched network)
    if (S.scenario === "stale" && u.pathname.endsWith("/models") && u.host !== "generativelanguage.googleapis.com" && !(S.seen ||= {})[u.host]) { S.seen[u.host] = 1; throw new TypeError("Failed to fetch"); }
    if (u.pathname.endsWith("/models")) return lists[u.host] ? new Response(JSON.stringify(lists[u.host]), { status: 200 }) : new Response("{}", { status: 404 });
    const body = JSON.parse(init.body || "{}");
    if (u.host === "generativelanguage.googleapis.com") {
      if (S.scenario === "quota" || S.scenario === "dead" || S.scenario === "stale") return /pro|2\.0/.test(u.pathname) ? g503() : gQuota();
      const t = reply(body, u.host);
      return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode("data: " + JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] }, finishReason: "STOP" }] }) + "\n\n")); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
    }
    if (S.scenario === "dead") return new Response("rate limited", { status: 429 });
    return sse(reply(body, u.host));
  };
})();
