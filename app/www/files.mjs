// The phone's workspace for Agent mode and the Files tab: Documents/MyChat (visible in the phone's Files app).
// Native: @capacitor/filesystem. In a plain browser (self-test, desktop preview): the browser's private file store (OPFS),
// or memory as a last resort. All three expose the adapter core/agent.mjs expects.
import { memoryFs } from "./core/agent.mjs";
import { isZip, isArchiveName, extractZip } from "./core/zip.mjs";
const toB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

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
    async readBytes(rel) { try { const r = await P.readFile(at(rel)); return typeof r.data === "string" ? fromB64(r.data) : new Uint8Array(await r.data.arrayBuffer()); } catch { return null; } },
    async writeBytes(rel, u8) { await P.writeFile({ ...at(rel), data: toB64(u8), recursive: true }); },
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
    if (isFile) { const h = await dir.getFileHandle(name); const { dir: d2, name: n2 } = await walk(b, { file: true, create: true });
      const w = await (await d2.getFileHandle(n2, { create: true })).createWritable(); await w.write(await (await h.getFile()).arrayBuffer()); await w.close(); }
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
    async readBytes(rel) { try { const { dir, name } = await walk(rel, { file: true }); return new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer()); } catch { return null; } },
    async writeBytes(rel, u8) { const { dir, name } = await walk(rel, { file: true, create: true }); const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(u8); await w.close(); },
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

// ---------------------------------------------------------------- tidy imports
// Everything you add goes to Inbox/<date>/; an archive (.zip, .apk…) is also unpacked into Projects/<name>/ so models
// can read it. Names never clash: "report (2).pdf", "Projects/app-2".
const TEXT_NAME = /\.(md|markdown|txt|csv|tsv|json|jsonl|js|mjs|cjs|ts|tsx|jsx|py|html?|css|scss|xml|ya?ml|toml|ini|cfg|sh|ps1|bat|sql|java|kt|go|rs|c|h|cpp|cs|php|rb|swift|dart|svg|log)$/i;
export const today = () => new Date().toISOString().slice(0, 10);
export async function uniquePath(fs, rel) {
  if (!(await fs.exists(rel))) return rel;
  const m = /^(.*?)(\.[^./]+)?$/.exec(rel);
  for (let k = 2; k < 1000; k++) { const p = `${m[1]} (${k})${m[2] || ""}`; if (!(await fs.exists(p))) return p; }
  return rel + "-" + Date.now();
}
export async function importFiles(fs, fileList, { folder = `Inbox/${today()}`, unpack = true, onStatus = () => {} } = {}) {
  const saved = [], projects = [];
  if (!(await fs.exists(folder))) await fs.mkdir(folder);
  for (const f of fileList) {
    const name = f.name.replace(/[\\/:*?"<>|]/g, "_");
    const rel = await uniquePath(fs, `${folder}/${name}`);
    onStatus(`Saving ${name}…`);
    const bytes = new Uint8Array(await f.arrayBuffer());
    if ((TEXT_NAME.test(name) || /^text\//.test(f.type)) && !isZip(bytes)) await fs.write(rel, new TextDecoder().decode(bytes));
    else await fs.writeBytes(rel, bytes);
    saved.push(rel);
    if (unpack && (isArchiveName(name) || isZip(bytes)) && isZip(bytes)) {
      const base = name.replace(/\.[^.]+$/, "").replace(/[^\w.\- ()א-ת]/g, "_") || "archive";
      let to = `Projects/${base}`; for (let k = 2; await fs.exists(to); k++) to = `Projects/${base}-${k}`;
      if (!(await fs.exists("Projects"))) await fs.mkdir("Projects");
      onStatus(`Unpacking ${name}…`);
      try {
        const r = await extractZip(bytes, fs, to, { onProgress: (i, n) => onStatus(`Unpacking ${name}: ${i}/${n}`) });
        projects.push({ from: rel, to, files: r.files });
        // an APK inside the archive is itself a ZIP: unpack its app code too
        for (const it of await fs.list(to).catch(() => [])) {
          if (!it.dir && /\.apk$/i.test(it.name)) {
            const ab = await fs.readBytes(`${to}/${it.name}`);
            if (ab && isZip(ab)) { const r2 = await extractZip(ab, fs, `${to}/${it.name.replace(/\.apk$/i, "")}-apk`); projects.push({ from: `${to}/${it.name}`, to: `${to}/${it.name.replace(/\.apk$/i, "")}-apk`, files: r2.files }); }
          }
        }
      } catch (e) { projects.push({ from: rel, error: e.message }); }
    }
  }
  return { saved, projects };
}
