import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dpapiScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$data = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
$result = if ($env:MYCHAT_DPAPI_ENCRYPT -eq '1') {
    [Security.Cryptography.ProtectedData]::Protect($data, $null, $scope)
} else {
    [Security.Cryptography.ProtectedData]::Unprotect($data, $null, $scope)
}
[Console]::Write([Convert]::ToBase64String($result))
`;
function dpapi(data, encrypt) {
  return new Promise((resolve, reject) => {
    const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = spawn(exe, ["-NoProfile", "-NonInteractive", "-Command", dpapiScript], {
      env: { ...process.env, MYCHAT_DPAPI_ENCRYPT: encrypt ? "1" : "0" },
      windowsHide: true, stdio: ["pipe", "pipe", "ignore"], timeout: 12000,
    });
    let output = "";
    child.stdout.setEncoding("ascii");
    child.stdout.on("data", chunk => { output += chunk; });
    child.stdin.on("error", reject);
    child.on("error", reject);
    child.on("close", code => code === 0 && output ? resolve(Buffer.from(output, "base64")) : reject(new Error("Windows credential protection failed.")));
    child.stdin.end(Buffer.from(data).toString("base64"));
  });
}

export function createPlanConnector(home) {
  let sdk, openConsent, signIn, catalog;
  const client = () => sdk ??= import(pathToFileURL(path.join(home, "siwc-sdk", "dist", "index.js")).href)
    .then(({createChatGPT}) => createChatGPT({
      appName: "MyChat", appId: "mychat", sendHostId: true, redirectPort: 0,
      storageDir: path.join(home, "chatgpt-plan"),
      credentialEncryption: {
        id: "windows-dpapi-current-user-v1",
        isAvailable: () => process.platform === "win32",
        encrypt: plaintext => dpapi(plaintext, true),
        decrypt: async ciphertext => (await dpapi(ciphertext, false)).toString("utf8"),
      },
      openBrowser: url => {
        if (new URL(url).origin !== "https://auth.openai.com" || !openConsent) throw new Error("Unexpected ChatGPT sign-in request.");
        openConsent(url);
      },
    }));
  async function status() {
    let c;
    try { c = await client(); } catch { return { status: "unavailable", sharing: false }; }
    const {status, sharing, identity, error} = await c.getSession();
    return { status, sharing, account: identity?.email, error: error?.message };
  }
  async function models() {
    const s = await status();
    if (!s.sharing || s.status !== "connected") return [];
    if (catalog && Date.now() < catalog.until) return catalog.models;
    const available = await (await client()).listModels({signal:AbortSignal.timeout(10000)});
    catalog = {until:Date.now()+60000, models:available};
    return available;
  }
  async function start() {
    const c = await client();
    if (signIn) throw new Error("A ChatGPT sign-in is already in progress.");
    const s = await c.getSession();
    if (s.sharing && s.status === "connected") throw new Error("ChatGPT plan usage is already connected.");
    if (signIn) throw new Error("A ChatGPT sign-in is already in progress.");
    const signal = AbortSignal.timeout(300000);
    return new Promise((resolve,reject) => {
      openConsent = url => resolve({url});
      catalog = null;
      signIn = c.signIn({signal,reconsent:s.status !== "disconnected"}).then(
        () => reject(new Error("Sign-in completed without opening a browser.")),
        reject,
      ).finally(() => { signIn = null; openConsent = null; });
    });
  }
  async function disconnect() {
    catalog = null;
    await (await client()).disconnect();
    return status();
  }
  async function answer(model, req, options) {
    if (req.tools?.length || req.response_format || req.messages.some(m => typeof m.content !== "string" || !["system","developer","user","assistant"].includes(m.role))) {
      throw new Error("ChatGPT plan mode currently supports text conversations.");
    }
    if (!(await models()).some(m => m.slug === model)) throw new Error("Connect ChatGPT and choose a model available to your plan.");
    const {text} = await (await client()).streamResponse({
      model,
      instructions: req.messages.filter(m => m.role === "system").map(m => m.content).join("\n\n") || undefined,
      input: req.messages.filter(m => m.role !== "system"),
      signal: options.signal, onDelta: options.onDelta,
    });
    return {content:text, provider:"chatgpt-plan", model, mode:"chatgpt-plan", trace:[{step:"answer",by:"chatgpt-plan:"+model}]};
  }
  return { status, models, start, disconnect, answer, cancel: async () => (await client()).cancelSignIn() };
}
