// Command line for tools that are not JavaScript (Kestrel, the local agent):
//   node pc/proof-cli.mjs page <file.html> [clicks]   → runs the app in a headless browser, prints the report
//   node pc/proof-cli.mjs outline <file>              → prints the parser-built map of the file
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPage } from "./pagecheck.mjs";
import { outline, outlineText } from "../core/codemap.mjs";

const [cmd, file, n] = process.argv.slice(2);
if (cmd === "page") {
  const home = process.env.MYCHAT_HOME || path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "MyChat");
  const r = await checkPage(file, { clicks: Number(n) || 25, outDir: path.join(home, "runs") });
  console.log(r.text);
} else if (cmd === "outline") {
  console.log(outlineText(outline(fs.readFileSync(file, "utf8"), file), Number(n) || 400));
} else {
  console.log("usage: proof-cli.mjs page <file.html> [clicks] | outline <file>");
  process.exitCode = 2;
}
