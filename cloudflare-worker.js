/**
 * cloudflare-worker.js — Serverless Stateless Connector (Remote MCP + OpenAPI Action)
 * pentru `legislatie.just.ro/apiws/FreeWebService.svc/SOAP` + Forma Consolidata la Zi (`LinkHtml`).
 *
 * - Ruleaza pe Cloudflare Workers Free Tier (0 EUR/luna, 100.000 cereri/zi gratuite).
 * - Stateless & GDPR-Safe: nu salveaza loguri si nu primeste documentele utilizatorului,
 *   ci doar interogari legislative generice (`act`, `articole`, `cuvinte_cheie`).
 * - Expune 3 interfete pe acelasi URL (`https://<nume>.<subdomeniu>.workers.dev`):
 *   1. `POST /mcp`         -> Remote MCP Server (JSON-RPC 2.0 Streamable HTTP) pt. Claude Web & Mobile / Cursor / etc.
 *   2. `GET /openapi.json` -> Schema OpenAPI 3.1.0 pt. ChatGPT (Custom GPT Actions) / Gemini Extensions
 *   3. `GET /cauta`        -> Endpoint REST direct (`/cauta?act=OG+2/2001&articole=14,17`)
 *
 * Acces privat (implicit): `/mcp` si `/cauta` cer un token din secretul `ACCESS_TOKEN`
 * (Settings -> Variables and Secrets; mai multe tokenuri separate prin virgula, cate unul per persoana).
 * Tokenul se trimite ca `Authorization: Bearer <token>`, `X-Api-Key: <token>` sau `?key=<token>`
 * (ultima varianta pt. clientii care accepta doar URL, ex. Custom Connectors din claude.ai).
 * Fara `ACCESS_TOKEN` setat, Worker-ul refuza toate cererile, cu exceptia cazului in care
 * variabila `PUBLIC_ACCESS` este setata explicit la "true".
 */

const SOAP_URL = "https://legislatie.just.ro/apiws/FreeWebService.svc/SOAP";
const SOAP_ACTION_TOKEN = "http://tempuri.org/IFreeWebService/GetToken";
const SOAP_ACTION_SEARCH = "http://tempuri.org/IFreeWebService/Search";

const DISCLAIMER_LEGAL =
  "Sursa: Portalul Legislativ N-Lex (legislatie.just.ro — Ministerul Justitiei). " +
  "Conform Termenilor si Conditiilor portalului (https://legislatie.just.ro/Public/Termeni) " +
  "si art. 9 lit. b) din Legea nr. 8/1996, textele oficiale de natura legislativa nu beneficiaza " +
  "de protectia dreptului de autor si pot fi reutilizate, insa versiunile consolidate au caracter " +
  "strict informativ/consultativ. Singura baza legala autentica este Monitorul Oficial (Legea nr. 202/1998).";

