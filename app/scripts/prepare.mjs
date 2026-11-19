// Copies the shared engine (../../core) into www/core so the app runs exactly the code the PC gateway runs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../../core"), dst = path.resolve(here, "../www/core");
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
for (const f of fs.readdirSync(src)) if (f.endsWith(".mjs")) fs.copyFileSync(path.join(src, f), path.join(dst, f));
console.log("core copied:", fs.readdirSync(dst).join(", "));
