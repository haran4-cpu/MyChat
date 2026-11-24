// Reads a secret from the Windows Credential Manager (generic credential) by target name, for connectors that accept a
// token. The value goes only to the caller in memory: never logged, written to disk, or returned by an HTTP route.
import { execFile } from "node:child_process";

const SCRIPT = `
$ErrorActionPreference='Stop'
$sig=@'
using System; using System.Runtime.InteropServices;
public static class MyChatCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct C { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten;
    public int BlobSize; public IntPtr Blob; public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredReadW(string t, int type, int flags, out IntPtr c);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);
}
'@
Add-Type -TypeDefinition $sig
$target=[Console]::In.ReadLine()
$p=[IntPtr]::Zero
if(-not [MyChatCred]::CredReadW($target,1,0,[ref]$p)){ exit 3 }
try {
  $c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[type][MyChatCred+C])
  $b=New-Object byte[] $c.BlobSize
  [Runtime.InteropServices.Marshal]::Copy($c.Blob,$b,0,$c.BlobSize)
  $s= if($b -contains 0){[Text.Encoding]::Unicode.GetString($b)} else {[Text.Encoding]::ASCII.GetString($b)}
  [Console]::Out.Write($s.TrimEnd([char]0))
} finally { [MyChatCred]::CredFree($p) }
`;

/** Resolves to the secret, or null when the credential does not exist / this is not Windows. */
export function readCredential(target, { exec = execFile, platform = process.platform } = {}) {
  if (platform !== "win32" || typeof target !== "string" || !target || target.length > 512 || /[\r\n]/.test(target)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT],
      { windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024 }, (err, stdout) => {
        const v = String(stdout || "").trim();
        resolve(!err && v ? v : null);
      });
    child.stdin?.end(target + "\n");
  });
}

const WRITE = `
$ErrorActionPreference='Stop'
$sig=@'
using System; using System.Runtime.InteropServices;
public static class MyChatCredW {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct C { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten;
    public int BlobSize; public IntPtr Blob; public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWriteW(ref C c, int flags);
}
'@
Add-Type -TypeDefinition $sig
$target=[Console]::In.ReadLine(); $secret=[Console]::In.ReadLine()
$b=[Text.Encoding]::Unicode.GetBytes($secret)
$p=[Runtime.InteropServices.Marshal]::AllocHGlobal($b.Length)
try {
  [Runtime.InteropServices.Marshal]::Copy($b,0,$p,$b.Length)
  $c=New-Object MyChatCredW+C; $c.Type=1; $c.TargetName=$target; $c.BlobSize=$b.Length; $c.Blob=$p; $c.Persist=2; $c.UserName='MyChat'
  if(-not [MyChatCredW]::CredWriteW([ref]$c,0)){ exit 4 }
  [Console]::Out.Write('ok')
} finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($p) }
`;

/** Saves a secret as a generic Windows credential (target and secret over stdin, never on the command line). */
export function writeCredential(target, secret, { exec = execFile, platform = process.platform } = {}) {
  const bad = (v, max) => typeof v !== "string" || !v || v.length > max || /[\r\n]/.test(v);
  if (platform !== "win32" || bad(target, 512) || bad(secret, 4096)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WRITE],
      { windowsHide: true, timeout: 20000, maxBuffer: 1024 }, (err, stdout) => resolve(!err && String(stdout).trim() === "ok"));
    child.stdin?.end(target + "\n" + secret + "\n");
  });
}