const ALIASURI = {
  "codul administrativ": { numar: "57", an: "2019", titlu: "Codul administrativ", tip_act: "ORDONANȚĂ DE URGENȚĂ", doc_id: "215925" },
  "oug 57/2019": { numar: "57", an: "2019", titlu: "Codul administrativ", tip_act: "ORDONANȚĂ DE URGENȚĂ", doc_id: "215925" },
  "cod administrativ": { numar: "57", an: "2019", titlu: "Codul administrativ", tip_act: "ORDONANȚĂ DE URGENȚĂ", doc_id: "215925" },
  "codul muncii": { numar: "53", an: "2003", titlu: "Codul muncii", tip_act: "LEGE", doc_id: "309240" },
  "legea 53/2003": { numar: "53", an: "2003", titlu: "Codul muncii", tip_act: "LEGE", doc_id: "309240" },
  "codul civil": { numar: "287", an: "2009", titlu: "Codul civil", tip_act: "LEGE", doc_id: "109884" },
  "codul de procedura civila": { numar: "134", an: "2010", titlu: "Codul de procedură civilă", tip_act: "LEGE", doc_id: "304485" },
  "cod procedura civila": { numar: "134", an: "2010", titlu: "Codul de procedură civilă", tip_act: "LEGE", doc_id: "304485" },
  "codul penal": { numar: "286", an: "2009", titlu: "Codul penal", tip_act: "LEGE", doc_id: "109855" },
  "codul de procedura penala": { numar: "135", an: "2010", titlu: "Codul de procedură penală", tip_act: "LEGE", doc_id: "310738" },
  "codul fiscal": { numar: "227", an: "2015", titlu: "Codul fiscal", tip_act: "LEGE", doc_id: "171282" },
  "codul de procedura fiscala": { numar: "207", an: "2015", titlu: "Codul de procedură fiscală", tip_act: "LEGE", doc_id: "312603" },
  "codul rutier": { numar: "195", an: "2002", titlu: "circulația pe drumurile publice", tip_act: "ORDONANȚĂ DE URGENȚĂ", doc_id: "41006" },
  "oug 195/2002": { numar: "195", an: "2002", titlu: "circulația pe drumurile publice", tip_act: "ORDONANȚĂ DE URGENȚĂ", doc_id: "41006" },
  "codul urbanismului": { numar: "169", an: "2026", titlu: "amenajării teritoriului, urbanismului și construcțiilor", tip_act: "LEGE" },
  "catuc": { numar: "169", an: "2026", titlu: "amenajării teritoriului, urbanismului și construcțiilor", tip_act: "LEGE" },
  "contencios administrativ": { numar: "554", an: "2004", titlu: "contenciosului administrativ", tip_act: "LEGE", doc_id: "57426" },
  "legea contenciosului administrativ": { numar: "554", an: "2004", titlu: "contenciosului administrativ", tip_act: "LEGE", doc_id: "57426" },
  "legea 554/2004": { numar: "554", an: "2004", titlu: "contenciosului administrativ", tip_act: "LEGE", doc_id: "57426" },
  "legea locuintei": { numar: "114", an: "1996", titlu: "legea locuinţei", tip_act: "LEGE", doc_id: "8597" },
  "legea 114/1996": { numar: "114", an: "1996", titlu: "legea locuinţei", tip_act: "LEGE", doc_id: "8597" },
  "legea societatilor": { numar: "31", an: "1990", titlu: "societăţilor", tip_act: "LEGE", doc_id: "798" },
  "legea 31/1990": { numar: "31", an: "1990", titlu: "societăţilor", tip_act: "LEGE", doc_id: "798" },
  "legea urbanismului": { numar: "350", an: "2001", titlu: "amenajarea teritoriului", tip_act: "LEGE", doc_id: "29453" },
  "legea 350/2001": { numar: "350", an: "2001", titlu: "amenajarea teritoriului", tip_act: "LEGE", doc_id: "29453" },
  "autorizarea constructiilor": { numar: "50", an: "1991", titlu: "autorizarea executării lucrărilor de construcţii", tip_act: "LEGE", doc_id: "1515" },
  "legea 50/1991": { numar: "50", an: "1991", titlu: "autorizarea executării lucrărilor de construcţii", tip_act: "LEGE", doc_id: "1515" },
  "regimul contraventiilor": { numar: "2", an: "2001", titlu: "regimul juridic al contravenţiilor", tip_act: "ORDONANȚĂ", doc_id: "29779" },
  "og 2/2001": { numar: "2", an: "2001", titlu: "regimul juridic al contravenţiilor", tip_act: "ORDONANȚĂ", doc_id: "29779" },
  "og nr. 2/2001": { numar: "2", an: "2001", titlu: "regimul juridic al contravenţiilor", tip_act: "ORDONANȚĂ", doc_id: "29779" },
  "ordonanta 2/2001": { numar: "2", an: "2001", titlu: "regimul juridic al contravenţiilor", tip_act: "ORDONANȚĂ", doc_id: "29779" },
  "stare civila": { numar: "119", an: "1996", titlu: "actele de stare civilă", tip_act: "LEGE", doc_id: "8624" },
  "legea 119/1996": { numar: "119", an: "1996", titlu: "actele de stare civilă", tip_act: "LEGE", doc_id: "8624" },
  "legea 7/1996": { numar: "7", an: "1996", titlu: "cadastrului şi a publicităţii imobiliare", tip_act: "LEGE", doc_id: "7798" },
  "asociatii de proprietari": { numar: "196", an: "2018", titlu: "asociaţiilor de proprietari", tip_act: "LEGE", doc_id: "203233" },
  "legea 196/2018": { numar: "196", an: "2018", titlu: "asociaţiilor de proprietari", tip_act: "LEGE", doc_id: "203233" },
  "accesul la informatii de interes public": { numar: "544", an: "2001", titlu: "liberul acces la informaţiile de interes public", tip_act: "LEGE", doc_id: "31413" },
  "transparenta decizionala": { numar: "52", an: "2003", titlu: "transparenţa decizională", tip_act: "LEGE", doc_id: "41571" },
  "norme de tehnica legislativa": { numar: "24", an: "2000", titlu: "normele de tehnică legislativă", tip_act: "LEGE", doc_id: "21698" },
  "legea 24/2000": { numar: "24", an: "2000", titlu: "normele de tehnică legislativă", tip_act: "LEGE", doc_id: "21698" },
  "achizitii publice": { numar: "98", an: "2016", titlu: "achiziţiile publice", tip_act: "LEGE", doc_id: "178667" }
};

let cachedToken = null;
let cachedTokenTs = 0;

// ============================================================================
// Cache in doua niveluri, fara configurare (nu necesita KV):
// 1. memoria izolatului: LRU cu actele deja parsate (zero CPU la potrivire; util in aceeasi conversatie);
// 2. Cache API (per centru de date): articolele parsate ca JSON, ca sa nu reparsam HTML-ul (zeci de ms CPU la Coduri).
// Cheile includ PARSER_VERSION, deci o versiune noua a parserului invalideaza automat cache-ul.
// ============================================================================

const PARSER_VERSION = "2026-10-22.2";
const DOC_TTL_SEC = 24 * 3600;
const SEARCH_TTL_SEC = 12 * 3600;
const MEMORY_TTL_MS = 6 * 3600 * 1000;
const MEMORY_MAX_CHARS = 20_000_000; // ~40 MB (sirurile cu diacritice ocupa 2 octeti/caracter) din cei 128 MB ai izolatului

const memoryCache = new Map(); // cheie -> { value, size, expires }; ordinea de inserare = ordinea LRU
let memoryChars = 0;

function memoryGet(key) {
  const entry = memoryCache.get(key);
  if (!entry) return undefined;
  memoryCache.delete(key);
  if (entry.expires < Date.now()) {
    memoryChars -= entry.size;
    return undefined;
  }
  memoryCache.set(key, entry);
  return entry.value;
}

