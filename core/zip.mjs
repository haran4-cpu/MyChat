// ZIP reading without dependencies (phone WebView and Node 18+): stored and deflated entries, via DecompressionStream.
// Used to open uploaded archives (projects, an APK — which is a ZIP — so its code can be read) without unpacking by hand.
// Limits protect the phone: entry count, total size, and every name must stay inside the target folder (no "zip-slip").

export const ZIP_LIMITS = { files: 5000, totalBytes: 300 * 1024 * 1024, fileBytes: 60 * 1024 * 1024 };

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export const isZip = (bytes) => bytes?.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5);
export const isArchiveName = (name) => /\.(zip|apk|jar|aar|xpi|epub|docx|xlsx|pptx)$/i.test(name);

/** List entries: [{ name, size, compressed, method, offset, dir }] from the central directory. */
export function zipEntries(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a ZIP file (or damaged)");
  let n = u16(bytes, eocd + 10), p = u32(bytes, eocd + 16);
  if (n === 0xffff || p === 0xffffffff) throw new Error("ZIP64 archives are not supported yet");
  if (n > ZIP_LIMITS.files) throw new Error(`too many files in the archive (${n})`);
  const out = [], dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    if (u32(bytes, p) !== 0x02014b50) throw new Error("damaged ZIP directory");
    const method = u16(bytes, p + 10), compressed = u32(bytes, p + 20), size = u32(bytes, p + 24);
    const nl = u16(bytes, p + 28), xl = u16(bytes, p + 30), cl = u16(bytes, p + 32), offset = u32(bytes, p + 42);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nl));
    out.push({ name, size, compressed, method, offset, dir: name.endsWith("/") });
    p += 46 + nl + xl + cl;
  }
  return out;
}

async function inflateRaw(data) {
  const ds = new DecompressionStream("deflate-raw");
  const buf = await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}

/** Bytes of one entry. */
export async function zipRead(bytes, e) {
  const p = e.offset;
  if (u32(bytes, p) !== 0x04034b50) throw new Error("damaged ZIP entry " + e.name);
  const start = p + 30 + u16(bytes, p + 26) + u16(bytes, p + 28);
  const raw = bytes.subarray(start, start + e.compressed);
  if (e.size > ZIP_LIMITS.fileBytes) throw new Error(`${e.name} is too large (${e.size} bytes)`);
  if (e.method === 0) return raw.slice();
  if (e.method === 8) return inflateRaw(raw);
  throw new Error(`${e.name}: compression method ${e.method} not supported`);
}

/** A safe relative path for an entry name, or null (absolute, "..", drive letters). */
export function safeEntry(name) {
  const s = String(name).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!s || /^[a-zA-Z]:/.test(s)) return null;
  const parts = s.split("/").filter((x) => x && x !== ".");
  if (parts.some((x) => x === "..")) return null;
  return parts.join("/");
}

/** Extract everything into fs under `to` (text as text, binary as base64 when the fs supports it). Returns a summary. */
// In an APK only assets/ is readable app content (for a web-based app like MyChat: assets/public = its code);
// classes.dex, kotlin/, META-INF/, res/ (binary XML) and lib/*.so are machine data that only confuse readers.
export const APK_KEEP = (name) => /^assets\//.test(name);
export async function extractZip(bytes, fs, to, { onProgress, filter, apk } = {}) {
  let entries = zipEntries(bytes);
  if (apk == null) apk = entries.some((e) => e.name === "classes.dex" || e.name === "AndroidManifest.xml");
  const keep = filter || (apk ? APK_KEEP : null);
  const all = entries.length;
  if (keep) entries = entries.filter((e) => keep(e.name));
  const total = entries.reduce((a, e) => a + e.size, 0);
  if (total > ZIP_LIMITS.totalBytes) throw new Error(`the archive unpacks to ${Math.round(total / 1048576)} MB, over the ${ZIP_LIMITS.totalBytes / 1048576} MB limit`);
  let files = 0, skipped = 0, k = 0;
  if (!(await fs.exists(to))) await fs.mkdir(to);
  for (const e of entries) {
    k++;
    const rel = safeEntry(e.name);
    if (!rel) { skipped++; continue; }
    const target = to + "/" + rel;
    if (e.dir) { await fs.mkdir(target).catch(() => {}); continue; }
    const parent = target.split("/").slice(0, -1).join("/");
    if (parent && !(await fs.exists(parent))) await fs.mkdir(parent);
    const data = await zipRead(bytes, e);
    if (looksText(data)) await fs.write(target, new TextDecoder().decode(data));
    else if (fs.writeBytes) await fs.writeBytes(target, data);
    else { skipped++; continue; }
    files++;
    if (onProgress && k % 25 === 0) onProgress(k, entries.length);
  }
  return { files, skipped, entries: entries.length, left: all - entries.length, apk: !!apk, bytes: total };
}

/** Heuristic: no NUL bytes in the first 8 KB and it decodes as UTF-8. */
export function looksText(data) {
  const head = data.subarray(0, 8192);
  if (head.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true }); return true; } catch { return false; }
}

/** Build a ZIP in memory (stored, no compression) — used by tests and for exporting a folder. */
export function makeZip(files) {
  const enc = new TextEncoder(), parts = [], dir = [];
  let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? enc.encode(content) : content, nb = enc.encode(name), crc = crc32(data);
    const lh = new Uint8Array(30 + nb.length), v = new DataView(lh.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint32(14, crc, true); v.setUint32(18, data.length, true); v.setUint32(22, data.length, true); v.setUint16(26, nb.length, true);
    lh.set(nb, 30);
    const ch = new Uint8Array(46 + nb.length), w = new DataView(ch.buffer);
    w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true); w.setUint32(16, crc, true); w.setUint32(20, data.length, true); w.setUint32(24, data.length, true);
    w.setUint16(28, nb.length, true); w.setUint32(42, off, true); ch.set(nb, 46);
    parts.push(lh, data); dir.push(ch); off += lh.length + data.length;
  }
  const dsize = dir.reduce((a, d) => a + d.length, 0), end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, dir.length, true); e.setUint16(10, dir.length, true); e.setUint32(12, dsize, true); e.setUint32(16, off, true);
  const all = [...parts, ...dir, end], out = new Uint8Array(all.reduce((a, x) => a + x.length, 0));
  let p = 0; for (const x of all) { out.set(x, p); p += x.length; }
  return out;
}
let CRC;
function crc32(d) {
  CRC ||= Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let c = 0xffffffff; for (const b of d) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}
