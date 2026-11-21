// Agent mode on the PC: a folder on disk as the small fs adapter core/agent.mjs expects.
// Every path is resolved inside the root and checked again after resolving (symlinks and junctions included).
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { safeRel } from "../core/agent.mjs";

const DENY = [process.env.MYCHAT_HOME || path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "MyChat"), path.join(os.homedir(), ".ssh")]
  .map((d) => path.resolve(d).toLowerCase());
export function nodeFs(root) {
  const base = path.resolve(root);
  let realBase = null;
  const abs = async (rel) => {
    const r = rel === "" ? "" : safeRel(rel) ?? (/^\.mychat-trash(\/[^\\]+)?$/.test(rel) && !rel.split("/").includes("..") ? rel : null);
    if (r == null) throw new Error("path outside the workspace: " + rel);
    const p = path.resolve(base, r);
    if (p !== base && !p.startsWith(base + path.sep)) throw new Error("path outside the workspace: " + rel);
    // MyChat's own data (keys, tokens, settings) is never readable by the agent, even inside a broad folder like C:\Users\you
    for (const d of DENY) if (p.toLowerCase() === d || p.toLowerCase().startsWith(d + path.sep)) throw new Error("protected: MyChat's own data");
    // a symlink or junction inside the folder must not lead outside it: check the deepest part that exists
    realBase ||= await fs.realpath(base);
    let probe = p;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (real !== realBase && !real.startsWith(realBase + path.sep)) throw new Error("link leads outside the workspace: " + rel);
        break;
      } catch (e) {
        if (e.message.startsWith("link leads")) throw e;
        if (probe === base) break;
        probe = path.dirname(probe);
      }
    }
    return p;
  };
  return {
    root: base,
    async list(rel) {
      const ents = await fs.readdir(await abs(rel), { withFileTypes: true });
      const out = [];
      for (const e of ents) {
        if (e.name === ".mychat-trash" && !rel) { out.push({ name: e.name, dir: true }); continue; }
        let size;
        if (e.isFile()) { try { size = (await fs.stat(path.join(await abs(rel), e.name))).size; } catch { /* gone */ } }
        out.push({ name: e.name, dir: e.isDirectory(), size });
      }
      return out;
    },
    async read(rel) {
      const p = await abs(rel);
      const st = await fs.stat(p).catch(() => null);
      if (!st || !st.isFile() || st.size > 5_000_000) return null;
      const buf = await fs.readFile(p);
      if (buf.subarray(0, 8000).includes(0)) return null;   // binary
      return buf.toString("utf8");
    },
    async readBytes(rel) { const p = await abs(rel); const st = await fs.stat(p).catch(() => null); return st?.isFile() && st.size < 300_000_000 ? new Uint8Array(await fs.readFile(p)) : null; },
    async writeBytes(rel, u8) { await fs.writeFile(await abs(rel), u8); },
    async write(rel, text) { const p = await abs(rel); const tmp = p + ".mychat-tmp"; await fs.writeFile(tmp, text, "utf8"); await fs.rename(tmp, p); },
    async mkdir(rel) { await fs.mkdir(await abs(rel), { recursive: true }); },
    async exists(rel) { try { await fs.stat(await abs(rel)); return true; } catch { return false; } },
    async move(a, b) { await fs.rename(await abs(a), await abs(b)); },
    async rmdirEmpty(rel) { await fs.rmdir(await abs(rel)); },   // fails if not empty, by design
  };
}