function memorySet(key, value, size) {
  if (size > MEMORY_MAX_CHARS / 2) return;
  const old = memoryCache.get(key);
  if (old) {
    memoryChars -= old.size;
    memoryCache.delete(key);
  }
  memoryCache.set(key, { value, size, expires: Date.now() + MEMORY_TTL_MS });
  memoryChars += size;
  for (const [k, e] of memoryCache) {
    if (memoryChars <= MEMORY_MAX_CHARS) break;
    memoryCache.delete(k);
    memoryChars -= e.size;
  }
}

function cacheApiKey(key) {
  return new Request(`https://cache.legislatie-ro-mcp.internal/${PARSER_VERSION}/${encodeURIComponent(key)}`);
}

// cc = { ctx, stats }: ctx.waitUntil scrie in Cache API dupa raspuns; stats aduna sursa fiecarei piese (antet X-Legis-Cache)
async function cached(key, ttlSec, cc, produce, shouldStore = () => true) {
  const hit = memoryGet(key);
  if (hit !== undefined) {
    cc.stats.push(`${key.split(":")[0]}=memorie`);
    return hit;
  }
  const cacheApi = typeof caches !== "undefined" ? caches.default : null;
  if (cacheApi) {
    try {
      const res = await cacheApi.match(cacheApiKey(key));
      if (res) {
        const body = await res.text();
        const value = JSON.parse(body);
        memorySet(key, value, body.length);
        cc.stats.push(`${key.split(":")[0]}=cache-api`);
        return value;
      }
    } catch (_) {}
  }
  const value = await produce();
  cc.stats.push(`${key.split(":")[0]}=sursa`);
  if (shouldStore(value)) {
    const body = JSON.stringify(value);
    memorySet(key, value, body.length);
    if (cacheApi && cc.ctx) {
      const res = new Response(body, {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${ttlSec}` }
      });
      cc.ctx.waitUntil(cacheApi.put(cacheApiKey(key), res).catch(() => {}));
    }
  }
  return value;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, Mcp-Session-Id",
    "Content-Type": "application/json; charset=utf-8"
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: corsHeaders() });
}

async function sha256(s) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}

// Comparam digest-urile SHA-256 (lungime fixa) cu timingSafeEqual ca sa nu scurgem tokenul prin timp de raspuns
async function tokenMatches(candidate, allowed) {
  const c = await sha256(candidate);
  let ok = false;
  for (const t of allowed) {
    if (crypto.subtle.timingSafeEqual(c, await sha256(t))) ok = true;
  }
  return ok;
}

function extractToken(request, url) {
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  return (request.headers.get("X-Api-Key") || url.searchParams.get("key") || "").trim();
}

// Intoarce null daca cererea e autorizata, altfel raspunsul de eroare
async function checkAccess(request, url, env) {
  if (env.PUBLIC_ACCESS === "true") return null;
  const allowed = String(env.ACCESS_TOKEN || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!allowed.length) {
    return jsonResponse({ eroare: "Worker neconfigurat: setati secretul ACCESS_TOKEN (sau PUBLIC_ACCESS=true)." }, 503);
  }
  const token = extractToken(request, url);
  if (token && (await tokenMatches(token, allowed))) return null;
  return jsonResponse({ eroare: "Acces neautorizat." }, 401);
}

function stripDiacriticsLower(s) {
  return (s || "")
    .replace(/[ăâĂÂ]/g, "a")
    .replace(/[îÎ]/g, "i")
    .replace(/[șşȘŞ]/g, "s")
    .replace(/[țţȚŢ]/g, "t")
    .toLowerCase()
    .trim();
}

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXml(s) {
  return String(s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

function extractTag(xml, tag) {
  const re = new RegExp(`<(?:[a-zA-Z0-9_]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_]+:)?${tag}>`, "i");
  const m = xml.match(re);
  return m ? decodeXml(m[1].trim()) : "";
}

function cleanText(raw) {
  return decodeXml(raw || "")
    .replace(/^\uFEFF/, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s*\.\.\.\s*/g, "\n  ")
    .replace(/\s*\+\s*(?=\n|$)/g, "\n")
    .replace(/\s{2,}(?=(?:Articolul\s+[0-9IVXLCDM]+|CAPITOLUL\s+[0-9IVXLCDM]+|TITLUL\s+[0-9IVXLCDM]+|Notă|Nota|La data de\s+[0-9]{2}-[0-9]{2}-[0-9]{4}))/g, "\n\n")
    .replace(/\s{2,}(?=\([0-9]+\)\s+[A-ZĂÂÎȘȚ])/g, "\n  ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Marcaje interne pentru tipul fiecarei linii din articol (vezi parse_articles_from_consolidated_html din server.py)
const MARK_NOTE = "\u0001"; // .S_NTA_TTL / .S_NTA_PAR (Nota: Decizii CCR, RIL/HP ICCJ)
const MARK_PAR = "\u0002"; // .S_PAR (denumirea marginala sau nota de modificare "(la dd-mm-yyyy, ...)")

function splitArticleLines(buffer) {
  const body = [];
  const notes = [];
  let inNote = false;
  for (const rawLine of buffer.split("\n")) {
    const first = rawLine.replace(/^ +/, "")[0];
    const mark = first === MARK_NOTE || first === MARK_PAR ? first : "";
    const line = rawLine
      .replace(/[\u0001\u0002]/g, "")
      .replace(/ {2,}/g, " ")
      .trim()
      .replace(/ +([,;.)])/g, "$1");
    if (!line) continue;
    if (mark === MARK_NOTE) {
      if (/^not[aă](?:[\s:]|$)/i.test(line) || !inNote) {
        notes.push(line.replace(/:$/, "") + ":");
      } else {
        notes[notes.length - 1] += (notes[notes.length - 1].endsWith(":") ? " " : "\n") + line;
      }
      inNote = true;
      continue;
    }
    inNote = false;
    if (mark === MARK_PAR && /^\(la \d{2}-\d{2}-\d{4}/.test(line)) notes.push(line);
    else body.push(line);
  }
  return { content: body.join("\n"), notes };
}

// Parcurge tag-urile cu o stiva: fiecare .S_ART de nivel superior este un articol; elementele
// `display: block` devin linii; notele (.S_PAR "(la ...)" si .S_NTA) sunt extrase separat;
// duplicatele ascunse (*_SHORT, TAG_COLLAPSED, display: none) sunt ignorate.
function parseArticlesFromConsolidatedHtml(rawHtml) {
  if (!rawHtml || !rawHtml.includes("S_ART_TTL")) return [];
  const tokenRe = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|[^<]+|</g;
  const articles = [];
  const stack = [];
  let hiddenDepth = 0;
  let artDepth = -1;
  let buf = [];
  let label = [];
  let inArtTtl = false;
  let m;
  while ((m = tokenRe.exec(rawHtml)) !== null) {
    const tok = m[0];
    if (tok.startsWith("<!--")) continue;
    const tag = (m[2] || "").toLowerCase();
    if (!tag) {
      if (hiddenDepth || tok === "<" || artDepth < 0) continue;
      const text = decodeXml(tok).replace(/\s+/g, " ");
      buf.push(text);
      if (inArtTtl) label.push(text);
      continue;
    }
    if (tag === "br") {
      if (artDepth >= 0 && !hiddenDepth) buf.push("\n");
      continue;
    }
    if (tag !== "span") {
      if (["div", "p", "li", "tr"].includes(tag) && artDepth >= 0 && !hiddenDepth) buf.push("\n");
      continue;
    }
    if (m[1] !== "/") {
      const attrs = m[3] || "";
      const cm = attrs.match(/class="([^"]*)"/);
      const cls = cm ? cm[1] : "";
      const compact = attrs.replace(/ /g, "").toLowerCase();
      const hidden = compact.includes("display:none") || cls.endsWith("_SHORT") || cls === "TAG_COLLAPSED";
      const block = compact.includes("display:block");
      stack.push({ cls, block, hidden });
      if (hidden) {
        hiddenDepth++;
        continue;
      }
      if (hiddenDepth) continue;
      if (cls === "S_ART" && artDepth < 0) {
        artDepth = stack.length;
        buf = [];
        label = [];
        continue;
      }
      if (artDepth >= 0) {
        if (cls === "S_ART_TTL") inArtTtl = true;
        if (cls === "S_NTA_TTL" || cls === "S_NTA_PAR") buf.push("\n" + MARK_NOTE);
        else if (cls === "S_PAR") buf.push("\n" + MARK_PAR);
        else if (block) buf.push("\n");
      }
      continue;
    }
    const top = stack.pop();
    if (!top) continue;
    if (top.hidden) {
      hiddenDepth--;
      continue;
    }
    if (hiddenDepth || artDepth < 0) continue;
    if (stack.length < artDepth) {
      const lbl = label.join("").replace(/\s+/g, " ").trim();
      // Articolele de peste 999 apar ca "Articolul 1.270" (separator de mii)
      const numM = lbl.match(/^(?:articolul|art\.?)\s*((?:[0-9]{1,3}(?:\.[0-9]{3})+|[0-9]+)(?:\^[0-9]+)?|[IVXLCDM]+)\b/i);
      const { content, notes } = splitArticleLines(buf.join(""));
      articles.push({
        num: numM ? numM[1].toLowerCase().replace(/\./g, "") : String(articles.length + 1),
        label: lbl,
        content,
        notes: notes.length ? notes : null
      });
      artDepth = -1;
      continue;
    }
    if (top.cls === "S_ART_TTL") inArtTtl = false;
    if (top.block || top.cls === "S_NTA_TTL" || top.cls === "S_ART_TTL") buf.push("\n");
  }
  return articles;
}

function splitArticlesPlain(text) {
  const re = /(?:^|\n)(Articolul\s+((?:[0-9]{1,3}(?:\.[0-9]{3})+|[0-9]+)(?:\^[0-9]+)?|[IVXLCDM]+)|Art\.\s*((?:[0-9]{1,3}(?:\.[0-9]{3})+|[0-9]+)(?:\^[0-9]+)?|[IVXLCDM]+))\b[.\s:-]*/gi;
  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({
      idx: m.index + (text[m.index] === "\n" ? 1 : 0),
      label: m[1].trim(),
      num: (m[2] || m[3] || "").toLowerCase().replace(/\./g, "")
    });
  }
  if (!matches.length) return [{ num: "integral", label: "Text", content: text.slice(0, 6000), notes: null }];
  return matches.map((it, i) => ({
    num: it.num,
    label: it.label,
    content: text.slice(it.idx, i + 1 < matches.length ? matches[i + 1].idx : text.length).trim(),
    notes: null
  }));
}

async function getSoapToken(force = false) {
  if (!force && cachedToken && Date.now() - cachedTokenTs < 15 * 60 * 1000) {
    return cachedToken;
  }
  const env = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><GetToken xmlns="http://tempuri.org/" /></s:Body></s:Envelope>`;
  const r = await fetch(SOAP_URL, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${SOAP_ACTION_TOKEN}"` },
    body: env
  });
  const xml = await r.text();
  cachedToken = extractTag(xml, "GetTokenResult");
  cachedTokenTs = Date.now();
  return cachedToken;
}

function optXml(tag, val) {
  const v = (val || "").trim();
  return v ? `<d4p1:${tag}>${escapeXml(v)}</d4p1:${tag}>` : `<d4p1:${tag} i:nil="true" />`;
}

// Rezultatele goale nu se pastreaza (pot fi o eroare temporara a API-ului)
function soapSearch(params, cc) {
  const { an = "", numar = "", text = "", titlu = "" } = params;
  return cached(`cautare:${JSON.stringify([an, numar, text, titlu])}`, SEARCH_TTL_SEC, cc, () => soapSearchRaw(params), (items) => items.length > 0);
}

async function soapSearchRaw({ an = "", numar = "", text = "", titlu = "", perPage = 15 }) {
  const token = await getSoapToken(false);
  const env = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <Search xmlns="http://tempuri.org/">
      <SearchModel xmlns:d4p1="http://schemas.datacontract.org/2004/07/FreeWebService" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
        <d4p1:NumarPagina>0</d4p1:NumarPagina>
        <d4p1:RezultatePagina>${Math.min(Math.max(perPage, 1), 25)}</d4p1:RezultatePagina>
        ${optXml("SearchAn", an)}
        ${optXml("SearchNumar", numar)}
        ${optXml("SearchText", text)}
        ${optXml("SearchTitlu", titlu)}
      </SearchModel>
      <tokenKey>${escapeXml(token)}</tokenKey>
    </Search>
  </s:Body>
</s:Envelope>`;
  const r = await fetch(SOAP_URL, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${SOAP_ACTION_SEARCH}"` },
    body: env
  });
  const xml = await r.text();
  const blocks = xml.match(/<(?:[a-zA-Z0-9_]+:)?Legi\b[^>]*>[\s\S]*?<\/(?:[a-zA-Z0-9_]+:)?Legi>/gi) || [];
  return blocks.map((b) => ({
    tip_act: extractTag(b, "TipAct"),
    numar: extractTag(b, "Numar"),
    data_vigoare: extractTag(b, "DataVigoare"),
    emitent: extractTag(b, "Emitent"),
    publicatie: extractTag(b, "Publicatie"),
    link_oficial: extractTag(b, "LinkHtml"),
    titlu: cleanText(extractTag(b, "Titlu")),
    text: cleanText(extractTag(b, "Text"))
  }));
}

