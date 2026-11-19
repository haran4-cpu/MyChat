import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("PC server: token, model list, streaming with team progress as reasoning", async () => {
  const mock = http.createServer((req, res) => {
    const [, prov, ...rest] = req.url.split("/");
    if (rest.join("/").endsWith("models")) return res.end(JSON.stringify({ data: prov === "a" ? [{ id: "z-ai/glm-5.3" }] : [{ id: "kimi-k2.6" }] }));
    let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => {
      const b = JSON.parse(s);
      const text = b.model === "kimi-k2.6" ? '{"verdict":"ok","issues":[]}' : "def f():\n    return 1";
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + "\n\ndata: [DONE]\n\n");
    });
  });
  await new Promise((ok) => mock.listen(0, "127.0.0.1", ok));
  const mu = `http://127.0.0.1:${mock.address().port}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mychat-"));
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ allowKeyless: false, allowLocal: false,
    extraProviders: { a: { name: "a", baseUrl: mu + "/a" }, b: { name: "b", baseUrl: mu + "/b" } } }));
  fs.writeFileSync(path.join(home, "keys.json"), JSON.stringify({ a: "k", b: "k" }));
  process.env.MYCHAT_HOME = home;
  const { server, token } = await import("../pc/server.mjs?t=" + Date.now());
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const u = `http://127.0.0.1:${server.address().port}`;
  // strip the real catalogue so only the mocks are used
  assert.equal((await fetch(u + "/v1/models")).status, 401);
  // DNS rebinding: a foreign Host header is refused even for the Accounts page (which carries the local key)
  const rebound = await new Promise((ok) => http.get({ host: "127.0.0.1", port: server.address().port, path: "/connections",
    headers: { Host: "evil.example:" + server.address().port } }, (res) => { res.resume(); ok(res.statusCode); }));
  assert.equal(rebound, 403);
  const html = await (await fetch(u + "/connections")).text();
  assert.match(html, /Use MyChat inside Open WebUI/);
  // the page's own script must at least parse (template-literal escaping bugs show up here)
  for (const [, js] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(js.replace(/\bawait\b/g, "")), js.slice(0, 80));
  const H = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const models = await (await fetch(u + "/v1/models", { headers: H })).json();
  assert.ok(models.data.some((m) => m.id === "mychat/max"));
  const r = await fetch(u + "/v1/chat/completions", { method: "POST", headers: H,
    body: JSON.stringify({ model: "mychat/max", stream: true, messages: [{ role: "user", content: "write a python function f" }] }) });
  const txt = await r.text();
  const deltas = txt.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)).choices[0].delta);
  const content = deltas.map((d) => d.content || "").join(""), reasoning = deltas.map((d) => d.reasoning_content || "").join("");
  assert.equal(content, "def f():\n    return 1");
  assert.match(reasoning, /Drafting/);
  assert.match(reasoning, /review/i);
  assert.ok(txt.trim().endsWith("data: [DONE]"));
  const page = await (await fetch(u + "/connections")).text();
  assert.match(page, /aistudio\.google\.com\/apikey/);    // sign-up links for each provider
  server.closeAllConnections(); server.close(); mock.closeAllConnections(); mock.close();
});
