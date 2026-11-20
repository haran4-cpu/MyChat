import { test } from "node:test";
import assert from "node:assert/strict";
import { md } from "../app/www/markdown.mjs";

test("answers render like a premium chat: headings, lists, tables, quotes, code with language and copy", () => {
  const h = md("## Review\n\n1. **SQL injection** — `src/users.js:4`\n2. Off-by-one\n    - nested *detail*\n\n| Bug | File |\n|---|---|\n| SQL | users.js |\n\n> note\n\n---\n\n```js\nconst a = '<b>';\n```\nafter");
  assert.match(h, /<h3 dir="auto">Review<\/h3>/);
  assert.match(h, /<ol><li><b>SQL injection<\/b> — <code>src\/users\.js:4<\/code><\/li><li>Off-by-one<ul><li>nested <i>detail<\/i><\/li><\/ul><\/li><\/ol>/);
  assert.match(h, /<table><thead><tr><th dir="auto">Bug<\/th><th dir="auto">File<\/th><\/tr><\/thead><tbody><tr><td dir="auto">SQL<\/td><td dir="auto">users\.js<\/td><\/tr>/);
  assert.match(h, /<blockquote dir="auto"><p dir="auto">note<\/p><\/blockquote>/);
  assert.match(h, /<hr>/);
  assert.match(h, /<span class="lang">js<\/span><button class="copycode"[^>]*>Copy<\/button><code>const a = &#39;&lt;b&gt;&#39;;<\/code>/);
  assert.match(h, /<p dir="auto">after<\/p>$/);
});

test("nothing from a model can inject HTML or scripts; only http(s) links", () => {
  const h = md("<img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://a.b/c) **<script>**");
  assert.doesNotMatch(h, /<img|<script|href="javascript/);
  assert.match(h, /<a href="https:\/\/a\.b\/c" target="_blank" rel="noopener">ok<\/a>/);
});
