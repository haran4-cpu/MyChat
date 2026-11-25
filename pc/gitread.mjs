// Read-only git and GitHub for the agent. Nothing here can change a repository, run a hook or reach another account.
//   gitReader(root)  -> (repo, args) => text    only allow-listed read subcommands, hooks/fsmonitor/pager/external diff off
//   githubReader({owner, token}) -> (path) => text    GET only, only /repos/<owner>/..., /users/<owner>/repos
import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const READ = new Set(["log", "show", "diff", "status", "branch", "tag", "blame", "ls-files", "ls-tree", "rev-parse", "shortlog",
  "describe", "merge-base", "rev-list", "cat-file", "for-each-ref", "count-objects", "remote", "worktree", "stash"]);
const SUB_OK = { remote: /^(-v|--verbose|show|get-url)$/, worktree: /^list$/, stash: /^list$/, branch: /^(-a|-r|-v|-vv|--all|--list|--contains|--merged|--no-merged|--show-current|--sort=.*|--format=.*|[\w./-]+)$/,
  tag: /^(-l|--list|-n\d*|--contains|--sort=.*|--format=.*|[\w./*-]+)$/, "cat-file": /^(-t|-s|-p|[0-9a-f]{4,64}(:[\w./-]+)?|[\w./-]+:[\w./ -]+)$/ };
// options that write files, run programs or change config are refused everywhere
const BAD = /^(--output|-o$|--ext-diff|--textconv|--exec|--upload-pack|--receive-pack|--config|-c$|--git-dir|--work-tree|--namespace|--open-files-in-pager|--paginate)/;
const BAD_EXACT = new Set(["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "--set-upstream-to", "--unset-upstream", "--edit-description", "-f", "--force", "-u",
  "add", "rm", "rename", "set-url", "prune", "drop", "pop", "apply", "clear", "push", "create", "remove", "lock", "unlock", "repair"]);

export function gitReader(root, { exec = execFile } = {}) {
  const base = path.resolve(root);
  return (repo, args) => new Promise((resolve) => {
    if (!Array.isArray(args) || !args.length || args.length > 40 || args.some((a) => typeof a !== "string" || a.length > 300 || /[\r\n\0]/.test(a)))
      return resolve("git: give args as a list, e.g. [\"log\",\"--oneline\",\"-20\"]");
    const [cmd, ...rest] = args;
    if (!READ.has(cmd)) return resolve(`git: only read commands are allowed (${[...READ].join(", ")})`);
    const bad = rest.find((a) => BAD.test(a) || (SUB_OK[cmd] && !SUB_OK[cmd].test(a) && !a.startsWith("--format")) || BAD_EXACT.has(a) && cmd !== "log" && cmd !== "show" && cmd !== "diff");
    if (bad) return resolve(`git: "${bad}" is not allowed here (read-only)`);
    const dir = path.resolve(base, String(repo || "."));
    if (dir !== base && !dir.startsWith(base + path.sep)) return resolve("git: the repository must be inside the workspace");
    if (!fs.existsSync(path.join(dir, ".git")) && !fs.existsSync(path.join(dir, "HEAD"))) return resolve(`git: ${repo} is not a git repository`);
    const safe = ["-C", dir, "--no-pager", "-c", "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"), "-c", "core.fsmonitor=false",
      "-c", "diff.external=", "-c", "core.pager=cat", "-c", "credential.helper=", "-c", "protocol.allow=never"];
    const extra = ["log", "show", "diff"].includes(cmd) ? ["--no-ext-diff", "--no-textconv"] : [];
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k))), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" };
    exec("git", [...safe, cmd, ...extra, ...rest], { env, timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const out = String(stdout || "") + (err ? "\n[git] " + String(stderr || err.message).slice(0, 500) : "");
      resolve(out.length > 30000 ? out.slice(0, 30000) + "\n…(cut; narrow the command)" : out || "(no output)");
    });
  });
}

const DROP = /(_url|^url|node_id|gravatar_id|^avatar|_links|^permissions|^reactions)$/;
function compact(v, depth = 0) {
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => compact(x, depth + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !DROP.test(k)).map(([k, x]) => [k, depth > 4 ? "…" : compact(x, depth + 1)]));
  return typeof v === "string" && v.length > 600 ? v.slice(0, 600) + "…" : v;
}

export function githubReader({ owner, token, fetchImpl = fetch }) {
  const allowed = new RegExp(`^/(repos/${owner}/[\\w.-]+(/[\\w./%=&?,:-]*)?|users/${owner}/repos(\\?[\\w=&]*)?)$`, "i");
  return async (p) => {
    const pathname = String(p || "");
    if (!allowed.test(pathname)) return `github: only GET /repos/${owner}/<repo>/... or /users/${owner}/repos`;
    if (!token) return "github: no read key is configured on this PC";
    try {
      const r = await fetchImpl("https://api.github.com" + pathname, { headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json",
        "User-Agent": "MyChat-agent", "X-GitHub-Api-Version": "2022-11-28" }, redirect: "error", signal: AbortSignal.timeout(20000) });
      const body = await r.text();
      if (!r.ok) return `github: HTTP ${r.status} ${body.slice(0, 200)}`;
      let out;
      try { out = JSON.stringify(compact(JSON.parse(body))); } catch { out = body; }
      return out.length > 30000 ? out.slice(0, 30000) + "…(cut; use per_page or a narrower path)" : out;
    } catch (e) { return "github: " + e.message; }
  };
}
