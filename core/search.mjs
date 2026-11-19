// MyChat — web evidence. One interface over several search providers; results carry the full page text when it
// can be fetched, so a quote can be checked against what the page really says (deterministically, by string match).
//   wikipedia  keyless, always on (Hebrew questions also search he.wikipedia)
//   brave      Brave Search API          key: X-Subscription-Token
//   tavily     Tavily (built for agents)  key in body
//   serper     Google results via Serper  key: X-API-KEY
//   google     Google Programmable Search JSON API  key "API_KEY|CX"
//   exa        Exa neural search          key: x-api-key
//   jina       Jina Reader for page text (optional key, works without one at low rate)

export const SEARCH_PROVIDERS = {
  brave: { name: "Brave Search", keyUrl: "https://api-dashboard.search.brave.com/app/keys", note: "Independent index · free tier" },
  tavily: { name: "Tavily", keyUrl: "https://app.tavily.com/home", note: "Built for AI agents · free monthly quota · Google sign-in" },
  serper: { name: "Serper (Google results)", keyUrl: "https://serper.dev/api-key", note: "Google results · free starter credits · Google sign-in" },
  google: { name: "Google Programmable Search", keyUrl: "https://developers.google.com/custom-search/v1/introduction", note: "Your Google account · free daily quota · paste as API_KEY|SEARCH_ENGINE_ID" },
  exa: { name: "Exa", keyUrl: "https://dashboard.exa.ai/api-keys", note: "Neural search · free credits · Google sign-in" },
  jina: { name: "Jina Reader", keyUrl: "https://jina.ai/api-dashboard/key-manager", note: "Reads full pages for evidence · optional key" },
};

const isHebrew = (s) => /[֐-׿]/.test(s);

export function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

