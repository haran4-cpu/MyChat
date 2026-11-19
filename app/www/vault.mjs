// Keys at rest: AES-GCM encrypted with a key the app can USE but never read out (non-extractable CryptoKey kept in
// IndexedDB). Only ciphertext is in localStorage. Nothing leaves the phone.
const DB = "mychat-vault", STORE = "k", SLOT = "mychat.keys.v1";

function idb() {
  return new Promise((ok, bad) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
}
async function idbGet(k) {
  const db = await idb();
  return new Promise((ok, bad) => { const t = db.transaction(STORE).objectStore(STORE).get(k); t.onsuccess = () => ok(t.result); t.onerror = () => bad(t.error); });
}
async function idbPut(k, v) {
  const db = await idb();
  return new Promise((ok, bad) => { const t = db.transaction(STORE, "readwrite").objectStore(STORE).put(v, k); t.onsuccess = () => ok(); t.onerror = () => bad(t.error); });
}
async function masterKey() {
  let k = await idbGet("aes");
  if (!k) {
    k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await idbPut("aes", k);
  }
  return k;
}
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function loadKeys() {
  const raw = localStorage.getItem(SLOT);
  if (!raw) return {};
  try {
    const [iv, ct] = raw.split(".");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await masterKey(), unb64(ct));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch { return {}; }
}

export async function saveKeys(keys) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await masterKey(), new TextEncoder().encode(JSON.stringify(keys))));
  localStorage.setItem(SLOT, b64(iv) + "." + b64(ct));
}