function resolveAct(actStr) {
  const norm = stripDiacriticsLower(actStr);
  for (const [k, v] of Object.entries(ALIASURI)) {
    if (norm.includes(k)) return v;
  }
  const prefixRe = "(legea|lege|oug|o\\.u\\.g\\.|og|o\\.g\\.|hg|h\\.g\\.|hotararea|ordinul|ordin|decizia)";
  let m = norm.match(new RegExp(`\\b(?:${prefixRe}\\s*)?(?:nr\\.\\s*)?([0-9]{1,5})\\s*(?:\\/|\\s+din\\s+)(?:[0-9]{1,2}[./][0-9]{1,2}[./])?((?:19|20)[0-9]{2})\\b`));
  // Fara an (ex: "HG 859"): retinem tipul si numarul; anul se clarifica din lista de candidati
  if (!m) {
    const m2 = norm.match(new RegExp(`\\b${prefixRe}\\s*(?:nr\\.\\s*)?([0-9]{1,5})\\b`));
    if (m2) m = [m2[0], m2[1], m2[2], ""];
  }
  if (m) {
    const p = (m[1] || "").replace(/\./g, "");
    let tip_act = "";
    if (p === "oug") tip_act = "ORDONANȚĂ DE URGENȚĂ";
    else if (p === "og") tip_act = "ORDONANȚĂ";
    else if (p === "hg" || p === "hotararea") tip_act = "HOTĂRÂRE";
    else if (p.startsWith("leg")) tip_act = "LEGE";
    else if (p.startsWith("ordin")) tip_act = "ORDIN";
    return { numar: m[2], an: m[3], titlu: "", tip_act, doc_id: "" };
  }
  return { numar: "", an: "", titlu: actStr, tip_act: "", doc_id: "" };
}

