// The phone's workspace for Agent mode and the Files tab: Documents/MyChat (visible in the phone's Files app).
// Native: @capacitor/filesystem. In a plain browser (self-test, desktop preview): the browser's private file store (OPFS),
// or memory as a last resort. All three expose the adapter core/agent.mjs expects.
import { memoryFs } from "./core/agent.mjs";

const FS = () => globalThis.Capacitor?.Plugins?.Filesystem;
export const WORKSPACE = "MyChat";

function nativeFs() {
  const P = FS();
  const at = (rel) => ({ path: rel ? `${WORKSPACE}/${rel}` : WORKSPACE, directory: "DOCUMENTS" });
  const exists = async (rel) => { try { await P.stat(at(rel)); return true; } catch { return false; } };
  return {
    kind: "Documents/MyChat",
    async ready() { if (!(await exists(""))) await P.mkdir({ ...at(""), recursive: true }); },
    async list(rel) {
      const r = await P.readdir(at(rel));
      return r.files.map((f) => ({ name: f.name, dir: f.type === "directory", size: f.type === "file" ? f.size : undefined }));
    },
    async read(rel) {
      try { const r = await P.readFile({ ...at(rel), encoding: "utf8" }); return typeof r.data === "string" ? r.data : null; } catch { return null; }
    },
    async write(rel, text) { await P.writeFile({ ...at(rel), data: text, encoding: "utf8", recursive: true }); },
    async writeBase64(rel, b64) { await P.writeFile({ ...at(rel), data: b64, recursive: true }); },
    async mkdir(rel) { await P.mkdir({ ...at(rel), recursive: true }); },
    exists,
    async move(a, b) { await P.rename({ from: at(a).path, to: at(b).path, directory: "DOCUMENTS", toDirectory: "DOCUMENTS" }); },
    async rmdirEmpty(rel) {
      const r = await P.readdir(at(rel));
      if (r.files.length) throw new Error("not empty");
      await P.rmdir(at(rel));
    },
    async uri(rel) { return (await P.getUri(at(rel))).uri; },
  };
}

async function opfs() {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(WORKSPACE, { create: true });
  const walk = async (rel, { create = false, file = false } = {}) => {
    const parts = rel ? rel.split("/") : [];
    let d = root;
    for (let i = 0; i < parts.length - (file ? 1 : 0); i++) d = await d.getDirectoryHandle(parts[i], { create });
    return file ? { dir: d, name: parts.at(-1) } : d;
  };
  const exists = async (rel) => {
    try { const { dir, name } = await walk(rel, { file: true }); try { await dir.getFileHandle(name); return true; } catch { await dir.getDirectoryHandle(name); return true; } }
    catch { return !rel; }
  };
  const readText = async (rel) => { const { dir, name } = await walk(rel, { file: true }); return (await (await dir.getFileHandle(name)).getFile()).text(); };
  const writeText = async (rel, text) => {
    const { dir, name } = await walk(rel, { file: true, create: true });
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(text); await w.close();
  };
  const copyTree = async (a, b) => {
    const { dir, name } = await walk(a, { file: true });
    let isFile = true; try { await dir.getFileHandle(name); } catch { isFile = false; }
    if (isFile) { await writeText(b, await readText(a)); }
    else { await walk(b, { create: true }); for await (const [n] of (await walk(a)).entries()) await copyTree(a + "/" + n, b + "/" + n); }
    await dir.removeEntry(name, { recursive: true });
  };
  return {
    kind: "browser storage",
    async ready() {},
    async list(rel) {
      const out = [];
      for await (const [name, h] of (await walk(rel)).entries()) out.push({ name, dir: h.kind === "directory", size: h.kind === "file" ? (await h.getFile()).size : undefined });
      return out;
    },
    async read(rel) { try { return await readText(rel); } catch { return null; } },
    write: writeText,
    async mkdir(rel) { await walk(rel, { create: true }); },
    exists,
    move: copyTree,
    async rmdirEmpty(rel) {
      for await (const _ of (await walk(rel)).entries()) throw new Error("not empty");   // eslint-disable-line no-unused-vars
      const { dir, name } = await walk(rel, { file: true }); await dir.removeEntry(name);
    },
  };
}

let cached = null;
export async function workspace() {
  if (cached) return cached;
  if (FS()) cached = nativeFs();
  else { try { cached = await opfs(); } catch { cached = { ...memoryFs(), kind: "memory (not saved)", ready: async () => {} }; } }
  await cached.ready();
  return cached;
}
