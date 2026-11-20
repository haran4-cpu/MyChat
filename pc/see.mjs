// Seeing: a picture of the screen (only when the person asks for it) or of an app run, answered by a vision model.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Capture the whole screen to a PNG (Windows: PowerShell + .NET; nothing is kept after the answer). */
export function captureScreen(outDir = os.tmpdir()) {
  const f = path.join(outDir, `screen-${Date.now()}.png`);
  if (process.platform !== "win32") return Promise.reject(new Error("screen capture is available on the Windows PC"));
  const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; ` +
    `$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); ` +
    `$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save('${f.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`;
  return new Promise((ok, no) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 20000, windowsHide: true },
    (e) => (e || !fs.existsSync(f) ? no(new Error("could not capture the screen" + (e ? ": " + e.message : ""))) : ok(f))));
}

/** Ask a vision model about an image file. */
export async function askImage(gw, file, question, { signal } = {}) {
  const b = fs.readFileSync(file);
  if (b.length > 15e6) throw new Error("image too large");
  const r = await gw.chat({ temperature: 0.1, messages: [{ role: "user", content: [
    { type: "text", text: `${question || "Describe what is on this screen."}\nAnswer precisely; say what you can actually see, and say so when something is too small or unclear to read.` },
    { type: "image_url", image_url: { url: "data:image/png;base64," + b.toString("base64") } }] }] }, { task: "vision", signal });
  return `SEEN by ${r.model} (${path.basename(file)}):\n${r.content}`;
}