// Cuvinte fara valoare de cautare (dupa eliminarea diacriticelor)
const STOPWORDS = new Set(
  "de la si in din pe pt pentru cu fara a al ale ai o un unei unui care ce sa se nu sau iar daca cand prin privind despre fata dupa catre spre este sunt fi mai cel cea cei cele acest aceasta lege legea art articol articolul alin hg oug og nr".split(" ")
);
// Terminatii flexionare frecvente in romana (cele mai lungi primele): "termenele" -> "termen", "topografie" -> "topograf"
const SUFFIXES = ["urilor", "elor", "ilor", "ului", "uri", "ele", "ile", "iei", "ii", "ie", "ia", "ea", "ul", "le", "a", "e", "i", "u"];

function stemRo(token) {
  for (const s of SUFFIXES) {
    if (token.endsWith(s) && token.length - s.length >= 4) return token.slice(0, -s.length);
  }
  return token;
}

function searchStems(query) {
  const tokens = stripDiacriticsLower(query).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set(tokens.map(stemRo))];
}

// Clasament pe articole: fiecare radacina gasita la inceput de cuvant valoreaza mai mult cu cat e mai rara in act (IDF)
function rankArticles(arts, query) {
  const stems = searchStems(query);
  if (!stems.length) return { stems, ranked: [] };
  const docs = arts.map((a) => stripDiacriticsLower(`${a.content}\n${(a.notes || []).join("\n")}`));
  const res = stems.map((s) => new RegExp(`\\b${s}`, "g"));
  const df = res.map((re) => docs.filter((d) => d.search(re) >= 0).length);
  const ranked = [];
  docs.forEach((d, i) => {
    let score = 0;
    const found = [];
    res.forEach((re, k) => {
      const hits = (d.match(re) || []).length;
      if (!hits) return;
      found.push(stems[k]);
      score += Math.log(1 + arts.length / df[k]) * (1 + Math.log(hits));
    });
    if (found.length) ranked.push({ idx: i, score, found });
  });
  ranked.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return { stems, ranked };
}

