// Privacy guard: fails CI when tracked files contain secrets, private data files, personal emails, or private project
// names. The private names are NOT in this public repo: they come from the PRIVATE_TERMS secret (regex alternatives,
// e.g. "name1|name2"). Usage: node tools/privacy-guard.mjs   (scans every tracked file)
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);

const SECRETS = [
  ["Google API key", /AIza[0-9A-Za-z_\-]{35}/g], ["Groq key", /gsk_[A-Za-z0-9]{40,}/g],
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g], ["OpenRouter key", /sk-or-v1-[a-f0-9]{40,}/g],
  ["OpenAI/Anthropic key", /\bsk-(proj-|ant-)?[A-Za-z0-9_\-]{30,}/g], ["NVIDIA key", /nvapi-[A-Za-z0-9_\-]{30,}/g],
  ["Hugging Face token", /\bhf_[A-Za-z0-9]{30,}/g], ["xAI key", /\bxai-[A-Za-z0-9]{30,}/g], ["Vercel key", /\bvck_[A-Za-z0-9]{20,}/g],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/g], ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["JWT", /\beyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}/g],
  ["Slack token", /xox[baprs]-[A-Za-z0-9\-]{10,}/g], ["Telegram bot token", /\b\d{9,10}:AA[A-Za-z0-9_\-]{30,}/g],
];
const EMAIL = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const EMAIL_OK = /@(example\.(com|org|net)|anthropic\.com|users\.noreply\.github\.com|noreply\.github\.com|github\.com|localhost|test)$/i;
const BAD_NAMES = /(^|\/)(keys\.json|token|\.env(\..*)?|.*\.(pem|key|p12|pfx|jks|keystore|sqlite|sqlite3|db)|id_(rsa|ed25519).*|credentials?(\..*)?|settings\.json|stats\.json|ledger\.json|.*keys[-_]?bundle.*|.*chat[-_]?export.*)$/i;
const PRIVATE = process.env.PRIVATE_TERMS ? new RegExp(process.env.PRIVATE_TERMS, "gi") : null;

const problems = [];
for (const f of files) {
  if (BAD_NAMES.test(f)) problems.push(`${f}: file type that must never be committed`);
  let buf;
  try { buf = fs.readFileSync(f); } catch { continue; }
  if (buf.length > 5_000_000 || buf.subarray(0, 8000).includes(0)) continue;   // binaries / big data packs
  const text = buf.toString("utf8");
  for (const [name, rx] of SECRETS) for (const m of text.matchAll(rx)) {
    if (/FAKE|EXAMPLE|xxxx|0000000000/i.test(m[0])) continue;                    // deliberate test placeholders
    problems.push(`${f}: ${name} (${m[0].slice(0, 6)}…)`);
  }
  for (const m of text.matchAll(EMAIL)) if (!EMAIL_OK.test(m[0]) && !/\.(png|svg|js|mjs|css)$/i.test(m[0])) problems.push(`${f}: email address (${m[0].replace(/^(.).*@/, "$1…@")})`);
  if (PRIVATE) for (const m of text.matchAll(PRIVATE)) problems.push(`${f}: private project term (${m[0].slice(0, 3)}…)`);
}
if (problems.length) {
  for (const p of problems) console.log(`::error::privacy guard: ${p}`);
  console.error(`${problems.length} privacy problem(s) — remove them before merging.`);
  process.exit(1);
}
console.log(`privacy guard: ${files.length} tracked files clean${PRIVATE ? " (incl. private terms)" : " (PRIVATE_TERMS secret not set: private names not checked)"}`);
