import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import os from "node:os";

const stateDir = () => path.join(process.env.MYCHAT_HOME || path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "MyChat"), "terminal-receipts");
const ticketFile = id => path.join(stateDir(), id + ".json");
const boot = crypto.randomUUID();
function saveTicket(ticket) {
  const temp = ticketFile(ticket.id) + "." + crypto.randomUUID() + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(ticket), {flag: "wx", mode: 0o600});
  fs.renameSync(temp, ticketFile(ticket.id));
}
const lifetime = 15 * 60_000;
const hunterLauncher = fileURLToPath(new URL("./launch-hunter.mjs", import.meta.url));
const hunterRequest = /^(?:\/hunter start|(?:start|launch|run) (?:the )?hunter|(?:הפעל|תפעיל|הרץ|תריץ|פתח)(?: לי)? (?:את )?(?:הצייד|hunter))(?:[.! ]*)$/iu;

export function terminalRequest(text) {
  if (hunterRequest.test(text.trim())) return `"${process.execPath}" "${hunterLauncher}"`;
  return /^\/terminal\s+([^\r\n]+)$/i.exec(text.trim())?.[1];
}

export function prepareTerminal(root, command, port) {
  if (typeof command !== "string" || !command.trim() || command.length > 4000 || /[\r\n\0]/.test(command)) throw new Error("Expected a single Windows command line.");
  fs.mkdirSync(stateDir(), {recursive: true});
  let pending = 0;
  for (const f of fs.readdirSync(stateDir())) {
    if (!/^[a-f0-9-]{36}\.json$/.test(f)) continue;
    const record = JSON.parse(fs.readFileSync(path.join(stateDir(), f), "utf8"));
    if (Date.now() - record.at > 7 * 86400000) {
      fs.rmSync(ticketFile(record.id), {force:true});
      fs.rmSync(ticketFile(record.id) + ".claim", {force:true});
    } else if (record.state === "pending" && Date.now() - record.at < lifetime) pending++;
  }
  if (pending >= 128) throw new Error("Too many pending command reviews.");
  const id = crypto.randomUUID();
  const ticket = { id, root, command, at: Date.now(), state: "pending", url: `http://127.0.0.1:${port}/#terminal?id=${id}` };
  saveTicket(ticket);
  return ticket;
}

export function terminalTicket(id) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id) || !fs.existsSync(ticketFile(id))) throw new Error("Unknown command review.");
  const ticket = JSON.parse(fs.readFileSync(ticketFile(id), "utf8"));
  if (ticket.state === "pending" && Date.now() - ticket.at > lifetime) ticket.state = "expired";
  if ((ticket.state === "running" && ticket.boot !== boot) || (ticket.state === "pending" && fs.existsSync(ticketFile(id) + ".claim"))) {
    ticket.state = "unconfirmed";
    ticket.output = "The gateway restarted after approval. Check the result before proposing another command.";
  }
  return ticket;
}

export async function executeTerminal(id) {
  const t = terminalTicket(id);
  if (t.state !== "pending") throw new Error("This command has already been submitted.");
  fs.writeFileSync(ticketFile(id) + ".claim", "", {flag: "wx", mode: 0o600});
  t.state = "running";
  t.boot = boot;
  saveTicket(t);
  try {
    const key = fs.readFileSync(path.join(process.env.KESTREL_HOME || "C:/AI-Workspace/Kestrel", "state/api_token"), "utf8").trim();
    const r = await fetch("http://127.0.0.1:8765/tools/run_command", {
      method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ command: t.command, cwd: t.root, timeout: 150 }), signal: AbortSignal.timeout(155000)
    });
    if (!r.ok) throw new Error("Kestrel returned HTTP " + r.status);
    const reply = await r.json();
    t.output = String(reply.result);
    t.state = reply.ok && /^exit code 0(?:\r?\n|$)/.test(t.output) ? "passed" : "failed";
  } catch (error) {
    t.state = "unconfirmed";
    t.output = error.message;
  }
  saveTicket(t);
  return t;
}