function articleSummary(a) {
  const lines = a.content.split("\n");
  const rest = lines.slice(1).join(" ");
  return `${a.label}: ${rest.length > 90 ? rest.slice(0, 90) + "…" : rest}`;
}

// "11 alin. (2) lit. c), 38-40" -> ["11", "38", "39", "40"]
function parseRequestedArticles(articole) {
  const cleaned = stripDiacriticsLower(articole)
    .replace(/\b(?:alin(?:eatul)?|lit(?:era)?|pct|punctul|teza)\.?\s*\(?[0-9a-z^]+\)?/g, " ")
    .replace(/\b(?:articolele|articolul|art)\.?/g, " ")
    .replace(/(\d)\.(\d{3})\b/g, "$1$2"); // "1.270" -> "1270"
  const out = [];
  for (const part of cleaned.split(/[,;]+|\s+si\s+/)) {
    const range = part.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (range) {
      for (let n = +range[1]; n <= Math.min(+range[2], +range[1] + 30); n++) out.push(String(n));
      continue;
    }
    out.push(...(part.match(/[0-9]+(?:\^[0-9]+)?/g) || []));
  }
  return [...new Set(out)];
}

const INSTRUCTIUNI_MODEL =
  "Citeaza si rezuma DOAR din textul din `articole_extrase`. Daca informatia ceruta (termene, documente, institutii) " +
  "nu apare in acest text, spune explicit ca nu ai gasit-o in act si NU o completa din memorie. Pentru alte articole " +
  "reapeleaza unealta cu `articole` (vezi `cuprins_articole`) sau cu alti termeni, in limbajul legii " +
  "(ex: 'aeronave fara pilot' in loc de 'drone').";

// Unele acte (ex: legile de aprobare/republicare a Codurilor) au in forma consolidata doar o trimitere (.S_REF)
// catre documentul cu textul propriu-zis; urmam o singura trimitere cand pagina nu are articole.
function fetchConsolidatedArticles(link, cc) {
  const docId = (link.match(/(\d+)\s*$/) || [])[1] || link;
  return cached(`act:${docId}`, DOC_TTL_SEC, cc, () => fetchConsolidatedArticlesRaw(link), (r) => r.arts.length > 0);
}

