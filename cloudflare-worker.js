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
  "codul muncii": { numar: "53", an: "2003", titlu: "Codul muncii", tip_act: "LEGE", doc_id: "41625" },
  "legea 53/2003": { numar: "53", an: "2003", titlu: "Codul muncii", tip_act: "LEGE", doc_id: "41625" },
  "codul civil": { numar: "287", an: "2009", titlu: "Codul civil", tip_act: "LEGE", doc_id: "109884" },
  "codul de procedura civila": { numar: "134", an: "2010", titlu: "Codul de procedură civilă", tip_act: "LEGE", doc_id: "120611" },
  "cod procedura civila": { numar: "134", an: "2010", titlu: "Codul de procedură civilă", tip_act: "LEGE", doc_id: "120611" },
  "codul penal": { numar: "286", an: "2009", titlu: "Codul penal", tip_act: "LEGE", doc_id: "109855" },
  "codul de procedura penala": { numar: "135", an: "2010", titlu: "Codul de procedură penală", tip_act: "LEGE", doc_id: "120612" },
  "codul fiscal": { numar: "227", an: "2015", titlu: "Codul fiscal", tip_act: "LEGE", doc_id: "171282" },
  "codul de procedura fiscala": { numar: "207", an: "2015", titlu: "Codul de procedură fiscală", tip_act: "LEGE", doc_id: "170011" },
  "codul rutier": { numar: "195", an: "2002", titlu: "circulația pe drumurile publice", tip_act: "ORDONANȚĂ DE URGENȚĂ", doc_id: "41023" },
  "oug 195/2002": { numar: "195", an: "2002", titlu: "circulația pe drumurile publice", tip_act: "ORDONANȚĂ DE URGENȚĂ", doc_id: "41023" },
  "codul urbanismului": { numar: "169", an: "2026", titlu: "amenajării teritoriului, urbanismului și construcțiilor", tip_act: "LEGE" },
  "catuc": { numar: "169", an: "2026", titlu: "amenajării teritoriului, urbanismului și construcțiilor", tip_act: "LEGE" },
  "contencios administrativ": { numar: "554", an: "2004", titlu: "contenciosului administrativ", tip_act: "LEGE", doc_id: "57426" },
  "legea contenciosului administrativ": { numar: "554", an: "2004", titlu: "contenciosului administrativ", tip_act: "LEGE", doc_id: "57426" },
  "legea 554/2004": { numar: "554", an: "2004", titlu: "contenciosului administrativ", tip_act: "LEGE", doc_id: "57426" },
  "legea locuintei": { numar: "114", an: "1996", titlu: "legea locuinţei", tip_act: "LEGE", doc_id: "8597" },
  "legea 114/1996": { numar: "114", an: "1996", titlu: "legea locuinţei", tip_act: "LEGE", doc_id: "8597" },
  "legea societatilor": { numar: "31", an: "1990", titlu: "societăţilor", tip_act: "LEGE", doc_id: "737" },
  "legea 31/1990": { numar: "31", an: "1990", titlu: "societăţilor", tip_act: "LEGE", doc_id: "737" },
  "legea urbanismului": { numar: "350", an: "2001", titlu: "amenajarea teritoriului", tip_act: "LEGE", doc_id: "29453" },
  "legea 350/2001": { numar: "350", an: "2001", titlu: "amenajarea teritoriului", tip_act: "LEGE", doc_id: "29453" },
  "autorizarea constructiilor": { numar: "50", an: "1991", titlu: "autorizarea executării lucrărilor de construcţii", tip_act: "LEGE", doc_id: "1449" },
  "legea 50/1991": { numar: "50", an: "1991", titlu: "autorizarea executării lucrărilor de construcţii", tip_act: "LEGE", doc_id: "1449" },
  "regimul contraventiilor": { numar: "2", an: "2001", titlu: "regimul juridic al contravenţiilor", tip_act: "ORDONANȚĂ", doc_id: "29779" },
  "og 2/2001": { numar: "2", an: "2001", titlu: "regimul juridic al contravenţiilor", tip_act: "ORDONANȚĂ", doc_id: "29779" },
  "og nr. 2/2001": { numar: "2", an: "2001", titlu: "regimul juridic al contravenţiilor", tip_act: "ORDONANȚĂ", doc_id: "29779" },
  "ordonanta 2/2001": { numar: "2", an: "2001", titlu: "regimul juridic al contravenţiilor", tip_act: "ORDONANȚĂ", doc_id: "29779" },
  "stare civila": { numar: "119", an: "1996", titlu: "actele de stare civilă", tip_act: "LEGE", doc_id: "8613" },
  "legea 119/1996": { numar: "119", an: "1996", titlu: "actele de stare civilă", tip_act: "LEGE", doc_id: "8613" },
  "legea 7/1996": { numar: "7", an: "1996", titlu: "cadastrului şi a publicităţii imobiliare", tip_act: "LEGE", doc_id: "7863" },
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
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
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

