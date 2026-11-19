// Tiny static server for trying the app in a desktop browser: node scripts/serve.mjs  ->  http://127.0.0.1:5173
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../www");
const types = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname.replace(/\/$/, "/index.html")));
  if (!p.startsWith(root) || !fs.existsSync(p)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": (types[path.extname(p)] || "application/octet-stream") + "; charset=utf-8" });
  fs.createReadStream(p).pipe(res);
}).listen(Number(process.env.PORT || 5173), "127.0.0.1", () => console.log("http://127.0.0.1:" + (process.env.PORT || 5173)));