async function fetchConsolidatedArticlesRaw(link) {
  const get = (u) =>
    fetch(u.replace(/^http:\/\//i, "https://"), { headers: { "User-Agent": "legislatie-ro-mcp/1.0" } }).then((r) => r.text());
  const rawHtml = await get(link);
  const arts = parseArticlesFromConsolidatedHtml(rawHtml);
  if (arts.length) return { arts, link };
  const ref = rawHtml.match(/class="S_REF"><A href="[^"]*DetaliiDocumentAfis\/(\d+)/i);
  if (!ref) return { arts, link };
  const refLink = `https://legislatie.just.ro/Public/DetaliiDocument/${ref[1]}`;
  return { arts: parseArticlesFromConsolidatedHtml(await get(refLink)), link: refLink };
}

async function queryLegislatie({ act = "", articole = "", cuvinte_cheie = "" }, cc = { ctx: null, stats: [] }) {
  const resolved = resolveAct(act);
  let best = null;
  let allArts = [];
  let avertisment = null;

  if (resolved.doc_id) {
    let fetched;
    try {
      fetched = await fetchConsolidatedArticles(`https://legislatie.just.ro/Public/DetaliiDocument/${resolved.doc_id}`, cc);
    } catch (err) {
      return {
        eroare: `Forma consolidata la zi nu a putut fi preluata de pe legislatie.just.ro (${err}). Reincearca mai tarziu; nu raspunde din memorie.`,
        disclaimer: DISCLAIMER_LEGAL
      };
    }
    const { arts, link } = fetched;
    allArts = arts;
    best = {
      tip_act: resolved.tip_act || "ACT NORMATIV",
      numar: resolved.numar,
      data_vigoare: resolved.an,
      titlu: `${resolved.tip_act || "Act"} nr. ${resolved.numar}/${resolved.an} (${resolved.titlu})`,
      link_oficial: link
    };
  } else {
    const filterItems = (items) => {
      if (resolved.tip_act && items.length) {
        const exp = stripDiacriticsLower(resolved.tip_act);
        const exact = items.filter((x) => stripDiacriticsLower(x.tip_act) === exp);
        if (exact.length) items = exact;
      }
      if (resolved.numar) {
        const sameNum = items.filter((x) => x.numar === resolved.numar);
        if (sameNum.length) items = sameNum;
      }
      return items;
    };

    let items = [];
    if (resolved.numar && !resolved.an) {
      // Numar fara an: API-ul intoarce max. 20 de rezultate, cele mai vechi primele, deci lista completa nu e accesibila.
      // Restrangem cu cuvintele-cheie (cautare in textul actelor); altfel cerem anul in loc sa ghicim.
      const exp = stripDiacriticsLower(resolved.tip_act);
      // Intai toata fraza, apoi primele cuvinte semnificative pe rand
      const words = cuvinte_cheie.split(/\s+/).filter((t) => t.length >= 4 && !STOPWORDS.has(stripDiacriticsLower(t)));
      const tries = cuvinte_cheie ? [cuvinte_cheie, ...(words.length > 1 ? words.slice(0, 3) : [])] : [];
      const seen = new Map();
      for (const text of tries) {
        for (const x of await soapSearch({ numar: resolved.numar, text }, cc)) {
          if (x.numar === resolved.numar && (!exp || stripDiacriticsLower(x.tip_act) === exp)) seen.set(x.link_oficial, x);
        }
        if (seen.size) break;
      }
      items = [...seen.values()];
      if (items.length !== 1) {
        return {
          ambiguu: true,
          mesaj:
            `Exista mai multe acte cu numarul ${resolved.numar} (din ani diferiti)` +
            (items.length ? ", iar cuvintele-cheie se potrivesc cu mai multe dintre ele (vezi candidati)." : " si cuvintele-cheie nu au restrans cautarea.") +
            ` Reapeleaza unealta cu anul (ex: '${act.trim()}/2021'). Daca anul nu reiese din context, intreaba utilizatorul; NU presupune continutul actului.`,
          candidati: items.map((x) => ({
            act: `${x.tip_act} nr. ${x.numar}`,
            data: x.data_vigoare,
            titlu: x.titlu.slice(0, 200),
            link_oficial: x.link_oficial
          })),
          disclaimer: DISCLAIMER_LEGAL
        };
      }
    } else {
      items = filterItems(
        await soapSearch({
          an: resolved.an,
          numar: resolved.numar,
          titlu: !resolved.numar && !resolved.an ? resolved.titlu : "",
          text: !act ? cuvinte_cheie : ""
        }, cc)
      );
    }
    if (!items.length) {
      return { eroare: `Nu s-au gasit acte normative pentru '${act}' / '${cuvinte_cheie}'.`, disclaimer: DISCLAIMER_LEGAL };
    }
    best = [...items].sort((a, b) => (b.text || "").length - (a.text || "").length)[0];
    if (best.link_oficial) {
      try {
        const { arts, link } = await fetchConsolidatedArticles(best.link_oficial, cc);
        allArts = arts;
        if (arts.length) best = { ...best, link_oficial: link };
      } catch (err) {
        avertisment = `Forma consolidata nu a putut fi preluata (${err}).`;
      }
    }
    if (!allArts.length) {
      avertisment = `${avertisment || "Pagina consolidata nu contine articole."} Textul provine din API-ul SOAP si poate sa nu fie la zi.`;
      allArts = splitArticlesPlain(best.text);
    }
  }

  const reqNums = parseRequestedArticles(articole);
  let selected = [];
  let cautare = null;
  if (reqNums.length) {
    allArts.forEach((a, i) => {
      if (reqNums.includes(a.num)) {
        selected.push(a);
        if (reqNums.length === 1 && i + 1 < allArts.length) selected.push(allArts[i + 1]);
      }
    });
    const missing = reqNums.filter((n) => !allArts.some((a) => a.num === n));
    if (missing.length) cautare = { articole_negasite: missing };
  } else if (cuvinte_cheie) {
    const { stems, ranked } = rankArticles(allArts, cuvinte_cheie);
    selected = ranked.slice(0, 5).map((r) => allArts[r.idx]);
    cautare = {
      termeni_cautati: stems,
      articole_potrivite: ranked.length,
      clasament: ranked.slice(0, 10).map((r) => ({ articol: allArts[r.idx].label, termeni_gasiti: r.found })),
      ...(ranked.length
        ? {}
        : { mesaj: `Niciun articol din act nu contine termenii [${stems.join(", ")}]. Incearca termenii folositi de lege sau alege din cuprins_articole.` })
    };
  } else {
    selected = allArts.slice(0, 4);
  }

  return {
    act: {
      tip_act: best.tip_act,
      numar: best.numar,
      data_vigoare: best.data_vigoare,
      titlu: best.titlu,
      link_oficial: best.link_oficial
    },
    numar_articole_in_act: allArts.length,
    ...(cautare ? { cautare } : {}),
    articole_extrase: selected,
    // Harta actului pentru apeluri ulterioare tintite (doar pentru acte de dimensiune rezonabila)
    ...(allArts.length <= 80 ? { cuprins_articole: allArts.map(articleSummary) } : {}),
    ...(avertisment ? { avertisment } : {}),
    instructiuni_model: INSTRUCTIUNI_MODEL,
    disclaimer: DISCLAIMER_LEGAL
  };
}

const MCP_TOOLS = [
  {
    name: "cauta_si_extrage_legislatie_ro",
    description:
      "Cauta in baza oficiala legislatie.just.ro (Legi, Coduri, OUG, OG, HG, Ordine, RIL/HP ICCJ, Decizii CCR) si extrage forma consolidata la zi " +
      "a articolelor cerute sau a articolelor cele mai relevante pentru cuvintele-cheie. Raspunsul include `cuprins_articole` (harta actului) " +
      "pentru apeluri ulterioare tintite. Daca actul are numar fara an si exista mai multe, primesti `candidati` si trebuie sa reapelezi cu anul. " +
      "Raspunde utilizatorului doar pe baza textului returnat.",
    inputSchema: {
      type: "object",
      properties: {
        act: { type: "string", description: "Tip, numar si AN: ex. 'Legea 114/1996', 'HG 859/2021', 'OG 2/2001', 'OUG 57/2019' sau 'Codul administrativ'" },
        articole: { type: "string", description: "Articolele dorite (ex: '38, 39', '14-17', '11'); alineatele/literele se ignora, se returneaza articolul intreg" },
        cuvinte_cheie: {
          type: "string",
          description: "Termeni cautati in lege, in limbajul legii (ex: 'aeronave fara pilot fotografiere' in loc de 'drone'); fara date personale"
        }
      }
    }
  }
];

export default {
  async fetch(request, env = {}, ctx = null) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    const url = new URL(request.url);

    if (url.pathname === "/mcp" || url.pathname === "/cauta") {
      const denied = await checkAccess(request, url, env);
      if (denied) return denied;
    }

    // 1. Remote MCP Endpoint (Streamable HTTP JSON-RPC 2.0) pentru Claude Web/Mobile, Cursor etc.
    if (url.pathname === "/mcp" && request.method !== "POST") {
      return new Response(null, { status: 405, headers: { ...corsHeaders(), Allow: "POST, OPTIONS" } });
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      let msg;
      try {
        msg = await request.json();
      } catch (_) {
        return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON invalid" } }, 400);
      }
      const id = msg.id;
      // Notificarile JSON-RPC (fara id) nu primesc raspuns
      if (id === undefined || id === null) {
        return new Response(null, { status: 202, headers: corsHeaders() });
      }
      if (msg.method === "ping") {
        return jsonResponse({ jsonrpc: "2.0", id, result: {} });
      }
      if (msg.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: (msg.params && msg.params.protocolVersion) || "2024-11-05",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "legislatie-ro-mcp-cloudflare", version: "1.0.0" },
              instructions:
                "Conector catre legislatia consolidata la zi a Romaniei (legislatie.just.ro). Nu cita din memorie texte de lege; " +
                "verifica-le cu unealta. Raspunde doar pe baza articolelor returnate, cu linkul oficial. Daca textul returnat nu " +
                "contine raspunsul, spune asta si cauta din nou (alte articole din cuprins sau alti termeni). Nu trimite date personale."
            }
          }),
          { headers: corsHeaders() }
        );
      }
      if (msg.method === "tools/list") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } }), {
          headers: corsHeaders()
        });
      }
      if (msg.method === "tools/call") {
        const toolName = msg.params && msg.params.name;
        if (toolName !== MCP_TOOLS[0].name) {
          return jsonResponse({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unealta necunoscuta: ${toolName}` } });
        }
        const args = (msg.params && msg.params.arguments) || {};
        const cc = { ctx, stats: [] };
        const res = await queryLegislatie(
          { act: args.act || "", articole: args.articole || "", cuvinte_cheie: args.cuvinte_cheie || "" },
          cc
        );
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], isError: false }
          }),
          { headers: { ...corsHeaders(), "X-Legis-Cache": cc.stats.join(", ") } }
        );
      }
      return jsonResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `Metoda nesuportata: ${msg.method}` } });
    }

    // 2. OpenAPI 3.1.0 Schema pentru ChatGPT Custom GPT Actions
    if (url.pathname === "/openapi.json") {
      const spec = {
        openapi: "3.1.0",
        info: {
          title: "Legislatie RO — API Oficial legislatie.just.ro",
          version: "1.0.0",
          description: "Cauta autonom legi, OUG, OG, HG, RIL/HP ICCJ si Decizii CCR si extrage articolele consolidate la zi din legislatie.just.ro."
        },
        servers: [{ url: `${url.protocol}//${url.host}` }],
        components: {
          securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } }
        },
        security: [{ bearerAuth: [] }],
        paths: {
          "/cauta": {
            get: {
              operationId: "cautaLegislatieSiArticole",
              summary: "Cauta o lege/OUG/OG/HG/Cod si extrage articolele consolidate la zi sau fragmentele relevante.",
              parameters: [
                { name: "act", in: "query", required: false, schema: { type: "string" }, description: "Ex: Legea 114/1996, OG 2/2001, OUG 57/2019, Codul administrativ" },
                { name: "articole", in: "query", required: false, schema: { type: "string" }, description: "Ex: 38, 39 sau 14, 17" },
                { name: "cuvinte_cheie", in: "query", required: false, schema: { type: "string" }, description: "Termeni juridici cautati in lege" }
              ],
              responses: { "200": { description: "Textul oficial consolidat al articolelor si linkul legislatie.just.ro" } }
            }
          }
        }
      };
      return new Response(JSON.stringify(spec, null, 2), { headers: corsHeaders() });
    }

    // 3. Endpoint REST direct GET /cauta
    if (url.pathname === "/cauta") {
      const cc = { ctx, stats: [] };
      const res = await queryLegislatie(
        {
          act: url.searchParams.get("act") || "",
          articole: url.searchParams.get("articole") || "",
          cuvinte_cheie: url.searchParams.get("cuvinte_cheie") || ""
        },
        cc
      );
      return new Response(JSON.stringify(res, null, 2), { headers: { ...corsHeaders(), "X-Legis-Cache": cc.stats.join(", ") } });
    }

    return new Response(
      JSON.stringify({
        serviciu: "legislatie-ro-mcp stateless Cloudflare Worker",
        endpoints: {
          remote_mcp: "POST /mcp",
          openapi_spec: "GET /openapi.json",
          rest_search: "GET /cauta?act=OG+2/2001&articole=14,17"
        }
      }),
      { headers: corsHeaders() }
    );
  }
};
