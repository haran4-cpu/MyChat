// A map of the workspace for the model: what each project is and where its real code lives, so the assistant starts
// from understanding instead of wandering through folders (measured: the agent spent its steps in an APK's kotlin/ data).
const read = async (fs, p) => { try { return await fs.read(p); } catch { return null; } };
const list = async (fs, p) => { try { return await fs.list(p); } catch { return []; } };
const has = (items, name) => items.some((i) => i.name === name);

/** Describe one folder: { path, kind, code: [paths], notes } */
export async function describeProject(fs, path) {
  const items = await list(fs, path);
  const out = { path, kind: "folder", code: [], notes: [] };
  const sub = (n) => `${path}/${n}`;
  // an unpacked Android app built with web code (Capacitor / Cordova): the code is in assets/public (or assets/www)
  for (const web of ["assets/public", "assets/www"]) {
    const w = await list(fs, sub(web));
    if (w.length) {
      out.kind = "Android app (unpacked APK, web-based)";
      out.code.push(sub(web));
      const cfg = await read(fs, sub("assets/capacitor.config.json"));
      if (cfg) { try { const c = JSON.parse(cfg); out.notes.push(`app id ${c.appId}, name ${c.appName}`); } catch { /* ignore */ } }
      const mods = w.filter((x) => !x.dir && /\.(m?js|html|css)$/.test(x.name)).map((x) => x.name);
      if (mods.length) out.notes.push(`files: ${mods.slice(0, 12).join(", ")}`);
      const core = await list(fs, sub(web + "/core"));
      if (core.length) out.notes.push(`core/: ${core.filter((x) => !x.dir).map((x) => x.name).slice(0, 15).join(", ")}`);
      return out;
    }
  }
  if (has(items, "classes.dex") || has(items, "AndroidManifest.xml")) { out.kind = "Android app (unpacked APK, compiled — no readable source)"; return out; }
  const pkg = await read(fs, sub("package.json"));
  if (pkg) {
    try {
      const j = JSON.parse(pkg);
      out.kind = "JavaScript/Node project" + (j.dependencies?.["@capacitor/core"] ? " (Capacitor mobile app)" : j.dependencies?.react ? " (React)" : "");
      out.notes.push(`name ${j.name || "?"}` + (j.scripts ? `, scripts: ${Object.keys(j.scripts).slice(0, 8).join(", ")}` : ""));
    } catch { out.kind = "JavaScript/Node project"; }
  } else if (has(items, "pyproject.toml") || has(items, "requirements.txt")) out.kind = "Python project";
  else if (has(items, "index.html")) out.kind = "Web page / site";
  for (const d of ["src", "app", "lib", "core", "www", "pc", "server"]) if (items.some((i) => i.dir && i.name === d)) out.code.push(sub(d));
  const readme = items.find((i) => /^readme/i.test(i.name));
  if (readme) { const t = await read(fs, sub(readme.name)); if (t) out.notes.push("README: " + t.replace(/\s+/g, " ").slice(0, 200)); }
  return out;
}

/** The whole workspace in a few lines: projects (with their code folders) and recent inbox files. */
export async function workspaceMap(fs) {
  const lines = [];
  const projects = (await list(fs, "Projects")).filter((x) => x.dir);
  if (projects.length) {
    lines.push("PROJECTS:");
    for (const p of projects.slice(0, 20)) {
      const d = await describeProject(fs, "Projects/" + p.name);
      lines.push(`- ${d.path} — ${d.kind}${d.code.length ? `; code in ${d.code.join(", ")}` : ""}${d.notes.length ? `; ${d.notes.join("; ")}` : ""}`);
    }
  }
  const days = (await list(fs, "Inbox")).filter((x) => x.dir).map((x) => x.name).sort().reverse().slice(0, 3);
  if (days.length) {
    lines.push("INBOX (newest first):");
    for (const d of days) for (const f of (await list(fs, "Inbox/" + d)).slice(0, 15)) lines.push(`- Inbox/${d}/${f.name}${f.dir ? "/" : ""}`);
  }
  const top = (await list(fs, "")).filter((x) => !["Projects", "Inbox", ".mychat-trash"].includes(x.name));
  if (top.length) lines.push("OTHER: " + top.slice(0, 30).map((x) => x.name + (x.dir ? "/" : "")).join(", "));
  return lines.join("\n") || "(the folder is empty)";
}

/** Does this message ask about the user's own files / projects / folder (so the assistant should look, not guess)? */
export const WORKSPACE_RX = /(קובץ|קבצים|תיקי|פרויקט|פרוייקט|הקוד|קוד שלי|אפליקציה שלי|האפליקציה|ריפו|zip|apk|\bfiles?\b|\bfolders?\b|\bproject|\brepo\b|\bmy (code|app)\b|\bthe (code|app)\b|Inbox|Projects\/|\.m?js\b|\.py\b|\.json\b)/i;
