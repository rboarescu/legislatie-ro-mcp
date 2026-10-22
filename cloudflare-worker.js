/**
 * cloudflare-worker.js — Serverless Stateless Proxy & Remote MCP / OpenAPI Action
 * pentru `legislatie.just.ro/apiws/FreeWebService.svc/SOAP`.
 *
 * - Ruleaza pe Cloudflare Workers Free Tier (0 EUR/luna, 100.000 cereri/zi gratuite).
 * - Stateless & GDPR-Safe: nu salveaza loguri si nu primeste documentele utilizatorului,
 *   ci doar interogari legislative generice (`act`, `articole`, `cuvinte_cheie`).
 * - Poate fi conectat direct in:
 *   1. ChatGPT (Custom GPT Actions -> OpenAPI URL: `https://<worker>.workers.dev/openapi.json`)
 *   2. Claude Web & Mobile / Gemini / Orice client HTTP (`POST /mcp` sau `GET /cauta`, `GET /articol`)
 */

const SOAP_URL = "https://legislatie.just.ro/apiws/FreeWebService.svc/SOAP";
const SOAP_ACTION_TOKEN = "http://tempuri.org/IFreeWebService/GetToken";
const SOAP_ACTION_SEARCH = "http://tempuri.org/IFreeWebService/Search";

const ALIASURI = {
  "codul administrativ": { numar: "57", an: "2019", titlu: "Codul administrativ" },
  "cod administrativ": { numar: "57", an: "2019", titlu: "Codul administrativ" },
  "codul muncii": { numar: "53", an: "2003", titlu: "Codul muncii" },
  "codul civil": { numar: "287", an: "2009", titlu: "Codul civil" },
  "codul de procedura civila": { numar: "134", an: "2010", titlu: "Codul de procedura civila" },
  "cod procedura civila": { numar: "134", an: "2010", titlu: "Codul de procedura civila" },
  "codul penal": { numar: "286", an: "2009", titlu: "Codul penal" },
  "codul de procedura penala": { numar: "135", an: "2010", titlu: "Codul de procedura penala" },
  "codul fiscal": { numar: "227", an: "2015", titlu: "Codul fiscal" },
  "codul de procedura fiscala": { numar: "207", an: "2015", titlu: "Codul de procedura fiscala" },
  "codul rutier": { numar: "195", an: "2002", titlu: "circulatia pe drumurile publice" },
  "codul urbanismului": { numar: "169", an: "2026", titlu: "amenajarii teritoriului, urbanismului si constructiilor" },
  "catuc": { numar: "169", an: "2026", titlu: "amenajarii teritoriului, urbanismului si constructiilor" },
  "contencios administrativ": { numar: "554", an: "2004", titlu: "contenciosului administrativ" },
  "legea contenciosului administrativ": { numar: "554", an: "2004", titlu: "contenciosului administrativ" },
  "legea locuintei": { numar: "114", an: "1996", titlu: "legea locuintei" },
  "legea urbanismului": { numar: "350", an: "2001", titlu: "amenajarea teritoriului si urbanismul" },
  "autorizarea constructiilor": { numar: "50", an: "1991", titlu: "autorizarea executarii lucrarilor de constructii" },
  "regimul contraventiilor": { numar: "2", an: "2001", titlu: "regimul juridic al contraventiilor" },
  "stare civila": { numar: "119", an: "1996", titlu: "actele de stare civila" },
  "asociatii de proprietari": { numar: "196", an: "2018", titlu: "asociatiilor de proprietari" }
};

