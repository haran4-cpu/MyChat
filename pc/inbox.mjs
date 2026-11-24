import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function receiveAttachment(req, root, name) {
  const size = Number(req.headers["content-length"]);
  const digest = String(req.headers["x-content-sha256"] || "");
  if (!Number.isSafeInteger(size) || size < 0 || !/^[0-9a-f]{64}$/.test(digest)) throw new Error("Missing upload length or SHA-256.");
  if (!name || name !== path.win32.basename(name) || /[<>:"|?*\x00-\x1f]/.test(name) || /[ .]$/.test(name) || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(name) || name.length > 180) throw new Error("Unsupported attachment name.");
  const base = await fs.realpath(root);
  let dir = base;
  for (const component of ["Inbox", new Date().toISOString().slice(0,10)]) {
    dir = path.join(dir, component);
    try { await fs.mkdir(dir); } catch (error) { if (error.code !== "EEXIST") throw error; }
    if (path.relative(base,await fs.realpath(dir)) !== path.relative(base,dir)) throw new Error("Inbox points outside the selected directory.");
  }
  const tmp = path.join(dir, "." + crypto.randomUUID() + ".partial");
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const handle = await fs.open(tmp, "wx");
  try {
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > size) throw new Error("Received more data than declared.");
        hash.update(chunk);
        await handle.writeFile(chunk);
      }
      if (bytes !== size || hash.digest("hex") !== digest) throw new Error("Incomplete upload or SHA-256 mismatch.");
      await handle.sync();
    } finally { await handle.close(); }
    const {name: stem, ext} = path.parse(name);
    for (let i=1; ; i++) {
      const target = path.join(dir,i===1 ? name : stem + " (" + i + ")" + ext);
      try { await fs.link(tmp,target); return {path:path.relative(base,target).split(path.sep).join("/"),root,bytes,sha256:digest}; }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
  } finally { await fs.unlink(tmp).catch(() => {}); }
}
