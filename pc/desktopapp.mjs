// MyChat as a PC app: its own window (Edge app mode — no tabs, no address bar), a Desktop and Start-menu shortcut with
// MyChat's icon, and an installable web-app manifest. No extra runtime: Edge is part of Windows.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };

/** MyChat's icon, drawn in code: a rounded dark square, a blue chat bubble, a teal dot (the app's colours). */
export function iconPng(size = 256) {
  const px = Buffer.alloc(size * size * 4), s = size / 256;
  const set = (x, y, r, g, b, a = 255) => { const i = (y * size + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a; };
  const inRound = (x, y, x0, y0, x1, y1, rad) => {
    const cx = Math.min(Math.max(x, x0 + rad), x1 - rad), cy = Math.min(Math.max(y, y0 + rad), y1 - rad);
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad && x >= x0 && x <= x1 && y >= y0 && y <= y1;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const X = x / s, Y = y / s;
    if (!inRound(X, Y, 8, 8, 248, 248, 56)) continue;
    set(x, y, 16, 17, 20);                                                                     // background
    const bubble = inRound(X, Y, 52, 62, 204, 170, 40) || (X > 78 && X < 120 && Y > 160 && Y < 206 && (X - 78) > (Y - 160) * 0.9);
    if (bubble) set(x, y, 43, 91, 215);                                                        // blue bubble
    for (const cx of [96, 128, 160]) if ((X - cx) ** 2 + (Y - 116) ** 2 <= 13 * 13) set(x, y, 236, 236, 239);   // three dots
    if ((X - 200) ** 2 + (Y - 62) ** 2 <= 22 * 22) set(x, y, 93, 214, 196);                    // teal "online" dot
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** A Windows .ico holding PNG images (supported since Vista). */
export function icoFrom(pngs) {
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = 6 + 16 * pngs.length; const dirs = [];
  for (const { size, png } of pngs) {
    const d = Buffer.alloc(16); d[0] = size >= 256 ? 0 : size; d[1] = size >= 256 ? 0 : size; d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6);
    d.writeUInt32LE(png.length, 8); d.writeUInt32LE(off, 12); off += png.length; dirs.push(d);
  }
  return Buffer.concat([head, ...dirs, ...pngs.map((p) => p.png)]);
}

export const manifest = (url) => ({ name: "MyChat", short_name: "MyChat", start_url: url, scope: url, display: "standalone",
  background_color: "#101114", theme_color: "#101114", icons: [{ src: "/ui/icon.png", sizes: "256x256", type: "image/png" }] });

function edgePath() {
  for (const p of ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]) if (fs.existsSync(p)) return p;
  return null;
}

/** Desktop + Start-menu shortcuts that open MyChat in its own window. Returns the paths written. */
export function installShortcuts({ home, url }) {
  if (process.platform !== "win32") return Promise.reject(new Error("the PC app is for Windows"));
  const edge = edgePath();
  if (!edge) return Promise.reject(new Error("Microsoft Edge was not found"));
  const ico = path.join(home, "MyChat.ico");
  fs.writeFileSync(ico, icoFrom([16, 32, 48, 256].map((size) => ({ size, png: iconPng(size) }))));
  // the normal Edge profile: your sign-ins (Open WebUI, Google on the key pages) work inside the app window too
  const args = `--app=${url} --window-size=1360,900`;
  const q = (x) => x.replace(/'/g, "''");
  const ps = ["Desktop", "Programs"].map((where) =>
    `$p=[Environment]::GetFolderPath('${where === "Desktop" ? "Desktop" : "Programs"}'); $l=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $p 'MyChat.lnk')); ` +
    `$l.TargetPath='${q(edge)}'; $l.Arguments='${q(args)}'; $l.IconLocation='${q(ico)},0'; $l.Description='MyChat — your models, agent and accounts'; $l.Save(); Write-Output (Join-Path $p 'MyChat.lnk')`).join("; ");
  return new Promise((ok, no) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 30000, windowsHide: true },
    (e, out) => (e ? no(new Error("could not create the shortcuts: " + e.message)) : ok({ shortcuts: String(out).trim().split(/\r?\n/).filter(Boolean), icon: ico }))));
}

/** Open the app window now. */
export function launch({ home, url }) {
  const edge = edgePath();
  if (!edge) throw new Error("Microsoft Edge was not found");
  execFile(edge, [`--app=${url}`, "--window-size=1360,900"], { windowsHide: false }).unref?.();
}

/** The Open WebUI app installed on this PC (a browser web-app shortcut, e.g. from Edge or Avast Browser): open the
 *  chat in it instead of a browser tab. Returns the shortcut used, or null when there is none. */
export function findChatApp() {
  if (process.platform !== "win32") return null;
  const roots = [path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(process.env.ProgramData || "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(process.env.USERPROFILE || "", "Desktop"), path.join(process.env.USERPROFILE || "", "OneDrive")];
  const walk = (d, depth) => {
    let items = []; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    for (const it of items) if (it.isFile() && /^open ?webui.*\.lnk$/i.test(it.name)) return path.join(d, it.name);
    if (depth > 0) for (const it of items) if (it.isDirectory() && !/^(node_modules|\.)/.test(it.name)) { const f = walk(path.join(d, it.name), depth - 1); if (f) return f; }
    return null;
  };
  for (const r of roots) { const f = walk(r, r.endsWith("OneDrive") ? 1 : 3); if (f) return f; }
  return null;
}
export function openChatApp() {
  const lnk = findChatApp();
  if (!lnk) return null;
  execFile("cmd.exe", ["/c", "start", "", lnk], { windowsHide: true });
  return lnk;
}