let cachedToken = null;
let cachedTokenTs = 0;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json; charset=utf-8"
  };
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
  return (raw || "")
    .replace(/^\uFEFF/, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s*\.\.\.\s*/g, "\n  ")
    .replace(/\s*\+\s*(?=\n|$)/g, "\n")
    .replace(/\s{2,}(?=(?:Articolul\s+[0-9IVXLCDM]+|CAPITOLUL\s+[0-9IVXLCDM]+|TITLUL\s+[0-9IVXLCDM]+|Notă|Nota|La data de\s+[0-9]{2}-[0-9]{2}-[0-9]{4}))/g, "\n\n")
    .replace(/\s{2,}(?=\([0-9]+\)\s+[A-ZĂÂÎȘȚ])/g, "\n  ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

async function soapSearch({ an = "", numar = "", text = "", titlu = "", perPage = 5 }) {
  const token = await getSoapToken(false);
  const env = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <Search xmlns="http://tempuri.org/">
      <SearchModel xmlns:d4p1="http://schemas.datacontract.org/2004/07/FreeWebService" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
        <d4p1:NumarPagina>0</d4p1:NumarPagina>
        <d4p1:RezultatePagina>${Math.min(Math.max(perPage, 1), 8)}</d4p1:RezultatePagina>
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
  const m = norm.match(/\b([0-9]{1,5})\s*(?:\/|\s+din\s+)((?:19|20)[0-9]{2})\b/);
  if (m) return { numar: m[1], an: m[2], titlu: "" };
  return { numar: "", an: "", titlu: actStr };
}

function splitArticles(text) {
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
  if (!matches.length) return [{ num: "integral", label: "Text", content: text.slice(0, 6000) }];
  return matches.map((it, i) => ({
    num: it.num,
    label: it.label,
    content: text.slice(it.idx, i + 1 < matches.length ? matches[i + 1].idx : text.length).trim()
  }));
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    const url = new URL(request.url);

    if (url.pathname === "/openapi.json") {
      const spec = {
        openapi: "3.1.0",
        info: {
          title: "Legislatie RO — API Oficial legislatie.just.ro",
          version: "1.0.0",
          description: "Cauta autonom legi, OUG, HG, RIL/HP ICCJ si Decizii CCR si extrage articolele la zi din legislatie.just.ro."
        },
        servers: [{ url: `${url.protocol}//${url.host}` }],
        paths: {
          "/cauta": {
            get: {
              operationId: "cautaLegislatieSiArticole",
              summary: "Cauta o lege/OUG/HG/Cod si extrage articolele sau fragmentele relevante dupa cuvinte-cheie.",
              parameters: [
                { name: "act", in: "query", required: false, schema: { type: "string" }, description: "Ex: Legea 114/1996, OUG 57/2019, Codul administrativ" },
                { name: "articole", in: "query", required: false, schema: { type: "string" }, description: "Ex: 38, 39 sau 11" },
                { name: "cuvinte_cheie", in: "query", required: false, schema: { type: "string" }, description: "Termeni juridici cautati in lege" }
              ],
              responses: { "200": { description: "Textul oficial al articolelor si linkul legislatie.just.ro" } }
            }
          }
        }
      };
      return new Response(JSON.stringify(spec, null, 2), { headers: corsHeaders() });
    }

    if (url.pathname === "/cauta") {
      const actParam = url.searchParams.get("act") || "";
      const artParam = url.searchParams.get("articole") || "";
      const kwParam = url.searchParams.get("cuvinte_cheie") || "";

      const resolved = resolveAct(actParam);
      let items = await soapSearch({
        an: resolved.an,
        numar: resolved.numar,
        titlu: !resolved.numar && !resolved.an ? resolved.titlu : "",
        text: !actParam ? kwParam : ""
      });

      if (!items.length && (resolved.titlu || kwParam)) {
        items = await soapSearch({
          an: resolved.an,
          numar: resolved.numar,
          titlu: "",
          text: `${resolved.titlu} ${kwParam}`.trim()
        });
      }

      if (!items.length) {
        return new Response(JSON.stringify({ eroare: "Nu s-au gasit acte normative." }), { headers: corsHeaders() });
      }

      const best = [...items].sort((a, b) => (b.text || "").length - (a.text || "").length)[0];
      const allArts = splitArticles(best.text);
      const reqNums = (artParam.match(/\d+/g) || []).map((x) => x.toLowerCase());

      let selected = [];
      if (reqNums.length) {
        allArts.forEach((a, i) => {
          if (reqNums.includes(a.num)) {
            selected.push(a);
            if (reqNums.length === 1 && i + 1 < allArts.length) selected.push(allArts[i + 1]);
          }
        });
      } else if (kwParam) {
        const terms = stripDiacriticsLower(kwParam).split(/\s+/).filter((t) => t.length >= 3);
        selected = allArts.filter((a) => terms.some((t) => stripDiacriticsLower(a.content).includes(t))).slice(0, 6);
      }
      if (!selected.length) selected = allArts.slice(0, 4);

      return new Response(
        JSON.stringify(
          {
            act: {
              tip_act: best.tip_act,
              numar: best.numar,
              data_vigoare: best.data_vigoare,
              titlu: best.titlu,
              link_oficial: best.link_oficial
            },
            articole_extrase: selected
          },
          null,
          2
        ),
        { headers: corsHeaders() }
      );
    }

    return new Response(
      JSON.stringify({
        serviciu: "legislatie-ro-mcp stateless worker",
        endpoints: ["/cauta?act=Legea+114/1996&articole=38,39", "/openapi.json"]
      }),
      { headers: corsHeaders() }
    );
  }
};
