import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectKeys, pkcePair, openRouterAuthUrl, openRouterExchange, validateKey, identifyPlainKey } from "../core/accounts.mjs";
import { PROVIDERS } from "../core/providers.mjs";

const fake = {
  gemini: "AIza" + "x".repeat(35), nvidia: "nvapi-" + "a".repeat(64), groq: "gsk_" + "b".repeat(52),
  openrouter: "sk-or-v1-" + "c".repeat(64), anthropic: "sk-ant-api03-" + "d".repeat(90), huggingface: "hf_" + "e".repeat(34),
};

test("keys are recognised by their shape, several at once, inside other text", () => {
  const text = `my keys:\n gemini ${fake.gemini}\nNVIDIA: ${fake.nvidia}, groq=${fake.groq}\n${fake.openrouter} ${fake.anthropic} ${fake.huggingface}`;
  const got = Object.fromEntries(detectKeys(text).map((k) => [k.provider, k.key]));
  for (const [p, k] of Object.entries(fake)) assert.equal(got[p], k, p);
  assert.deepEqual(detectKeys("hello world"), []);
});

test("PKCE S256 challenge matches the standard", async () => {
  const { verifier, challenge } = await pkcePair();
  const want = nodeCrypto.createHash("sha256").update(verifier).digest("base64url");
  assert.equal(challenge, want);
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  const u = new URL(openRouterAuthUrl("http://localhost:11500/oauth/openrouter/callback/n1", challenge));
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("callback_url"), "http://localhost:11500/oauth/openrouter/callback/n1");
});

test("OpenRouter code exchange sends code + verifier and returns the key", async () => {
  let sent;
  const key = await openRouterExchange("CODE1", "VER1", async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ key: fake.openrouter }) };
  });
  assert.equal(key, fake.openrouter);
  assert.equal(sent.url, "https://openrouter.ai/api/v1/auth/keys");
  assert.deepEqual(sent.body, { code: "CODE1", code_verifier: "VER1", code_challenge_method: "S256" });
});

test("Accounts page: pasting text with a key validates it live and stores it", async () => {
  const mock = http.createServer((req, res) => {
    const ok = req.headers["x-goog-api-key"] === fake.gemini;   // Gemini uses Google's native API and header
    res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: ok ? [{ id: "gemini-3.1-pro" }, { id: "gemini-3.6-flash" }] : [] }));
  });
  await new Promise((ok) => mock.listen(0, "127.0.0.1", ok));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mychat-acc-"));
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ allowKeyless: false, allowLocal: false,
    extraProviders: { gemini: { ...PROVIDERS.gemini, baseUrl: `http://127.0.0.1:${mock.address().port}/v1` } } }));
  process.env.MYCHAT_HOME = home;
  const { server, token } = await import("../pc/server.mjs?acc=" + Date.now());
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const u = `http://127.0.0.1:${server.address().port}`;
  const H = { "Content-Type": "application/json", "X-MyChat-Token": token };
  const bad = await (await fetch(u + "/connections/paste", { method: "POST", headers: H, body: JSON.stringify({ text: "AIza" + "z".repeat(35) }) })).json();
  assert.equal(bad.results[0].ok, false);
  assert.ok(!fs.existsSync(path.join(home, "keys.json")) || !JSON.parse(fs.readFileSync(path.join(home, "keys.json"))).gemini);
  const good = await (await fetch(u + "/connections/paste", { method: "POST", headers: H, body: JSON.stringify({ text: "here: " + fake.gemini }) })).json();
  assert.deepEqual([good.results[0].provider, good.results[0].ok, good.results[0].models], ["gemini", true, 2]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "keys.json"))).gemini, fake.gemini);
  assert.equal((await fetch(u + "/connections/paste", { method: "POST", body: "{}" })).status, 401);   // needs the local token
  const start = await fetch(u + "/oauth/openrouter/start?t=" + token, { redirect: "manual" });
  assert.equal(start.status, 302);
  assert.match(start.headers.get("location"), /^https:\/\/openrouter\.ai\/auth\?callback_url=http%3A%2F%2Flocalhost/);
  assert.equal((await fetch(u + "/oauth/openrouter/start", { redirect: "manual" })).status, 401);
  server.closeAllConnections(); server.close(); mock.closeAllConnections(); mock.close();
});

test("new Gemini 'AQ.' keys are recognised as Gemini", () => {
  const k = "AQ.Ab8RN6" + "x".repeat(40);
  assert.deepEqual(detectKeys("my key " + k).map((d) => d.provider), ["gemini"]);
});

test("a provider whose model list is public does not accept any key: a real call decides", async () => {
  const good = "good-key-123456789012345678901234";
  const mock = http.createServer((req, res) => {
    if (req.url.endsWith("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "Meta-Llama-4" }] })); }
    const ok = req.headers.authorization === "Bearer " + good;
    res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
    res.end(ok ? JSON.stringify({ choices: [{ message: { content: "h" } }] }) : '{"error":"Invalid API key"}');
  });
  await new Promise((ok) => mock.listen(0, "127.0.0.1", ok));
  const provs = { samba: { name: "samba", baseUrl: `http://127.0.0.1:${mock.address().port}/v1` } };
  assert.equal((await validateKey("samba", "AQ.someone-elses-key-xxxxxxxxxxxx", provs)).ok, false);
  assert.equal((await validateKey("samba", good, provs)).ok, true);
  assert.equal(await identifyPlainKey("AQ.someone-elses-key-xxxxxxxxxxxx", provs, ["samba"]), null);
  mock.closeAllConnections(); mock.close();
});