function parseArticlesFromConsolidatedHtml(rawHtml) {
  if (!rawHtml || !rawHtml.includes("S_ART_TTL")) return [];
  const artRe = /<span\s+class="S_ART_TTL"[^>]*>([\s\S]*?)<\/span>/gi;
  const matches = [];
  let m;
  while ((m = artRe.exec(rawHtml)) !== null) {
    const label = cleanText(m[1]);
    const numM = label.match(/^(?:articolul|art\.?)\s*([0-9]+(?:\^[0-9]+)?|[IVXLCDM]+)\b/i);
    matches.push({
      start: m.index,
      label,
      num: numM ? numM[1].toLowerCase() : String(matches.length + 1)
    });
  }
  return matches.map((it, i) => {
    const end = i + 1 < matches.length ? matches[i + 1].start : rawHtml.length;
    const block = rawHtml.slice(it.start, end);
    const content = cleanText(block);
    const notes = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /(\(la\s+[0-9]{2}-[0-9]{2}-[0-9]{4}|Notă|Nota|Decizia\s+(?:ÎCCJ|ICCJ|CCR)|Recurs\s+în\s+interesul\s+legii|Hotărâre\s+prealabilă|HP\s+nr\.)/i.test(l))
      .slice(0, 10)
      .join("\n");
    return { num: it.num, label: it.label, content, notes: notes || null };
  });
}