export const norm = (s) => String(s || "").toLowerCase().normalize("NFKC").replace(/[‘’“”"'`]/g, "").replace(/[^\p{L}\p{N}%.]+/gu, " ").replace(/\s+/g, " ").trim();

/** Does `quote` really appear in `text`? Normalised (case, quotes, punctuation, spacing); allows "…" gaps. */
export function quoteFound(quote, text) {
  const q = norm(quote), t = norm(text);
  if (q.length < 12) return false;
  if (t.includes(q)) return true;
  const parts = String(quote).split(/\.\.\.|…/).map(norm).filter((p) => p.length >= 12);
  if (parts.length > 1) { let at = 0; for (const p of parts) { const i = t.indexOf(p, at); if (i < 0) return false; at = i + p.length; } return true; }
  return false;
}

// Wikimedia requires scripts to identify themselves; browsers can't set User-Agent, so Api-User-Agent is sent as well.
const WIKI_UA = "MyChat/0.3 (https://github.com/haran4-cpu/MyChat)";
const WIKI_HEADERS = typeof window === "undefined" ? { "User-Agent": WIKI_UA, "Api-User-Agent": WIKI_UA } : { "Api-User-Agent": WIKI_UA };

export class Search {
  constructor({ keys = {}, fetch: f, enabled } = {}) {
    this.keys = keys;
    this.fetch = f || globalThis.fetch.bind(globalThis);
    this.enabled = enabled || ["brave", "tavily", "serper", "google", "exa"].filter((p) => keys[p]);
    this.cache = new Map();
  }

  async _json(url, init = {}) {
    const r = await this.fetch(url, { ...init, signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
    return r.json();
  }

  _err(where, e) {   // failures used to be swallowed silently; keep the last few for the connection check
    (this.errors ||= []).push({ at: Date.now(), where, error: String(e?.message || e).slice(0, 160) });
    if (this.errors.length > 20) this.errors.shift();
  }

  /** Wikipedia, identified as Wikimedia asks (unidentified scripts get blocked). Hebrew questions search he + en,
   *  and a long sentence that finds nothing is retried with its quoted title or key words. */
  async wikipedia(q, n = 3) {
    const langs = isHebrew(q) ? ["he", "en"] : ["en"];
    const quoted = /(?:^|[^\p{L}])['"“”«»‘’`״]([^'"“”«»‘’`״]{2,60})['"“”«»‘’`״](?!\p{L})/u.exec(q)?.[1];
    const short = q.replace(/[?!.,:;()]/g, " ").split(/\s+/).filter((w) => w.length > 2).slice(0, 6).join(" ");
    const tries = [...new Set([q, quoted, short].filter(Boolean))];
    const out = [];
    for (const lang of langs) {
      const base = `https://${lang}.wikipedia.org/w/api.php?format=json&origin=*`;
      let titles = [];
      for (const t of tries) {
        try {
          const s = await this._json(`${base}&action=query&list=search&srlimit=${n}&srsearch=${encodeURIComponent(t)}`, { headers: WIKI_HEADERS });
          titles = (s.query?.search || []).map((x) => x.title);
        } catch (e) { this._err("wikipedia-" + lang, e); break; }
        if (titles.length) break;
      }
      if (!titles.length) continue;
      try {
        const e = await this._json(`${base}&action=query&prop=extracts&explaintext=1&exlimit=${n}&titles=${encodeURIComponent(titles.join("|"))}`, { headers: WIKI_HEADERS });
        out.push(...Object.values(e.query?.pages || {}).map((p) => ({ title: p.title, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`,
          snippet: (p.extract || "").slice(0, 400), text: (p.extract || "").slice(0, 60000), source: "wikipedia" })));
      } catch (e) { this._err("wikipedia-" + lang, e); }
      if (out.length >= n) break;
    }
    return out;
  }

  /** Quick health check of every evidence source (shown on the Accounts page). */
  async diagnose() {
    const t = async (name, fn) => { const t0 = Date.now(); try { const r = await fn(); return { name, ok: r.length > 0, results: r.length, ms: Date.now() - t0 }; }
      catch (e) { return { name, ok: false, error: String(e.message).slice(0, 160), ms: Date.now() - t0 }; } };
    const checks = [t("Wikipedia (Hebrew)", () => this.wikipedia("אהבת ציון אברהם מאפו", 1)), t("Wikipedia (English)", () => this.wikipedia("Eiffel Tower", 1)),
      ...this.enabled.map((p) => t(SEARCH_PROVIDERS[p]?.name || p, () => this.provider(p, "Eiffel Tower height", 2)))];
    return { checks: await Promise.all(checks), recentErrors: (this.errors || []).slice(-8) };
  }

  async provider(p, q, n) {
    const k = this.keys[p];
    if (p === "brave") {
      const j = await this._json(`https://api.search.brave.com/res/v1/web/search?count=${n}&q=${encodeURIComponent(q)}`, { headers: { "X-Subscription-Token": k, Accept: "application/json" } });
      return (j.web?.results || []).map((r) => ({ title: r.title, url: r.url, snippet: htmlToText(r.description), source: p }));
    }
    if (p === "tavily") {
      const j = await this._json("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + k },
        body: JSON.stringify({ query: q, max_results: n, include_raw_content: true }) });
      return (j.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content, text: r.raw_content || "", source: p }));
    }
    if (p === "serper") {
      const j = await this._json("https://google.serper.dev/search", { method: "POST", headers: { "Content-Type": "application/json", "X-API-KEY": k }, body: JSON.stringify({ q, num: n }) });
      return (j.organic || []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet, source: p }));
    }
    if (p === "google") {
      const [key, cx] = String(k).split("|");
      const j = await this._json(`https://www.googleapis.com/customsearch/v1?num=${Math.min(n, 10)}&key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx || "")}&q=${encodeURIComponent(q)}`);
      return (j.items || []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet, source: p }));
    }
    if (p === "exa") {
      const j = await this._json("https://api.exa.ai/search", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": k },
        body: JSON.stringify({ query: q, numResults: n, contents: { text: { maxCharacters: 20000 } } }) });
      return (j.results || []).map((r) => ({ title: r.title, url: r.url, snippet: (r.text || "").slice(0, 300), text: r.text || "", source: p }));
    }
    return [];
  }

  /** Full text of a page (Jina Reader when available, otherwise a plain fetch). */
  async page(url) {
    if (this.cache.has(url)) return this.cache.get(url);
    let text = "";
    try {
      const h = this.keys.jina ? { Authorization: "Bearer " + this.keys.jina } : {};
      const r = await this.fetch("https://r.jina.ai/" + url, { headers: { ...h, Accept: "text/plain" } });
      if (r.ok) text = await r.text();
    } catch { /* fall through */ }
    if (!text) {
      try { const r = await this.fetch(url, { headers: { "User-Agent": "MyChat evidence fetcher" } }); if (r.ok) text = htmlToText(await r.text()); } catch { /* unreachable page */ }
    }
    text = text.slice(0, 80000);
    this.cache.set(url, text);
    return text;
  }

  /** Search with every enabled provider + Wikipedia, de-duplicate, fetch page text for the top results. */
  async evidence(q, { n = 4, fetchPages = 3 } = {}) {
    const key = "e:" + q;
    if (this.cache.has(key)) return this.cache.get(key);
    const runs = [this.wikipedia(q, 2).catch((e) => (this._err("wikipedia", e), [])),
      ...this.enabled.slice(0, 2).map((p) => this.provider(p, q, n).catch((e) => (this._err(p, e), [])))];
    const all = (await Promise.all(runs)).flat();
    const seen = new Set(), out = [];
    for (const r of all) { if (!r.url || seen.has(r.url)) continue; seen.add(r.url); out.push(r); }
    await Promise.all(out.slice(0, fetchPages).map(async (r) => { if (!r.text) r.text = await this.page(r.url); }));
    this.cache.set(key, out);
    return out;
  }
}