function splitArticlesPlain(text) {
  const re = /(?:^|\n)(Articolul\s+([0-9]+(?:\^[0-9]+)?|[IVXLCDM]+)|Art\.\s*([0-9]+(?:\^[0-9]+)?|[IVXLCDM]+))\b[.\s:-]*/gi;
  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({
      idx: m.index + (text[m.index] === "\n" ? 1 : 0),
      label: m[1].trim(),
      num: (m[2] || m[3] || "").toLowerCase()
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

async function soapSearch({ an = "", numar = "", text = "", titlu = "", perPage = 15 }) {
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
  const m = norm.match(/\b(?:(legea|lege|oug|o\.u\.g\.|og|o\.g\.|hg|h\.g\.|ordinul|ordin|decizia)\s*)?(?:nr\.\s*)?([0-9]{1,5})\s*(?:\/|\s+din\s+)((?:19|20)[0-9]{2})\b/);
  if (m) {
    const p = (m[1] || "").replace(/\./g, "");
    let tip_act = "";
    if (p === "oug") tip_act = "ORDONANȚĂ DE URGENȚĂ";
    else if (p === "og") tip_act = "ORDONANȚĂ";
    else if (p === "hg") tip_act = "HOTĂRÂRE";
    else if (p.startsWith("leg")) tip_act = "LEGE";
    return { numar: m[2], an: m[3], titlu: "", tip_act, doc_id: "" };
  }
  return { numar: "", an: "", titlu: actStr, tip_act: "", doc_id: "" };
}

async function queryLegislatie({ act = "", articole = "", cuvinte_cheie = "" }) {
  const resolved = resolveAct(act);
  let best = null;
  let allArts = [];

  if (resolved.doc_id && !cuvinte_cheie) {
    const link = `https://legislatie.just.ro/Public/DetaliiDocument/${resolved.doc_id}`;
    const r = await fetch(link, { headers: { "User-Agent": "legislatie-ro-mcp/1.0" } });
    const rawHtml = await r.text();
    allArts = parseArticlesFromConsolidatedHtml(rawHtml);
    best = {
      tip_act: resolved.tip_act || "ACT NORMATIV",
      numar: resolved.numar,
      data_vigoare: resolved.an,
      titlu: `${resolved.tip_act || "Act"} nr. ${resolved.numar}/${resolved.an} (${resolved.titlu})`,
      link_oficial: link
    };
  } else {
    let items = await soapSearch({
      an: resolved.an,
      numar: resolved.numar,
      titlu: !resolved.numar && !resolved.an ? resolved.titlu : "",
      text: !act ? cuvinte_cheie : ""
    });
    if (resolved.tip_act && items.length) {
      const exp = stripDiacriticsLower(resolved.tip_act);
      const exact = items.filter((x) => stripDiacriticsLower(x.tip_act) === exp);
      if (exact.length) items = exact;
    }
    if (!items.length) {
      return { eroare: `Nu s-au gasit acte normative pentru '${act}' / '${cuvinte_cheie}'.`, disclaimer: DISCLAIMER_LEGAL };
    }
    best = [...items].sort((a, b) => (b.text || "").length - (a.text || "").length)[0];
    if (best.link_oficial) {
      try {
        const httpsUrl = best.link_oficial.replace(/^http:\/\//i, "https://");
        const r = await fetch(httpsUrl, { headers: { "User-Agent": "legislatie-ro-mcp/1.0" } });
        const rawHtml = await r.text();
        allArts = parseArticlesFromConsolidatedHtml(rawHtml);
      } catch (_) {}
    }
    if (!allArts.length) {
      allArts = splitArticlesPlain(best.text);
    }
  }

  const reqNums = (articole.match(/[0-9]+(?:\^[0-9]+)?/g) || []).map((x) => x.toLowerCase());
  let selected = [];
  if (reqNums.length) {
    allArts.forEach((a, i) => {
      if (reqNums.includes(a.num)) {
        selected.push(a);
        if (reqNums.length === 1 && i + 1 < allArts.length) selected.push(allArts[i + 1]);
      }
    });
  } else if (cuvinte_cheie) {
    const terms = stripDiacriticsLower(cuvinte_cheie).split(/\s+/).filter((t) => t.length >= 3);
    selected = allArts.filter((a) => terms.some((t) => stripDiacriticsLower(a.content).includes(t))).slice(0, 6);
  }
  if (!selected.length) selected = allArts.slice(0, 4);

  return {
    act: {
      tip_act: best.tip_act,
      numar: best.numar,
      data_vigoare: best.data_vigoare,
      titlu: best.titlu,
      link_oficial: best.link_oficial
    },
    articole_extrase: selected,
    disclaimer: DISCLAIMER_LEGAL
  };
}

const MCP_TOOLS = [
  {
    name: "cauta_si_extrage_legislatie_ro",
    description:
      "Cauta in baza oficiala legislatie.just.ro (Legi, Coduri, OUG, OG, HG, Ordine, RIL/HP ICCJ, Decizii CCR) si extrage forma consolidata la zi a articolelor sau fragmentele relevante dupa cuvinte-cheie.",
    inputSchema: {
      type: "object",
      properties: {
        act: { type: "string", description: "Ex: 'Legea 114/1996', 'OG 2/2001', 'OUG 57/2019', 'Codul administrativ', 'Legea 554/2004'" },
        articole: { type: "string", description: "Articolele dorite (ex: '38, 39', '14, 17', '11')" },
        cuvinte_cheie: { type: "string", description: "Cuvinte-cheie juridice cautate in lege (fara date personale)" }
      }
    }
  }
];

export default {
  async fetch(request, env = {}) {
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
              serverInfo: { name: "legislatie-ro-mcp-cloudflare", version: "1.0.0" }
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
        const res = await queryLegislatie({
          act: args.act || "",
          articole: args.articole || "",
          cuvinte_cheie: args.cuvinte_cheie || ""
        });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], isError: false }
          }),
          { headers: corsHeaders() }
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
      const res = await queryLegislatie({
        act: url.searchParams.get("act") || "",
        articole: url.searchParams.get("articole") || "",
        cuvinte_cheie: url.searchParams.get("cuvinte_cheie") || ""
      });
      return new Response(JSON.stringify(res, null, 2), { headers: corsHeaders() });
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
